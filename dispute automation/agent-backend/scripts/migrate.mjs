#!/usr/bin/env node
// Usage:  MIGRATION_DATABASE_URL=<owner connection string> npm run migrate [-- --dry-run]
// Applies any migration in ../db/migrations that has not been applied. Uses an owner role, not the service's role.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations, loadMigrations } from '../src/migrations.mjs';
import { withSslMode } from '../src/ssl.mjs';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('Set MIGRATION_DATABASE_URL to a connection string for a role that owns the dispute_automation schema.');
  process.exit(2);
}
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
const dryRun = process.argv.includes('--dry-run');

const client = new pg.Client({ connectionString: withSslMode(url), application_name: 'korefi-migrate' });
try {
  await client.connect();
  const { applied, skipped } = await applyMigrations(client, loadMigrations(dir), { log: (l) => console.log(l), dryRun });
  console.log(`${dryRun ? 'would apply' : 'applied'}: ${applied.length ? applied.join(', ') : 'nothing'}; already applied: ${skipped.length}`);
} catch (err) {
  console.error(String(err.message || err));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
