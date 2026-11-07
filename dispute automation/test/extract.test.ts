import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOrder, parseMoney, parsePlacedAt } from '../src/shared/extract.ts';
import { assessRules } from '../src/shared/rules.ts';

const won = readFileSync(new URL('../fixtures/order-3990CBFD.txt', import.meta.url), 'utf8');
const open = readFileSync(new URL('../fixtures/order-3990CBFD-open.txt', import.meta.url), 'utf8');

test('parseMoney handles signs and separators', () => {
  assert.equal(parseMoney('-US$7.99'), -7.99);
  assert.equal(parseMoney('+US$7.99'), 7.99);
  assert.equal(parseMoney('US$1,024.50'), 1024.5);
  assert.equal(parseMoney('Large size (US$1.00)'), null);
});

test('parsePlacedAt reads the portal date format', () => {
  assert.equal(parsePlacedAt('20 September 2026 at 12:48 pm'), '2026-09-20T12:48');
  assert.equal(parsePlacedAt('3 October 2026 at 12:05 am'), '2026-10-03T00:05');
});

test('parses the sample order page', () => {
  const { snapshot: s } = parseOrder(won);
  assert.equal(s.orderId, '3990CBFD');
  assert.equal(s.placedAt, '2026-09-20T12:48');
  assert.equal(s.status, 'Completed');
  assert.equal(s.disputeStatus, 'approved');
  assert.equal(s.channel, 'Marketplace');
  assert.equal(s.fulfillment, 'DoorDash delivery');
  assert.deepEqual(s.pickedUp, { actual: '12:57 pm', quoted: '1:03 pm' });
  assert.deepEqual(s.droppedOff, { actual: '1:32 pm', quoted: '1:41 pm' });
  assert.equal(s.items.length, 4);
  assert.equal(s.items[3].name, 'Wintermelon Lemon (REFRESHERS)');
  assert.equal(s.items[3].price, 7.99);
  assert.equal(s.subtotal, 31.46);
  assert.equal(s.tax, 0);
  assert.equal(s.commissionPct, 22);
  assert.equal(s.commission, -6.92);
  assert.equal(s.orderTotal, 24.54);
  assert.equal(s.errorCharges.length, 1);
  const e = s.errorCharges[0];
  assert.equal(e.item, 'Wintermelon Lemon (REFRESHERS)');
  assert.equal(e.reason, 'Missing entire item');
  assert.equal(e.disputeStatus, 'approved');
  assert.equal(e.amount, -7.99);
  assert.equal(e.customerComment, 'Missing this item');
  assert.equal(s.errorChargeTotal, -7.99);
  assert.equal(s.errorCredit, 7.99);
  assert.equal(s.estimatedPayout, 24.54);
  assert.deepEqual(s.transactions.map((t) => [t.id, t.kind, t.amount]), [
    ['18570676679', 'Delivery', 24.54],
    ['18571334223', 'Error charges', -7.99],
    ['18677749380', 'Refunds', 7.99],
  ]);
});

test('rules: already approved charge is decided', () => {
  const { snapshot } = parseOrder(won);
  const facts = assessRules(snapshot, new Date('2026-09-25T09:00'));
  assert.equal(facts.decided, true);
  assert.equal(facts.openErrorCharges.length, 0);
  assert.equal(facts.daysLeft, 9);
});

test('rules: open charge has days left, amount and fault hint', () => {
  const { snapshot } = parseOrder(open);
  assert.equal(snapshot.disputeStatus, null);
  const facts = assessRules(snapshot, new Date('2026-09-25T09:00'));
  assert.equal(facts.decided, false);
  assert.equal(facts.errorTotal, 7.99);
  assert.equal(facts.daysLeft, 9);
  assert.ok(facts.faultHint?.includes('merchant'));
});

test('rules: expired after 14 days', () => {
  const { snapshot } = parseOrder(open);
  const facts = assessRules(snapshot, new Date('2026-10-10T09:00'));
  assert.equal(facts.expired, true);
  assert.ok((facts.daysLeft ?? 0) < 0);
});
