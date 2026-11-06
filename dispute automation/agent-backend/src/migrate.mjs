// Makes sure the conversation tables exist, creating them with the backend's own role when they do not.
// It never throws: if the role may not create tables, the backend keeps serving everything else and says so
// (chat routes answer 503 with a plain message) instead of crashing or returning a bare 500.

export const CONVERSATION_TABLES = ['conversations', 'conversation_messages', 'conversation_runs', 'conversation_state', 'evidence_images'];
const RETRY_AFTER_MS = 60_000;

/**
 * @param {{ missingTables: () => Promise<string[]>, applyMigration: () => Promise<void> }} db
 * @returns {{ ensure: (opts?: {force?: boolean}) => Promise<{ready: boolean, missing: string[], error: string|null}>, ready: () => boolean|null }}
 */
export function createMigrator(db, { log = () => {}, now = Date.now } = {}) {
  let ready = null; // null until the first check
  let lastAttempt = 0;
  let last = { ready: false, missing: [...CONVERSATION_TABLES], error: null };
  let inFlight = null;

  async function run() {
    try {
      let missing = await db.missingTables();
      if (missing.length) {
        log(JSON.stringify({ level: 'info', event: 'conversation_tables_missing', missing }));
        await db.applyMigration();
        missing = await db.missingTables();
      }
      ready = missing.length === 0;
      last = { ready, missing, error: ready ? null : 'Tables are still missing after the migration ran.' };
      if (ready) log(JSON.stringify({ level: 'info', event: 'conversation_tables_ready' }));
    } catch (err) {
      ready = false;
      const message = String(err?.message || err).slice(0, 300);
      last = { ready: false, missing: last.missing, error: message };
      log(JSON.stringify({ level: 'error', event: 'conversation_migration_failed', message }));
    }
    return last;
  }

  return {
    ready: () => ready,
    /** Checks, and if needed creates, the tables. A failed attempt is not repeated for a minute unless forced. */
    async ensure({ force = false } = {}) {
      if (ready === true && !force) return last;
      if (inFlight) return inFlight;
      if (ready === false && !force && now() - lastAttempt < RETRY_AFTER_MS) return last;
      lastAttempt = now();
      inFlight = run().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
