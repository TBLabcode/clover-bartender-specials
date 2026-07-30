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
const auth = require('./src/auth');

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

// --- Auth middleware ---

function requireBartenderAuth(req, res, next) {
  const cookies = auth.parseCookies(req);
  const token = cookies[auth.SESSION_COOKIE];
  const session = token && db.findSessionByToken(token);

  if (!session || Date.now() - session.createdAt > auth.SESSION_TTL_MS) {
    if (session) db.removeSession(token);
    return res.redirect('/login');
  }

  const bartender = db.getBartenders().find((b) => b.id === session.bartenderId);
  if (!bartender) {
    db.removeSession(token);
    return res.redirect('/login');
  }

  req.bartender = bartender;
  next();
}

function requireOwnerAuth(req, res, next) {
  const cookies = auth.parseCookies(req);
  const token = cookies[auth.ADMIN_COOKIE];
  const session = token && db.findOwnerSessionByToken(token);

  if (!session || Date.now() - session.createdAt > auth.SESSION_TTL_MS) {
    if (session) db.removeOwnerSession(token);
    return res.redirect('/admin/login');
  }

  if (session.ownerId === 'master') {
    req.owner = { id: 'master', name: 'Master passcode' };
    return next();
  }

  const owner = db.getOwners().find((o) => o.id === session.ownerId);
  if (!owner) {
    db.removeOwnerSession(token);
    return res.redirect('/admin/login');
  }

  req.owner = owner;
  next();
}

// --- GET /login — bartender enters phone + passcode ---
app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Sign in</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="card">
        <h1>Sign in</h1>
        <p class="subtitle">Enter your phone number and passcode to submit specials.</p>
        ${req.query.error ? `<div class="error-banner">${req.query.error}</div>` : ''}
        <form method="POST" action="/login">
          <label for="phone">Phone number</label>
          <input type="tel" id="phone" name="phone" required autofocus />

          <label for="passcode">Passcode</label>
          <input type="password" id="passcode" name="passcode" inputmode="numeric" required />

          <button type="submit">Sign in</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// --- POST /login — verify phone + passcode, start a session ---
app.post('/login', (req, res) => {
  const { phone, passcode } = req.body;
  const bartender = phone && db.findBartenderByPhone(phone.trim());

  if (!bartender || !passcode || !auth.verifyPasscode(passcode, bartender.passcodeHash)) {
    return res.redirect('/login?error=' + encodeURIComponent('Phone number or passcode not recognized.'));
  }

  const token = auth.newToken();
  db.addSession({ token, bartenderId: bartender.id, createdAt: Date.now() });
  auth.setCookie(res, auth.SESSION_COOKIE, token, auth.SESSION_TTL_MS);
  res.redirect('/specials/new');
});

// --- GET /logout ---
app.get('/logout', (req, res) => {
  const cookies = auth.parseCookies(req);
  const token = cookies[auth.SESSION_COOKIE];
  if (token) db.removeSession(token);
  auth.clearCookie(res, auth.SESSION_COOKIE);
  res.redirect('/login');
});

// --- GET /specials/new — the bartender-facing form ---
app.get('/specials/new', requireBartenderAuth, async (req, res) => {
  try {
    const items = await clover.getItems();
    const itemsJson = JSON.stringify(
      items.map((i) => ({ id: i.id, name: i.name, price: i.price }))
    ).replace(/</g, '\\u003c');

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
          <p class="subtitle">
            Signed in as ${req.bartender.name} · <a href="/logout">not you?</a>
          </p>
          <form method="POST" action="/specials/new" id="specialForm">
            <label for="itemSearch">Item</label>
            <div class="item-picker">
              <input type="text" id="itemSearch" autocomplete="off" placeholder="Search items…" required />
              <input type="hidden" id="itemId" name="itemId" />
              <ul id="itemResults" class="item-results"></ul>
            </div>

            <label for="specialPrice">Special price ($)</label>
            <input type="number" id="specialPrice" name="specialPrice" step="0.01" min="0" required />

            <button type="submit">Send for approval</button>
          </form>
        </div>

        <script>
          const items = ${itemsJson};
          const searchInput = document.getElementById('itemSearch');
          const hiddenInput = document.getElementById('itemId');
          const resultsList = document.getElementById('itemResults');

          function formatMoney(cents) {
            return '$' + (cents / 100).toFixed(2);
          }

          function renderResults(filter) {
            const q = filter.trim().toLowerCase();
            const matches = (q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items).slice(0, 25);
            resultsList.innerHTML = matches
              .map((i) => \`<li data-id="\${i.id}">\${i.name} (currently \${formatMoney(i.price)})</li>\`)
              .join('');
            resultsList.style.display = matches.length ? 'block' : 'none';
          }

          searchInput.addEventListener('input', () => {
            hiddenInput.value = '';
            renderResults(searchInput.value);
          });
          searchInput.addEventListener('focus', () => renderResults(searchInput.value));

          resultsList.addEventListener('click', (e) => {
            const li = e.target.closest('li[data-id]');
            if (!li) return;
            const item = items.find((i) => i.id === li.dataset.id);
            if (!item) return;
            hiddenInput.value = item.id;
            searchInput.value = item.name;
            resultsList.style.display = 'none';
          });

          document.addEventListener('click', (e) => {
            if (!e.target.closest('.item-picker')) resultsList.style.display = 'none';
          });

          document.getElementById('specialForm').addEventListener('submit', (e) => {
            if (!hiddenInput.value) {
              e.preventDefault();
              alert('Please choose an item from the search results.');
            }
          });
        </script>
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
app.post('/specials/new', requireBartenderAuth, async (req, res) => {
  const bartenderName = req.bartender.name;
  const { itemId, specialPrice } = req.body;

  if (!itemId) {
    return res.status(400).send('Item is required.');
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

// --- GET /admin/login — each owner signs in with their own phone + passcode ---
app.get('/admin/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Owner sign in</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="card">
        <h1>Owner sign in</h1>
        <p class="subtitle">Manage bartenders and owners.</p>
        ${req.query.error ? `<div class="error-banner">${req.query.error}</div>` : ''}
        <form method="POST" action="/admin/login">
          <label for="phone">Phone number</label>
          <input type="tel" id="phone" name="phone" required autofocus />

          <label for="passcode">Passcode</label>
          <input type="password" id="passcode" name="passcode" inputmode="numeric" required />

          <button type="submit">Sign in</button>
        </form>
        <p class="subtitle" style="margin-top: 18px;">
          <a href="/admin/master-login">Sign in with the master passcode instead</a>
        </p>
      </div>
    </body>
    </html>
  `);
});

app.post('/admin/login', (req, res) => {
  const { phone, passcode } = req.body;
  const owner = phone && db.findOwnerByPhone(phone.trim());

  if (!owner || !passcode || !auth.verifyPasscode(passcode, owner.passcodeHash)) {
    return res.redirect('/admin/login?error=' + encodeURIComponent('Phone number or passcode not recognized.'));
  }

  const token = auth.newToken();
  db.addOwnerSession({ token, ownerId: owner.id, createdAt: Date.now() });
  auth.setCookie(res, auth.ADMIN_COOKIE, token, auth.SESSION_TTL_MS);
  res.redirect('/admin/bartenders');
});

// --- Master passcode — bootstraps the first owner account, and works as a
// recovery path if every owner gets locked out. Not meant for everyday use. ---
app.get('/admin/master-login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Master sign in</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="card">
        <h1>Master sign in</h1>
        <p class="subtitle">For initial setup or if every owner is locked out.</p>
        ${req.query.error ? `<div class="error-banner">${req.query.error}</div>` : ''}
        <form method="POST" action="/admin/master-login">
          <label for="passcode">Master passcode</label>
          <input type="password" id="passcode" name="passcode" required autofocus />

          <button type="submit">Sign in</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/admin/master-login', (req, res) => {
  if (!process.env.OWNER_PASSCODE || req.body.passcode !== process.env.OWNER_PASSCODE) {
    return res.redirect('/admin/master-login?error=' + encodeURIComponent('Incorrect passcode.'));
  }
  const token = auth.newToken();
  db.addOwnerSession({ token, ownerId: 'master', createdAt: Date.now() });
  auth.setCookie(res, auth.ADMIN_COOKIE, token, auth.SESSION_TTL_MS);
  res.redirect('/admin/owners');
});

app.get('/admin/logout', (req, res) => {
  const cookies = auth.parseCookies(req);
  const token = cookies[auth.ADMIN_COOKIE];
  if (token) db.removeOwnerSession(token);
  auth.clearCookie(res, auth.ADMIN_COOKIE);
  res.redirect('/admin/login');
});

// --- GET /admin/owners — list + add owners (owner only) ---
app.get('/admin/owners', requireOwnerAuth, (req, res) => {
  const rows = db.getOwners()
    .map(
      (o) => `
        <li class="bartender-row">
          <div>
            <strong>${o.name}</strong>
            <div class="subtitle">${o.phone}</div>
          </div>
          <form method="POST" action="/admin/owners/${o.id}/delete">
            <button type="submit" class="danger">Remove</button>
          </form>
        </li>`
    )
    .join('');

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Owners</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="card">
        <h1>Owners</h1>
        <p class="subtitle">
          Signed in as ${req.owner.name} · <a href="/admin/bartenders">Bartenders</a> · <a href="/admin/logout">Sign out</a>
        </p>
        ${req.query.error ? `<div class="error-banner">${req.query.error}</div>` : ''}

        <ul class="bartender-list">${rows || '<li class="subtitle">No owners added yet.</li>'}</ul>

        <h1 style="margin-top: 32px;">Add an owner</h1>
        <form method="POST" action="/admin/owners">
          <label for="name">Name</label>
          <input type="text" id="name" name="name" required />

          <label for="phone">Phone number</label>
          <input type="tel" id="phone" name="phone" placeholder="+19105551234" required />

          <label for="passcode">Passcode</label>
          <input type="password" id="passcode" name="passcode" inputmode="numeric" required />

          <button type="submit">Add owner</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/admin/owners', requireOwnerAuth, (req, res) => {
  const { name, phone, passcode } = req.body;

  if (!name || !name.trim() || !phone || !phone.trim() || !passcode) {
    return res.redirect('/admin/owners?error=' + encodeURIComponent('Name, phone, and passcode are all required.'));
  }

  if (db.findOwnerByPhone(phone.trim())) {
    return res.redirect('/admin/owners?error=' + encodeURIComponent('That phone number is already registered.'));
  }

  db.addOwner({
    id: shortId(),
    name: name.trim(),
    phone: phone.trim(),
    passcodeHash: auth.hashPasscode(passcode),
    createdAt: Date.now(),
  });

  res.redirect('/admin/owners');
});

app.post('/admin/owners/:id/delete', requireOwnerAuth, (req, res) => {
  db.removeOwner(req.params.id);
  res.redirect('/admin/owners');
});

// --- GET /admin/bartenders — list + add bartenders (owner only) ---
app.get('/admin/bartenders', requireOwnerAuth, (req, res) => {
  const rows = db.getBartenders()
    .map(
      (b) => `
        <li class="bartender-row">
          <div>
            <strong>${b.name}</strong>
            <div class="subtitle">${b.phone}</div>
          </div>
          <form method="POST" action="/admin/bartenders/${b.id}/delete">
            <button type="submit" class="danger">Remove</button>
          </form>
        </li>`
    )
    .join('');

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Bartenders</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="card">
        <h1>Bartenders</h1>
        <p class="subtitle">
          Signed in as ${req.owner.name} · <a href="/admin/owners">Owners</a> · <a href="/admin/logout">Sign out</a>
        </p>
        ${req.query.error ? `<div class="error-banner">${req.query.error}</div>` : ''}

        <ul class="bartender-list">${rows || '<li class="subtitle">No bartenders added yet.</li>'}</ul>

        <h1 style="margin-top: 32px;">Add a bartender</h1>
        <form method="POST" action="/admin/bartenders">
          <label for="name">Name</label>
          <input type="text" id="name" name="name" required />

          <label for="phone">Phone number</label>
          <input type="tel" id="phone" name="phone" placeholder="+19105551234" required />

          <label for="passcode">Passcode</label>
          <input type="password" id="passcode" name="passcode" inputmode="numeric" required />

          <button type="submit">Add bartender</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/admin/bartenders', requireOwnerAuth, (req, res) => {
  const { name, phone, passcode } = req.body;

  if (!name || !name.trim() || !phone || !phone.trim() || !passcode) {
    return res.redirect('/admin/bartenders?error=' + encodeURIComponent('Name, phone, and passcode are all required.'));
  }

  if (db.findBartenderByPhone(phone.trim())) {
    return res.redirect('/admin/bartenders?error=' + encodeURIComponent('That phone number is already registered.'));
  }

  db.addBartender({
    id: shortId(),
    name: name.trim(),
    phone: phone.trim(),
    passcodeHash: auth.hashPasscode(passcode),
    createdAt: Date.now(),
  });

  res.redirect('/admin/bartenders');
});

app.post('/admin/bartenders/:id/delete', requireOwnerAuth, (req, res) => {
  db.removeBartender(req.params.id);
  res.redirect('/admin/bartenders');
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
