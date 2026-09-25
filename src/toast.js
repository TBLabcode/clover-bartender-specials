// Wrapper around the Toast REST API. Mirrors src/clover.js's interface so
// the rest of the app can eventually treat either POS the same way.
//
// STATUS: scaffolding only. We don't have Toast API credentials yet — the
// Integration Request Application was submitted 2026-09-16 for Duck & Dive
// (custom integration, up to 30 days for a response). Only the auth flow
// below is built against confirmed Toast documentation
// (doc.toasttab.com/doc/devguide/authentication.html). getItems/getItem/
// updateItemPrice/getOrdersBetween are left as NOT_IMPLEMENTED stubs
// outside dry-run mode — the Menus and Orders API docs haven't been
// reviewed yet, so their real endpoint shapes are still unknown. Fill
// those in once sandbox credentials exist and those docs have been read.
//
// Contract with the rest of the app (same as clover.js): prices are integer
// CENTS in and out, and getOrdersBetween returns orders shaped like
// { total: cents, discounts: { elements: [{ amount: cents }] } } so the
// scheduler's daily report works unchanged. Toast likely uses decimal
// dollars natively — convert at the API boundary once the Menus/Orders
// docs are reviewed (TODO), never in callers.

const axios = require('axios');

const DRY_RUN = process.env.TOAST_DRY_RUN === 'true';

// Fake inventory used when TOAST_DRY_RUN=true, so routes/flows can be
// exercised end-to-end before real credentials exist.
const MOCK_ITEMS = [
  { id: 'MOCKTOASTITEM001', name: 'House Margarita', price: 1200, code: 'HM001' },
  { id: 'MOCKTOASTITEM002', name: 'Draft IPA', price: 700, code: 'DIPA02' },
  { id: 'MOCKTOASTITEM003', name: 'Old Fashioned', price: 1400, code: 'OF003' },
];

const hostname = process.env.TOAST_API_HOSTNAME;
const restaurantGuid = process.env.TOAST_RESTAURANT_GUID;

// --- Authentication ---
// OAuth2 client-credentials grant. POST clientId/clientSecret to
// /authentication/v1/authentication/login, get back a Bearer token that's
// valid for a limited time (expiresIn seconds) and must be refreshed.
let cachedToken = null;
let cachedTokenExpiresAt = 0; // epoch ms

async function fetchAccessToken() {
  if (DRY_RUN) return 'DRY_RUN_FAKE_TOKEN';

  const res = await axios.post(
    `https://${hostname}/authentication/v1/authentication/login`,
    {
      clientId: process.env.TOAST_CLIENT_ID,
      clientSecret: process.env.TOAST_CLIENT_SECRET,
      userAccessType: 'TOAST_MACHINE_CLIENT',
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  const { accessToken, expiresIn } = res.data.token;
  return { accessToken, expiresIn };
}

// Returns a valid Bearer token, reusing the cached one until shortly before
// it expires (60s safety margin) rather than refetching on every call.
async function getAccessToken() {
  if (DRY_RUN) return 'DRY_RUN_FAKE_TOKEN';

  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const { accessToken, expiresIn } = await fetchAccessToken();
  cachedToken = accessToken;
  cachedTokenExpiresAt = now + expiresIn * 1000;
  return cachedToken;
}

async function client() {
  const token = await getAccessToken();
  return axios.create({
    baseURL: `https://${hostname}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // TODO: confirm the restaurant-scoping header name/requirement
      // against the Menus/Orders API docs — Toast-Restaurant-External-ID
      // is the commonly documented pattern but hasn't been verified here.
      'Toast-Restaurant-External-ID': restaurantGuid,
    },
  });
}

// --- Items (menu) ---
// TODO: implement against the Menus API once its docs have been reviewed
// and sandbox credentials exist. Endpoint paths below are NOT real yet.

async function getItems() {
  if (DRY_RUN) return MOCK_ITEMS;
  throw new Error('toast.getItems: not implemented — Menus API not yet reviewed');
}

async function getItem(itemId) {
  if (DRY_RUN) {
    const item = MOCK_ITEMS.find((i) => i.id === itemId);
    if (!item) throw new Error(`[DRY RUN] No mock item with id ${itemId}`);
    return item;
  }
  throw new Error('toast.getItem: not implemented — Menus API not yet reviewed');
}

async function updateItemPrice(itemId, priceCents) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would set item ${itemId} to ${priceCents} cents on Toast`);
    return { id: itemId, price: priceCents };
  }
  throw new Error('toast.updateItemPrice: not implemented — Menus API not yet reviewed');
}

// Inventory import (receipt scanning) — Toast's stock/item-creation APIs
// haven't been reviewed; these exist so the shared interface is complete.
async function createItem(name, priceCents, code) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would create new Toast item "${name}" at ${priceCents} cents (code: ${code || 'none'})`);
    return { id: `MOCKTOASTNEW${Date.now()}`, name, price: priceCents, code: code || '' };
  }
  throw new Error('toast.createItem: not implemented — Menus API not yet reviewed');
}

async function getItemStock() {
  if (DRY_RUN) return 0;
  throw new Error('toast.getItemStock: not implemented — Stock API not yet reviewed');
}

async function addToItemStock(itemId, quantityToAdd) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would add ${quantityToAdd} to stock for item ${itemId} on Toast`);
    return quantityToAdd;
  }
  throw new Error('toast.addToItemStock: not implemented — Stock API not yet reviewed');
}

// --- Orders (for daily sales/discount reporting) ---
// TODO: implement against the Orders API once its docs have been reviewed.

async function getOrdersBetween(startMs, endMs) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would fetch Toast orders between ${startMs} and ${endMs}`);
    return [];
  }
  throw new Error('toast.getOrdersBetween: not implemented — Orders API not yet reviewed');
}

module.exports = {
  getAccessToken,
  getItems,
  getItem,
  updateItemPrice,
  createItem,
  getItemStock,
  addToItemStock,
  getOrdersBetween,
};
