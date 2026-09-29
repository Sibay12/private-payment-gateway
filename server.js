const express = require('express');
const QRCode = require('qrcode');
const Imap = require('imap-simple');
const mongoose = require('mongoose');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ⚙️ Configurations (Hard-coded as requested)
const MERCHANT_UPI_ID = "paytm.s2ujlw0@pty"; 
const MERCHANT_NAME = "Private Gateway";

// Hard-coded MongoDB Connection URI
const MONGO_URI = "mongodb+srv://sibadityapal47_db_user:G95Dds7IGyBQNmGh@cluster0.yjvazin.mongodb.net/jpw_bot?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
    .then(() => console.log("Connected to MongoDB successfully!"))
    .catch(err => console.error("MongoDB connection error:", err));

// Database Schemas
const transactionSchema = new mongoose.Schema({
    order_id: { type: String, unique: true, required: true },
    amount: { type: Number, required: true },
    status: { type: String, default: "PENDING" }, // PENDING or SUCCESS
    webhook_url: { type: String, default: "N/A" },
    created_at: { type: String }
});

const webhookSchema = new mongoose.Schema({
    order_id: String,
    amount: Number,
    status: String,
    time: String
});

const Transaction = mongoose.model('Transaction', transactionSchema);
const WebhookLog = mongoose.model('WebhookLog', webhookSchema);

// 1. API: Create Payment & Generate Dynamic QR
app.post('/api/create-payment', async (req, res) => {
    try {
        const { amount, order_id, webhook_url } = req.body;
        if (!amount || !order_id) {
            return res.status(400).json({ error: "Amount and order_id are required!" });
        }

        const upiString = `upi://pay?pa=${MERCHANT_UPI_ID}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${amount}&cu=INR&tn=${order_id}`;
        const qrImageBase64 = await QRCode.toDataURL(upiString);

        await Transaction.findOneAndUpdate(
            { order_id },
            { 
                amount, 
                status: "PENDING", 
                webhook_url: webhook_url || "N/A",
                created_at: new Date().toLocaleString()
            },
            { upsert: true, new: true }
        );

        res.json({
            status: "success",
            order_id,
            amount,
            qr_image: qrImageBase64,
            checkout_url: `/checkout.html?order_id=${order_id}&amount=${amount}`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. API: Verify Payment via Email
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { amount, order_id } = req.body;
        const tx = await Transaction.findOne({ order_id });

        if (!tx) {
            return res.status(404).json({ status: "NOT_FOUND", message: "Order ID not found." });
        }

        if (tx.status === "SUCCESS") {
            return res.json({ status: "SUCCESS", message: "Payment already verified." });
        }

        const isPaid = await checkPaytmEmail(amount, order_id);

        if (isPaid) {
            tx.status = "SUCCESS";
            await tx.save();

            await WebhookLog.create({
                order_id,
                amount,
                status: "SUCCESS",
                time: new Date().toLocaleString()
            });

            return res.json({ status: "SUCCESS", message: "Payment verified successfully!" });
        } else {
            return res.json({ status: "PENDING", message: "Payment confirmation email not found yet." });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. API for Admin Dashboard Stats
app.get('/api/admin/stats', async (req, res) => {
    try {
        const transactions = await Transaction.find().sort({ _id: -1 }).limit(50);
        const webhooks = await WebhookLog.find().sort({ _id: -1 }).limit(50);
        
        const total = await Transaction.countDocuments();
        const success = await Transaction.countDocuments({ status: "SUCCESS" });
        const pending = total - success;

        res.json({ total, success, pending, transactions, webhooks });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// IMAP Email Verification Function
async function checkPaytmEmail(targetAmount, orderId) {
    const config = {
        imap: {
            user: 'sibadityapal7@gmail.com',         // Your Gmail
            password: 'your-16-digit-app-password', // Google App Password
            host: 'imap.gmail.com',
            port: 993,
            tls: true,
            authTimeout: 10000
        }
    };

    try {
        const connection = await Imap.connect(config);
        await connection.openBox('INBOX');

        const searchCriteria = [
            'UNSEEN', 
            ['FROM', 'no-reply@paytm.com'],
            ['BODY', targetAmount.toString()]
        ];
        
        const fetchOptions = { bodies: ['TEXT'], markSeen: false }; 
        const messages = await connection.search(searchCriteria, fetchOptions);
        connection.end();

        if (messages.length > 0) {
            for (let item of messages) {
                const emailBody = item.parts[0].body;
                if (emailBody.includes(orderId) && emailBody.includes(targetAmount.toString())) {
                    return true; 
                }
            }
        }
        return false;
    } catch (err) {
        console.error("IMAP Error:", err);
        return false;
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Gateway running on port ${PORT}`);
});
