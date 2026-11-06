import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createApp } from '../src/app.mjs';
import { CONVERSATION_TABLES, createMigrator } from '../src/migrate.mjs';
import { createMemoryStore } from './memory-store.mjs';

/** A fake database that knows which tables exist and whether this role may create them. */
function fakeDb({ existing = [], canCreate = true } = {}) {
  const tables = new Set(existing);
  const calls = { missing: 0, apply: 0 };
  return {
    calls,
    tables,
    async missingTables() {
      calls.missing++;
      return CONVERSATION_TABLES.filter((t) => !tables.has(t));
    },
    async applyMigration() {
      calls.apply++;
      if (!canCreate) throw new Error('permission denied for schema dispute_automation');
      CONVERSATION_TABLES.forEach((t) => tables.add(t));
    },
  };
}

test('tables already there: nothing is run', async () => {
  const db = fakeDb({ existing: CONVERSATION_TABLES });
  const m = createMigrator(db);
  assert.equal(m.ready(), null);
  const r = await m.ensure();
  assert.deepEqual(r, { ready: true, missing: [], error: null });
  assert.equal(db.calls.apply, 0);
  assert.equal(m.ready(), true);
});

test('tables missing: the service creates them itself, once', async () => {
  const db = fakeDb();
  const m = createMigrator(db);
  assert.equal((await m.ensure()).ready, true);
  assert.equal(db.calls.apply, 1);
  await m.ensure();
  assert.equal(db.calls.apply, 1, 'a ready service does not migrate again');
});

test('a role that may not create tables is reported, never thrown, and retried later', async () => {
  let t = 0;
  const logs = [];
  const db = fakeDb({ canCreate: false });
  const m = createMigrator(db, { now: () => t, log: (l) => logs.push(l) });
  const first = await m.ensure();
  assert.equal(first.ready, false);
  assert.match(first.error, /permission denied/);
  assert.equal(m.ready(), false);
  assert.ok(logs.some((l) => /conversation_migration_failed/.test(l)));

  await m.ensure();
  assert.equal(db.calls.apply, 1, 'not retried within a minute');
  t = 61_000;
  db.tables.clear();
  await m.ensure();
  assert.equal(db.calls.apply, 2, 'retried after a minute');
  await m.ensure({ force: true });
  assert.equal(db.calls.apply, 3, 'force retries at once');
});

test('after an admin grants access, the next attempt succeeds without a restart', async () => {
  let t = 0;
  const db = fakeDb({ canCreate: false });
  const m = createMigrator(db, { now: () => t });
  assert.equal((await m.ensure()).ready, false);
  db.applyMigration = async () => CONVERSATION_TABLES.forEach((x) => db.tables.add(x));
  t = 61_000;
  assert.equal((await m.ensure()).ready, true);
});

test('concurrent checks share one attempt', async () => {
  const db = fakeDb();
  const m = createMigrator(db);
  await Promise.all([m.ensure(), m.ensure(), m.ensure()]);
  assert.equal(db.calls.apply, 1);
});

test('the SQL only creates new tables: no alters, no links to existing tables, no grants needed', () => {
  const sql = readFileSync(new URL('../../db/migrations/001_conversations.sql', import.meta.url), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /ALTER\s+TABLE/i);
  assert.doesNotMatch(code, /GRANT\s/i);
  assert.doesNotMatch(code, /CREATE\s+SCHEMA/i);
  assert.doesNotMatch(code, /REFERENCES\s+dispute_automation\.(cases|investigations|submissions)/i);
  for (const t of CONVERSATION_TABLES) assert.match(code, new RegExp(`CREATE TABLE IF NOT EXISTS dispute_automation\\.${t}\\b`), t);
  assert.equal((code.match(/CREATE TABLE/g) || []).length, CONVERSATION_TABLES.length);
  assert.doesNotMatch(code, /CREATE TABLE(?! IF NOT EXISTS)/);
});

test('without chat tables the chat routes say so plainly and the older flow still works', async () => {
  const store = createMemoryStore({ chats: 'missing' });
  const app = createApp({ store, env: { KOREFI_AGENT_TOKEN: 'a'.repeat(40), OPENAI_API_KEY: 'sk' }, log: () => {}, investigate: async () => ({ recommendation: 'needs_review', reasoning_summary: 'x', draft_text: 'd', missing_evidence: [], risk_notes: null, model: 'f', tools_used: [], transcript: null }) });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body) => fetch(base + path, { method, headers: { Authorization: `Bearer ${'a'.repeat(40)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    for (const [method, path, body] of [['GET', '/v1/conversations'], ['POST', '/v1/conversations', { operator_id: 'o', order_id: 'ABC12345' }], ['GET', '/v1/conversations/1'], ['POST', '/v1/conversations/1/messages', { text: 'hi' }]]) {
      const res = await call(method, path, body);
      assert.equal(res.status, 503, `${method} ${path}`);
      assert.match((await res.json()).error, /Chats are not set up/);
    }
    assert.equal((await call('POST', '/v1/investigations', { operator_id: 'o', order_id: 'ABC12345' })).status, 202);
    const ready = await (await call('GET', '/readyz')).json();
    assert.equal(ready.conversations, 'missing');
  } finally {
    server.close();
  }
});
