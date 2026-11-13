// tools.js requires electron-free modules only at top level except zod; load PURCHASE_RE directly.
const test = require('node:test');
const assert = require('node:assert');
const { PURCHASE_RE } = require('../src/main/tools');

test('purchase guard catches checkout buttons', () => {
  for (const t of ['Buy Now', 'Place your order', 'Proceed to checkout', 'Pay now', 'Start your free trial', 'Buy now with 1-Click']) assert.ok(PURCHASE_RE.test(t), t);
});
test('purchase guard ignores normal browsing', () => {
  for (const t of ['Add to List', 'See all reviews', 'Search', 'Next page', 'Sort by: Price']) assert.ok(!PURCHASE_RE.test(t), t);
});
