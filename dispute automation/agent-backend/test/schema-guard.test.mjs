import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.mjs';
import { CONVERSATION_TABLES } from '../src/constants.mjs';
import { createSchemaGuard } from '../src/schema-guard.mjs';
import { createMemoryStore } from './memory-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function fakeDb(missing = []) {
  const state = { missing: [...missing], calls: 0, fail: null };
  return {
    state,
    async missingTables() {
      state.calls++;
      if (state.fail) throw state.fail;
      return state.missing;
    },
  };
}

test('all tables present: ready, and it stays ready without asking again', async () => {
  const db = fakeDb();
  const g = createSchemaGuard(db);
  assert.equal(g.ready(), null);
  assert.equal((await g.ensure()).ready, true);
  await g.ensure();
  assert.equal(db.state.calls, 1);
  assert.equal(g.ready(), true);
});

test('tables missing: reported as not ready, rechecked at most every 30 seconds, and recovers without a restart', async () => {
  let t = 0;
  const db = fakeDb(['conversations']);
  const logs = [];
  const g = createSchemaGuard(db, { now: () => t, log: (l) => logs.push(l) });
  assert.equal((await g.ensure()).ready, false);
  assert.ok(logs.some((l) => /conversation_schema_missing/.test(l)));
  await g.ensure();
  assert.equal(db.state.calls, 1, 'not rechecked within 30 seconds');
  t = 31_000;
  db.state.missing = []; // the migration was applied meanwhile
  assert.equal((await g.ensure()).ready, true);
  assert.equal(g.ready(), true);
});

test('an unreachable database is not reported as a missing migration, and a ready schema stays ready', async () => {
  let t = 0;
  const db = fakeDb();
  const g = createSchemaGuard(db, { now: () => t });
  await g.ensure();
  db.state.fail = new Error('connection terminated');
  t = 99_000;
  const r = await g.ensure({ force: true });
  assert.equal(r.ready, true);
  assert.match(r.error, /connection terminated/);
});

test('concurrent checks share one query', async () => {
  const db = fakeDb(['conversations']);
  const g = createSchemaGuard(db);
  await Promise.all([g.ensure(), g.ensure(), g.ensure()]);
  assert.equal(db.state.calls, 1);
});

test('the service never changes the schema: no DDL anywhere in its source', () => {
  const dir = path.join(here, '../src');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs') && x !== 'migrations.mjs')) {
    const code = readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    assert.doesNotMatch(code, /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|SCHEMA|ROLE)\b/i, f);
  }
});

test('migrations match the live schema conventions', () => {
  const dir = path.join(here, '../../db/migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  assert.deepEqual(files, ['000_schema_migrations.sql', '001_conversations.sql', '002_goodwill_recommendation.sql']);
  const strip = (f) => readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(files.map(strip).join('\n'), /\bBEGIN\b\s*;|\bCOMMIT\b\s*;/i, 'the runner owns the transaction');
  const all = files.filter((f) => f !== '002_goodwill_recommendation.sql').map(strip).join('\n');
  assert.doesNotMatch(all, /ALTER\s+TABLE/i, 'existing tables are left alone');
  // 002 only widens the two recommendation checks to accept 'goodwill'; it touches no column, row or other constraint.
  const goodwill = strip('002_goodwill_recommendation.sql');
  const statements = goodwill.split(';').map((x) => x.trim()).filter(Boolean);
  assert.equal(statements.length, 4);
  for (const x of statements) assert.match(x, /^ALTER TABLE dispute_automation\.(investigations|conversations) (DROP CONSTRAINT IF EXISTS|ADD CONSTRAINT) (investigations_recommendation_check|conversations_last_recommendation_check)\b/);
  assert.equal((goodwill.match(/'dispute', 'goodwill', 'needs_review', 'do_not_dispute'/g) || []).length, 2);
  assert.doesNotMatch(all, /CREATE TABLE(?! IF NOT EXISTS)/i);
  assert.doesNotMatch(all, /\bbigserial\b|\bserial\b|\bbigint\s+(NOT NULL\s+)?REFERENCES/i, 'keys are uuid, like the existing tables');
  const chat = strip('001_conversations.sql');
  for (const t of CONVERSATION_TABLES) assert.match(chat, new RegExp(`CREATE TABLE IF NOT EXISTS dispute_automation\\.${t}\\b`), t);
  assert.equal((chat.match(/CREATE TABLE/g) || []).length, CONVERSATION_TABLES.length);
  assert.match(chat, /FOREIGN KEY \(tenant_id, case_id\) REFERENCES dispute_automation\.cases \(tenant_id, id\)/, 'chats are tenant-scoped like submissions');
  assert.match(chat, /GRANT SELECT, INSERT, UPDATE, DELETE ON/, 'the service role gets exactly read/write');
  assert.doesNotMatch(chat, /GRANT\s+(ALL|CREATE|TRUNCATE|REFERENCES)/i);
});

test('without chat tables the chat routes say so plainly, the older flow still works, and readyz reports it', async () => {
  const store = createMemoryStore({ chats: 'missing' });
  const app = createApp({ store, env: { KOREFI_AGENT_TOKEN: 'a'.repeat(40), OPENAI_API_KEY: 'sk' }, log: () => {}, investigate: async () => ({ recommendation: 'needs_review', reasoning_summary: 'x', draft_text: 'd', missing_evidence: [], risk_notes: null, model: 'f', tools_used: [], transcript: null }) });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) => fetch(base + p, { method, headers: { Authorization: `Bearer ${'a'.repeat(40)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    const uuid = '00000000-0000-4000-8000-000000000000';
    for (const [method, p, body] of [['GET', '/v1/conversations'], ['POST', '/v1/conversations', { operator_id: 'o', order_id: 'ABC12345' }], ['GET', `/v1/conversations/${uuid}`], ['POST', `/v1/conversations/${uuid}/messages`, { text: 'hi' }]]) {
      const res = await call(method, p, body);
      assert.equal(res.status, 503, `${method} ${p}`);
      assert.match((await res.json()).error, /Chats are not available/);
    }
    assert.equal((await call('POST', '/v1/investigations', { operator_id: 'o', order_id: 'ABC12345' })).status, 202);
    assert.equal((await (await call('GET', '/readyz')).json()).conversations, 'missing');
  } finally {
    server.close();
  }
});
