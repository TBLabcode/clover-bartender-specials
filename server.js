require('dotenv').config();

// Set the process timezone BEFORE anything else touches Date().
// This makes the 3am job and "yesterday" calculations line up with
// the bar's actual local time.
process.env.TZ = process.env.APP_TIMEZONE || 'America/New_York';

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const clover = require('./src/clover');
const sms = require('./src/sms');
const db = require('./src/db');
const scheduler = require('./src/scheduler');

const app = express();
app.use(express.urlencoded({ extended: false })); // form submissions + Twilio webhook
app.use(express.static(path.join(__dirname, 'public')));

function shortId() {
  return crypto.randomBytes(3).toString('hex'); // e.g. "a1b2c3"
}

function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function dollarsToCents(dollarsStr) {
  return Math.round(parseFloat(dollarsStr) * 100);
}

// --- GET /specials/new — the bartender-facing form ---
app.get('/specials/new', async (req, res) => {
  try {
    const items = await clover.getItems();
    const options = items
      .map((i) => `<option value="${i.id}">${i.name} (currently ${formatMoney(i.price)})</option>`)
      .join('');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Submit a Special</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <div class="card">
          <h1>Submit a special</h1>
          <p class="subtitle">This goes out for approval before it changes anything.</p>
          <form method="POST" action="/specials/new">
            <label for="bartenderName">Your name</label>
            <input type="text" id="bartenderName" name="bartenderName" required />

            <label for="itemId">Item</label>
            <select id="itemId" name="itemId" required>
              <option value="" disabled selected>Choose an item</option>
              ${options}
            </select>

            <label for="specialPrice">Special price ($)</label>
            <input type="number" id="specialPrice" name="specialPrice" step="0.01" min="0" required />

            <button type="submit">Send for approval</button>
          </form>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`
      <!DOCTYPE html>
      <html><body><div class="card"><div class="error-banner">
        Couldn't load the item list from Clover: ${err.message}
      </div></div></body></html>
    `);
  }
});

// --- POST /specials/new — bartender submits the form ---
app.post('/specials/new', async (req, res) => {
  const { bartenderName, itemId, specialPrice } = req.body;

  if (!bartenderName || !bartenderName.trim() || !itemId) {
    return res.status(400).send('Name and item are required.');
  }

  const priceCents = dollarsToCents(specialPrice);
  if (!Number.isFinite(priceCents) || priceCents <= 0) {
    return res.status(400).send('Special price must be a positive number.');
  }

  const alreadyPending = db.getPendingRequests().find((r) => r.itemId === itemId);
  if (alreadyPending) {
    return res.status(409).send(
      `This item already has a special pending approval (submitted by ${alreadyPending.bartenderName}). ` +
      `Wait for it to be approved or ask an approver to ignore it before submitting another.`
    );
  }

  try {
    const item = await clover.getItem(itemId);
    const request = {
      id: shortId(),
      bartenderName,
      itemId,
      itemName: item.name,
      originalPrice: item.price,
      specialPriceCents: priceCents,
      createdAt: Date.now(),
    };
    db.addPendingRequest(request);

    await sms.notifyApprovers(
      `${bartenderName} wants to special "${item.name}" at ${formatMoney(request.specialPriceCents)} ` +
      `(normally ${formatMoney(item.price)}).\n` +
      `Reply YES ${request.id} to approve.`
    );

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Sent</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <div class="card confirmation">
          <div class="big">✅</div>
          <p>Sent for approval. It'll go live once approved.</p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`Something went wrong: ${err.message}`);
  }
});

// --- POST /sms/incoming — Twilio webhook for approval replies ---
app.post('/sms/incoming', async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || '').trim();

  res.set('Content-Type', 'text/xml');

  if (!sms.approverNumbers.includes(from)) {
    // Not a recognized approver number — ignore silently.
    return res.send('<Response></Response>');
  }

  const match = body.match(/^YES\s+([a-zA-Z0-9]+)$/i) || body.match(/^YES$/i);
  if (!match) {
    return res.send('<Response><Message>Reply "YES [code]" to approve a special.</Message></Response>');
  }

  const pending = db.getPendingRequests();
  let request;

  if (match[1]) {
    request = pending.find((r) => r.id.toLowerCase() === match[1].toLowerCase());
  } else if (pending.length === 1) {
    request = pending[0];
  }

  if (!request) {
    return res.send('<Response><Message>No matching pending special found. Include the code, e.g. YES a1b2c3.</Message></Response>');
  }

  try {
    await clover.updateItemPrice(request.itemId, request.specialPriceCents);
    db.removePendingRequest(request.id);
    db.addActiveSpecial(request);

    await sms.notifyApprovers(
      `${request.itemName} is now ${formatMoney(request.specialPriceCents)}. ` +
      `Approved by ${from}. Reverts automatically at 3am.`
    );

    res.send('<Response></Response>');
  } catch (err) {
    res.send(`<Response><Message>Failed to update Clover: ${err.message}</Message></Response>`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (process.env.CLOVER_DRY_RUN === 'true') {
    console.log('CLOVER_DRY_RUN: Clover calls are mocked/logged, not sent for real.');
  }
  if (process.env.TWILIO_DRY_RUN === 'true') {
    console.log('TWILIO_DRY_RUN: Twilio texts are logged, not sent for real.');
  }
  scheduler.start();
});
