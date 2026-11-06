import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scrubText } from '../src/shared/redact.ts';
import { findOrderId, findStoreId } from '../src/shared/ids.ts';

const open = readFileSync(new URL('../fixtures/order-3990CBFD-open.txt', import.meta.url), 'utf8');

test('scrubText removes the Customer and Dasher blocks without knowing any names', () => {
  const out = scrubText(open);
  for (const leak of ['Sam P', 'Dana K', 'on DoorDash', 'orders from your store']) assert.ok(!out.includes(leak), leak);
  // The evidence around those blocks survives.
  for (const keep of ['Order: 3990CBFD', 'Picked up', 'Missing entire item', 'Wintermelon Lemon (REFRESHERS)']) assert.ok(out.includes(keep), keep);
  assert.match(out, /Customer\n\[redacted\]\nDasher\n\[redacted\]\nPicked up/);
});

test('scrubText hides emails and phone numbers but not transaction IDs or money', () => {
  const out = scrubText('Reach me at jo@example.com or (310) 555-0142 or 310-555-0142\nTransaction #18570676679 - Delivery\nUS$24.54');
  assert.ok(!out.includes('jo@example.com') && !out.includes('555-0142'));
  assert.ok(out.includes('18570676679') && out.includes('US$24.54'));
});

test('scrubText never swallows the whole page when a block has no end', () => {
  const lines = ['Customer', ...Array.from({ length: 30 }, (_, i) => `line ${i}`)].join('\n');
  const out = scrubText(lines);
  assert.ok(out.includes('line 29'));
  assert.ok(!out.includes('line 0\n'));
});

test('store ID is found in the path, the query, or the page text, and may be absent', () => {
  assert.equal(findStoreId('https://www.doordash.com/merchant/store/28006527/orders', ''), '28006527');
  assert.equal(findStoreId('https://www.doordash.com/merchant/orders?storeId=555123', ''), '555123');
  assert.equal(findStoreId('https://www.doordash.com/merchant/orders#/x?store_id=777888', ''), '777888');
  assert.equal(findStoreId('https://www.doordash.com/merchant/orders', 'Store ID: 998877'), '998877');
  assert.equal(findStoreId('https://www.doordash.com/merchant/orders', 'no id here'), null);
  assert.equal(findStoreId('https://www.doordash.com/merchant/orders?store=abc', ''), null);
});

test('order ID is read from the page heading first, then the address', () => {
  assert.equal(findOrderId('https://x.doordash.com/', 'Hello\nOrder: 3990CBFD\nCompleted'), '3990CBFD');
  assert.equal(findOrderId('https://x.doordash.com/orders/ABCD1234/detail', 'nothing'), 'ABCD1234');
  assert.equal(findOrderId('https://x.doordash.com/orders?orderId=ZXCV9876', ''), 'ZXCV9876');
  assert.equal(findOrderId('https://x.doordash.com/', 'nothing'), null);
});
