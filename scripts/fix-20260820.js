// One-off fix for 2026-08-20: register today's manually-set Clover prices
// as tracked active specials so the normal 8am job reverts them correctly.
// See scripts/add-active-special.js for the reusable version of this.

const db = require('../src/db');

const items = [
  { itemId: '54VNGH5MFPF5A', itemName: 'Bud Light', originalPrice: 300, specialPriceCents: 200 },
  { itemId: 'XT18GFTG6M7CP', itemName: 'Sweetwater Hazy IPA', originalPrice: 400, specialPriceCents: 300 },
  { itemId: '77TS6DH3XXQQA', itemName: 'Smirnoff Raspberry', originalPrice: 600, specialPriceCents: 400 },
  { itemId: 'ZEV0FTRSRQGEE', itemName: 'Jack Daniels', originalPrice: 600, specialPriceCents: 500 },
];

for (const item of items) {
  db.addActiveSpecial({ ...item, bartenderName: 'Manual entry', createdAt: Date.now() });
}

console.log('Registered', items.length, 'active specials:');
console.log(JSON.stringify(db.getActiveSpecials(), null, 2));
