import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyMigrations, loadMigrations } from '../src/migrations.mjs';

/** A pretend database session: it tracks applied versions and records every statement and transaction boundary. */
function fakeClient({ applied = {}, failOn = null } = {}) {
  const log = [];
  const tracked = { ...applied };
  let tableExists = Object.keys(applied).length > 0;
  return {
    log,
    tracked,
    async query(sql, params = []) {
      const s = String(sql).trim();
      log.push(s.split('\n')[0].slice(0, 60));
      if (/^SELECT to_regclass/.test(s)) return { rows: [{ t: tableExists ? 'dispute_automation.schema_migrations' : null }] };
      if (/^SELECT version, checksum/.test(s)) return { rows: Object.entries(tracked).map(([version, checksum]) => ({ version, checksum })) };
      if (failOn && s.includes(failOn)) throw new Error('relation does not exist');
      if (/^INSERT INTO dispute_automation.schema_migrations/.test(s)) tracked[params[0]] = params[1];
      if (/CREATE TABLE IF NOT EXISTS dispute_automation.schema_migrations/.test(s)) tableExists = true;
      return { rows: [] };
    },
  };
}

function dir(files) {
  const d = mkdtempSync(path.join(tmpdir(), 'mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(d, name), sql);
  return d;
}

test('migrations are read in order with a checksum, ignoring other files', () => {
  const m = loadMigrations(dir({ '001_b.sql': 'SELECT 2;', '000_a.sql': 'SELECT 1;', 'notes.txt': 'x', 'bad name.sql': 'x' }));
  assert.deepEqual(m.map((x) => x.version), ['000_a', '001_b']);
  assert.match(m[0].checksum, /^[0-9a-f]{64}$/);
  assert.notEqual(m[0].checksum, m[1].checksum);
});

test('pending migrations are applied in order, each in its own transaction, and recorded', async () => {
  const c = fakeClient();
  const m = loadMigrations(dir({ '000_a.sql': 'CREATE TABLE IF NOT EXISTS dispute_automation.schema_migrations (x int);', '001_b.sql': 'CREATE TABLE b();' }));
  const r = await applyMigrations(c, m);
  assert.deepEqual(r, { applied: ['000_a', '001_b'], skipped: [] });
  assert.deepEqual(Object.keys(c.tracked), ['000_a', '001_b']);
  assert.equal(c.log.filter((l) => l === 'BEGIN').length, 2);
  assert.equal(c.log.filter((l) => l === 'COMMIT').length, 2);
  assert.ok(c.log[0].includes('pg_advisory_lock') && c.log.at(-1).includes('pg_advisory_unlock'));
});

test('applied migrations are skipped, so running twice changes nothing', async () => {
  const m = loadMigrations(dir({ '000_a.sql': 'SELECT 1;', '001_b.sql': 'SELECT 2;' }));
  const c = fakeClient({ applied: Object.fromEntries(m.map((x) => [x.version, x.checksum])) });
  const r = await applyMigrations(c, m);
  assert.deepEqual(r, { applied: [], skipped: ['000_a', '001_b'] });
  assert.ok(!c.log.includes('BEGIN'));
});

test('an edited migration is refused, not silently re-run', async () => {
  const m = loadMigrations(dir({ '001_b.sql': 'SELECT 2;' }));
  const c = fakeClient({ applied: { '001_b': 'f'.repeat(64) } });
  await assert.rejects(() => applyMigrations(c, m), /edited after it was applied/);
});

test('a failing migration is rolled back and nothing after it runs', async () => {
  const c = fakeClient({ failOn: 'CREATE TABLE bad' });
  const m = loadMigrations(dir({ '000_a.sql': 'CREATE TABLE IF NOT EXISTS dispute_automation.schema_migrations (x int);', '001_bad.sql': 'CREATE TABLE bad();', '002_c.sql': 'SELECT 3;' }));
  await assert.rejects(() => applyMigrations(c, m), /001_bad failed and was rolled back/);
  assert.deepEqual(Object.keys(c.tracked), ['000_a']);
  assert.ok(c.log.includes('ROLLBACK'));
  assert.ok(c.log.at(-1).includes('pg_advisory_unlock'), 'the lock is released even on failure');
});

test('a dry run reports what would be applied and changes nothing', async () => {
  const c = fakeClient();
  const m = loadMigrations(dir({ '000_a.sql': 'SELECT 1;' }));
  const r = await applyMigrations(c, m, { dryRun: true });
  assert.deepEqual(r.applied, ['000_a']);
  assert.ok(!c.log.includes('BEGIN'));
  assert.deepEqual(c.tracked, {});
});
