// Dynamic, self-healing anti-sleep pinger (Render free tier).
//
// - Public URL is detected automatically (no manual setting needed):
//     KEEP_ALIVE_URL > RENDER_EXTERNAL_URL > RENDER_EXTERNAL_HOSTNAME > SERVER_PUBLIC_URL
//     > the host seen on the very first real incoming request (learned at runtime)
// - Never stops: uses a self-rescheduling timer (one failed ping can't kill it), every tick is
//   wrapped in try/catch, and a watchdog restarts the loop if it ever stalls.
// - Failed ping -> quick retry (30s) instead of waiting a full interval.
// - Works for any app: pass the health path and an optional onResult callback.
//
// Env (all optional): KEEP_ALIVE=false to disable, KEEP_ALIVE_URL, PING_INTERVAL_MIN (1-14, default 5)
const http = require('http');
const https = require('https');

const state = { learnedBase: null, timer: null, watchdog: null, lastTickAt: 0, started: false };

function isLocalHost(host) {
    const h = String(host || '').split(':')[0].toLowerCase();
    return !h || h === 'localhost' || h === '0.0.0.0' || h === '127.0.0.1' || h === '::1'
        || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

// Express middleware: learns the public URL from the first real request (works with any host).
function keepAliveMiddleware(req, res, next) {
    try {
        if (!state.learnedBase) {
            const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
            if (host && !isLocalHost(host)) {
                const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
                state.learnedBase = `${proto}://${host}`;
            }
        }
    } catch (e) { /* never break a request */ }
    next();
}

function resolveBase() {
    const clean = (u) => String(u || '').trim().replace(/\/+$/, '');
    if (process.env.KEEP_ALIVE_URL) return clean(process.env.KEEP_ALIVE_URL);
    if (process.env.PUBLIC_URL) return clean(process.env.PUBLIC_URL);
    if (process.env.RENDER_EXTERNAL_URL) return clean(process.env.RENDER_EXTERNAL_URL);
    if (process.env.RENDER_EXTERNAL_HOSTNAME) return `https://${clean(process.env.RENDER_EXTERNAL_HOSTNAME)}`;
    if (process.env.SERVER_PUBLIC_URL) return clean(process.env.SERVER_PUBLIC_URL);
    return state.learnedBase || null;
}

function ping(url, timeoutMs = 20000) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        try {
            const client = url.startsWith('https') ? https : http;
            const req = client.get(url, { headers: { 'user-agent': 'self-ping', 'cache-control': 'no-cache' } }, (res) => {
                res.resume();
                finish(res.statusCode);
            });
            req.setTimeout(timeoutMs, () => { req.destroy(); finish('error: timeout'); });
            req.on('error', (err) => finish('error: ' + (err.code || err.message)));
        } catch (e) { finish('error: ' + e.message); }
    });
}

/**
 * @param {object} opts
 * @param {number|string} opts.port         local port (fallback target when no public URL is known yet)
 * @param {string}        [opts.path]       health path, default '/health'
 * @param {function}      [opts.log]        logger(tag, msg)
 * @param {function}      [opts.onResult]   called with (status, url) after every ping
 */
function startKeepAlive(opts = {}) {
    const port = opts.port || process.env.PORT || 3000;
    const path = opts.path || '/health';
    const log = opts.log || ((tag, msg) => console.log(`[${tag}] ${msg}`));
    const onResult = typeof opts.onResult === 'function' ? opts.onResult : () => {};

    if (process.env.KEEP_ALIVE === 'false') { log('KeepAlive', 'Disabled via KEEP_ALIVE=false'); return; }
    if (state.started) return; // already running
    state.started = true;

    const mins = Math.min(14, Math.max(1, Number(process.env.PING_INTERVAL_MIN) || 5));
    const INTERVAL = mins * 60 * 1000;
    const RETRY = 30 * 1000;
    let lastTarget = null;

    const schedule = (ms) => {
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(tick, ms); // NOT unref'd on purpose: the loop must never die
    };

    const tick = async () => {
        state.lastTickAt = Date.now();
        let nextIn = INTERVAL;
        try {
            const base = resolveBase();
            const target = base ? `${base}${path}` : `http://127.0.0.1:${port}${path}`;
            if (target !== lastTarget) {
                log('KeepAlive', base ? `Target: ${target} every ${mins} min` : `No public URL yet - pinging localhost; will switch automatically on the first real request`);
                lastTarget = target;
            }
            const status = await ping(target);
            try { onResult(status, target); } catch (e) { /* ignore */ }
            const ok = typeof status === 'number' && status < 400;
            if (!ok) nextIn = RETRY; // retry quickly after a failure
            log('KeepAlive', `Ping ${target} -> ${status}${ok ? '' : ' (retry in 30s)'}`);
            // Learned URL is only a hint: if we only reached localhost, retry sooner to pick up the public URL
            if (!base) nextIn = Math.min(nextIn, 60 * 1000);
        } catch (e) {
            nextIn = RETRY;
            log('KeepAlive', `tick error: ${e && e.message}`);
        } finally {
            schedule(nextIn); // always re-arm, whatever happened
        }
    };

    // Watchdog: if the loop hasn't ticked for 3 intervals, restart it.
    state.watchdog = setInterval(() => {
        if (Date.now() - state.lastTickAt > INTERVAL * 3) {
            log('KeepAlive', 'Watchdog: loop stalled, restarting');
            schedule(1000);
        }
    }, 60 * 1000);

    state.lastTickAt = Date.now();
    schedule(Number(process.env.KA_FIRST_MS) || 15 * 1000); // first ping shortly after boot
    log('KeepAlive', `✅ Started (interval ${mins} min, path ${path})`);
}

// Public https address of this service (null until known). Handy for building links dynamically.
function getPublicBase() { return resolveBase(); }

module.exports = { startKeepAlive, keepAliveMiddleware, getPublicBase };
