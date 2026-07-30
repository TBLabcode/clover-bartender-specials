// Wrapper around the Clover REST API.
// All Clover prices are in CENTS (e.g. $3.50 = 350).

const axios = require('axios');

const DRY_RUN = process.env.CLOVER_DRY_RUN === 'true';

// Fake inventory used when CLOVER_DRY_RUN=true, so the form/approval/revert
// flow can be tested end-to-end without valid Clover credentials.
const MOCK_ITEMS = [
  { id: 'MOCKITEM001', name: 'House Margarita', price: 1200 },
  { id: 'MOCKITEM002', name: 'Draft IPA', price: 700 },
  { id: 'MOCKITEM003', name: 'Old Fashioned', price: 1400 },
];

const client = axios.create({
  baseURL: process.env.CLOVER_BASE_URL,
  headers: {
    Authorization: `Bearer ${process.env.CLOVER_API_TOKEN}`,
    'Content-Type': 'application/json',
    // Clover requires a User-Agent header on every request as of 2026.
    'User-Agent': 'clover-bartender-specials/1.0',
  },
});

const merchantId = process.env.CLOVER_MERCHANT_ID;

// Get all inventory items (id, name, current price in cents)
async function getItems() {
  if (DRY_RUN) return MOCK_ITEMS;

  const res = await client.get(`/v3/merchants/${merchantId}/items`, {
    params: { limit: 300 },
  });
  return (res.data.elements || []).map((item) => ({
    id: item.id,
    name: item.name,
    price: item.price,
  }));
}

// Get a single item (used to grab the current/original price before changing it)
async function getItem(itemId) {
  if (DRY_RUN) {
    const item = MOCK_ITEMS.find((i) => i.id === itemId);
    if (!item) throw new Error(`[DRY RUN] No mock item with id ${itemId}`);
    return item;
  }

  const res = await client.get(`/v3/merchants/${merchantId}/items/${itemId}`);
  return res.data;
}

// Update an item's price. priceCents must be a whole number of cents.
async function updateItemPrice(itemId, priceCents) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would set item ${itemId} to ${priceCents} cents on Clover`);
    return { id: itemId, price: priceCents };
  }

  const res = await client.post(`/v3/merchants/${merchantId}/items/${itemId}`, {
    price: priceCents,
  });
  return res.data;
}

// Get orders within a time range (start/end are millisecond timestamps).
// Expands line items and discounts so we can total both sales and discounts given.
async function getOrdersBetween(startMs, endMs) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would fetch orders between ${startMs} and ${endMs}`);
    return [];
  }

  const res = await client.get(`/v3/merchants/${merchantId}/orders`, {
    params: {
      filter: `clientCreatedTime>=${startMs} AND clientCreatedTime<${endMs}`,
      expand: 'lineItems,discounts',
      limit: 300,
    },
  });
  return res.data.elements || [];
}

module.exports = {
  getItems,
  getItem,
  updateItemPrice,
  getOrdersBetween,
};
