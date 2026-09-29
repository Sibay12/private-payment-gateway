const express = require('express');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const imap = require('imap-simple');
const { simpleParser } = require('mailparser');
const path = require('path');
const http = require('http');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB Connection
const MONGO_URI = 'mongodb+srv://sibadityapal47_db_user:G95Dds7IGyBQNmGh@cluster0.yjvazin.mongodb.net/jpw_bot?retryWrites=true&w=majority';
mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log('MongoDB Connected Successfully')).catch(err => console.log('DB Connection Error:', err));

// Payment Schema
const paymentSchema = new mongoose.Schema({
    orderId: { type: String, unique: true, required: true },
    amount: { type: Number, required: true },
    status: { type: String, default: 'PENDING' },
    createdAt: { type: Date, default: Date.now }
});
const Payment = mongoose.model('Payment', paymentSchema);

const BUSINESS_UPI = 'paytm.s2ujlw0@pty';
const API_SECRET_KEY = 'sibaditya_secure_api_key_2026';

// IMAP Config (Updated with your App Password & secure TLS settings)
const imapConfig = {
    imap: {
        user: 'sibadityapal7@gmail.com',
        password: 'qkrxjnnmwzynsjvo', // आपका नया ऐप पासवर्ड (बिना स्पेस के)
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        authTimeout: 20000,
        tlsOptions: { 
            rejectUnauthorized: false,
            servername: 'imap.gmail.com'
        }
    }
};

// --- API ROUTES ---

// 1. Create Payment API
app.post('/api/create-payment', async (req, res) => {
    const clientApiKey = req.headers['x-api-key'] || req.query.apiKey;
    if (!clientApiKey || clientApiKey !== API_SECRET_KEY) {
        return res.status(401).json({ success: false, message: 'Unauthorized API Key' });
    }

    const { amount, orderId } = req.body;
    if (!amount || !orderId) {
        return res.status(400).json({ success: false, message: 'Amount and orderId required' });
    }

    try {
        await Payment.findOneAndUpdate(
            { orderId },
            { amount, status: 'PENDING' },
            { upsert: true, new: true }
        );

        const upiString = `upi://pay?pa=${BUSINESS_UPI}&pn=TelegramBotGateway&am=${amount}&tr=${orderId}&cu=INR`;
        const qrCodeUrl = await QRCode.toDataURL(upiString);
        const checkoutUrl = `${req.protocol}://${req.get('host')}/index.html?orderId=${orderId}&amount=${amount}`;

        res.json({ success: true, orderId, amount, qrCodeUrl, checkoutUrl });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// 2. Check Payment Status API (IMAP Email Scanner)
app.get('/api/check-status/:orderId', async (req, res) => {
    const { orderId } = req.params;
    try {
        const payment = await Payment.findOne({ orderId });
        if (!payment) return res.status(404).json({ success: false, message: 'Order not found' });

        if (payment.status === 'PENDING') {
            const isPaid = await checkPaytmEmail(payment.amount, payment.orderId);
            if (isPaid) {
                payment.status = 'SUCCESS';
                await payment.save();
            }
        }

        res.json({ success: true, status: payment.status, amount: payment.amount, orderId: payment.orderId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error checking status' });
    }
});

// 3. Admin Transactions API
app.get('/api/admin/transactions', async (req, res) => {
    try {
        const payments = await Payment.find().sort({ createdAt: -1 }).limit(50);
        res.json({ success: true, payments });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 4. System Health & Connection Status API
app.get('/api/admin/health', async (req, res) => {
    let dbStatus = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected';
    let imapStatus = 'Connected & Working';
    let imapError = null;

    let connection;
    try {
        connection = await imap.connect(imapConfig);
        await connection.openBox('INBOX');
        if (connection) connection.end();
    } catch (err) {
        imapStatus = 'Failed / Authentication Error';
        imapError = err.message;
        if (connection) {
            try { connection.end(); } catch(e) {}
        }
    }

    res.json({
        success: true,
        database: dbStatus,
        gmailImap: imapStatus,
        errorDetails: imapError,
        timestamp: new Date().toLocaleString()
    });
});

// --- OPTIMIZED IMAP GMAIL VERIFICATION FUNCTION (Memory Safe) ---
async function checkPaytmEmail(targetAmount, orderId) {
    let connection;
    try {
        connection = await imap.connect(imapConfig);
        await connection.openBox('INBOX');

        // केवल Paytm विषय वाले ईमेल खोजें ताकि मेमोरी ओवरलोड न हो
        const searchCriteria = [['SUBJECT', 'Paytm']];
        const fetchOptions = { bodies: ['TEXT'], markSeen: false }; 
        const messages = await connection.search(searchCriteria, fetchOptions);

        // केवल आखिरी के 5 सबसे नए ईमेल चेक करें (मेमोरी बचाने के लिए)
        const recentMessages = messages.slice(-5);

        for (const item of recentMessages) {
            const allParts = imap.findParts(item.parts, 'TEXT');
            for (const part of allParts) {
                const mail = await simpleParser(item.parts[part.bodyID]);
                const bodyText = (mail.text || mail.html || '').toLowerCase();
                const subjectText = (mail.subject || '').toLowerCase();

                const cleanAmount = targetAmount.toString().trim();
                const cleanOrderId = orderId.toString().toLowerCase().trim();

                // पीडीएफ के अनुसार अमाउंट और आर्डर आईडी की पुष्टि
                if ((bodyText.includes(cleanAmount) || subjectText.includes(cleanAmount)) && 
                    bodyText.includes(cleanOrderId)) {
                    
                    if (connection) {
                        try { connection.end(); } catch(e) {}
                    }
                    return true;
                }
            }
        }

        if (connection) {
            try { connection.end(); } catch(e) {}
        }
        return false;
    } catch (err) {
        console.error('IMAP Error:', err.message);
        if (connection) {
            try { connection.end(); } catch(e) {}
        }
        return false;
    }
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    startAntiSleepPing(PORT);
});

// --- ANTI-SLEEP / AUTO-PING SYSTEM ---
function startAntiSleepPing(port) {
    const INTERVAL_TIME = 4 * 60 * 1000; // हर 4 मिनट में खुद को पिंग करेगा
    
    setInterval(() => {
        const url = `http://127.0.0.1:${port}/api/admin/health`;
        http.get(url, (res) => {
            console.log(`[Anti-Sleep] Self-ping status: ${res.statusCode} at ${new Date().toLocaleTimeString()}`);
        }).on('error', (err) => {
            console.error('[Anti-Sleep] Ping error:', err.message);
        });
    }, INTERVAL_TIME);
}
