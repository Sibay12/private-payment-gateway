const express = require('express');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const imap = require('imap-simple');
const { simpleParser } = require('mailparser');
const path = require('path');

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
    status: { type: String, default: 'PENDING' }, // PENDING, SUCCESS
    createdAt: { type: Date, default: Date.now }
});
const Payment = mongoose.model('Payment', paymentSchema);

// Business Details & API Secret Key
const BUSINESS_UPI = 'paytm.s2ujlw0@pty';
const API_SECRET_KEY = 'sibaditya_secure_api_key_2026'; // इसे अपनी मर्जी से बदल भी सकते हैं

// --- API ROUTES ---

// 1. Create Payment API (Telegram Bot & Other Sites will call this)
app.post('/api/create-payment', async (req, res) => {
    const clientApiKey = req.headers['x-api-key'] || req.query.apiKey;
    if (!clientApiKey || clientApiKey !== API_SECRET_KEY) {
        return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or missing API Key' });
    }

    const { amount, orderId } = req.body;
    if (!amount || !orderId) {
        return res.status(400).json({ success: false, message: 'Amount and orderId are required' });
    }

    try {
        await Payment.findOneAndUpdate(
            { orderId },
            { amount, status: 'PENDING' },
            { upsert: true, new: true }
        );

        const upiString = `upi://pay?pa=${BUSINESS_UPI}&pn=TelegramBotGateway&am=${amount}&tr=${orderId}&cu=INR`;
        const qrCodeUrl = await QRCode.toDataURL(upiString);
        
        // Checkout page URL for direct user redirection if needed
        const checkoutUrl = `${req.protocol}://${req.get('host')}/index.html?orderId=${orderId}&amount=${amount}`;

        res.json({ success: true, orderId, amount, qrCodeUrl, checkoutUrl });
    } catch (error) {
        console.error('Create Payment Error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// 2. Check Payment Status API (For Polling by Telegram Bot or Checkout Page)
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
        console.error('Status Check Error:', error);
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

// --- IMAP GMAIL VERIFICATION FUNCTION ---
async function checkPaytmEmail(targetAmount, orderId) {
    const config = {
        imap: {
            user: 'sibadityapal7@gmail.com',
            password: 'tvlxcmlwcrweghaf', // आपका जीमेल ऐप पासवर्ड
            host: 'imap.gmail.com',
            port: 993,
            tls: true,
            authTimeout: 10000
        }
    };

    try {
        const connection = await imap.connect(config);
        await connection.openBox('INBOX');

        const searchCriteria = ['UNSEEN', ['SUBJECT', 'Paytm']];
        const fetchOptions = { bodies: [''], markSeen: true };
        const messages = await connection.search(searchCriteria, fetchOptions);

        for (const item of messages) {
            const allParts = imap.findParts(item.parts, 'BODY');
            for (const part of allParts) {
                const mail = await simpleParser(item.parts[part.bodyID]);
                const bodyText = mail.text || mail.html || '';

                if (bodyText.includes(targetAmount.toString()) && bodyText.includes(orderId)) {
                    connection.end();
                    return true;
                }
            }
        }
        connection.end();
        return false;
    } catch (err) {
        console.error('IMAP Error:', err);
        return false;
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
