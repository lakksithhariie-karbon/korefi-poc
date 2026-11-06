// Applies db/migrations/*.sql in order, once each, recording a checksum so an edited migration is caught.
// Run by a person or CI with an owner role (see scripts/migrate.mjs). The running service never does this.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const FILE = /^(\d{3}_[a-z0-9_]+)\.sql$/;
const LOCK_ID = 727001;

export function loadMigrations(dir) {
  return readdirSync(dir)
    .filter((f) => FILE.test(f))
    .sort()
    .map((f) => {
      const raw = readFileSync(path.join(dir, f));
      return { version: f.match(FILE)[1], file: f, sql: raw.toString('utf8'), checksum: createHash('sha256').update(raw).digest('hex') };
    });
}

/**
 * @param client a single connected pg client (one session, because of the advisory lock and the transactions)
 * @returns {{applied: string[], skipped: string[]}}
 */
export async function applyMigrations(client, migrations, { log = () => {}, dryRun = false } = {}) {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
  try {
    const tracked = (await client.query("SELECT to_regclass('dispute_automation.schema_migrations') AS t")).rows[0].t !== null;
    const known = new Map();
    if (tracked) for (const r of (await client.query('SELECT version, checksum FROM dispute_automation.schema_migrations')).rows) known.set(r.version, r.checksum);

    const applied = [];
    const skipped = [];
    for (const m of migrations) {
      const seen = known.get(m.version);
      if (seen) {
        if (seen !== m.checksum) {
          throw new Error(`Migration ${m.version} was edited after it was applied (checksum differs). Leave old migrations alone and add a new one.`);
        }
        skipped.push(m.version);
        continue;
      }
      if (dryRun) {
        applied.push(m.version);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO dispute_automation.schema_migrations(version, checksum) VALUES($1, $2)', [m.version, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${m.version} failed and was rolled back: ${err.message}`);
      }
      applied.push(m.version);
      log(`applied ${m.version}`);
    }
    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
  }
}
