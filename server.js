const express = require('express');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const imap = require('imap-simple');
const { simpleParser } = require('mailparser');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { startKeepAlive, keepAliveMiddleware } = require('./utils/keepAlive');

// ---------- CONFIG (all secrets come from environment variables) ----------
const MONGO_URI = process.env.MONGO_URI;
const API_SECRET_KEY = process.env.API_SECRET_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const BUSINESS_UPI = process.env.BUSINESS_UPI || 'paytm.s2ujlw0@pty';
const PAYEE_NAME = process.env.PAYEE_NAME || 'TaknaTechnologies';
// Optional: main site webhook, e.g. https://your-site.com/api/payment-webhook
const SITE_WEBHOOK_URL = process.env.SITE_WEBHOOK_URL || '';
// Only PENDING orders newer than this are scanned in the mailbox
// Admin panel password (use the same value as ADMIN_SECRET_PASS on the main site)
const ADMIN_PASS = process.env.ADMIN_SECRET_PASS || '';
const PENDING_WINDOW_HOURS = Number(process.env.PENDING_WINDOW_HOURS) || 24;

const missing = ['MONGO_URI', 'API_SECRET_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD'].filter(k => !process.env[k]);
if (missing.length) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
}

process.on('unhandledRejection', (r) => console.error('[UnhandledRejection]', r && r.message ? r.message : r));
process.on('uncaughtException', (e) => console.error('[UncaughtException]', e && e.message ? e.message : e));

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy -> correct https in generated links
app.use(keepAliveMiddleware); // learns the public URL automatically for the self-ping
// registration / KYC carry a compressed PAN card photo (base64), so only these two routes accept a bigger body
app.use(['/api/merchant/register', '/api/merchant/kyc'], express.json({ limit: '1500kb' }));
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true }));
app.disable('x-powered-by');
// "/" is the public home (merchant sign-up + docs links); the checkout page only opens with an orderId
app.get('/', (req, res, next) => req.query.orderId ? next() : res.redirect('/merchant.html'));
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1d',
    setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); }
}));

// ---------- DATABASE ----------
let dbAttempt = 0;
function connectDb() {
    dbAttempt++;
    mongoose.connect(MONGO_URI, { maxPoolSize: 10, serverSelectionTimeoutMS: 15000, socketTimeoutMS: 45000 }).then(
        () => { dbAttempt = 0; console.log('MongoDB Connected Successfully'); },
        (err) => {
            const delay = Math.min(5000 * dbAttempt, 60000);
            console.log(`DB Connection Error: ${err.message} - retrying in ${delay / 1000}s (attempt ${dbAttempt}). Check MONGO_URI and the Atlas IP allow-list.`);
            setTimeout(connectDb, delay);
        }
    );
}
connectDb();
// While the database is (re)connecting, answer clearly instead of hanging; the main site's webhook sweep retries anyway
app.use('/api', (req, res, next) => {
    const path = req.originalUrl.split('?')[0];
    if (mongoose.connection.readyState === 1 || path === '/api/ping' || path === '/api/admin/login') return next();
    res.status(503).json({ success: false, message: 'Service is starting (database connecting). Please try again in a few seconds.' });
});

// NOTE: this uses the same "payments" collection as the main site (same DB),
// so extra fields written by the site (coins, telegramChatId) are preserved.
const paymentSchema = new mongoose.Schema({
    orderId: { type: String, unique: true, required: true },
    amount: { type: Number, required: true },
    status: { type: String, default: 'PENDING' },
    paidAt: Date,
    webhookSent: { type: Boolean, default: false },
    merchantId: { type: mongoose.Schema.Types.ObjectId, default: null }, // null = your own main site
    plan: { type: String, default: null },   // merchant plan at order creation (FREE | PAID)
    fee: { type: Number, default: null },    // gateway fee for this order (null = no fee, e.g. main site)
    createdAt: { type: Date, default: Date.now }
});
paymentSchema.index({ status: 1, createdAt: -1 }); // fast pending scan + admin filters
paymentSchema.index({ merchantId: 1, createdAt: -1 });
const Payment = mongoose.model('Payment', paymentSchema);

// Merchants = other people who register to use this gateway on their own site (admin approves them)
const merchantSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    siteUrl: { type: String, default: '' },
    webhookUrl: { type: String, default: '' },
    contact: { type: String, default: '' },
    status: { type: String, default: 'PENDING' },   // PENDING | APPROVED | REJECTED | SUSPENDED
    apiKey: { type: String, default: null, index: true },
    tokenHash: { type: String, default: '' },        // sha256 of the dashboard login token
    panName: { type: String, default: '' },           // name as printed on the PAN card
    panNumber: { type: String, default: '', index: true },
    kycStatus: { type: String, default: 'NONE' },     // NONE | SUBMITTED | VERIFIED | REJECTED
    kycNote: { type: String, default: '' },           // admin's reason when KYC / registration is rejected
    plan: { type: String, default: 'FREE' },          // FREE (default) | PAID
    planExpiresAt: Date,                              // PAID plan is valid until this date
    subscriptionPaid: { type: Number, default: 0 },   // plan fees already deducted from the merchant balance
    createdAt: { type: Date, default: Date.now },
    approvedAt: Date
});
const Merchant = mongoose.model('Merchant', merchantSchema);

// PAN card photo lives in its own collection so normal merchant queries stay light
const kycDocSchema = new mongoose.Schema({
    merchantId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    image: { type: String, required: true },          // data:image/...;base64,...
    updatedAt: { type: Date, default: Date.now }
});
const KycDoc = mongoose.model('KycDoc', kycDocSchema);
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
function parseKyc(b) {
    const panName = String(b.panName || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const panNumber = String(b.panNumber || '').replace(/\s/g, '').toUpperCase();
    const image = String(b.panImage || '');
    if (panName.length < 2) return { error: 'Enter your name exactly as printed on the PAN card.' };
    if (!PAN_RE.test(panNumber)) return { error: 'Enter a valid 10-character PAN number, e.g. ABCDE1234F.' };
    const mt = image.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!mt) return { error: 'Upload a clear photo of your PAN card (JPG or PNG).' };
    const buf = Buffer.from(mt[2], 'base64');
    const okMagic = buf.length > 12 && ((buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) || (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') || (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP'));
    if (!okMagic || buf.length < 5000) return { error: 'The PAN card image is not a valid photo. Upload it again.' };
    if (buf.length > 900 * 1024) return { error: 'The PAN card image is too large. Use a smaller photo.' };
    return { panName, panNumber, image };
}

// ---------- PLANS, SETTLEMENT & PAYOUT RULES (edit the numbers here) ----------
const PLANS = {
    FREE: { name: 'Free', monthly: 0,   percent: 5, perTxn: 0, payoutRates: { NEFT: 1, IMPS: 1.5, UPI: 2 } },
    PAID: { name: 'Pro',  monthly: 499, percent: 0, perTxn: 1, payoutRates: { NEFT: 0, IMPS: 0.5, UPI: 0 } }
};
const SETTLEMENT_DAYS = 3;   // working days (Mon-Fri) after payment before money can be withdrawn
const REFUND_PERCENT = 1;   // refund charge (% of the refunded amount), same on every plan
const MIN_PAYOUT = 100;      // minimum payout request in INR
const PLAN_DAYS = 30;
const r2 = n => Math.round(n * 100) / 100;
const effPlan = m => (m && m.plan === 'PAID' && m.planExpiresAt && new Date(m.planExpiresAt) > new Date()) ? 'PAID' : 'FREE';
const calcFee = (plan, amount) => r2(Math.min(amount, amount * PLANS[plan].percent / 100 + PLANS[plan].perTxn));
function addWorkingDays(d, n) { const x = new Date(d); let i = 0; while (i < n) { x.setDate(x.getDate() + 1); const w = x.getDay(); if (w !== 0 && w !== 6) i++; } return x; }

// Payout requests: merchant asks -> admin pays manually -> admin enters UTR and accepts (or rejects)
const payoutSchema = new mongoose.Schema({
    merchantId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    amount: { type: Number, required: true },        // deducted from the merchant balance
    method: { type: String, required: true },        // NEFT | IMPS | UPI
    fee: { type: Number, default: 0 },               // payout charge
    payable: { type: Number, required: true },       // amount - fee = what the admin transfers
    accountName: String, accountNumber: String, ifsc: String, upiId: String,
    status: { type: String, default: 'PENDING' },    // PENDING | PAID | REJECTED
    utr: { type: String, default: '' },
    note: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    processedAt: Date
});
payoutSchema.index({ status: 1, createdAt: -1 });
const Payout = mongoose.model('Payout', payoutSchema);

// Refunds: merchant asks to refund a paid order -> admin refunds the customer from the same payment account -> enters UTR -> accept / reject
const refundSchema = new mongoose.Schema({
    merchantId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    orderId: { type: String, required: true, index: true },
    amount: { type: Number, required: true },        // what the customer gets back
    charge: { type: Number, default: 0 },            // refund charge (REFUND_PERCENT of amount), always cut from the merchant
    deduct: { type: Number, required: true },        // taken from the merchant balance = amount + charge (the payment fee is never refunded)
    reason: { type: String, default: '' },
    customerUpi: { type: String, default: '' },      // optional, helps the admin find the payer
    status: { type: String, default: 'PENDING' },    // PENDING | REFUNDED | REJECTED
    utr: { type: String, default: '' },
    note: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    processedAt: Date
});
refundSchema.index({ status: 1, createdAt: -1 });
const Refund = mongoose.model('Refund', refundSchema);

// available = settled earnings (after fees, older than SETTLEMENT_DAYS working days) - payouts - plan fees
async function getBalance(m) {
    const [pays, pos, rfs] = await Promise.all([
        Payment.find({ merchantId: m._id, status: 'SUCCESS' }).select('amount fee paidAt createdAt').lean(),
        Payout.find({ merchantId: m._id, status: { $in: ['PENDING', 'PAID'] } }).select('amount status').lean(),
        Refund.find({ merchantId: m._id, status: { $in: ['PENDING', 'REFUNDED'] } }).select('deduct').lean()
    ]);
    const now = Date.now(); let available = 0, pending = 0, gross = 0, fees = 0;
    for (const p of pays) {
        const fee = p.fee != null ? p.fee : calcFee('FREE', p.amount);
        gross += p.amount; fees += fee;
        if (addWorkingDays(p.paidAt || p.createdAt, SETTLEMENT_DAYS).getTime() <= now) available += p.amount - fee; else pending += p.amount - fee;
    }
    let paidOut = 0, requested = 0;
    pos.forEach(o => { if (o.status === 'PAID') paidOut += o.amount; else requested += o.amount; });
    const refundCut = rfs.reduce((a, x) => a + (x.deduct || 0), 0);
    return { available: r2(available - paidOut - requested - refundCut - (m.subscriptionPaid || 0)), refunds: r2(refundCut), pending: r2(pending), paidOut: r2(paidOut), requested: r2(requested), gross: r2(gross), fees: r2(fees) };
}
const moneyLock = new Set(); // one balance-changing action per merchant at a time

// ---------- IMAP ----------
const imapConfig = {
    imap: {
        user: GMAIL_USER,
        password: GMAIL_APP_PASSWORD,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        authTimeout: 20000,
        tlsOptions: { rejectUnauthorized: true, servername: 'imap.gmail.com' }
    }
};

// ---------- HELPERS ----------
function buildUpiLink(orderId, amount) {
    const am = Number(amount).toFixed(2);
    return `upi://pay?pa=${encodeURIComponent(BUSINESS_UPI)}&pn=${encodeURIComponent(PAYEE_NAME)}&am=${am}&tr=${encodeURIComponent(orderId)}&cu=INR`;
}

// QR images are pure functions of (orderId, amount) -> cache them (small LRU-ish map)
const qrCache = new Map();
async function getQr(orderId, amount) {
    const link = buildUpiLink(orderId, amount);
    if (qrCache.has(link)) return qrCache.get(link);
    const img = await QRCode.toDataURL(link, { margin: 1, width: 300 });
    qrCache.set(link, img);
    if (qrCache.size > 500) qrCache.delete(qrCache.keys().next().value);
    return img;
}

// Tiny in-memory rate limiter (per IP, per minute) for public endpoints
const hits = new Map();
function rateLimit(max, windowMs = 60000) {
    return (req, res, next) => {
        const k = req.ip + '|' + (req.route ? req.route.path : req.path);
        const now = Date.now();
        let h = hits.get(k);
        if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
        if (++h.n > max) return res.status(429).json({ success: false, message: 'Too many requests, slow down.' });
        next();
    };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 5 * 60 * 1000).unref();

// CSV cell escaping (commas/quotes/newlines + spreadsheet formula injection)
function csvCell(v) {
    let t = v === undefined || v === null ? '' : String(v);
    if (/^[=+\-@]/.test(t)) t = "'" + t;
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

// Keep-alive / ping statistics (shown on /ping.html)
const pingStats = { startedAt: Date.now(), selfPings: 0, selfOk: 0, lastSelfPing: null, lastSelfStatus: null, externalHits: 0, lastExternalHit: null };

// True only if the exact amount appears (15 must not match 150, 115, 0.15 or 1,500)
function amountMatches(text, amount) {
    const n = Number(amount);
    const forms = new Set([String(n), n.toFixed(2)]);
    for (const f of forms) {
        const escaped = f.replace(/\./g, '\\.');
        const re = new RegExp(`(?<!\\d)(?<!\\d[.,])${escaped}(?!\\.?\\d)`);
        if (re.test(text)) return true;
    }
    return false;
}

// ---------- security helpers ----------
const rid = n => crypto.randomBytes(n).toString('hex');
const newApiKey = () => 'tk_live_' + rid(24);
const sha256hex = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const safeEq = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return m ? isPrivateIp(m[1]) : false;
}
// Merchant-supplied webhook URLs must be public https URLs (stops the server being used to call internal addresses)
async function isSafeWebhookUrl(u) {
    try {
        const x = new URL(u);
        if (x.protocol !== 'https:' || x.username || x.password) return false;
        const host = x.hostname.replace(/^\[|\]$/g, '');
        if (net.isIP(host)) return !isPrivateIp(host);
        if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
        const addrs = await dns.lookup(host, { all: true });
        return addrs.length > 0 && addrs.every(a => !isPrivateIp(a.address));
    } catch (e) { return false; }
}
const validUrl = (u, httpsOnly) => { try { const x = new URL(u); return httpsOnly ? x.protocol === 'https:' : (x.protocol === 'https:' || x.protocol === 'http:'); } catch (e) { return false; } };

// Signed webhook call. Signature = HMAC-SHA256(key, `${timestamp}.${rawBody}`) in header x-signature (+ x-timestamp).
async function sendSigned(url, key, payload, { legacyKeyHeader = false, follow = true } = {}) {
    const body = JSON.stringify(payload);
    const ts = String(Date.now());
    const headers = { 'Content-Type': 'application/json', 'x-timestamp': ts, 'x-signature': crypto.createHmac('sha256', key).update(ts + '.' + body).digest('hex') };
    if (legacyKeyHeader) headers['x-api-key'] = key; // your own main site keeps the old header
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
        const r = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal, redirect: follow ? 'follow' : 'manual' });
        return { ok: r.ok, status: r.status };
    } catch (err) { return { ok: false, status: 0, error: err.message }; }
    finally { clearTimeout(timer); }
}

// Sends the SUCCESS webhook (to your main site, or to the merchant who owns the order).
// Retries a few times; marks webhookSent=true on a 2xx reply. Returns true when acknowledged.
async function notifySite(orderId, attempts = 3) {
    const p = await Payment.findOne({ orderId }).lean();
    if (!p) return false;
    let url = SITE_WEBHOOK_URL, key = API_SECRET_KEY, merchant = null;
    if (p.merchantId) {
        merchant = await Merchant.findById(p.merchantId).lean();
        url = merchant ? merchant.webhookUrl : '';
        key = merchant ? merchant.apiKey : '';
        if (!url) { await Payment.updateOne({ orderId }, { webhookSent: true }).catch(() => {}); return true; } // merchant has no webhook: nothing to send
        if (!(await isSafeWebhookUrl(url))) { console.error(`[Webhook] ${orderId}: merchant webhook URL rejected as unsafe`); return false; }
    }
    if (!url) return false;
    const payload = { event: 'payment.success', orderId, status: 'SUCCESS', amount: p.amount, paidAt: p.paidAt || null };
    for (let i = 1; i <= attempts; i++) {
        const r = await sendSigned(url, key, payload, { legacyKeyHeader: !merchant, follow: !merchant });
        console.log(`[Webhook] ${orderId} -> ${r.error ? 'error ' + r.error : 'site responded ' + r.status} (try ${i}/${attempts})`);
        if (r.ok) { await Payment.updateOne({ orderId }, { webhookSent: true }).catch(() => {}); return true; }
        if (i < attempts) await new Promise(res => setTimeout(res, 2000 * i));
    }
    return false;
}

// Safety net: SUCCESS orders whose webhook was never acknowledged are re-sent every minute (last 48h only).
async function resendMissedWebhooks() {
    if (mongoose.connection.readyState !== 1) return;
    try {
        const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
        const f = { status: 'SUCCESS', webhookSent: { $ne: true }, $or: [{ paidAt: { $gte: since } }, { paidAt: null, createdAt: { $gte: since } }] };
        if (!SITE_WEBHOOK_URL) f.merchantId = { $ne: null }; // no main-site webhook configured -> only merchant orders need sending
        const missed = await Payment.find(f).limit(20);
        for (const p of missed) await notifySite(p.orderId, 1);
    } catch (e) { console.error('[Webhook sweep] error:', e.message); }
}

// ---------- API ROUTES ----------

// 1. Create Payment (server-to-server, needs API key)
app.post('/api/create-payment', async (req, res) => {
    const clientApiKey = String(req.headers['x-api-key'] || '');
    if (!clientApiKey) return res.status(401).json({ success: false, message: 'Unauthorized API Key' });
    let merchant = null; // stays null for your own main site (uses API_SECRET_KEY)
    if (!safeEq(clientApiKey, API_SECRET_KEY)) {
        merchant = await Merchant.findOne({ apiKey: clientApiKey }).lean().catch(() => null);
        if (!merchant) return res.status(401).json({ success: false, message: 'Unauthorized API Key' });
        if (merchant.status !== 'APPROVED') return res.status(403).json({ success: false, message: 'Merchant account is not active (status: ' + merchant.status + ')' });
    }

    const orderId = typeof req.body.orderId === 'string' ? req.body.orderId.trim() : '';
    const amount = Number(req.body.amount);
    if (!/^[A-Za-z0-9_\-.:]{1,100}$/.test(orderId) || !Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
        return res.status(400).json({ success: false, message: 'Valid amount and orderId required' });
    }

    try {
        // $setOnInsert: an existing order keeps its original amount and status.
        // (Previously a repeat call could reset a SUCCESS order back to PENDING.)
        const payment = await Payment.findOneAndUpdate(
            { orderId },
            { $setOnInsert: (() => { const plan = merchant ? effPlan(merchant) : null; return { amount, status: 'PENDING', createdAt: new Date(), merchantId: merchant ? merchant._id : null, plan, fee: plan ? calcFee(plan, amount) : null }; })() },
            { upsert: true, new: true }
        );

        // an orderId already used by someone else must never leak that order's details
        if (String(payment.merchantId || '') !== String(merchant ? merchant._id : '')) {
            return res.status(409).json({ success: false, message: 'This orderId is already in use. Use a unique orderId.' });
        }
        const qrCodeUrl = await getQr(orderId, payment.amount);
        const checkoutUrl = `${req.protocol}://${req.get('host')}/index.html?orderId=${encodeURIComponent(orderId)}&amount=${payment.amount}`;

        res.json({ success: true, orderId, amount: payment.amount, status: payment.status, qrCodeUrl, checkoutUrl });
    } catch (error) {
        console.error('create-payment error:', error.message);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// 2. Order details for the checkout page (public, read-only; amount comes from DB, never from the URL)
app.get('/api/order/:orderId', rateLimit(60), async (req, res) => {
    try {
        const payment = await Payment.findOne({ orderId: req.params.orderId }).lean();
        if (!payment) return res.status(404).json({ success: false, message: 'Order not found' });

        const upiLink = buildUpiLink(payment.orderId, payment.amount);
        const qrCodeUrl = await getQr(payment.orderId, payment.amount);
        let merchantName = null, redirectHost = null;
        if (payment.merchantId) {
            const m = await Merchant.findById(payment.merchantId).select('name siteUrl').lean();
            if (m) { merchantName = m.name; try { redirectHost = new URL(m.siteUrl).hostname.replace(/^www\./, ''); } catch (e) {} }
        }
        res.json({ success: true, orderId: payment.orderId, amount: payment.amount, status: payment.status, qrCodeUrl, upiLink, merchantName, redirectHost });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error loading order' });
    }
});

// 3. Check Payment Status
app.get('/api/check-status/:orderId', rateLimit(40), async (req, res) => {
    const { orderId } = req.params;
    try {
        const payment = await Payment.findOne({ orderId });
        if (!payment) return res.status(404).json({ success: false, message: 'Order not found' });

        if (payment.status === 'PENDING') {
            await verifyAndUpdatePendingPayments();
            const updated = await Payment.findOne({ orderId });
            return res.json({ success: true, status: updated.status, amount: updated.amount, orderId: updated.orderId });
        }

        res.json({ success: true, status: payment.status, amount: payment.amount, orderId: payment.orderId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error checking status' });
    }
});

// ---------- ADMIN (password login -> 12h signed token) ----------
const sha = v => crypto.createHash('sha256').update(String(v)).digest();
const adminKey = sha('gw-admin:' + ADMIN_PASS);
const sign = exp => crypto.createHmac('sha256', adminKey).update(String(exp)).digest('hex');
function validToken(t) {
    const [exp, sig] = String(t || '').split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const a = Buffer.from(sig), b = Buffer.from(sign(exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function requireAdmin(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!ADMIN_PASS) return res.status(503).json({ success: false, message: 'ADMIN_SECRET_PASS is not set on the server' });
    if (!validToken((req.headers.authorization || '').replace('Bearer ', ''))) return res.status(401).json({ success: false, message: 'Unauthorized' });
    next();
}
const loginFails = {};
setInterval(() => { const now = Date.now(); for (const k in loginFails) if (loginFails[k].until < now && !loginFails[k].count) delete loginFails[k]; }, 30 * 60 * 1000).unref();
app.post('/api/admin/login', (req, res) => {
    if (!ADMIN_PASS) return res.status(503).json({ success: false, message: 'ADMIN_SECRET_PASS is not set on the server' });
    const f = loginFails[req.ip] || (loginFails[req.ip] = { count: 0, until: 0 });
    if (f.until > Date.now()) return res.status(429).json({ success: false, message: 'Too many attempts. Try again in 15 minutes.' });
    const ok = crypto.timingSafeEqual(sha(req.body.password || ''), sha(ADMIN_PASS));
    if (!ok) {
        if (++f.count >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
        return res.status(401).json({ success: false, message: 'Wrong password' });
    }
    delete loginFails[req.ip];
    const exp = Date.now() + 12 * 60 * 60 * 1000;
    res.json({ success: true, token: `${exp}.${sign(exp)}` });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const ist = new Date(Date.now() + 19800000);
        const today = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 19800000;
        const [byStatus, days, mstat] = await Promise.all([
            Payment.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
            Payment.aggregate([
                { $match: { status: 'SUCCESS', createdAt: { $gte: new Date(today - 6 * 864e5) } } },
                { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } }, amount: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]),
            Merchant.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
        ]);
        const merchants = {}; mstat.forEach(x => { merchants[x._id] = x.count; });
        const s = {}; byStatus.forEach(x => s[x._id] = x);
        const m = {}; days.forEach(d => m[d._id] = d);
        const series = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(today - i * 864e5 + 19800000).toISOString().slice(0, 10);
            series.push({ date: d, amount: m[d] ? m[d].amount : 0, count: m[d] ? m[d].count : 0 });
        }
        const g = k => s[k] || { count: 0, amount: 0 };
        res.json({ success: true, pendingPayouts: await Payout.countDocuments({ status: 'PENDING' }), pendingRefunds: await Refund.countDocuments({ status: 'PENDING' }), total: byStatus.reduce((a, x) => a + x.count, 0), ok: g('SUCCESS'), pending: g('PENDING'), failed: g('FAILED'), todayRevenue: series[6].amount, series, merchants });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

function orderFilter(q) {
    const f = {};
    if (['PENDING', 'SUCCESS', 'FAILED'].includes(q.status)) f.status = q.status;
    if (q.merchant === 'main') f.merchantId = null;
    else if (q.merchant && mongoose.isValidObjectId(q.merchant)) f.merchantId = q.merchant;
    if (q.q) f.orderId = { $regex: String(q.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    return f;
}
app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
    try {
        const page = Math.max(1, +req.query.page || 1), limit = Math.min(100, +req.query.limit || 15);
        const f = orderFilter(req.query);
        const [payments, total] = await Promise.all([
            Payment.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            Payment.countDocuments(f)
        ]);
        const ids = [...new Set(payments.filter(p => p.merchantId).map(p => String(p.merchantId)))];
        const ms = ids.length ? await Merchant.find({ _id: { $in: ids } }).select('name').lean() : [];
        const nm = {}; ms.forEach(m => { nm[m._id] = m.name; });
        payments.forEach(p => { p.merchantName = p.merchantId ? (nm[p.merchantId] || 'Unknown') : null; });
        res.json({ success: true, payments, total, page, pages: Math.ceil(total / limit) || 1 });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.get('/api/admin/export', requireAdmin, async (req, res) => {
  try {
    const rows = await Payment.find(orderFilter(req.query)).sort({ createdAt: -1 }).limit(5000).lean();
    const csv = ['orderId,amount,status,coins,telegramChatId,merchantId,createdAt,paidAt']
        .concat(rows.map(r => [r.orderId, r.amount, r.status, r.coins || '', r.telegramChatId || '', r.merchantId || '', r.createdAt ? r.createdAt.toISOString() : '', r.paidAt ? r.paidAt.toISOString() : ''].map(csvCell).join(','))).join('\n');
    res.set('Content-Type', 'text/csv').send(csv);
  } catch (e) { res.status(500).json({ success: false, message: 'Export failed' }); }
});
app.post('/api/admin/orders/:orderId/mark', requireAdmin, async (req, res) => {
    try {
        const status = req.body.status;
        if (!['SUCCESS', 'FAILED'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });
        const set = { status };
        if (status === 'SUCCESS') { set.paidAt = new Date(); set.webhookSent = false; }
        const p = await Payment.findOneAndUpdate({ orderId: req.params.orderId }, set, { new: true });
        if (!p) return res.status(404).json({ success: false, message: 'Order not found' });
        if (status === 'SUCCESS') notifySite(p.orderId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/admin/orders/:orderId/webhook', requireAdmin, async (req, res) => {
    try {
        const p = await Payment.findOne({ orderId: req.params.orderId });
        if (!p || p.status !== 'SUCCESS') return res.status(400).json({ success: false, message: 'Only SUCCESS orders can be re-sent' });
        const delivered = await notifySite(p.orderId);
        res.json({ success: true, webhookConfigured: !!SITE_WEBHOOK_URL, delivered });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/admin/recheck', requireAdmin, async (req, res) => {
    try {
        lastVerifyAt = 0;
        await verifyAndUpdatePendingPayments();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Recheck failed' }); }
});

// ---------- ADMIN: merchants (approve / reject / suspend) ----------
const maskKey = k => k ? k.slice(0, 8) + '…' + k.slice(-4) : null;
app.get('/api/admin/merchants', requireAdmin, async (req, res) => {
    try {
        const f = ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'].includes(req.query.status) ? { status: req.query.status } : {};
        const list = await Merchant.find(f).sort({ createdAt: -1 }).limit(500).lean();
        const agg = await Payment.aggregate([{ $match: { merchantId: { $ne: null } } }, { $group: { _id: { m: '$merchantId', s: '$status' }, count: { $sum: 1 }, amount: { $sum: '$amount' } } }]);
        const st = {};
        agg.forEach(a => { const k = String(a._id.m); st[k] = st[k] || { orders: 0, paid: 0, revenue: 0 }; st[k].orders += a.count; if (a._id.s === 'SUCCESS') { st[k].paid += a.count; st[k].revenue += a.amount; } });
        res.json({ success: true, merchants: list.map(m => ({ id: m._id, name: m.name, email: m.email, siteUrl: m.siteUrl, webhookUrl: m.webhookUrl, contact: m.contact, status: m.status, kycStatus: m.kycStatus || 'NONE', panNumber: m.panNumber || '', panName: m.panName || '', plan: effPlan(m), planExpiresAt: m.planExpiresAt, apiKey: maskKey(m.apiKey), createdAt: m.createdAt, approvedAt: m.approvedAt, ...(st[String(m._id)] || { orders: 0, paid: 0, revenue: 0 }) })) });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/admin/merchants/:id/status', requireAdmin, async (req, res) => {
    try {
        const status = req.body.status;
        if (!['APPROVED', 'REJECTED', 'SUSPENDED', 'PENDING'].includes(status) || !mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid request' });
        const m = await Merchant.findById(req.params.id);
        if (!m) return res.status(404).json({ success: false, message: 'Merchant not found' });
        if (status === 'APPROVED') {
            if (!m.panNumber || !(await KycDoc.exists({ merchantId: m._id }))) return res.status(400).json({ success: false, message: 'KYC missing: this merchant has not submitted a PAN number and PAN card image.' });
            m.kycStatus = 'VERIFIED'; m.kycNote = '';
        }
        if (status === 'REJECTED' && m.kycStatus !== 'VERIFIED') { m.kycStatus = 'REJECTED'; m.kycNote = String(req.body.note || '').trim().slice(0, 200); }
        m.status = status;
        if (status === 'APPROVED') { if (!m.apiKey) m.apiKey = newApiKey(); m.approvedAt = new Date(); }
        await m.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/admin/merchants/:id/reset-token', requireAdmin, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id' });
        const token = rid(16);
        const m = await Merchant.findByIdAndUpdate(req.params.id, { tokenHash: sha256hex(token) });
        if (!m) return res.status(404).json({ success: false, message: 'Merchant not found' });
        res.json({ success: true, token }); // shown once - pass it to the merchant
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.delete('/api/admin/merchants/:id', requireAdmin, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id' });
        if (await Payment.exists({ merchantId: req.params.id })) return res.status(400).json({ success: false, message: 'This merchant has orders. Suspend them instead of deleting.' });
        await Merchant.deleteOne({ _id: req.params.id });
        await KycDoc.deleteOne({ merchantId: req.params.id });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/admin/merchants/:id/kyc', requireAdmin, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id' });
        const [m, doc] = await Promise.all([Merchant.findById(req.params.id).lean(), KycDoc.findOne({ merchantId: req.params.id }).lean()]);
        if (!m) return res.status(404).json({ success: false, message: 'Merchant not found' });
        res.json({ success: true, panName: m.panName || '', panNumber: m.panNumber || '', kycStatus: m.kycStatus || 'NONE', image: doc ? doc.image : '' });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ---------- ADMIN: payouts (merchant requests -> admin pays -> enters UTR -> accept / reject) ----------
app.get('/api/admin/payouts', requireAdmin, async (req, res) => {
    try {
        const f = ['PENDING', 'PAID', 'REJECTED'].includes(req.query.status) ? { status: req.query.status } : {};
        const list = await Payout.find(f).sort({ createdAt: -1 }).limit(300).lean();
        const ms = await Merchant.find({ _id: { $in: [...new Set(list.map(p => String(p.merchantId)))] } }).select('name email').lean();
        const nm = {}; ms.forEach(m => { nm[m._id] = m; });
        res.json({ success: true, payouts: list.map(p => ({ ...p, merchantName: nm[p.merchantId] ? nm[p.merchantId].name : 'Unknown', merchantEmail: nm[p.merchantId] ? nm[p.merchantId].email : '' })) });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/admin/payouts/:id/accept', requireAdmin, async (req, res) => {
    try {
        const utr = String((req.body || {}).utr || '').trim().toUpperCase();
        if (!mongoose.isValidObjectId(req.params.id) || !/^[A-Z0-9]{6,30}$/.test(utr)) return res.status(400).json({ success: false, message: 'Enter a valid UTR number (6-30 letters/digits).' });
        const p = await Payout.findOneAndUpdate({ _id: req.params.id, status: 'PENDING' }, { status: 'PAID', utr, processedAt: new Date() }, { new: true });
        if (!p) return res.status(404).json({ success: false, message: 'Payout not found or already processed' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/admin/payouts/:id/reject', requireAdmin, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id' });
        const p = await Payout.findOneAndUpdate({ _id: req.params.id, status: 'PENDING' }, { status: 'REJECTED', note: String((req.body || {}).note || '').slice(0, 200), processedAt: new Date() }, { new: true });
        if (!p) return res.status(404).json({ success: false, message: 'Payout not found or already processed' });
        res.json({ success: true }); // rejected payouts no longer count against the balance, so the money returns automatically
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.get('/api/admin/refunds', requireAdmin, async (req, res) => {
    try {
        const f = ['PENDING', 'REFUNDED', 'REJECTED'].includes(req.query.status) ? { status: req.query.status } : {};
        const list = await Refund.find(f).sort({ createdAt: -1 }).limit(300).lean();
        const ms = await Merchant.find({ _id: { $in: [...new Set(list.map(p => String(p.merchantId)))] } }).select('name email').lean();
        const nm = {}; ms.forEach(m => { nm[m._id] = m; });
        res.json({ success: true, refunds: list.map(p => ({ ...p, merchantName: nm[p.merchantId] ? nm[p.merchantId].name : 'Unknown', merchantEmail: nm[p.merchantId] ? nm[p.merchantId].email : '' })) });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/admin/refunds/:id/accept', requireAdmin, async (req, res) => {
    try {
        const utr = String((req.body || {}).utr || '').trim().toUpperCase();
        if (!mongoose.isValidObjectId(req.params.id) || !/^[A-Z0-9]{6,30}$/.test(utr)) return res.status(400).json({ success: false, message: 'Enter a valid UTR / refund reference (6-30 letters/digits).' });
        const p = await Refund.findOneAndUpdate({ _id: req.params.id, status: 'PENDING' }, { status: 'REFUNDED', utr, processedAt: new Date() }, { new: true });
        if (!p) return res.status(404).json({ success: false, message: 'Refund not found or already processed' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/admin/refunds/:id/reject', requireAdmin, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id' });
        const p = await Refund.findOneAndUpdate({ _id: req.params.id, status: 'PENDING' }, { status: 'REJECTED', note: String((req.body || {}).note || '').slice(0, 200), processedAt: new Date() }, { new: true });
        if (!p) return res.status(404).json({ success: false, message: 'Refund not found or already processed' });
        res.json({ success: true }); // a rejected refund stops counting against the merchant balance
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/admin/merchants/:id/plan', requireAdmin, async (req, res) => {
    try {
        const plan = (req.body || {}).plan, days = Math.min(365, Math.max(1, Number((req.body || {}).days) || PLAN_DAYS));
        if (!['FREE', 'PAID'].includes(plan) || !mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid request' });
        const upd = plan === 'PAID' ? { plan, planExpiresAt: new Date(Date.now() + days * 864e5) } : { plan: 'FREE', planExpiresAt: null };
        const m = await Merchant.findByIdAndUpdate(req.params.id, upd);
        if (!m) return res.status(404).json({ success: false, message: 'Merchant not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ---------- MERCHANT PORTAL (register -> admin approves -> merchant gets an API key) ----------
const merchantKey = sha('gw-merchant:' + API_SECRET_KEY);
const signM = (id, exp) => crypto.createHmac('sha256', merchantKey).update(id + '.' + exp).digest('hex');
function requireMerchant(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const [id, exp, sig] = String((req.headers.authorization || '').replace('Bearer ', '')).split('.');
    if (!id || !exp || !sig || Number(exp) < Date.now() || !mongoose.isValidObjectId(id)) return res.status(401).json({ success: false, message: 'Please log in again' });
    const a = Buffer.from(sig), b = Buffer.from(signM(id, exp));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ success: false, message: 'Please log in again' });
    req.merchantId = id;
    next();
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

app.post('/api/merchant/register', rateLimit(5, 60 * 60 * 1000), async (req, res) => {
    try {
        const b = req.body || {};
        const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase();
        const siteUrl = String(b.siteUrl || '').trim(), webhookUrl = String(b.webhookUrl || '').trim(), contact = String(b.contact || '').trim().slice(0, 30);
        if (name.length < 2 || name.length > 80) return res.status(400).json({ success: false, message: 'Enter your business / site name (2-80 characters).' });
        if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
        if (!validUrl(siteUrl, false) || siteUrl.length > 200) return res.status(400).json({ success: false, message: 'Enter your website URL, e.g. https://yoursite.com' });
        if (webhookUrl && (webhookUrl.length > 300 || !(await isSafeWebhookUrl(webhookUrl)))) return res.status(400).json({ success: false, message: 'Webhook URL must be a public https:// address.' });
        const k = parseKyc(b);
        if (k.error) return res.status(400).json({ success: false, message: k.error });
        if (b.agree !== true) return res.status(400).json({ success: false, message: 'Confirm that the details are true and accept the terms to continue.' });
        if (await Merchant.exists({ panNumber: k.panNumber })) return res.status(409).json({ success: false, message: 'This PAN number is already registered. Contact the admin if this is your account.' });
        if (await Merchant.exists({ email })) return res.status(409).json({ success: false, message: 'This email is already registered. Use "Dashboard login", or ask the admin to reset your token.' });
        const token = rid(16);
        const mm = await Merchant.create({ name, email, siteUrl, webhookUrl, contact, panName: k.panName, panNumber: k.panNumber, kycStatus: 'SUBMITTED', tokenHash: sha256hex(token) });
        try { await KycDoc.create({ merchantId: mm._id, image: k.image }); } catch (e) { await Merchant.deleteOne({ _id: mm._id }); throw e; }
        res.json({ success: true, token, message: 'Registered. Save your login token now - it is shown only once.' });
    } catch (e) {
        if (e && e.code === 11000) return res.status(409).json({ success: false, message: 'This email is already registered.' });
        console.error('register error:', e.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});
app.post('/api/merchant/login', rateLimit(10, 15 * 60 * 1000), async (req, res) => {
    try {
        const email = String((req.body || {}).email || '').trim().toLowerCase(), token = String((req.body || {}).token || '').trim();
        const m = email && token ? await Merchant.findOne({ email }).lean() : null;
        if (!m || !m.tokenHash || !safeEq(sha256hex(token), m.tokenHash)) return res.status(401).json({ success: false, message: 'Wrong email or token' });
        const exp = Date.now() + 12 * 60 * 60 * 1000;
        res.json({ success: true, token: `${m._id}.${exp}.${signM(String(m._id), exp)}` });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.get('/api/merchant/me', requireMerchant, async (req, res) => {
    try {
        const m = await Merchant.findById(req.merchantId).lean();
        if (!m) return res.status(401).json({ success: false, message: 'Please log in again' });
        const [agg, recent] = await Promise.all([
            Payment.aggregate([{ $match: { merchantId: m._id } }, { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
            Payment.find({ merchantId: m._id }).sort({ createdAt: -1 }).limit(10).select('orderId amount status createdAt paidAt webhookSent fee').lean()
        ]);
        const [balance, payouts, refunds] = await Promise.all([getBalance(m), Payout.find({ merchantId: m._id }).sort({ createdAt: -1 }).limit(30).lean(), Refund.find({ merchantId: m._id }).sort({ createdAt: -1 }).limit(30).lean()]);
        const g = k => agg.find(x => x._id === k) || { count: 0, amount: 0 };
        res.json({ success: true, merchant: { name: m.name, email: m.email, siteUrl: m.siteUrl, webhookUrl: m.webhookUrl, status: m.status, createdAt: m.createdAt, planExpiresAt: m.planExpiresAt, kycStatus: m.kycStatus || 'NONE', kycNote: m.kycNote || '', panName: m.panName || '', panMasked: m.panNumber ? m.panNumber.slice(0, 3) + '*****' + m.panNumber.slice(-2) : '', apiKey: m.status === 'APPROVED' ? m.apiKey : null },
            plan: effPlan(m), balance, payouts, refunds, config: { plans: PLANS, settlementDays: SETTLEMENT_DAYS, minPayout: MIN_PAYOUT, planDays: PLAN_DAYS, refundPercent: REFUND_PERCENT },
            stats: { total: agg.reduce((a, x) => a + x.count, 0), paid: g('SUCCESS').count, pending: g('PENDING').count, revenue: g('SUCCESS').amount }, recent });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/merchant/kyc', requireMerchant, rateLimit(6, 60 * 60 * 1000), async (req, res) => {
    try {
        const m = await Merchant.findById(req.merchantId);
        if (!m) return res.status(401).json({ success: false, message: 'Please log in again' });
        if (m.kycStatus === 'VERIFIED') return res.status(400).json({ success: false, message: 'Your KYC is already verified.' });
        const k = parseKyc(req.body || {});
        if (k.error) return res.status(400).json({ success: false, message: k.error });
        if (await Merchant.exists({ panNumber: k.panNumber, _id: { $ne: m._id } })) return res.status(409).json({ success: false, message: 'This PAN number is already registered to another account.' });
        await KycDoc.findOneAndUpdate({ merchantId: m._id }, { image: k.image, updatedAt: new Date() }, { upsert: true });
        m.panName = k.panName; m.panNumber = k.panNumber; m.kycStatus = 'SUBMITTED'; m.kycNote = '';
        if (m.status === 'REJECTED') m.status = 'PENDING';
        await m.save();
        res.json({ success: true });
    } catch (e) { console.error('kyc error:', e.message); res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/merchant/webhook', requireMerchant, async (req, res) => {
    try {
        const url = String((req.body || {}).webhookUrl || '').trim();
        if (url && (url.length > 300 || !(await isSafeWebhookUrl(url)))) return res.status(400).json({ success: false, message: 'Webhook URL must be a public https:// address.' });
        await Merchant.updateOne({ _id: req.merchantId }, { webhookUrl: url });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/merchant/regenerate-key', requireMerchant, async (req, res) => {
    try {
        const m = await Merchant.findById(req.merchantId);
        if (!m || m.status !== 'APPROVED') return res.status(403).json({ success: false, message: 'Your account is not approved yet.' });
        m.apiKey = newApiKey(); await m.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/merchant/payout', requireMerchant, rateLimit(10), async (req, res) => {
    const id = req.merchantId;
    if (moneyLock.has(id)) return res.status(429).json({ success: false, message: 'Another request is in progress. Try again.' });
    moneyLock.add(id);
    try {
        const m = await Merchant.findById(id);
        if (!m || m.status !== 'APPROVED') return res.status(403).json({ success: false, message: 'Your account is not approved yet.' });
        const b = req.body || {}, method = String(b.method || '').toUpperCase(), amount = r2(Number(b.amount));
        if (!['NEFT', 'IMPS', 'UPI'].includes(method)) return res.status(400).json({ success: false, message: 'Choose a payout method.' });
        if (!Number.isFinite(amount) || amount < MIN_PAYOUT || amount > 1000000) return res.status(400).json({ success: false, message: `Minimum payout is ₹${MIN_PAYOUT}.` });
        const d = {};
        if (method === 'UPI') {
            d.upiId = String(b.upiId || '').trim();
            if (!/^[A-Za-z0-9._-]{2,60}@[A-Za-z]{2,30}$/.test(d.upiId)) return res.status(400).json({ success: false, message: 'Enter a valid UPI ID, e.g. name@bank.' });
        } else {
            d.accountName = String(b.accountName || '').trim().slice(0, 80);
            d.accountNumber = String(b.accountNumber || '').replace(/\s/g, '');
            d.ifsc = String(b.ifsc || '').trim().toUpperCase();
            if (d.accountName.length < 2) return res.status(400).json({ success: false, message: 'Enter the account holder name.' });
            if (!/^\d{9,18}$/.test(d.accountNumber)) return res.status(400).json({ success: false, message: 'Account number must be 9-18 digits.' });
            if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(d.ifsc)) return res.status(400).json({ success: false, message: 'Enter a valid IFSC code, e.g. SBIN0001234.' });
        }
        const bal = await getBalance(m);
        if (amount > bal.available) return res.status(400).json({ success: false, message: `Only ₹${bal.available} is available to withdraw right now.` });
        const fee = r2(amount * PLANS[effPlan(m)].payoutRates[method] / 100);
        await Payout.create({ merchantId: m._id, amount, method, fee, payable: r2(amount - fee), ...d });
        res.json({ success: true });
    } catch (e) { console.error('payout error:', e.message); res.status(500).json({ success: false, message: 'Server error' }); }
    finally { moneyLock.delete(id); }
});
app.post('/api/merchant/refund', requireMerchant, rateLimit(20), async (req, res) => {
    const id = req.merchantId;
    if (moneyLock.has(id)) return res.status(429).json({ success: false, message: 'Another request is in progress. Try again.' });
    moneyLock.add(id);
    try {
        const m = await Merchant.findById(id);
        if (!m || m.status !== 'APPROVED') return res.status(403).json({ success: false, message: 'Your account is not approved yet.' });
        const b = req.body || {}, orderId = String(b.orderId || '').trim();
        const order = /^[A-Za-z0-9_\-.:]{1,100}$/.test(orderId) ? await Payment.findOne({ orderId, merchantId: m._id }).lean() : null;
        if (!order) return res.status(404).json({ success: false, message: 'Order not found in your account.' });
        if (order.status !== 'SUCCESS') return res.status(400).json({ success: false, message: 'Only paid orders can be refunded.' });
        const used = await Refund.find({ orderId, merchantId: m._id, status: { $in: ['PENDING', 'REFUNDED'] } }).select('amount').lean();
        const remaining = r2(order.amount - used.reduce((a, x) => a + x.amount, 0));
        if (remaining <= 0) return res.status(400).json({ success: false, message: 'This order is already fully refunded (or a refund is pending).' });
        const amount = b.amount === undefined || b.amount === '' ? remaining : r2(Number(b.amount));
        if (!Number.isFinite(amount) || amount < 1 || amount > remaining) return res.status(400).json({ success: false, message: `Refund amount must be between ₹1 and ₹${remaining}.` });
        const reason = String(b.reason || '').trim().slice(0, 200);
        if (reason.length < 3) return res.status(400).json({ success: false, message: 'Enter a reason for the refund.' });
        const customerUpi = String(b.customerUpi || '').trim();
        if (customerUpi && !/^[A-Za-z0-9._-]{2,60}@[A-Za-z]{2,30}$/.test(customerUpi)) return res.status(400).json({ success: false, message: 'Customer UPI ID looks wrong. Leave it empty or use name@bank.' });
        const charge = r2(amount * REFUND_PERCENT / 100), deduct = r2(amount + charge);
        const bal = await getBalance(m);
        if (bal.available < charge) return res.status(400).json({ success: false, message: `The refund charge (₹${charge}) is cut from your available balance, which is ₹${bal.available}.` });
        if (bal.available + bal.pending < deduct) return res.status(400).json({ success: false, message: `Your balance (₹${r2(bal.available + bal.pending)}) is too low to cover this refund and its charge (₹${deduct}).` });
        await Refund.create({ merchantId: m._id, orderId, amount, charge, deduct, reason, customerUpi });
        res.json({ success: true });
    } catch (e) { console.error('refund error:', e.message); res.status(500).json({ success: false, message: 'Server error' }); }
    finally { moneyLock.delete(id); }
});
app.post('/api/merchant/upgrade', requireMerchant, async (req, res) => {
    const id = req.merchantId;
    if (moneyLock.has(id)) return res.status(429).json({ success: false, message: 'Another request is in progress. Try again.' });
    moneyLock.add(id);
    try {
        const m = await Merchant.findById(id);
        if (!m || m.status !== 'APPROVED') return res.status(403).json({ success: false, message: 'Your account is not approved yet.' });
        const price = PLANS.PAID.monthly, bal = await getBalance(m);
        if (bal.available < price) return res.status(400).json({ success: false, message: `You need ₹${price} available balance to buy the Pro plan (you have ₹${bal.available}). Or ask the admin to activate it.` });
        const base = effPlan(m) === 'PAID' ? new Date(m.planExpiresAt).getTime() : Date.now();
        m.plan = 'PAID'; m.planExpiresAt = new Date(base + PLAN_DAYS * 864e5); m.subscriptionPaid = (m.subscriptionPaid || 0) + price;
        await m.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
    finally { moneyLock.delete(id); }
});
app.post('/api/merchant/test-webhook', requireMerchant, rateLimit(6), async (req, res) => {
    try {
        const m = await Merchant.findById(req.merchantId).lean();
        if (!m || m.status !== 'APPROVED') return res.status(403).json({ success: false, message: 'Your account is not approved yet.' });
        if (!m.webhookUrl) return res.status(400).json({ success: false, message: 'Save a webhook URL first.' });
        if (!(await isSafeWebhookUrl(m.webhookUrl))) return res.status(400).json({ success: false, message: 'Webhook URL must be a public https:// address.' });
        const r = await sendSigned(m.webhookUrl, m.apiKey, { event: 'webhook.test', orderId: 'TEST_ORDER', status: 'TEST', amount: 1, paidAt: new Date() }, { follow: false });
        res.json({ success: true, delivered: r.ok, httpStatus: r.status, error: r.error || null });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// Public, very light: used by the self-ping, the /ping.html page and external pingers (UptimeRobot, cron-job.org)
app.get('/healthz', (req, res) => {
    if (req.headers['user-agent'] !== 'self-ping') { pingStats.externalHits++; pingStats.lastExternalHit = Date.now(); }
    res.set('Cache-Control', 'no-store').send('ok');
});
app.get('/api/ping', (req, res) => {
    if (req.headers['user-agent'] !== 'self-ping') { pingStats.externalHits++; pingStats.lastExternalHit = Date.now(); }
    res.set('Cache-Control', 'no-store').json({
        success: true,
        time: Date.now(),
        uptimeSec: Math.round(process.uptime()),
        db: mongoose.connection.readyState === 1,
        keepAlive: process.env.KEEP_ALIVE !== 'false',
        selfPings: pingStats.selfPings,
        selfOk: pingStats.selfOk,
        lastSelfPing: pingStats.lastSelfPing,
        lastSelfStatus: pingStats.lastSelfStatus,
        externalHits: pingStats.externalHits,
        lastExternalHit: pingStats.lastExternalHit
    });
});

app.get('/api/admin/health', requireAdmin, async (req, res) => {
    const dbStatus = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected';
    let imapStatus = 'Connected', imapError = null, connection;
    try {
        connection = await imap.connect(imapConfig);
        await connection.openBox('INBOX');
        connection.end();
    } catch (err) {
        imapStatus = 'Disconnected / Auth Error';
        imapError = err.message;
        if (connection) { try { connection.end(); } catch (e) {} }
    }
    res.json({ success: true, database: dbStatus, gmailImap: imapStatus, errorDetails: imapError, webhook: !!SITE_WEBHOOK_URL, uptimeMin: Math.round(process.uptime() / 60) });
});

// ---------- CORE: match Paytm emails to pending orders ----------
// Only one mailbox scan runs at a time (many open checkout pages used to open
// many parallel Gmail connections), and scans are spaced at least 5s apart.
let verifyPromise = null;
let lastVerifyAt = 0;

function verifyAndUpdatePendingPayments() {
    if (verifyPromise) return verifyPromise;
    if (Date.now() - lastVerifyAt < 5000) return Promise.resolve();
    verifyPromise = runVerify().finally(() => {
        lastVerifyAt = Date.now();
        verifyPromise = null;
    });
    return verifyPromise;
}

// The real sender address must be @paytm.com (or a paytm.com subdomain). The display name can be faked, so it is ignored.
// Gmail writes its own SPF/DKIM/DMARC verdict into Authentication-Results: a mail that explicitly failed is rejected.
function isGenuinePaytmMail(mail) {
    try {
        const addr = String(mail && mail.from && mail.from.value && mail.from.value[0] && mail.from.value[0].address || '').toLowerCase();
        const domain = addr.split('@')[1] || '';
        if (!(domain === 'paytm.com' || domain.endsWith('.paytm.com'))) return false;
        const auth = String((mail.headers && mail.headers.get && mail.headers.get('authentication-results')) || '').toLowerCase();
        if (/\b(spf|dkim|dmarc)=fail\b/.test(auth)) return false;
        return true;
    } catch (e) { return false; }
}

async function runVerify() {
    let connection;
    try {
        const cutoff = new Date(Date.now() - PENDING_WINDOW_HOURS * 60 * 60 * 1000);
        const imapSince = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000); // IMAP SINCE has day granularity
        const pendingPayments = await Payment.find({ status: 'PENDING', createdAt: { $gte: cutoff } }).lean();
        if (pendingPayments.length === 0) return;

        connection = await imap.connect(imapConfig);
        await connection.openBox('INBOX');

        for (const payment of pendingPayments) {
            let messages = [];
            try {
                messages = await connection.search([['SINCE', imapSince], ['TEXT', payment.orderId]], { bodies: [''], markSeen: true });
            } catch (err) {
                continue;
            }
            if (!messages || messages.length === 0) continue;

            for (const item of messages) {
                let rawData = '';
                for (const part of item.parts) {
                    if (part.body) rawData += part.body;
                }

                const mail = await simpleParser(rawData);
                const bodyText = (mail.text || mail.html || '').toLowerCase();
                if (isGenuinePaytmMail(mail) && amountMatches(bodyText, payment.amount)) {
                    // Atomic PENDING -> SUCCESS; returns null if something else already did it
                    const done = await Payment.findOneAndUpdate(
                        { orderId: payment.orderId, status: 'PENDING' },
                        { status: 'SUCCESS', paidAt: new Date() },
                        { new: true }
                    );
                    if (done) {
                        console.log(`[Payment Verified] Order ID: ${payment.orderId} marked as SUCCESS.`);
                        notifySite(payment.orderId);
                    }
                    break;
                }
            }
        }
    } catch (err) {
        console.error('IMAP Error:', err.message);
    } finally {
        if (connection) { try { connection.end(); } catch (e) {} }
    }
}

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    startKeepAlive({
        port: PORT,
        path: '/healthz',
        onResult: (status) => {
            pingStats.selfPings++;
            pingStats.lastSelfPing = Date.now();
            pingStats.lastSelfStatus = status;
            if (typeof status === 'number' && status < 400) pingStats.selfOk++;
        }
    });
});

setInterval(() => { verifyAndUpdatePendingPayments().catch(() => {}); }, 15000);
setInterval(() => { resendMissedWebhooks(); }, 60 * 1000);
