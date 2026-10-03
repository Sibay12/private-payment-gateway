# Private UPI Payment Gateway

Dynamic UPI QR + automatic verification from Paytm confirmation emails (Gmail IMAP), MongoDB storage, admin dashboard.

## Setup
1. Google Account: enable 2-Step Verification, create an App Password, and enable IMAP in Gmail.
2. Set these environment variables (Render -> Environment). Nothing secret lives in the code any more. See `.env.example`.
   - `MONGO_URI`, `API_SECRET_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD` (required)
   - `ADMIN_SECRET_PASS` (admin panel password), `SITE_WEBHOOK_URL`, `BUSINESS_UPI`, `PAYEE_NAME`, `PENDING_WINDOW_HOURS` (optional)
3. `npm install` then `npm start`.

## Main site integration
- Site calls `POST /api/create-payment` with header `x-api-key` and body `{ amount, orderId }`, then sends the user to the returned `checkoutUrl` + `&redirectUrl=<encoded link>`.
- After payment the user returns to `redirectUrl` with `orderId` and `status=SUCCESS` appended properly.
- The gateway marks the order `SUCCESS` in the shared `payments` collection and, if `SITE_WEBHOOK_URL` is set, also calls the site webhook.
- See `/docs.html` for details.

## Reliability notes
- Webhook to the main site is retried and re-sent automatically until the site replies 2xx (`webhookSent` flag on the payment).
- Open `/ping.html` for a live status/ping page (response time, uptime, DB, self-ping stats) and the steps to add a free external pinger (UptimeRobot / cron-job.org -> `/healthz`, every 5 min). A sleeping Render service cannot wake itself, so the external pinger is what guarantees it never sleeps.
- The anti-sleep ping now targets the public URL (`RENDER_EXTERNAL_URL` / `KEEP_ALIVE_URL`); pinging 127.0.0.1 does not keep Render awake.
- Async admin routes have error handling and the process no longer exits on an unhandled rejection.
- Speed/safety: cached QR codes, DB index on status+createdAt, lean queries, IMAP search limited by date, static asset caching, per-IP rate limits on public endpoints, input validation on `orderId`/`amount`, safe CSV export.

## Automatic ping (works with the page closed)
- **Inside the server:** pings its own public URL every `PING_INTERVAL_MIN` minutes (default 5).
- **From GitHub (recommended):** `.github/workflows/keep-alive.yml` pings `/healthz` every 5 minutes from GitHub's servers. Set it up once: repo -> Settings -> Secrets and variables -> Actions -> **Variables** -> New variable `PING_URL` = `https://YOUR-APP.onrender.com/healthz`. Then Actions tab -> Keep Alive -> Run workflow to test.
- GitHub may delay scheduled runs by a few minutes, and pauses them if the repo has no activity for 60 days (re-enable from the Actions tab). Adding UptimeRobot / cron-job.org as a second pinger covers that.

## Checkout pages (Razorpay / Cashfree style)
- `/index.html` - hosted checkout: QR, **Pay with UPI app** (mobile), **Check payment status** button, **Cancel payment** link. Auto-checks every 4 s while the tab is visible.
- `/success.html` - shown after payment; verifies the order is really `SUCCESS` on the server (cannot be faked via URL), then returns the user to `redirectUrl` with `status=SUCCESS`.
- `/cancel.html` - shown on cancel/failed; offers **Try payment again** (only while the order is still PENDING) and **Return to merchant** with `status=CANCELLED`. Cancelling does not change the order in the database; unpaid orders simply expire after `PENDING_WINDOW_HOURS`.
- Shared styling lives in `/gateway.css`.

## Merchant sign-up (other people using your gateway)
- `/merchant.html` is the public home: anyone can register their site (name, email, website, optional https webhook). They get a one-time login token.
- In `/admin.html` -> **Merchants** tab you see the requests (badge shows how many are pending) and can **Approve / Reject / Suspend**, issue a new login token, or delete a merchant that has no orders. Approving creates their API key.
- The merchant logs in at `/merchant.html` (email + token) to see their API key, orders, revenue, set their webhook URL and send a test webhook.
- Merchant orders are separate: `orderId` collisions return 409, webhooks go only to the owner, and the return-to-site redirect only works for their registered website.
- Webhooks are signed: header `x-signature` = HMAC-SHA256(apiKey, `${x-timestamp}.${rawBody}`). Your main site still also gets the old `x-api-key` header.
- Merchant API keys are stored in the database (so merchants can view them); protect `MONGO_URI`.
- `GET /` now opens `/merchant.html`; the checkout still opens with `/index.html?orderId=...`.
- Full developer documentation: `/docs.html`.

## Plans, settlement and payouts
- Merchants start on **Free** (5% per transaction). **Pro** is ₹499 per 30 days with ₹1 per transaction. Edit the numbers in the `PLANS` block in `server.js` (`SETTLEMENT_DAYS` and `MIN_PAYOUT` are next to it).
- Money becomes withdrawable 3 working days (Mon-Fri) after payment. Merchants request a payout by NEFT, IMPS (name, account number, IFSC) or UPI; the charge depends on the plan.
- Admin panel -> **Payouts**: pay the money manually, then **Accept** with the UTR number, or **Reject** (the money returns to the merchant balance). **Merchants** tab: Make Pro / Make Free.
- Docs: `/docs.html#plans` and `/docs.html#payouts`.

## Refunds
- Merchant dashboard -> **Refunds** (or the Refund button in Orders): full or partial refund of a paid order with a reason (customer UPI ID optional).
- Admin panel -> **Refunds**: refund the customer manually from the same payment account, then **Accept** with the refund UTR, or **Reject**.
- The payment fee is never refunded. Every refund has a 1% refund charge (`REFUND_PERCENT` in `server.js`) on all plans. From the merchant balance we deduct `refund amount + charge`; the charge must be covered by the available balance.

## Merchant KYC
- The sign-up form on `/merchant.html` asks for: name on PAN, PAN number (validated `AAAAA9999A`), a PAN card photo (resized in the browser, stored in the `kycdocs` collection), business name, email, website, optional webhook / phone, and a declaration checkbox.
- Admin panel -> Merchants -> **View KYC** shows the PAN details and photo. A merchant cannot be approved without them. Rejecting asks for a reason that the merchant sees; the merchant can fix and resubmit from Profile.
- One PAN can be used by only one merchant account. Protect `MONGO_URI`: PAN data is stored as-is.
