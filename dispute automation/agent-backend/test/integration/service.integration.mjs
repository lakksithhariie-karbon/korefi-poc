// The whole service against a real Postgres, the way production runs it: real HTTP routes, real validation, the real
// Postgres store, a fake agent. Run it against a database branch, never production:
//
//   INTEGRATION_DATABASE_URL=<service-role url> INTEGRATION_HISTORY_DATABASE_URL=<history-role url> npm run test:integration
//
// The roles must be the least-privilege ones the service uses (read/write on dispute_automation, read on doordash), so this
// also proves the service needs no more than that. It uses its own tenant id and cleans up after itself.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createApp, startMaintenance } from '../../src/app.mjs';
import { createPgStore } from '../../src/data.mjs';

const RW = process.env.INTEGRATION_DATABASE_URL;
const RO = process.env.INTEGRATION_HISTORY_DATABASE_URL;
const skip = !RW || !RO ? 'set INTEGRATION_DATABASE_URL and INTEGRATION_HISTORY_DATABASE_URL to run against a real database' : false;

const TOKEN = 'i'.repeat(40);
const TENANT = `itest-${randomUUID().slice(0, 8)}`;
const jpeg = (tag) => `data:image/jpeg;base64,${Buffer.from('JFIF-' + tag).toString('base64')}`;

let store, server, base, calls;
const serviceLogs = [];
const gates = [];

const call = (method, path, body, headers = {}) =>
  fetch(base + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
const json = async (method, path, body, headers) => {
  const res = await call(method, path, body, headers);
  return { status: res.status, body: await res.json().catch(() => null) };
};
async function finish(id) {
  for (let i = 0; i < 300; i++) {
    gates.splice(0).forEach((g) => g());
    const j = (await json('GET', `/v1/investigations/${id}`)).body;
    if (j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('run never finished');
}

before(async () => {
  if (skip) return;
  store = createPgStore({ DATABASE_URL: RW, HISTORY_DATABASE_URL: RO });
  calls = [];
  const investigate = async ({ store: s, request, runId, transcript = [], images = [] }) => {
    calls.push({ request, transcript, images });
    // Exercise the same database calls the real agent's tools make.
    const tool = await s.startToolCall(runId, 'get_error_charges');
    const rows = request.storeId === 'unresolved' ? [] : await s.history.getCharges(request.storeId, request.orderId);
    await s.history.similarCases(TENANT, request.storeId, request.issueCategory, request.orderId);
    await s.finishToolCall(tool, 'completed', { summary: 'ok', record_count: rows.length });
    await new Promise((release) => gates.push(release));
    const n = calls.length;
    return {
      recommendation: 'needs_review', reasoning_summary: `answer ${n}`, missing_evidence: ['POS'], draft_text: `draft ${n}`, risk_notes: null,
      suggested_followups: ['Next?'], model: 'fake', tools_used: [{ name: 'get_error_charges', count: rows.length }],
      transcript: [...transcript, { role: 'user', content: [{ type: 'text', text: request.operatorQuestion }] }, { role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }], stopReason: 'stop' }],
    };
  };
  const app = createApp({ store, investigate, env: { KOREFI_AGENT_TOKEN: TOKEN, OPENAI_API_KEY: 'sk-test', TENANT_ID: TENANT }, log: (l) => serviceLogs.push(l) });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (skip || !store) return;
  // Remove everything this run created (its own tenant only).
  const { Client } = (await import('pg')).default;
  const c = new Client({ connectionString: RW });
  await c.connect().catch(() => {});
  const q = (sql) => c.query(sql, [TENANT]).catch((e) => console.error('cleanup:', e.message));
  await q('DELETE FROM dispute_automation.agent_tool_calls WHERE investigation_id IN (SELECT i.id FROM dispute_automation.investigations i JOIN dispute_automation.cases k ON k.id=i.case_id WHERE k.tenant_id=$1)');
  await q('DELETE FROM dispute_automation.investigations WHERE case_id IN (SELECT id FROM dispute_automation.cases WHERE tenant_id=$1)');
  await q('DELETE FROM dispute_automation.conversations WHERE tenant_id=$1');
  await q('DELETE FROM dispute_automation.case_events WHERE case_id IN (SELECT id FROM dispute_automation.cases WHERE tenant_id=$1)');
  await q('DELETE FROM dispute_automation.submissions WHERE tenant_id=$1');
  await q('DELETE FROM dispute_automation.cases WHERE tenant_id=$1');
  await c.end().catch(() => {});
  server.close();
  await store.close();
});

test('the service role can see its tables, and the chat tables exist', { skip }, async () => {
  assert.equal(await store.ready(), true);
  const state = await store.ensureConversations({ force: true });
  assert.deepEqual(state, { ready: true, missing: [], error: null });
  assert.equal(store.conversationsReady(), true);
  const ready = (await json('GET', '/readyz')).body;
  assert.equal(ready.conversations, 'ready');
});

test('the history lookups match the real doordash tables', { skip }, async () => {
  const { Client } = (await import('pg')).default;
  const c = new Client({ connectionString: RO });
  await c.connect();
  const { rows } = await c.query('SELECT store_id, doordash_order_id FROM doordash.financial_detailed_transactions WHERE store_id ~ $1 LIMIT 1', ['^[0-9]{3,32}$']);
  await c.end();
  assert.ok(rows.length === 1, 'the test database has history rows');
  const { store_id, doordash_order_id } = rows[0];
  assert.ok(Array.isArray(await store.history.getFinancials(store_id, doordash_order_id)));
  assert.ok(Array.isArray(await store.history.getCharges(store_id, doordash_order_id)));
  assert.ok(Array.isArray(await store.history.getIssueReports(store_id, doordash_order_id)));
  assert.ok(Array.isArray(await store.history.getStorePatterns(store_id)));
  assert.equal(await store.resolveStore(doordash_order_id), store_id, 'a known order resolves to its store');
  assert.equal(await store.resolveStore('NO-SUCH-ORDER-1'), null);
  assert.equal(await store.resolveStore('SCREENSHOT-ABC'), null);
});

test('a full chat: open, answer, follow up, add evidence, mark disputed, history', { skip }, async () => {
  const opened = (await json('POST', '/v1/conversations', { operator_id: 'itest', order_id: 'ITEST0001', issue_category: 'Missing item', dispute_amount: 7.99, structured_facts: { items: [{ name: 'Wintermelon Lemon' }] }, redacted_page_text: 'Order: ITEST0001', screenshots: [jpeg('a'), jpeg('b')] })).body;
  assert.match(opened.conversation_id, /^[0-9a-f-]{36}$/);
  assert.equal(opened.store_id, 'unresolved');
  assert.equal(opened.images, 2);

  const m1 = (await json('POST', `/v1/conversations/${opened.conversation_id}/messages`, { text: 'Can we dispute this?' })).body;
  assert.equal((await json('POST', `/v1/conversations/${opened.conversation_id}/messages`, { text: 'again' })).status, 409, 'one answer at a time');
  const done1 = await finish(m1.investigation_id);
  assert.equal(done1.status, 'completed');
  assert.equal(done1.conversation_id, opened.conversation_id);
  assert.deepEqual(done1.suggested_followups, ['Next?']);
  assert.equal(calls[0].transcript.length, 0);
  assert.equal(calls[0].images.length, 2);
  assert.equal(calls[0].request.issueCategory, 'Missing item');
  assert.equal(calls[0].request.amount, 7.99);

  // Follow-up: the saved transcript comes back from Postgres, and the images are attached again, from bytea.
  const m2 = (await json('POST', `/v1/conversations/${opened.conversation_id}/messages`, { text: 'What evidence?', previous_draft: 'edited', screenshots: [jpeg('c')] })).body;
  await finish(m2.investigation_id);
  assert.equal(calls[1].transcript.length, 2);
  assert.equal(calls[1].images.length, 3);
  assert.equal(Buffer.from(calls[1].images[0].data, 'base64').toString(), 'JFIF-a', 'image bytes survive the round trip');
  assert.equal(calls[1].request.previousDraft, 'edited');

  const detail = (await json('GET', `/v1/conversations/${opened.conversation_id}`)).body;
  assert.deepEqual(detail.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(detail.images.length, 3);
  const img = await call('GET', `/v1/conversations/${opened.conversation_id}/images/${detail.images[1].id}`);
  assert.equal(img.status, 200);
  assert.equal(Buffer.from(await img.arrayBuffer()).toString(), 'JFIF-b');

  // Marking it disputed is atomic, idempotent, and notes the chat.
  const filing = { operator_id: 'itest', conversation_id: opened.conversation_id, order_id: 'ITEST0001', dispute_text: 'We dispute.', disputed_at: '2026-11-06T12:00:00Z' };
  const first = (await json('POST', '/v1/disputes/confirm', filing)).body;
  assert.equal(first.already_recorded, false);
  assert.equal((await json('POST', '/v1/disputes/confirm', filing)).body.already_recorded, true);
  const after = (await json('GET', `/v1/conversations/${opened.conversation_id}`)).body;
  assert.equal(after.conversation.status, 'disputed');
  assert.equal(after.messages.filter((m) => /Marked as disputed/.test(m.text)).length, 1);

  // A second chat on the same order shares the case; history lists the newest first.
  const second = (await json('POST', '/v1/conversations', { operator_id: 'itest', order_id: 'ITEST0001' })).body;
  assert.equal(second.case_id, opened.case_id);
  const list = (await json('GET', '/v1/conversations')).body.conversations;
  assert.deepEqual(list.map((c) => c.id), [second.conversation_id, opened.conversation_id]);
  assert.equal(list[1].status, 'disputed');
  assert.equal(list[1].last_recommendation, 'needs_review');

  // The audit trail landed in the existing case_events table.
  const { Client } = (await import('pg')).default;
  const c = new Client({ connectionString: RW });
  await c.connect();
  const ev = await c.query('SELECT event_type FROM dispute_automation.case_events WHERE case_id=$1 ORDER BY created_at', [opened.case_id]);
  await c.end();
  const types = ev.rows.map((r) => r.event_type);
  for (const t of ['conversation_opened', 'evidence_added', 'agent_answered', 'operator_confirmed_submission']) assert.ok(types.includes(t), `${t} in ${types}`);
});

test('the case and run bookkeeping is right in the real tables', { skip }, async () => {
  const { Client } = (await import('pg')).default;
  const c = new Client({ connectionString: RW });
  await c.connect();
  const caseRow = (await c.query('SELECT case_status, tenant_id FROM dispute_automation.cases WHERE tenant_id=$1 AND platform_order_id=$2', [TENANT, 'ITEST0001'])).rows[0];
  assert.equal(caseRow.case_status, 'submitted', 'a filed case is never moved back by a later run');
  const runs = (await c.query("SELECT i.status, i.prompt_version, (SELECT count(*) FROM dispute_automation.agent_tool_calls t WHERE t.investigation_id=i.id) AS tools FROM dispute_automation.investigations i JOIN dispute_automation.cases k ON k.id=i.case_id WHERE k.tenant_id=$1", [TENANT])).rows;
  await c.end();
  assert.ok(runs.length >= 2);
  assert.ok(runs.every((r) => r.status === 'completed' && r.prompt_version && Number(r.tools) === 1));
});

test('idempotency: a retried request does the work once, against the real database', { skip }, async () => {
  const key = { 'Idempotency-Key': `retry-${randomUUID()}` };
  const body = { operator_id: 'itest', order_id: 'ITEST0002' };
  const a = await json('POST', '/v1/conversations', body, key);
  const b = await json('POST', '/v1/conversations', body, key);
  assert.equal(a.status, 201);
  assert.deepEqual(b.body, a.body);
  const list = (await json('GET', '/v1/conversations')).body.conversations.filter((c) => c.order_id === 'ITEST0002');
  assert.equal(list.length, 1);
});

test('bad ids and constraints are handled, not crashes', { skip }, async () => {
  assert.equal((await json('GET', '/v1/conversations/not-a-uuid')).status, 404);
  assert.equal((await json('GET', `/v1/conversations/${randomUUID()}`)).status, 404);
  assert.equal((await json('GET', '/v1/investigations/not-a-uuid')).status, 404);
  assert.equal((await json('GET', `/v1/investigations/${randomUUID()}`)).status, 404);
  const opened = (await json('POST', '/v1/conversations', { operator_id: 'itest', order_id: 'ITEST0003' })).body;
  assert.equal((await json('GET', `/v1/conversations/${opened.conversation_id}/images/not-a-uuid`)).status, 404);
  // The legacy stateless flow still works against the same database.
  const legacy = (await json('POST', '/v1/investigations', { operator_id: 'itest', order_id: 'ITEST0004', store_id: '12345678' })).body;
  const done = await finish(legacy.investigation_id);
  assert.equal(done.status, 'completed', JSON.stringify(done) + '\n' + serviceLogs.slice(-6).join('\n'));
  assert.equal(done.conversation_id, undefined);
});

test('image budget: over budget, images are skipped and the chat still works', { skip }, async () => {
  const app = createApp({ store, investigate: async () => ({}), env: { KOREFI_AGENT_TOKEN: TOKEN, OPENAI_API_KEY: 'x', TENANT_ID: TENANT, IMAGE_BUDGET_MB: '0' }, log: () => {} });
  const s = http.createServer(app.handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/v1/conversations`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operator_id: 'itest', order_id: 'ITEST0005', screenshots: [jpeg('z')] }) });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.images, 0);
    assert.equal(body.images_dropped, 1);
  } finally {
    s.close();
  }
});

test('expired images are purged and no longer served', { skip }, async () => {
  const app = createApp({ store, investigate: async () => ({}), env: { KOREFI_AGENT_TOKEN: TOKEN, OPENAI_API_KEY: 'x', TENANT_ID: TENANT, IMAGE_RETENTION_DAYS: '0' }, log: () => {} });
  const s = http.createServer(app.handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}`;
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  try {
    const opened = await (await fetch(url + '/v1/conversations', { method: 'POST', headers, body: JSON.stringify({ operator_id: 'itest', order_id: 'ITEST0006', screenshots: [jpeg('old')] }) })).json();
    assert.equal(opened.images, 1);
    const detail = await (await fetch(`${url}/v1/conversations/${opened.conversation_id}`, { headers })).json();
    assert.equal(detail.images.length, 0, 'an expired image is not listed');
    const stop = startMaintenance({ store, everyMs: 1e9, log: () => {} });
    await new Promise((r) => setTimeout(r, 300));
    stop();
    assert.equal(await store.countImages(opened.conversation_id), 0);
  } finally {
    s.close();
  }
});

test('the service role really cannot change the schema', { skip }, async () => {
  const { Client } = (await import('pg')).default;
  const c = new Client({ connectionString: RW });
  await c.connect();
  await assert.rejects(() => c.query('CREATE TABLE dispute_automation.should_not_exist (x int)'), /permission denied/);
  await assert.rejects(() => c.query('ALTER TABLE dispute_automation.cases ADD COLUMN nope int'), /must be owner|permission denied/);
  await c.end();
});
