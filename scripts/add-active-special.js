// One-off admin tool: register an item as a tracked active special without
// going through the normal submit -> approve flow. For cases where a price
// was already changed directly in Clover (e.g. the approval text never
// arrived) and it needs to auto-revert on schedule like a normal special.
//
// Usage (run from the project root, e.g. in Render's Web Shell):
//   node scripts/add-active-special.js <itemId> "<itemName>" <originalPriceCents> <specialPriceCents>
//
// Example:
//   node scripts/add-active-special.js 54VNGH5MFPF5A "Bud Light" 300 200

const db = require('../src/db');

const [itemId, itemName, originalPriceStr, specialPriceStr] = process.argv.slice(2);

if (!itemId || !itemName || !originalPriceStr || !specialPriceStr) {
  console.error('Usage: node scripts/add-active-special.js <itemId> "<itemName>" <originalPriceCents> <specialPriceCents>');
  process.exit(1);
}

const originalPrice = parseInt(originalPriceStr, 10);
const specialPriceCents = parseInt(specialPriceStr, 10);

if (!Number.isFinite(originalPrice) || !Number.isFinite(specialPriceCents)) {
  console.error('originalPriceCents and specialPriceCents must be whole numbers of cents.');
  process.exit(1);
}

const special = db.addActiveSpecial({
  itemId,
  itemName,
  originalPrice,
  specialPriceCents,
  bartenderName: 'Manual entry',
  createdAt: Date.now(),
});

console.log('Registered as an active special (will auto-revert on the normal schedule):');
console.log(JSON.stringify(special, null, 2));
console.log('\nAll active specials now tracked:');
console.log(JSON.stringify(db.getActiveSpecials(), null, 2));
