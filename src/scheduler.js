const cron = require('node-cron');
const clover = require('./clover');
const sms = require('./sms');
const db = require('./db');

function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// A pending request older than this by the time the 8am job runs is
// treated as missed and auto-denied — otherwise a single unanswered text
// (e.g. two requests came in close together and one got overlooked) can
// block that item from ever being specialed again, with no way to notice
// until someone happens to try and hits the "already pending" error.
const PENDING_REQUEST_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours

// Returns [startMs, endMs] for "yesterday" (midnight to midnight),
// based on the server's local timezone (set via process.env.TZ in server.js).
function getYesterdayRange() {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  return [startOfYesterday.getTime(), startOfToday.getTime()];
}

// --- 8am job: revert every active special back to its original price ---
async function revertExpiredSpecials() {
  const active = db.getActiveSpecials();
  if (active.length === 0) return;

  const results = [];
  const failures = [];
  for (const special of active) {
    try {
      await clover.updateItemPrice(special.itemId, special.originalPrice);
      results.push(`${special.itemName} back to ${formatMoney(special.originalPrice)}`);
    } catch (err) {
      results.push(`FAILED to revert ${special.itemName}: ${err.message}`);
      failures.push(`${special.itemName}: ${err.message}`);
    }
  }

  db.clearActiveSpecials();

  await sms.notifyApprovers(
    `Specials reverted for the day:\n${results.join('\n')}`
  );

  if (failures.length > 0) {
    await sms.notifyOwners(
      `⚠️ ${failures.length} special${failures.length > 1 ? 's' : ''} failed to revert automatically — check Clover manually:\n${failures.join('\n')}`
    );
  }
}

// --- 8am job: auto-deny any pending request still unanswered from a
// previous day, so a missed reply can never permanently block an item. ---
async function expireStalePendingRequests() {
  const pending = db.getPendingRequests();
  const now = Date.now();
  const stale = pending.filter((r) => now - r.createdAt > PENDING_REQUEST_TIMEOUT_MS);
  if (stale.length === 0) return;

  for (const request of stale) {
    db.removePendingRequest(request.id);
    const itemNames = request.items.map((i) => i.itemName).join(', ');

    await sms.notifyApprovers(
      `${request.bartenderName}'s special (${itemNames}) expired unanswered and was automatically denied.`
    );

    if (request.bartenderPhone) {
      await sms.sendText(
        request.bartenderPhone,
        `Your special (${itemNames}) expired unanswered and was automatically denied. Feel free to resubmit.`
      );
    }
  }
}

// --- Daily report job: yesterday's sales + discounts, texted out ---
async function sendDailyReport() {
  const [startMs, endMs] = getYesterdayRange();
  const orders = await clover.getOrdersBetween(startMs, endMs);

  let totalSales = 0;
  let totalDiscounts = 0;

  for (const order of orders) {
    totalSales += order.total || 0;
    const discounts = (order.discounts && order.discounts.elements) || [];
    for (const d of discounts) {
      // Percentage discounts don't have a flat cent amount on the order
      // object directly in every case — amount-based discounts do.
      if (typeof d.amount === 'number') {
        totalDiscounts += Math.abs(d.amount);
      }
    }
  }

  const dateLabel = new Date(startMs).toLocaleDateString('en-US');

  await sms.notifyApprovers(
    `Sales report for ${dateLabel}:\n` +
    `Orders: ${orders.length}\n` +
    `Total sales: ${formatMoney(totalSales)}\n` +
    `Total discounts given: ${formatMoney(totalDiscounts)}`
  );
}

function start() {
  const tz = process.env.APP_TIMEZONE || 'America/New_York';

  // 8:00 AM every day — revert specials, and auto-deny anything left
  // pending unanswered since a previous day
  cron.schedule('0 8 * * *', () => {
    revertExpiredSpecials().catch((err) =>
      console.error('Error reverting specials:', err.message)
    );
    expireStalePendingRequests().catch((err) =>
      console.error('Error expiring stale pending requests:', err.message)
    );
  }, { timezone: tz });

  // 6:00 AM every day — send the previous day's sales report
  cron.schedule('0 6 * * *', () => {
    sendDailyReport().catch((err) =>
      console.error('Error sending daily report:', err.message)
    );
  }, { timezone: tz });

  console.log(`Scheduler started (timezone: ${tz})`);
}

module.exports = { start, revertExpiredSpecials, expireStalePendingRequests, sendDailyReport };
