import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseUberOrder, parseMoneyAny, uberPlacedAt } from '../src/shared/extract-ubereats.ts';
import { findOrderId, findStoreId } from '../src/shared/ids.ts';
import { platformFromUrl } from '../src/shared/platform.ts';
import { assessRules } from '../src/shared/rules.ts';

const page = readFileSync(new URL('../fixtures/ubereats-D2D46.txt', import.meta.url), 'utf8');

test('Uber Eats money and dates', () => {
  assert.equal(parseMoneyAny('-US$0.95'), -0.95);
  assert.equal(parseMoneyAny('$8.94'), 8.94);
  assert.equal(parseMoneyAny('(OPTIONAL) Add Topping'), null);
  assert.equal(uberPlacedAt('18 Oct 2026', '16:57'), '2026-10-18T16:57');
  assert.equal(uberPlacedAt('3 September 2026', '09:05'), '2026-09-03T09:05');
});

test('reads the Uber Eats order drawer', () => {
  const { snapshot: s } = parseUberOrder(page);
  assert.equal(s.platform, 'ubereats');
  assert.equal(s.orderId, 'D2D46');
  assert.equal(s.placedAt, '2026-10-18T16:57');
  assert.equal(s.shop, 'Odd One Out Tea (Pasadena) (14 South Fair Oaks Avenue)');
  assert.equal(s.status, 'Delivered');
  assert.equal(s.pickedUp.actual, '17:19');
  assert.equal(s.droppedOff.actual, '17:28');
  assert.equal(s.timeline?.length, 5);
  assert.deepEqual(s.items.map((i) => [i.name, i.price]), [['Summer Night Black Milk Tea', 8.94], ['Banana Bread Matcha', 9.99]]);
  assert.ok(s.items[0].options.includes('Add Topping: Jasmine Silk Boba (ICE ONLY)'));
  assert.ok(s.items[0].options.includes('Milk Alternatives - Default Straus Organic Pure Milk: Califia Oat Milk'));
  assert.equal(s.subtotal, 18.93);
  assert.equal(s.commission, -5.68);
  assert.equal(s.estimatedPayout, 12.3);
  assert.equal(s.errorChargeTotal, -0.95);
  assert.equal(s.errorCharges.length, 1);
  const c = s.errorCharges[0];
  assert.equal(c.item, 'Summer Night Black Milk Tea');
  assert.equal(c.reason, '1 customisation wrong');
  assert.equal(c.amount, -0.95);
  assert.equal(c.disputeStatus, 'available');
  assert.match(c.options[0], /Jasmine Silk Boba .*Customisation reported wrong/);
  assert.match(c.customerComment ?? '', /didn't have the jasmine silk boba/);
});

test('Uber Eats charges get no made-up deadline', () => {
  const facts = assessRules(parseUberOrder(page).snapshot, new Date('2026-10-20T00:00:00Z'));
  assert.equal(facts.deadlineIso, null);
  assert.equal(facts.errorTotal, 0.95);
  assert.match(facts.faultHint ?? '', /charged to the restaurant/);
});

test('platform and IDs come from the address', () => {
  assert.equal(platformFromUrl('https://merchants.ubereats.com/manager/orders'), 'ubereats');
  assert.equal(platformFromUrl('https://merchant-portal.doordash.com/merchant/orders'), 'doordash');
  assert.equal(platformFromUrl('https://evil-ubereats.com.example.org/'), null);
  assert.equal(findOrderId('https://merchants.ubereats.com/manager/orders', page), 'D2D46');
  const uuid = '3f2c9a1e-5b7d-4c11-9a0e-1234567890ab';
  assert.equal(findStoreId(`https://merchants.ubereats.com/manager/home/${uuid}/orders`, '', 'ubereats'), uuid);
  assert.equal(findStoreId(`https://merchants.ubereats.com/manager/orders?restaurantUUID=${uuid.toUpperCase()}`, '', 'ubereats'), uuid);
  assert.equal(findStoreId('https://merchants.ubereats.com/manager/orders', 'Store ID 12345', 'ubereats'), null);
});

test('a pickup order with "27 orders" under the name', () => {
  const text = readFileSync(new URL('../fixtures/ubereats-5DE2A-pickup.txt', import.meta.url), 'utf8').replace('Jeff J', 'Jeff J');
  const { snapshot: s } = parseUberOrder(text);
  assert.equal(s.orderId, '5DE2A');
  assert.equal(s.errorChargeTotal, -2.85);
  assert.equal(s.errorCharges[0].item, 'Icy Peak Milk Tea');
  assert.equal(s.errorCharges[0].reason, '1 customisation missing');
  assert.equal(s.fulfillment, null);
});

test('an order past Uber Eats\' 30-day limit: the page total is read even when items carry no amounts', () => {
  const text = readFileSync(new URL('../fixtures/ubereats-365D6-closed.txt', import.meta.url), 'utf8');
  const { snapshot: s } = parseUberOrder(text);
  assert.equal(s.orderId, '365D6');
  assert.equal(s.errorChargeTotal, -2, 'the "Chargeback amount" line, not "Net chargeback amount"');
  assert.equal(s.disputeStatus, null, 'no Dispute button, only Contact support');
  assert.match(s.notice ?? '', /more than 30 days ago can’t be disputed/);
});
