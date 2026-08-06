require('dotenv').config();

// Set the process timezone BEFORE anything else touches Date().
// This makes the 3am job and "yesterday" calculations line up with
// the bar's actual local time.
process.env.TZ = process.env.APP_TIMEZONE || 'America/New_York';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const clover = require('./src/clover');
const sms = require('./src/sms');
const db = require('./src/db');
const scheduler = require('./src/scheduler');
const auth = require('./src/auth');
const social = require('./src/social');
const receipt = require('./src/receipt');

// Standard 1.5oz pour: a 750ml bottle yields ~17 drinks, a 1L bottle ~22.
const DRINKS_PER_750ML = 17;
const DRINKS_PER_1L = 22;

function normalizeItemName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Best-effort match of a receipt line against real Clover items, so the
// review screen can pre-select the right one. A matching product code is
// exact and trusted over any name-based guess.
function findBestItemMatch(extractedName, items, extractedCode) {
  const code = (extractedCode || '').trim().toLowerCase();
  if (code) {
    const byCode = items.find((i) => (i.code || '').trim().toLowerCase() === code);
    if (byCode) return byCode;
  }

  const target = normalizeItemName(extractedName);
  if (!target) return null;

  const exact = items.find((i) => normalizeItemName(i.name) === target);
  if (exact) return exact;

  const contains = items.find((i) => {
    const n = normalizeItemName(i.name);
    return n.includes(target) || target.includes(n);
  });
  if (contains) return contains;

  const targetWords = new Set(target.split(' '));
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const overlap = normalizeItemName(item.name)
      .split(' ')
      .filter((w) => targetWords.has(w)).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = item;
    }
  }
  return best;
}

function renderInventoryRow(index, matchedItem, drinksValue, receiptNote) {
  return `
    <div class="item-row">
      <label>Item</label>
      <div class="item-picker">
        <input type="text" class="item-search" autocomplete="off" placeholder="Search items…"
          value="${matchedItem ? matchedItem.name.replace(/"/g, '&quot;') : ''}" />
        <input type="hidden" class="item-id-input" name="itemId" value="${matchedItem ? matchedItem.id : ''}" />
        <ul class="item-results"></ul>
      </div>
      <label>Drinks to add</label>
      <input type="number" class="drinks-input" name="drinksToAdd" step="1" min="1" value="${drinksValue}" />
      ${receiptNote ? `<p class="subtitle" style="margin: 6px 0 0;">${receiptNote}</p>` : ''}
      <button type="button" class="remove-row-btn danger">Remove item</button>
    </div>`;
}

const app = express();
app.use(express.urlencoded({ extended: false })); // form submissions + Twilio webhook
app.use(express.static(path.join(__dirname, 'public')));

// --- Photo uploads for social posts ---
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = file.mimetype === 'image/png' ? '.png' : '.jpg';
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype === 'image/jpeg' || file.mimetype === 'image/png');
  },
});

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
          <input type="tel" id="phone" name="phone" placeholder="9105551234" required autofocus />

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
            Signed in as ${req.bartender.name} · <a href="/social/new">Post a photo</a> · <a href="/logout">not you?</a>
          </p>
          <form method="POST" action="/specials/new" id="specialForm">
            <div id="itemRows"></div>
            <button type="button" id="addRowBtn" class="secondary-btn">+ Add another item</button>

            <button type="submit">Send for approval</button>
          </form>
        </div>

        <script>
          const items = ${itemsJson};
          const MAX_ROWS = 5;
          const rowsContainer = document.getElementById('itemRows');
          const addRowBtn = document.getElementById('addRowBtn');
          let rowCount = 0;

          function formatMoney(cents) {
            return '$' + (cents / 100).toFixed(2);
          }

          function addRow() {
            if (rowCount >= MAX_ROWS) return;
            rowCount++;

            const row = document.createElement('div');
            row.className = 'item-row';
            row.innerHTML = \`
              <label>Item</label>
              <div class="item-picker">
                <input type="text" class="item-search" autocomplete="off" placeholder="Search items…" />
                <input type="hidden" class="item-id-input" name="itemId" />
                <ul class="item-results"></ul>
              </div>
              <label>Special price ($)</label>
              <input type="number" class="special-price-input" name="specialPrice" step="0.01" min="0" />
              <button type="button" class="remove-row-btn danger">Remove item</button>
            \`;
            rowsContainer.appendChild(row);

            const searchInput = row.querySelector('.item-search');
            const hiddenInput = row.querySelector('.item-id-input');
            const resultsList = row.querySelector('.item-results');
            const removeBtn = row.querySelector('.remove-row-btn');

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

            removeBtn.addEventListener('click', () => {
              row.remove();
              rowCount--;
              updateRowControls();
            });

            updateRowControls();
          }

          function updateRowControls() {
            addRowBtn.style.display = rowCount >= MAX_ROWS ? 'none' : 'block';
            document.querySelectorAll('.remove-row-btn').forEach((btn) => {
              btn.style.display = rowCount > 1 ? 'block' : 'none';
            });
          }

          document.addEventListener('click', (e) => {
            if (!e.target.closest('.item-picker')) {
              document.querySelectorAll('.item-results').forEach((el) => (el.style.display = 'none'));
            }
          });

          addRowBtn.addEventListener('click', addRow);
          addRow();

          document.getElementById('specialForm').addEventListener('submit', (e) => {
            const rows = Array.from(document.querySelectorAll('.item-row'));
            const filled = rows.filter(
              (r) => r.querySelector('.item-id-input').value && r.querySelector('.special-price-input').value
            );

            if (filled.length !== rows.length) {
              e.preventDefault();
              alert('Finish or remove any item row that\\'s missing an item or a price.');
              return;
            }

            const ids = filled.map((r) => r.querySelector('.item-id-input').value);
            if (new Set(ids).size !== ids.length) {
              e.preventDefault();
              alert('The same item is selected more than once — remove the duplicate.');
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

// --- POST /specials/new — bartender submits the form (up to 5 items, one approval code) ---
app.post('/specials/new', requireBartenderAuth, async (req, res) => {
  const bartenderName = req.bartender.name;
  const itemIds = [].concat(req.body.itemId || []).filter(Boolean);
  const specialPrices = [].concat(req.body.specialPrice || []);

  if (itemIds.length === 0) {
    return res.status(400).send('At least one item is required.');
  }
  if (itemIds.length > 5) {
    return res.status(400).send('You can submit at most 5 items at once.');
  }
  if (new Set(itemIds).size !== itemIds.length) {
    return res.status(400).send('The same item was selected more than once.');
  }

  const priceCentsList = specialPrices.map(dollarsToCents);
  if (priceCentsList.some((c) => !Number.isFinite(c) || c <= 0)) {
    return res.status(400).send('Special price must be a positive number for every item.');
  }

  const pendingItemIds = new Set(
    db.getPendingRequests().flatMap((r) => r.items.map((i) => i.itemId))
  );
  const conflict = itemIds.find((id) => pendingItemIds.has(id));
  if (conflict) {
    return res.status(409).send(
      'One of these items already has a special pending approval. ' +
      'Wait for it to be approved or ask an approver to ignore it before submitting another.'
    );
  }

  try {
    const cloverItems = await Promise.all(itemIds.map((id) => clover.getItem(id)));
    const items = cloverItems.map((item, i) => ({
      itemId: item.id,
      itemName: item.name,
      originalPrice: item.price,
      specialPriceCents: priceCentsList[i],
    }));

    const request = {
      id: shortId(),
      bartenderName,
      items,
      createdAt: Date.now(),
    };
    db.addPendingRequest(request);

    const itemLines = items
      .map((i) => `- ${i.itemName} at ${formatMoney(i.specialPriceCents)} (normally ${formatMoney(i.originalPrice)})`)
      .join('\n');

    await sms.notifyApprovers(
      `${bartenderName} wants to special:\n${itemLines}\n` +
      `Reply YES ${request.id} to approve all.`
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

// --- GET /social/new — bartender posts a photo to Facebook + Instagram ---
app.get('/social/new', requireBartenderAuth, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Post a Photo</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="card">
        <h1>Post a photo</h1>
        <p class="subtitle">
          Signed in as ${req.bartender.name} · <a href="/specials/new">Back to specials</a>
        </p>
        ${req.query.error ? `<div class="error-banner">${req.query.error}</div>` : ''}
        <form method="POST" action="/social/new" enctype="multipart/form-data">
          <label for="photo">Photo</label>
          <input type="file" id="photo" name="photo" accept="image/jpeg,image/png" required />

          <label for="caption">Caption</label>
          <textarea id="caption" name="caption" rows="4" required></textarea>

          <button type="submit">Post to Facebook &amp; Instagram</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// --- POST /social/new — upload the photo, post it, then clean up the file ---
app.post('/social/new', requireBartenderAuth, upload.single('photo'), async (req, res) => {
  const caption = (req.body.caption || '').trim();

  if (!req.file) {
    return res.redirect('/social/new?error=' + encodeURIComponent('Please attach a JPEG or PNG photo.'));
  }
  if (!caption) {
    fs.unlink(req.file.path, () => {});
    return res.redirect('/social/new?error=' + encodeURIComponent('A caption is required.'));
  }

  const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

  try {
    const result = await social.postPhoto(imageUrl, caption);
    fs.unlink(req.file.path, () => {});

    const lines = [
      `Facebook: ${result.facebook.success ? 'posted' : `failed — ${result.facebook.error}`}`,
      `Instagram: ${result.instagram.success ? 'posted' : `failed — ${result.instagram.error}`}`,
    ];

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Posted</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <div class="card confirmation">
          <div class="big">${result.facebook.success || result.instagram.success ? '✅' : '⚠️'}</div>
          <p>${lines.join('<br>')}</p>
          <p><a href="/specials/new">Back to specials</a></p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(500).send(`Something went wrong: ${err.message}`);
  }
});

// --- GET /inventory/new — owner uploads a receipt photo ---
app.get('/inventory/new', requireOwnerAuth, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Add Inventory from Receipt</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="card">
        <h1>Add inventory from a receipt</h1>
        <p class="subtitle">
          Signed in as ${req.owner.name} · <a href="/admin/bartenders">Bartenders</a> · <a href="/admin/owners">Owners</a>
        </p>
        ${req.query.error ? `<div class="error-banner">${req.query.error}</div>` : ''}
        <form method="POST" action="/inventory/new" enctype="multipart/form-data">
          <label for="receipt">Receipt photo</label>
          <input type="file" id="receipt" name="receipt" accept="image/jpeg,image/png" required />

          <button type="submit">Read receipt</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// --- POST /inventory/new — extract line items, show an editable review screen ---
app.post('/inventory/new', requireOwnerAuth, upload.single('receipt'), async (req, res) => {
  if (!req.file) {
    return res.redirect('/inventory/new?error=' + encodeURIComponent('Please attach a JPEG or PNG photo.'));
  }

  try {
    const imageBuffer = fs.readFileSync(req.file.path);
    const mimeType = req.file.mimetype;
    fs.unlink(req.file.path, () => {});

    const lines = await receipt.extractReceiptLines(imageBuffer, mimeType);
    const items = await clover.getItems();
    const itemsJson = JSON.stringify(items.map((i) => ({ id: i.id, name: i.name }))).replace(/</g, '\\u003c');

    const rowsHtml = lines
      .map((line, i) => {
        const drinks =
          line.sizeMl === 750 ? line.count * DRINKS_PER_750ML
          : line.sizeMl === 1000 ? line.count * DRINKS_PER_1L
          : '';
        const match = findBestItemMatch(line.name, items, line.code);
        const sizeLabel = line.sizeMl ? `${line.sizeMl}ml` : (line.rawSize || 'unknown size');
        const codeNote = line.code ? ` (code ${line.code})` : '';
        const receiptNote = `From receipt: "${line.name}"${codeNote} — ${line.count} × ${sizeLabel}`;

        return renderInventoryRow(i, match, drinks, receiptNote);
      })
      .join('');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Review Inventory</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <div class="card">
          <h1>Review before adding</h1>
          <p class="subtitle">
            Check each item and quantity, fix anything that looks wrong, then confirm.
          </p>
          <form method="POST" action="/inventory/confirm" id="inventoryForm">
            <div id="itemRows">${rowsHtml}</div>
            <button type="button" id="addRowBtn" class="secondary-btn">+ Add another item</button>

            <button type="submit">Add to inventory</button>
          </form>
        </div>

        <script>
          const items = ${itemsJson};
          const MAX_ROWS = 15;
          const rowsContainer = document.getElementById('itemRows');
          const addRowBtn = document.getElementById('addRowBtn');
          let rowCount = document.querySelectorAll('.item-row').length;

          function wireRow(row) {
            const searchInput = row.querySelector('.item-search');
            const hiddenInput = row.querySelector('.item-id-input');
            const resultsList = row.querySelector('.item-results');
            const removeBtn = row.querySelector('.remove-row-btn');

            function renderResults(filter) {
              const q = filter.trim().toLowerCase();
              const matches = (q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items).slice(0, 25);
              resultsList.innerHTML = matches.map((i) => \`<li data-id="\${i.id}">\${i.name}</li>\`).join('');
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

            removeBtn.addEventListener('click', () => {
              row.remove();
              rowCount--;
              updateRowControls();
            });
          }

          function addRow() {
            if (rowCount >= MAX_ROWS) return;
            rowCount++;
            const row = document.createElement('div');
            row.className = 'item-row';
            row.innerHTML = \`
              <label>Item</label>
              <div class="item-picker">
                <input type="text" class="item-search" autocomplete="off" placeholder="Search items…" />
                <input type="hidden" class="item-id-input" name="itemId" />
                <ul class="item-results"></ul>
              </div>
              <label>Drinks to add</label>
              <input type="number" class="drinks-input" name="drinksToAdd" step="1" min="1" />
              <button type="button" class="remove-row-btn danger">Remove item</button>
            \`;
            rowsContainer.appendChild(row);
            wireRow(row);
            updateRowControls();
          }

          function updateRowControls() {
            addRowBtn.style.display = rowCount >= MAX_ROWS ? 'none' : 'block';
          }

          document.querySelectorAll('.item-row').forEach(wireRow);
          updateRowControls();
          addRowBtn.addEventListener('click', addRow);

          document.addEventListener('click', (e) => {
            if (!e.target.closest('.item-picker')) {
              document.querySelectorAll('.item-results').forEach((el) => (el.style.display = 'none'));
            }
          });

          document.getElementById('inventoryForm').addEventListener('submit', (e) => {
            const rows = Array.from(document.querySelectorAll('.item-row'));
            const filled = rows.filter(
              (r) => r.querySelector('.item-id-input').value && r.querySelector('.drinks-input').value
            );
            if (filled.length === 0) {
              e.preventDefault();
              alert('Add at least one item with a quantity.');
              return;
            }
            if (filled.length !== rows.length) {
              e.preventDefault();
              alert('Finish or remove any row that\\'s missing an item or a quantity.');
            }
          });
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(500).send(`
      <!DOCTYPE html>
      <html><body><div class="card"><div class="error-banner">
        Couldn't read that receipt: ${err.message}
      </div></div></body></html>
    `);
  }
});

// --- POST /inventory/confirm — write the reviewed quantities to Clover ---
app.post('/inventory/confirm', requireOwnerAuth, async (req, res) => {
  const itemIds = [].concat(req.body.itemId || []).filter(Boolean);
  const drinksToAdd = [].concat(req.body.drinksToAdd || []).map((n) => parseInt(n, 10));

  if (itemIds.length === 0) {
    return res.status(400).send('At least one item is required.');
  }
  if (drinksToAdd.some((n) => !Number.isFinite(n) || n <= 0)) {
    return res.status(400).send('Quantity must be a positive whole number for every item.');
  }

  try {
    const results = [];
    for (let i = 0; i < itemIds.length; i++) {
      const item = await clover.getItem(itemIds[i]);
      const newQuantity = await clover.addToItemStock(itemIds[i], drinksToAdd[i]);
      results.push(`${item.name}: +${drinksToAdd[i]} (now ${newQuantity})`);
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Inventory Updated</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <div class="card confirmation">
          <div class="big">✅</div>
          <p>${results.join('<br>')}</p>
          <p><a href="/admin/bartenders">Back to admin</a></p>
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
          <input type="tel" id="phone" name="phone" placeholder="9105551234" required autofocus />

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
          Signed in as ${req.owner.name} · <a href="/admin/bartenders">Bartenders</a> · <a href="/inventory/new">Inventory</a> · <a href="/admin/logout">Sign out</a>
        </p>
        ${req.query.error ? `<div class="error-banner">${req.query.error}</div>` : ''}

        <ul class="bartender-list">${rows || '<li class="subtitle">No owners added yet.</li>'}</ul>

        <h1 style="margin-top: 32px;">Add an owner</h1>
        <form method="POST" action="/admin/owners">
          <label for="name">Name</label>
          <input type="text" id="name" name="name" required />

          <label for="phone">Phone number</label>
          <input type="tel" id="phone" name="phone" placeholder="9105551234" required />

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

  const normalizedPhone = db.normalizePhone(phone);
  if (normalizedPhone.length !== 10) {
    return res.redirect('/admin/owners?error=' + encodeURIComponent('Enter a valid 10-digit phone number.'));
  }

  if (db.findOwnerByPhone(normalizedPhone)) {
    return res.redirect('/admin/owners?error=' + encodeURIComponent('That phone number is already registered.'));
  }

  db.addOwner({
    id: shortId(),
    name: name.trim(),
    phone: normalizedPhone,
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
          Signed in as ${req.owner.name} · <a href="/admin/owners">Owners</a> · <a href="/inventory/new">Inventory</a> · <a href="/admin/logout">Sign out</a>
        </p>
        ${req.query.error ? `<div class="error-banner">${req.query.error}</div>` : ''}

        <ul class="bartender-list">${rows || '<li class="subtitle">No bartenders added yet.</li>'}</ul>

        <h1 style="margin-top: 32px;">Add a bartender</h1>
        <form method="POST" action="/admin/bartenders">
          <label for="name">Name</label>
          <input type="text" id="name" name="name" required />

          <label for="phone">Phone number</label>
          <input type="tel" id="phone" name="phone" placeholder="9105551234" required />

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

  const normalizedPhone = db.normalizePhone(phone);
  if (normalizedPhone.length !== 10) {
    return res.redirect('/admin/bartenders?error=' + encodeURIComponent('Enter a valid 10-digit phone number.'));
  }

  if (db.findBartenderByPhone(normalizedPhone)) {
    return res.redirect('/admin/bartenders?error=' + encodeURIComponent('That phone number is already registered.'));
  }

  db.addBartender({
    id: shortId(),
    name: name.trim(),
    phone: normalizedPhone,
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

  db.removePendingRequest(request.id);

  const results = [];
  for (const item of request.items) {
    try {
      await clover.updateItemPrice(item.itemId, item.specialPriceCents);
      db.addActiveSpecial({
        itemId: item.itemId,
        itemName: item.itemName,
        originalPrice: item.originalPrice,
        specialPriceCents: item.specialPriceCents,
        bartenderName: request.bartenderName,
        createdAt: Date.now(),
      });
      results.push(`${item.itemName} is now ${formatMoney(item.specialPriceCents)}`);
    } catch (err) {
      results.push(`FAILED to update ${item.itemName}: ${err.message}`);
    }
  }

  await sms.notifyApprovers(
    `${results.join('\n')}\nApproved by ${from}. Reverts automatically at 3am.`
  );

  res.send('<Response></Response>');
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
