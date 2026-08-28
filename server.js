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
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

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

// See src/sms.js for what this version number means and where it's enforced
// on the sending side — this file's requireCurrentConsent uses the same
// constant so a bartender can't get past login without re-accepting.
const { SMS_CONSENT_VERSION } = sms;

function normalizeItemName(s) {
  return (s || '')
    // Fold accented letters ("Jägermeister", "Espolòn") to plain ASCII
    // ("jagermeister", "espolon") before stripping non-alphanumerics below —
    // otherwise the accent itself gets treated as a word-breaking character
    // and splits the word in two, which quietly kills what would otherwise
    // be a good match against the (plain-ASCII) Clover catalog name.
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

  // Fuzzy fallback: only trust this when the overlap is substantial, not just
  // one coincidentally-shared word (e.g. "F/C Sweet/Sour RTU" sharing "sour"
  // with "Sour Apple" is NOT a real match — leave it unmatched instead of
  // confidently guessing wrong; the review screen will offer "add as new").
  //
  // Ranked by Jaccard similarity (overlap / union of words), not raw overlap
  // count — raw count treats "White Claw Black Cherry" and "White Claw NA
  // Black Cherry" as equally good matches for "White Claw ... Black Cherry"
  // (both share 4 words) and silently picks whichever comes first in
  // Clover's item order. Jaccard penalizes the extra unmatched "na" word,
  // so the tighter, correct match wins instead of an alphabetical coin flip.
  const targetWords = new Set(target.split(' '));
  let best = null;
  let bestJaccard = -1;
  for (const item of items) {
    const itemWords = new Set(normalizeItemName(item.name).split(' ').filter(Boolean));
    if (itemWords.size === 0) continue;
    let overlap = 0;
    for (const w of itemWords) if (targetWords.has(w)) overlap++;

    // Gate on how much of the CATALOG item's own name is accounted for, not
    // how much of the (often noisier) extracted name is — a short, exact
    // item name like "White Claw Black Cherry" shouldn't need to out-overlap
    // packaging/size words ("2/12 12oz Can") the catalog will never contain.
    // The overlap>=2 floor keeps single/short-word items off this fuzzy path
    // entirely (they rely on exact/contains matching above, which is safer).
    const coverage = overlap / itemWords.size;
    if (overlap < 2 || coverage < 0.6) continue;

    const union = new Set([...targetWords, ...itemWords]).size;
    const jaccard = overlap / union;
    if (jaccard > bestJaccard) {
      bestJaccard = jaccard;
      best = item;
    }
  }
  return best;
}

function renderInventoryRow(index, matchedItem, drinksValue, receiptNote, unmatchedName, unmatchedCode) {
  const startNew = !matchedItem && unmatchedName;
  return `
    <div class="item-row" data-mode="${startNew ? 'new' : 'existing'}">
      <label>Item</label>
      <div class="item-picker existing-item-fields" style="${startNew ? 'display:none;' : ''}">
        <input type="text" class="item-search" autocomplete="off" placeholder="Search items…"
          value="${matchedItem ? matchedItem.name.replace(/"/g, '&quot;') : ''}" />
        <input type="hidden" class="item-id-input" name="itemId" value="${matchedItem ? matchedItem.id : ''}" />
        <ul class="item-results"></ul>
      </div>
      <div class="new-item-fields" style="${startNew ? '' : 'display:none;'}">
        <label>New item name</label>
        <input type="text" class="new-item-name" name="newItemName" value="${(unmatchedName || '').replace(/"/g, '&quot;')}" />
        <label>Price ($)</label>
        <input type="number" class="new-item-price" name="newItemPrice" step="0.01" min="0" placeholder="e.g. 7.00" />
        <input type="hidden" class="new-item-code" name="newItemCode" value="${(unmatchedCode || '').replace(/"/g, '&quot;')}" />
      </div>
      <p class="subtitle" style="margin: 6px 0 0;">
        <a href="#" class="toggle-mode-btn">${startNew ? 'Search existing items instead' : "Can't find it? Add as a new item"}</a>
      </p>
      <label>Drinks to add</label>
      <input type="number" class="drinks-input" name="drinksToAdd" step="1" min="1" value="${drinksValue}" />
      ${receiptNote ? `<p class="subtitle" style="margin: 6px 0 0;">${receiptNote}</p>` : ''}
      <button type="button" class="remove-row-btn danger">Remove item</button>
    </div>`;
}

const app = express();
// Render actually sits behind TWO proxy hops in front of the app — Cloudflare,
// then Render's own edge — confirmed by logging a real request's
// X-Forwarded-For in production: "<real client IP>, <Cloudflare edge IP>".
// Without trusting proxies at all, req.protocol would report 'http' even on
// the real https:// site (breaking the Twilio signature check below, which
// signs against the actual public https URL) and mislabel uploaded photo
// URLs as http://. Trusting exactly 2 hops (not `true`, which trusts an
// unlimited chain and lets a client spoof its own IP to dodge the rate
// limiter below) resolves req.ip to the real, stable client IP rather than
// Cloudflare's own edge node, which changes on every request.
app.set('trust proxy', 2);
app.use(express.urlencoded({ extended: false })); // form submissions + Twilio webhook
app.use(express.static(path.join(__dirname, 'public')));

// Confirms an incoming /sms/* request actually came from Twilio (checks its
// cryptographic signature against our auth token, the exact URL, and the
// posted params) rather than trusting whatever "From" number is in the body
// — without this, anyone who knows these endpoints (this repo is public on
// GitHub) could forge a request claiming to be any phone number, e.g. an
// owner "approving" a price change or a bartender "claiming" a shift that
// was never actually texted in. Skipped in TWILIO_DRY_RUN, the same flag
// src/sms.js already uses to mean "no real Twilio in the loop" — otherwise
// local testing (curl'ing these routes directly) would always fail.
function verifyTwilioRequest(req, res, next) {
  if (process.env.TWILIO_DRY_RUN === 'true') return next();
  const signature = req.headers['x-twilio-signature'];
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const valid = signature && twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body);
  if (!valid) {
    console.error(`Rejected ${req.path}: invalid or missing Twilio signature.`);
    return res.status(403).send('Invalid signature.');
  }
  next();
}

// Slows down passcode-guessing on the login forms. Keyed per-IP by default;
// a real bartender/owner mistyping their passcode a few times in 15 minutes
// never comes close to this. On the limit, redirects back to the same page
// with the usual error-banner rather than express-rate-limit's default
// plain-text response, for consistency with the rest of the app.
function rateLimitHandler(req, res) {
  res.redirect(`${req.path}?error=${encodeURIComponent('Too many attempts. Please wait a few minutes and try again.')}`);
}
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});
// The master passcode grants full owner access on its own (see
// /admin/master-login below), so it gets a tighter limit than the
// per-bartender/per-owner logins above.
const masterLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

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

// Every ?error= banner below echoes a URL query param straight into the
// page - without this, a crafted link like /login?error=<script>... would
// run arbitrary JS in whoever clicks it, even before they've logged in.
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function dollarsToCents(dollarsStr) {
  return Math.round(parseFloat(dollarsStr) * 100);
}

// Big button-style nav for owner-facing admin pages, matching the size/look
// of a page's own submit button (e.g. "Add bartender") rather than small
// inline text links. The current page's own link stays in the list (rather
// than being omitted). Owners is left out of this list on purpose (see
// ownerSubtitleHtml below) since it's used rarely enough that it doesn't
// need a full-width button.
const OWNER_NAV_LINKS = [
  { key: 'inventory', href: '/inventory/new', label: 'Inventory' },
  { key: 'bartenders', href: '/admin/bartenders', label: 'Add/Delete Bartenders' },
  { key: 'schedule', href: '/admin/schedule', label: 'Change Bartender Schedule' },
  { key: 'calendar', href: '/admin/calendar', label: "Who's Working When" },
];

// Buttons all start yellow; tapping one turns it red and keeps it red across
// the page load it navigates to, via sessionStorage (this is a plain
// server-rendered multi-page app, so there's no in-memory client state to
// carry that across a navigation otherwise). Fresh logins pass ?login=1 to
// clear any stale selection left over from a previous session in the same
// browser tab, so the very first page after signing in is all yellow.
function ownerNavHtml() {
  const buttons = OWNER_NAV_LINKS.map((l) => `<a href="${l.href}" class="menu-link" data-nav-key="${l.key}">${l.label}</a>`).join('');
  return `${buttons}<a href="/admin/logout" class="menu-link">Sign out</a>
    <script>
      (function () {
        var params = new URLSearchParams(location.search);
        if (params.has('login')) {
          sessionStorage.removeItem('ownerNavSelected');
          params.delete('login');
          var qs = params.toString();
          history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
        }
        var selected = sessionStorage.getItem('ownerNavSelected');
        document.querySelectorAll('.menu-link[data-nav-key]').forEach(function (link) {
          if (link.dataset.navKey === selected) link.classList.add('current');
          link.addEventListener('click', function () {
            sessionStorage.setItem('ownerNavSelected', link.dataset.navKey);
          });
        });
      })();
    </script>`;
}

// Owners and Coverage stay small inline links next to "Signed in as",
// like the nav looked before the big-button redesign, rather than full-width
// buttons — both are occasional admin tasks, not everyday ones.
function ownerSubtitleHtml(ownerName, currentPage) {
  const ownersLink = currentPage === 'owners' ? '' : ' · <a href="/admin/owners">Owners</a>';
  const coverageLink = currentPage === 'coverage' ? '' : ' · <a href="/admin/coverage">Coverage</a>';
  return `Signed in as ${ownerName}${ownersLink}${coverageLink}`;
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

// Gates access behind /consent for any bartender who hasn't re-accepted
// the current SMS consent script yet (added before it changed, or never
// stamped at all). Must run after requireBartenderAuth.
function requireCurrentConsent(req, res, next) {
  if ((req.bartender.smsConsentVersion || 0) >= SMS_CONSENT_VERSION) return next();
  res.redirect('/consent');
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
        ${req.query.error ? `<div class="error-banner">${escapeHtml(req.query.error)}</div>` : ''}
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
app.post('/login', loginLimiter, (req, res) => {
  const { phone, passcode } = req.body;
  const bartender = phone && db.findBartenderByPhone(phone.trim());

  if (!bartender || !passcode || !auth.verifyPasscode(passcode, bartender.passcodeHash)) {
    return res.redirect('/login?error=' + encodeURIComponent('Phone number or passcode not recognized.'));
  }

  const token = auth.newToken();
  db.addSession({ token, bartenderId: bartender.id, createdAt: Date.now() });
  auth.setCookie(res, auth.SESSION_COOKIE, token, auth.SESSION_TTL_MS);
  res.redirect('/menu');
});

// --- GET /consent — re-opt-in prompt for the current SMS consent script ---
app.get('/consent', requireBartenderAuth, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Confirm text updates</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="card">
        <h1>Before you continue</h1>
        <p class="subtitle">
          We're adding shift-coverage texts, sent from a second, separate number from your
          existing specials-approval texts. Please confirm you're okay with that before signing
          back in.
        </p>
        <p>
          "We're adding a second number for shift-coverage texts — separate from the
          specials-approval number you're already signed up for. You'll get a text if an open
          shift needs covering, and a confirmation once someone picks it up. Message and data
          rates may apply. You can reply STOP at any time to stop receiving these texts. Do you
          agree to receive these texts at this number?"
        </p>
        <p class="subtitle">
          Full details: <a href="/sms-consent.html" target="_blank">SMS Consent Process</a>
        </p>
        <form method="POST" action="/consent">
          <button type="submit" name="decision" value="accept">I agree — continue</button>
        </form>
        <form method="POST" action="/consent" style="margin-top: 10px;">
          <button type="submit" name="decision" value="decline" class="danger">
            I don't agree — sign me out
          </button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// --- POST /consent — record acceptance (or decline) of the current script ---
app.post('/consent', requireBartenderAuth, (req, res) => {
  if (req.body.decision !== 'accept') {
    const cookies = auth.parseCookies(req);
    const token = cookies[auth.SESSION_COOKIE];
    if (token) db.removeSession(token);
    auth.clearCookie(res, auth.SESSION_COOKIE);
    return res.redirect('/login?error=' + encodeURIComponent(
      'You need to agree to the updated text terms to keep using this system — talk to a manager if you have questions.'
    ));
  }

  db.setBartenderConsentVersion(req.bartender.id, SMS_CONSENT_VERSION);
  res.redirect('/menu');
});

// --- GET /menu — bartender picks what to do ---
app.get('/menu', requireBartenderAuth, requireCurrentConsent, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Menu</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="card">
        <h1>What would you like to do?</h1>
        <p class="subtitle">
          Signed in as ${req.bartender.name} · <a href="/logout">not you?</a>
        </p>
        <a href="/specials/new" class="menu-link">Pick Specials</a>
        <a href="/social/new" class="menu-link">Make a Social Post</a>
        <a href="/shifts" class="menu-link">Get Shift Covered</a>
      </div>
    </body>
    </html>
  `);
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
app.get('/specials/new', requireBartenderAuth, requireCurrentConsent, async (req, res) => {
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
            Signed in as ${req.bartender.name} · <a href="/menu">Menu</a> · <a href="/logout">not you?</a>
          </p>
          <form method="POST" action="/specials/new" id="specialForm">
            <div id="itemRows"></div>
            <button type="button" id="addRowBtn" class="secondary-btn">+ Add another item</button>

            <button type="submit">Send for approval</button>
          </form>
        </div>

        <script>
          const items = ${itemsJson};
          const MAX_ROWS = 16;
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

// --- POST /specials/new — bartender submits the form (up to 16 items, one approval code) ---
app.post('/specials/new', requireBartenderAuth, requireCurrentConsent, async (req, res) => {
  const bartenderName = req.bartender.name;
  const bartenderPhone = req.bartender.phone;
  const itemIds = [].concat(req.body.itemId || []).filter(Boolean);
  const specialPrices = [].concat(req.body.specialPrice || []);

  if (itemIds.length === 0) {
    return res.status(400).send('At least one item is required.');
  }
  if (itemIds.length > 16) {
    return res.status(400).send('You can submit at most 16 items at once.');
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
      'Wait for it to be approved or denied before submitting another.'
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
      bartenderPhone,
      items,
      createdAt: Date.now(),
    };
    db.addPendingRequest(request);

    const itemLines = items
      .map((i) => `- ${i.itemName} at ${formatMoney(i.specialPriceCents)} (normally ${formatMoney(i.originalPrice)})`)
      .join('\n');

    await sms.notifyApprovers(
      `${bartenderName} wants to special:\n${itemLines}\n` +
      `Reply YES ${request.id} to approve, or NO ${request.id} to deny.`
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
          <p><a href="/menu">Back to menu</a></p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`Something went wrong: ${err.message}`);
  }
});

// --- GET /social/new — bartender posts a photo to Facebook + Instagram ---
app.get('/social/new', requireBartenderAuth, requireCurrentConsent, (req, res) => {
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
          Signed in as ${req.bartender.name} · <a href="/menu">Menu</a>
        </p>
        ${req.query.error ? `<div class="error-banner">${escapeHtml(req.query.error)}</div>` : ''}
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
app.post('/social/new', requireBartenderAuth, requireCurrentConsent, upload.single('photo'), async (req, res) => {
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
          <p><a href="/menu">Back to menu</a></p>
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
        <div id="uploadView">
          <h1>Add inventory from a receipt</h1>
          <p class="subtitle">${ownerSubtitleHtml(req.owner.name, 'inventory')}</p>
          ${ownerNavHtml()}
          ${req.query.error ? `<div class="error-banner">${escapeHtml(req.query.error)}</div>` : ''}
          <form method="POST" action="/inventory/new" enctype="multipart/form-data" id="receiptForm">
            <label for="receipt">Receipt photo</label>
            <input type="file" id="receipt" name="receipt" accept="image/jpeg,image/png" required />

            <button type="submit">Import Items</button>
          </form>
          <p class="subtitle"><a href="/inventory/new">Cancel</a></p>
        </div>
        <div id="loadingView" class="loading-view">
          <div class="spinner-beer">🍺</div>
          <p class="subtitle">Reading your receipt…</p>
          <p class="subtitle"><a href="/inventory/new">Cancel</a></p>
        </div>
      </div>

      <script>
        document.getElementById('receiptForm').addEventListener('submit', () => {
          if (!document.getElementById('receipt').files.length) return;
          document.getElementById('uploadView').style.display = 'none';
          document.getElementById('loadingView').style.display = 'block';
        });

        // If the browser restores this page from cache (e.g. hitting Back
        // after submitting), reset back to the upload view instead of
        // leaving the spinner frozen with nothing left to hide it.
        window.addEventListener('pageshow', (event) => {
          if (event.persisted) {
            document.getElementById('uploadView').style.display = 'block';
            document.getElementById('loadingView').style.display = 'none';
            document.getElementById('receiptForm').reset();
          }
        });
      </script>
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
        // Liquor gets converted to pours per bottle; anything else (beer,
        // seltzer, cider cans/bottles) is sold and counted as one drink per
        // unit, so the count itself is the right default rather than blank.
        const drinks =
          line.sizeMl === 750 ? line.count * DRINKS_PER_750ML
          : line.sizeMl === 1000 ? line.count * DRINKS_PER_1L
          : line.count;
        const lookupName = line.displayName || line.name;
        const match = findBestItemMatch(lookupName, items, line.code);
        const sizeLabel = line.sizeMl ? `${line.sizeMl}ml` : (line.rawSize || 'unknown size');
        const codeNote = line.code ? ` (code ${line.code})` : '';
        const nameNote = lookupName !== line.name ? `"${line.name}" → ${lookupName}` : `"${line.name}"`;
        const caseNote = line.caseCount && line.unitsPerCase
          ? ` (${line.caseCount} case${line.caseCount === 1 ? '' : 's'} × ${line.unitsPerCase}/case)`
          : '';
        const receiptNote = `From receipt: ${nameNote}${codeNote} — ${line.count}${caseNote} × ${sizeLabel}`;

        return renderInventoryRow(i, match, drinks, receiptNote, match ? null : lookupName, line.code);
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
          <p class="subtitle"><a href="/inventory/new">Cancel</a></p>
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
            const toggleBtn = row.querySelector('.toggle-mode-btn');
            const existingFields = row.querySelector('.existing-item-fields');
            const newFields = row.querySelector('.new-item-fields');

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

            toggleBtn.addEventListener('click', (e) => {
              e.preventDefault();
              const goingNew = row.dataset.mode !== 'new';
              row.dataset.mode = goingNew ? 'new' : 'existing';
              existingFields.style.display = goingNew ? 'none' : 'block';
              newFields.style.display = goingNew ? 'block' : 'none';
              toggleBtn.textContent = goingNew ? 'Search existing items instead' : "Can't find it? Add as a new item";
              if (goingNew) hiddenInput.value = '';
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
            row.dataset.mode = 'existing';
            row.innerHTML = \`
              <label>Item</label>
              <div class="item-picker existing-item-fields">
                <input type="text" class="item-search" autocomplete="off" placeholder="Search items…" />
                <input type="hidden" class="item-id-input" name="itemId" />
                <ul class="item-results"></ul>
              </div>
              <div class="new-item-fields" style="display:none;">
                <label>New item name</label>
                <input type="text" class="new-item-name" name="newItemName" />
                <label>Price ($)</label>
                <input type="number" class="new-item-price" name="newItemPrice" step="0.01" min="0" placeholder="e.g. 7.00" />
                <input type="hidden" class="new-item-code" name="newItemCode" />
              </div>
              <p class="subtitle" style="margin: 6px 0 0;">
                <a href="#" class="toggle-mode-btn">Can't find it? Add as a new item</a>
              </p>
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

          function rowIsFilled(r) {
            const drinks = r.querySelector('.drinks-input').value;
            if (!drinks) return false;
            if (r.dataset.mode === 'new') {
              return r.querySelector('.new-item-name').value && r.querySelector('.new-item-price').value;
            }
            return !!r.querySelector('.item-id-input').value;
          }

          document.getElementById('inventoryForm').addEventListener('submit', (e) => {
            const rows = Array.from(document.querySelectorAll('.item-row'));
            const filled = rows.filter(rowIsFilled);
            if (filled.length === 0) {
              e.preventDefault();
              alert('Add at least one item with a quantity.');
              return;
            }
            if (filled.length !== rows.length) {
              e.preventDefault();
              alert('Finish or remove any row that\\'s missing an item (or new item name + price) and a quantity.');
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
  // Every row submits all five fields (empty string for whichever mode isn't
  // active), so these stay positionally aligned row-for-row.
  const itemIds = [].concat(req.body.itemId || []);
  const newItemNames = [].concat(req.body.newItemName || []);
  const newItemPrices = [].concat(req.body.newItemPrice || []);
  const newItemCodes = [].concat(req.body.newItemCode || []);
  const drinksToAdd = [].concat(req.body.drinksToAdd || []).map((n) => parseInt(n, 10));

  const rowCount = drinksToAdd.length;
  if (rowCount === 0) {
    return res.status(400).send('At least one item is required.');
  }
  if (drinksToAdd.some((n) => !Number.isFinite(n) || n <= 0)) {
    return res.status(400).send('Quantity must be a positive whole number for every item.');
  }
  const newItemPriceCents = newItemPrices.map(dollarsToCents);
  for (let i = 0; i < rowCount; i++) {
    if (!itemIds[i] && !(newItemNames[i] && Number.isFinite(newItemPriceCents[i]) && newItemPriceCents[i] >= 0)) {
      return res.status(400).send(`Every row needs either an existing item, or a new item name + valid price.`);
    }
  }

  // Each row is its own Clover round-trip (or two, for a brand-new item),
  // fired sequentially with no gap between them — on a receipt with several
  // lines this can trip Clover's rate limit. Catch failures per row instead
  // of letting one bad row throw away every row that already succeeded.
  const succeeded = [];
  const failed = [];
  for (let i = 0; i < rowCount; i++) {
    try {
      let item;
      if (itemIds[i]) {
        item = await clover.getItem(itemIds[i]);
      } else {
        item = await clover.createItem(newItemNames[i], newItemPriceCents[i], newItemCodes[i]);
      }
      const newQuantity = await clover.addToItemStock(item.id, drinksToAdd[i]);
      const newTag = itemIds[i] ? '' : ' (new item)';
      succeeded.push(`${item.name}${newTag}: +${drinksToAdd[i]} (now ${newQuantity})`);
    } catch (err) {
      const label = itemIds[i] ? itemIds[i] : newItemNames[i];
      failed.push(`${label}: ${err.message}`);
    }
  }

  const summaryHtml = [
    ...succeeded.map((line) => `✅ ${line}`),
    ...failed.map((line) => `❌ ${line}`),
  ].join('<br>');

  res.status(failed.length > 0 ? 207 : 200).send(`
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
        <div class="big">${failed.length > 0 ? '⚠️' : '✅'}</div>
        <p>${summaryHtml}</p>
        ${failed.length > 0 ? `<p class="subtitle">${failed.length} item${failed.length > 1 ? 's' : ''} failed — the ones marked ✅ above were still added. Retry the failed ones separately.</p>` : ''}
        <p><a href="/inventory/new">Back to Inventory</a></p>
      </div>
    </body>
    </html>
  `);
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
        ${req.query.error ? `<div class="error-banner">${escapeHtml(req.query.error)}</div>` : ''}
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

app.post('/admin/login', loginLimiter, (req, res) => {
  const { phone, passcode } = req.body;
  const owner = phone && db.findOwnerByPhone(phone.trim());

  if (!owner || !passcode || !auth.verifyPasscode(passcode, owner.passcodeHash)) {
    return res.redirect('/admin/login?error=' + encodeURIComponent('Phone number or passcode not recognized.'));
  }

  const token = auth.newToken();
  db.addOwnerSession({ token, ownerId: owner.id, createdAt: Date.now() });
  auth.setCookie(res, auth.ADMIN_COOKIE, token, auth.SESSION_TTL_MS);
  res.redirect('/inventory/new?login=1');
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
        ${req.query.error ? `<div class="error-banner">${escapeHtml(req.query.error)}</div>` : ''}
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

app.post('/admin/master-login', masterLoginLimiter, (req, res) => {
  if (!process.env.OWNER_PASSCODE || req.body.passcode !== process.env.OWNER_PASSCODE) {
    return res.redirect('/admin/master-login?error=' + encodeURIComponent('Incorrect passcode.'));
  }
  const token = auth.newToken();
  db.addOwnerSession({ token, ownerId: 'master', createdAt: Date.now() });
  auth.setCookie(res, auth.ADMIN_COOKIE, token, auth.SESSION_TTL_MS);
  res.redirect('/admin/owners?login=1');
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
        <p class="subtitle">${ownerSubtitleHtml(req.owner.name, 'owners')}</p>
        ${ownerNavHtml()}
        ${req.query.error ? `<div class="error-banner">${escapeHtml(req.query.error)}</div>` : ''}

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
        <p class="subtitle">${ownerSubtitleHtml(req.owner.name, 'bartenders')}</p>
        ${ownerNavHtml()}
        ${req.query.error ? `<div class="error-banner">${escapeHtml(req.query.error)}</div>` : ''}
        ${req.query.fixed ? `<div class="subtitle" style="color: var(--accent);">Fixed ${escapeHtml(req.query.fixed)} phone number(s) — passcodes untouched.</div>` : ''}

        <ul class="bartender-list">${rows || '<li class="subtitle">No bartenders added yet.</li>'}</ul>

        <form method="POST" action="/admin/bartenders/normalize-phones">
          <button type="submit" class="secondary-btn">Fix phone number formatting</button>
        </form>

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

// --- POST /admin/bartenders/normalize-phones — fixes a stray leading "+1"
// on any bartender's stored phone (breaks outbound texts) without touching
// their passcode or requiring them to be removed and re-added. ---
app.post('/admin/bartenders/normalize-phones', requireOwnerAuth, (req, res) => {
  const fixed = db.normalizeAllBartenderPhones();
  res.redirect('/admin/bartenders?fixed=' + fixed);
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
    // Owner reads the current script live when adding them, so no /consent gate needed.
    smsConsentVersion: SMS_CONSENT_VERSION,
    consentAcceptedAt: Date.now(),
  });

  res.redirect('/admin/bartenders');
});

app.post('/admin/bartenders/:id/delete', requireOwnerAuth, (req, res) => {
  db.removeBartender(req.params.id);
  res.redirect('/admin/bartenders');
});

const SHIFT_LABELS = { day: 'Day', night: 'Night', allDay: 'All day', both: 'Day + Night' };

// A coverage request's shiftType is normally a real schedule slot type
// ('day'/'night'/'allDay'), but 'both' is a request-only value meaning "the
// day and night shifts together, as one give-away" for a bartender who is
// scheduled for both individually. This returns which slot(s) it actually
// covers, so two requests that overlap (e.g. a lone 'day' request and a
// 'both' request) can be treated as conflicting. 'allDay' is treated the
// same as 'both' here — it's one continuous shift spanning both halves of
// the day, so a bartender holding it can give up just the day portion, just
// the night portion, or the whole thing, exactly like someone individually
// scheduled for both 'day' and 'night'.
function slotsCoveredBy(shiftType) {
  return (shiftType === 'both' || shiftType === 'allDay') ? ['day', 'night'] : [shiftType];
}

// Every virtual "half-day" slot a bartender actually covers on a given day,
// expanding any 'allDay' assignment into its day+night halves so a partial
// give-up request against it can be recognized as their own shift.
function coveredSlots(realShiftTypes) {
  const set = new Set();
  for (const t of realShiftTypes) for (const slot of slotsCoveredBy(t)) set.add(slot);
  return set;
}
const DAY_LABELS = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday',
  friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

// --- GET /admin/schedule — owner sets the recurring weekly roster ---
app.get('/admin/schedule', requireOwnerAuth, (req, res) => {
  const schedule = db.getSchedule();
  const bartenders = db.getBartenders();

  const optionsHtml = (selectedId) =>
    `<option value="">— unassigned —</option>` +
    bartenders.map((b) => `<option value="${b.id}"${b.id === selectedId ? ' selected' : ''}>${b.name}</option>`).join('');

  const rowsHtml = db.DAYS.map((day) => `
    <div class="schedule-day">
      <h2>${DAY_LABELS[day]}</h2>
      ${db.SHIFT_TYPES.map((shiftType) => `
        <label for="${day}-${shiftType}">${SHIFT_LABELS[shiftType]}</label>
        <select id="${day}-${shiftType}" name="${day}-${shiftType}">
          ${optionsHtml(schedule[day][shiftType])}
        </select>
      `).join('')}
    </div>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Weekly Schedule</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="card">
        <h1>Weekly Schedule</h1>
        <p class="subtitle">${ownerSubtitleHtml(req.owner.name, 'schedule')}</p>
        ${ownerNavHtml()}
        <p class="subtitle">This repeats every week. Bartenders see only their own shifts and can request coverage from here.</p>
        ${req.query.saved ? `<div class="subtitle" style="color: var(--accent);">Schedule saved.</div>` : ''}

        <form method="POST" action="/admin/schedule">
          ${rowsHtml}
          <button type="submit">Save schedule</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// --- POST /admin/schedule — save the whole grid at once ---
app.post('/admin/schedule', requireOwnerAuth, (req, res) => {
  for (const day of db.DAYS) {
    for (const shiftType of db.SHIFT_TYPES) {
      const bartenderId = req.body[`${day}-${shiftType}`] || null;
      db.setScheduleSlot(day, shiftType, bartenderId);
    }
  }
  res.redirect('/admin/schedule?saved=1');
});

// --- GET /admin/coverage — owner view of shift-coverage requests, with a
// way to cancel one that's stuck (e.g. a reply landed on the wrong webhook
// and never advanced) instead of it sitting there blocking a fresh attempt.
app.get('/admin/coverage', requireOwnerAuth, (req, res) => {
  const requests = db.getCoverageRequests();
  const rowsHtml = requests.length
    ? requests.map((r) => `
        <li class="bartender-row">
          <div>
            <strong>${escapeHtml(r.dateLabel)} (${escapeHtml(SHIFT_LABELS[r.shiftType] || r.shiftType)}) · code ${escapeHtml(r.id)}</strong>
            <div class="subtitle">
              ${escapeHtml(r.bartenderName)} gave it up · status: ${escapeHtml(r.status)}
              ${r.claimedByName ? ` · claimed by ${escapeHtml(r.claimedByName)}, waiting on approval` : ''}
            </div>
          </div>
          <form method="POST" action="/admin/coverage/${encodeURIComponent(r.id)}/cancel">
            <button type="submit" class="danger">Cancel</button>
          </form>
        </li>`).join('')
    : '<li class="subtitle">No open shift-coverage requests.</li>';

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Coverage Requests</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="card">
        <h1>Coverage Requests</h1>
        <p class="subtitle">${ownerSubtitleHtml(req.owner.name, 'coverage')}</p>
        ${ownerNavHtml()}
        <p class="subtitle">Cancel a request if it gets stuck instead of waiting on it.</p>
        <ul class="bartender-list">${rowsHtml}</ul>
      </div>
    </body>
    </html>
  `);
});

// --- POST /admin/coverage/:id/cancel — remove a stuck/unwanted request ---
app.post('/admin/coverage/:id/cancel', requireOwnerAuth, (req, res) => {
  db.removeCoverageRequest(req.params.id);
  res.redirect('/admin/coverage');
});

// Returns the date of the next upcoming occurrence of dayName (today counts
// as "upcoming" if it hasn't fully passed — simplest correct behavior for a
// same-day request is to still treat today as the next occurrence).
function nextOccurrenceOf(dayName) {
  const targetIndex = db.DAYS.indexOf(dayName); // 0 = Monday
  const now = new Date();
  const todayIndex = (now.getDay() + 6) % 7; // convert Sunday=0 to Monday=0
  let daysAhead = (targetIndex - todayIndex + 7) % 7;
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead);
  return date;
}

// The recurring schedule is a fixed weekly pattern, so a bartender's Monday
// shift is really "every Monday" — this returns the next `count` real
// calendar dates that land on dayName, one week apart, so bartenders/owners
// can look (and give up a shift) further out than just the next occurrence.
const SHIFT_LOOKAHEAD_WEEKS = 52; // "on the calendar for the year"
function occurrencesOf(dayName, count) {
  const first = nextOccurrenceOf(dayName);
  const dates = [];
  for (let i = 0; i < count; i++) {
    dates.push(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i * 7));
  }
  return dates;
}

function formatDateLong(date) {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// Local (not UTC) yyyy-mm-dd key, used as the <option> value in date
// dropdowns and stored on a coverage request to identify the exact
// occurrence being given up — distinct from `day`, which only names the
// recurring weekday.
function dateKeyOf(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Full weekly roster, read-only — who's working each day/shift, for the
// "Calendar" view both bartenders and owners can see (as opposed to
// /admin/schedule's editable dropdowns, or /shifts' bartender-only view).
// Shown chronologically (not grouped by weekday name) since a bartender
// looking several weeks or months out wants an actual calendar order.
function calendarBodyHtml(weeks) {
  const schedule = db.getSchedule();
  const overrides = db.getScheduleOverrides();
  const nameById = new Map(db.getBartenders().map((b) => [b.id, b.name]));

  const entries = [];
  for (const day of db.DAYS) {
    for (const date of occurrencesOf(day, weeks)) entries.push({ day, date });
  }
  entries.sort((a, b) => a.date - b.date);

  return entries.map(({ day, date }) => {
    // An approved coverage swap overrides just this one date (see
    // db.setScheduleOverride, set in /sms/shift-incoming's owner-approval
    // branch) without touching the recurring weekly schedule below it.
    const dateOverrides = overrides[dateKeyOf(date)] || {};
    const rows = db.SHIFT_TYPES.map((shiftType) => {
      const regularId = schedule[day][shiftType];
      const regularName = regularId ? (nameById.get(regularId) || 'Unknown') : null;
      const overrideId = dateOverrides[shiftType];
      if (overrideId) {
        const overrideName = nameById.get(overrideId) || 'Unknown';
        const coveringNote = regularName && regularName !== overrideName ? ` (covering for ${regularName})` : '';
        return `<p class="subtitle">${SHIFT_LABELS[shiftType]}: ${overrideName}${coveringNote}</p>`;
      }
      return `<p class="subtitle">${SHIFT_LABELS[shiftType]}: ${regularName || '— unassigned —'}</p>`;
    }).join('');
    return `
      <div class="schedule-day">
        <h2>${formatDateLong(date)}</h2>
        ${rows}
      </div>`;
  }).join('');
}

// Shown by default; a link on the page expands it to the full year, since
// listing 52 weeks x 7 days up front would be a very long page to load and
// scroll through for what's usually a same-every-week roster.
const CALENDAR_DEFAULT_WEEKS = 8;

function calendarWeeksToggleHtml(weeks, baseHref) {
  return weeks >= SHIFT_LOOKAHEAD_WEEKS
    ? `<p class="subtitle"><a href="${baseHref}">Show fewer weeks</a></p>`
    : `<p class="subtitle"><a href="${baseHref}?weeks=${SHIFT_LOOKAHEAD_WEEKS}">Show the full year</a></p>`;
}

// --- GET /calendar — bartender-facing read-only view of the full roster ---
app.get('/calendar', requireBartenderAuth, requireCurrentConsent, (req, res) => {
  const weeks = req.query.weeks === String(SHIFT_LOOKAHEAD_WEEKS) ? SHIFT_LOOKAHEAD_WEEKS : CALENDAR_DEFAULT_WEEKS;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Calendar</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="card">
        <h1>Calendar</h1>
        <p class="subtitle">
          Signed in as ${req.bartender.name} · <a href="/menu">Back to menu</a>
        </p>
        ${calendarWeeksToggleHtml(weeks, '/calendar')}
        ${calendarBodyHtml(weeks)}
      </div>
    </body>
    </html>
  `);
});

// --- GET /admin/calendar — owner-facing read-only view of the full roster ---
app.get('/admin/calendar', requireOwnerAuth, (req, res) => {
  const weeks = req.query.weeks === String(SHIFT_LOOKAHEAD_WEEKS) ? SHIFT_LOOKAHEAD_WEEKS : CALENDAR_DEFAULT_WEEKS;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Calendar</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="card">
        <h1>Calendar</h1>
        <p class="subtitle">${ownerSubtitleHtml(req.owner.name, 'calendar')}</p>
        ${ownerNavHtml()}
        ${calendarWeeksToggleHtml(weeks, '/admin/calendar')}
        ${calendarBodyHtml(weeks)}
      </div>
    </body>
    </html>
  `);
});

// --- GET /shifts — bartender's own upcoming shifts, with a way to give one away ---
app.get('/shifts', requireBartenderAuth, requireCurrentConsent, (req, res) => {
  const myShifts = db.getBartenderShifts(req.bartender.id);
  const myOpenRequests = db.getCoverageRequests().filter((r) => r.bartenderId === req.bartender.id && r.status !== 'denied');

  const pendingHtml = myOpenRequests.length
    ? `<div class="subtitle" style="margin-bottom: 20px;">
        <strong>Pending requests:</strong><br/>
        ${myOpenRequests.map((r) =>
          `${r.dateLabel} (${SHIFT_LABELS[r.shiftType]}) — ${
            r.status === 'claimed' ? `claimed by ${r.claimedByName}, waiting on an owner` : 'waiting for someone to claim it'
          }`
        ).join('<br/>')}
      </div>`
    : '';

  // Group by day so a bartender working both Day and Night the same day can
  // give up either one, or both together as a single "Day + Night" request.
  const byDay = {};
  for (const { day, shiftType } of myShifts) {
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(shiftType);
  }

  const rowsHtml = Object.keys(byDay).length
    ? db.DAYS.filter((day) => byDay[day]).map((day) => {
        const shiftTypes = byDay[day];
        const hasAllDay = shiftTypes.includes('allDay');
        const hasBoth = shiftTypes.includes('day') && shiftTypes.includes('night');
        // A lone 'allDay' shift can be given up as just its day half, just
        // its night half, or the whole thing — same three-way choice as
        // being individually scheduled for both 'day' and 'night'.
        const offerDay = shiftTypes.includes('day') || hasAllDay;
        const offerNight = shiftTypes.includes('night') || hasAllDay;

        const buttons = [];
        if (offerDay) buttons.push(`<button type="submit" name="shiftType" value="day" class="danger">Give up Day</button>`);
        if (offerNight) buttons.push(`<button type="submit" name="shiftType" value="night" class="danger">Give up Night</button>`);
        if (hasBoth) buttons.push(`<button type="submit" name="shiftType" value="both" class="danger">Give up Day + Night</button>`);
        if (hasAllDay) buttons.push(`<button type="submit" name="shiftType" value="allDay" class="danger">Give up All day</button>`);

        const dateOptionsHtml = occurrencesOf(day, SHIFT_LOOKAHEAD_WEEKS)
          .map((d) => `<option value="${dateKeyOf(d)}">${formatDateLong(d)}</option>`)
          .join('');

        return `
          <div class="bartender-row" style="flex-direction: column; align-items: stretch; gap: 10px;">
            <strong>${DAY_LABELS[day]} · ${shiftTypes.map((st) => SHIFT_LABELS[st]).join(' + ')}</strong>
            <form method="POST" action="/shifts/cover">
              <input type="hidden" name="day" value="${day}" />
              <label for="date-${day}">Which date?</label>
              <select id="date-${day}" name="date">${dateOptionsHtml}</select>
              <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;">
                ${buttons.join('')}
              </div>
            </form>
          </div>`;
      }).join('')
    : '<p class="subtitle">You have no shifts on the schedule yet — check with an owner.</p>';

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>My Shifts</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <div class="card">
        <h1>My Shifts</h1>
        <p class="subtitle">
          Signed in as ${req.bartender.name} · <a href="/calendar">Calendar</a> · <a href="/menu">Back to menu</a>
        </p>
        ${req.query.sent ? `<div class="subtitle" style="color: var(--accent);">Sent to the other bartenders.</div>` : ''}
        ${req.query.error ? `<div class="error-banner">${escapeHtml(req.query.error)}</div>` : ''}
        ${pendingHtml}
        <div class="bartender-list">${rowsHtml}</div>
      </div>
    </body>
    </html>
  `);
});

// --- POST /shifts/cover — bartender asks the other bartenders to take a shift ---
app.post('/shifts/cover', requireBartenderAuth, requireCurrentConsent, async (req, res) => {
  const { day, shiftType, date } = req.body;
  const validShiftType = db.SHIFT_TYPES.includes(shiftType) || shiftType === 'both';
  if (!db.DAYS.includes(day) || !validShiftType) {
    return res.redirect('/shifts?error=' + encodeURIComponent('Invalid shift.'));
  }

  // Confirm the submitted date is actually a real upcoming occurrence of
  // that weekday, rather than trusting the client — defends against a
  // tampered form value pointing at some unrelated date.
  const validDates = new Set(occurrencesOf(day, SHIFT_LOOKAHEAD_WEEKS).map(dateKeyOf));
  if (!validDates.has(date)) {
    return res.redirect('/shifts?error=' + encodeURIComponent('Pick a valid upcoming date.'));
  }

  const myShiftTypesThatDay = db.getBartenderShifts(req.bartender.id)
    .filter((s) => s.day === day)
    .map((s) => s.shiftType);
  const requestedSlots = slotsCoveredBy(shiftType);
  const myCoveredSlots = coveredSlots(myShiftTypesThatDay);
  const mine = requestedSlots.every((slot) => myCoveredSlots.has(slot));
  if (!mine) {
    return res.redirect('/shifts?error=' + encodeURIComponent('That is not one of your shifts.'));
  }

  // Conflicts are checked against this specific date, not just the weekday —
  // giving up "Monday" three weeks out doesn't touch next Monday's slot.
  const alreadyOpen = db.getCoverageRequests()
    .filter((r) => r.date === date && r.status !== 'denied')
    .some((r) => slotsCoveredBy(r.shiftType).some((slot) => requestedSlots.includes(slot)));
  if (alreadyOpen) {
    return res.redirect('/shifts?error=' + encodeURIComponent('A coverage request overlapping that date is already pending.'));
  }

  const request = {
    id: String(db.nextCoverageRequestNumber()),
    bartenderId: req.bartender.id,
    bartenderName: req.bartender.name,
    bartenderPhone: req.bartender.phone,
    day,
    date,
    shiftType,
    dateLabel: formatDateLong(parseDateKey(date)),
    status: 'open',
    createdAt: Date.now(),
  };
  db.addCoverageRequest(request);

  await sms.notifyBartendersShift(
    `${req.bartender.name} wants to give up ${request.dateLabel} (${SHIFT_LABELS[shiftType]}) — would you like this shift? ` +
    `Reply YES ${request.id} to take it.`,
    [req.bartender.id]
  );

  res.redirect('/shifts?sent=1');
});

// --- POST /sms/incoming — Twilio webhook for approval replies ---
app.post('/sms/incoming', verifyTwilioRequest, async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || '').trim();

  res.set('Content-Type', 'text/xml');

  if (!sms.approverNumbers.includes(from)) {
    // Not a recognized approver number — ignore silently.
    return res.send('<Response></Response>');
  }

  const match =
    body.match(/^(YES|NO)\s+([a-zA-Z0-9]+)$/i) || body.match(/^(YES|NO)$/i);
  if (!match) {
    return res.send('<Response><Message>Reply "YES [code]" to approve or "NO [code]" to deny a special.</Message></Response>');
  }

  const decision = match[1].toUpperCase();
  const code = match[2];

  const pending = db.getPendingRequests();
  let request;

  if (code) {
    request = pending.find((r) => r.id.toLowerCase() === code.toLowerCase());
  } else if (pending.length === 1) {
    request = pending[0];
  }

  if (!request) {
    return res.send('<Response><Message>No matching pending special found. Include the code, e.g. YES a1b2c3.</Message></Response>');
  }

  db.removePendingRequest(request.id);

  if (decision === 'NO') {
    await sms.notifyApprovers(`${request.bartenderName}'s special was denied by ${from}.`);
    if (request.bartenderPhone) {
      await sms.sendText(
        request.bartenderPhone,
        `Your special (${request.items.map((i) => i.itemName).join(', ')}) was denied.`
      );
    }
    return res.send('<Response></Response>');
  }

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
    `${results.join('\n')}\nApproved by ${from}. Reverts automatically at 8am.`
  );

  if (request.bartenderPhone) {
    await sms.sendText(
      request.bartenderPhone,
      `Your special was approved:\n${results.join('\n')}\nReverts automatically at 8am.`
    );
  }

  res.send('<Response></Response>');
});

// --- POST /sms/shift-incoming — Twilio webhook for the shift-coverage number.
// A bartender's "YES [code]" claims an open shift; an owner's "YES [code]"
// approves a claimed one. Which behavior applies is decided purely by whose
// phone number sent it, since both roles reply with the same word. ---
app.post('/sms/shift-incoming', verifyTwilioRequest, async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || '').trim();

  res.set('Content-Type', 'text/xml');

  // \s* (not \s+) so "YES1"/"YES 1" both work — a bartender texting fast on
  // a phone keyboard won't always get the space in, and there's no reason
  // to bounce a perfectly clear reply just for missing it.
  const match = body.match(/^YES\s*([a-zA-Z0-9]+)$/i) || body.match(/^YES$/i);
  if (!match) {
    return res.send('<Response><Message>Reply "YES [code]" to take or approve a shift.</Message></Response>');
  }
  const code = match[1];

  const bartender = db.findBartenderByPhone(from);
  const owner = db.findOwnerByPhone(from);

  if (bartender) {
    const open = db.getCoverageRequests().filter((r) => r.status === 'open');
    const request = code
      ? open.find((r) => r.id.toLowerCase() === code.toLowerCase())
      : (open.length === 1 ? open[0] : undefined);

    if (!request) {
      return res.send('<Response><Message>No matching open shift found. Include the code, e.g. YES 3.</Message></Response>');
    }
    if (request.bartenderId === bartender.id) {
      return res.send('<Response><Message>That\'s your own shift — you can\'t claim it yourself.</Message></Response>');
    }

    db.updateCoverageRequest(request.id, {
      status: 'claimed',
      claimedByBartenderId: bartender.id,
      claimedByName: bartender.name,
      claimedByPhone: bartender.phone,
    });

    await sms.notifyOwnersShift(
      `${bartender.name} wants to take ${request.bartenderName}'s ${request.dateLabel} (${SHIFT_LABELS[request.shiftType]}) shift. Reply YES ${request.id} to approve.`
    );

    return res.send('<Response><Message>Got it — waiting on an owner to approve.</Message></Response>');
  }

  if (owner) {
    const claimed = db.getCoverageRequests().filter((r) => r.status === 'claimed');
    const request = code
      ? claimed.find((r) => r.id.toLowerCase() === code.toLowerCase())
      : (claimed.length === 1 ? claimed[0] : undefined);

    if (!request) {
      return res.send('<Response><Message>No matching claimed shift found. Include the code, e.g. YES 3.</Message></Response>');
    }

    // Record who's actually covering this one specific date, without
    // touching the recurring weekly schedule — the regular person is still
    // on the roster for every other future occurrence of this weekday.
    if (request.date) {
      for (const slot of slotsCoveredBy(request.shiftType)) {
        db.setScheduleOverride(request.date, slot, request.claimedByBartenderId);
      }
    }
    db.removeCoverageRequest(request.id);

    const settledMessage = `${request.dateLabel} (${SHIFT_LABELS[request.shiftType]}) is now covered by ${request.claimedByName}, approved by an owner.`;
    await sms.notifyBartendersShift(settledMessage, [request.bartenderId, request.claimedByBartenderId]);
    if (request.bartenderPhone) await sms.sendShiftText(request.bartenderPhone, settledMessage);
    if (request.claimedByPhone) {
      await sms.sendShiftText(
        request.claimedByPhone,
        `You're confirmed for ${request.dateLabel} (${SHIFT_LABELS[request.shiftType]}) — approved by an owner.`
      );
    }

    return res.send('<Response></Response>');
  }

  // Unrecognized number — ignore silently.
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
