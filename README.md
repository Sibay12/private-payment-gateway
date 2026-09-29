# Private UPI Payment Gateway with MongoDB

A fully automated, free custom payment gateway with Dynamic QR Generation, Email Verification (via Paytm alerts), MongoDB Database integration, and an Admin Dashboard.

## Features
- **Dynamic QR Generation**: Generates locked amount UPI QR codes instantly.
- **Email Verification**: Automatically parses incoming Paytm confirmation emails to verify transactions.
- **Database Storage**: Uses MongoDB Atlas (`jpw_bot` database) for permanent transaction and webhook logging.
- **Admin Panel**: Monitor total, success, and pending transactions live.

---

## Step-by-Step Setup Guide

### Step 1: Gmail Configuration (IMAP & App Password)
1. Go to your Google Account (`myaccount.google.com`) and enable **2-Step Verification**.
2. Search for **App Passwords**, create a new app named `Gateway`, and copy the **16-digit password**.
3. Open your Gmail settings, go to **Forwarding and POP/IMAP**, and enable **Enable IMAP**.

### Step 2: Update Server Configuration
Open `server.js` and update your email and app password inside the `checkPaytmEmail` function:
```javascript
user: 'sibadityapal7@gmail.com',
password: 'your-16-digit-app-password'
