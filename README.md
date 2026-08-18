# Bartender Specials App

Bartenders submit a special through a simple web form → you or your partner
approve it by replying "YES" to a text → the price changes in Clover →
it automatically reverts at 8am → every morning you get a text with
yesterday's sales and discounts.

## What you need before starting

1. **Node.js installed** on whatever computer/server will run this.
   Download from nodejs.org if you don't have it (get the "LTS" version).
2. **Your Clover sandbox credentials** (you already have these):
   - Merchant ID
   - Merchant-specific test API token
3. **Your Twilio credentials**:
   - Account SID
   - Auth Token
   - Messaging Service SID
4. **Phone numbers** for you and your business partner (the approvers).

## Setup steps

### 1. Install dependencies

Open a terminal in this folder and run:

```
npm install
```

This downloads the small number of packages the app needs (Express for
the web server, Twilio's SDK, etc.).

### 2. Fill in your credentials

Copy `.env.example` to a new file named `.env`:

```
cp .env.example .env
```

Open `.env` in any text editor and fill in your real values:
- `CLOVER_MERCHANT_ID` and `CLOVER_API_TOKEN` — from your Clover
  Developer Dashboard / test merchant
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`
  — from your Twilio Console
- `APPROVER_PHONE_NUMBERS` — your number and your partner's number,
  in the format `+19105551234` (country code, no spaces or dashes)
- `APP_TIMEZONE` — should already be correct for the East Coast
  (`America/New_York`)

**Never share your `.env` file or commit it anywhere public** — it
contains your real credentials.

### 3. Run it locally to test

```
npm start
```

You should see:
```
Server running on port 3000
Scheduler started (timezone: America/New_York)
```

Open `http://localhost:3000/specials/new` in a browser — you should see
the form with your real Clover items in the dropdown. Submitting it will
send a real text through Twilio, so use it for a real test once you're
ready (it *will* change a real item's price in whatever Clover
environment your `.env` points to — start in sandbox!).

### 4. Point Twilio at your incoming-text webhook

Twilio needs a public web address to send incoming text replies to —
`localhost` on your own computer isn't reachable from the internet.
Once this app is deployed somewhere public (step 5), go to your Twilio
Messaging Service settings and set the **incoming message webhook** to:

```
https://your-deployed-url.com/sms/incoming
```

### 5. Deploy it somewhere that runs 24/7

This needs to keep running even when your computer is off, so it can
catch the 8am revert and morning report. Simple, cheap options:
Railway, Render, or a small DigitalOcean droplet. Any of these can run
a Node app like this for a few dollars a month. When you deploy, you'll
set the same values from your `.env` file as environment variables in
that platform's dashboard (don't upload the `.env` file itself).

The web form link you give bartenders will be:
```
https://your-deployed-url.com/specials/new
```
Bookmark it on their phones.

## How the pieces work

- **`server.js`** — the web server: shows the form, handles submissions,
  and receives Twilio's incoming-text webhook.
- **`src/clover.js`** — everything that talks to Clover (reading items,
  changing a price, pulling yesterday's orders).
- **`src/sms.js`** — sends texts through Twilio.
- **`src/scheduler.js`** — the 8am revert job and the daily report job.
- **`src/db.js`** — tracks pending requests and currently-active specials
  in `data/db.json` (a plain file — no database server needed).

## Switching from sandbox to production

Right now `CLOVER_BASE_URL` points at the sandbox
(`apisandbox.dev.clover.com`). Once you've tested everything and are
ready to go live with your real Clover account:
1. Create/approve your app in the **production** environment on the
   Global Developer Dashboard.
2. Get a production merchant API token the same way you did in sandbox.
3. Update `.env` (or your hosting platform's environment variables) with
   the production merchant ID, token, and base URL
   (`https://api.clover.com`).

## A few notes and limitations to know about

- Only one special per item can be pending approval at a time by
  design — if you want two specials pending at once, approve or wait
  on the first before submitting the next.
- The "YES [code]" reply is required only when more than one special
  is pending; a plain "YES" works if there's just one.
- The discount total in the daily report depends on how discounts are
  recorded in your Clover account — if the numbers look off once you
  test it against real data, tell me and I'll adjust how it's calculated.
