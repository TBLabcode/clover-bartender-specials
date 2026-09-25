// Picks the POS integration for this deployment. Each venue runs its own
// instance of the app, so the provider is an env var rather than per-request.
// Defaults to Clover so existing deployments are unaffected.
//   POS_PROVIDER=clover | toast | none
// "none" runs the POS-free features only (social posts, staff schedule,
// calendar, shift coverage) — specials, inventory and the price/report jobs
// are switched off. For venues whose POS integration isn't approved yet.
const NONE = { enabled: false };
for (const fn of ['getItems', 'getItem', 'createItem', 'updateItemPrice', 'getOrdersBetween', 'getItemStock', 'addToItemStock']) {
  NONE[fn] = async () => { throw new Error(`${fn}: no POS configured (POS_PROVIDER=none)`); };
}

const PROVIDERS = {
  none: () => NONE,
  clover: () => require('./clover'),
  toast: () => require('./toast'),
};

const name = (process.env.POS_PROVIDER || 'clover').toLowerCase();
if (!PROVIDERS[name]) {
  throw new Error(`Unknown POS_PROVIDER "${name}" — expected one of: ${Object.keys(PROVIDERS).join(', ')}`);
}

const displayName = name.charAt(0).toUpperCase() + name.slice(1);

module.exports = Object.assign({}, PROVIDERS[name](), { providerName: displayName });
