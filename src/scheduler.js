const cron = require('node-cron');
const clover = require('./clover');
const sms = require('./sms');
const db = require('./db');

function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// Returns [startMs, endMs] for "yesterday" (midnight to midnight),
// based on the server's local timezone (set via process.env.TZ in server.js).
function getYesterdayRange() {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  return [startOfYesterday.getTime(), startOfToday.getTime()];
}

// --- 3am job: revert every active special back to its original price ---
async function revertExpiredSpecials() {
  const active = db.getActiveSpecials();
  if (active.length === 0) return;

  const results = [];
  for (const special of active) {
    try {
      await clover.updateItemPrice(special.itemId, special.originalPrice);
      results.push(`${special.itemName} back to ${formatMoney(special.originalPrice)}`);
    } catch (err) {
      results.push(`FAILED to revert ${special.itemName}: ${err.message}`);
    }
  }

  db.clearActiveSpecials();

  await sms.notifyApprovers(
    `Specials reverted for the day:\n${results.join('\n')}`
  );
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

  // 3:00 AM every day — revert specials
  cron.schedule('0 3 * * *', () => {
    revertExpiredSpecials().catch((err) =>
      console.error('Error reverting specials:', err.message)
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

module.exports = { start, revertExpiredSpecials, sendDailyReport };
