// The service never changes the database schema: its role is deliberately read/write only. Schema changes are
// migrations (db/migrations, applied with `npm run migrate` by an owner role). This only checks that the tables the
// chat feature needs are there, so a deploy that gets ahead of its migration degrades to a clear message instead of
// raw SQL errors, and recovers by itself (no restart) once the migration has been applied.

const RECHECK_AFTER_MS = 30_000;

/**
 * @param {{ missingTables: () => Promise<string[]> }} db
 */
export function createSchemaGuard(db, { log = () => {}, now = Date.now } = {}) {
  let state = null; // null until the first check
  let checkedAt = 0;
  let inFlight = null;

  async function check() {
    try {
      const missing = await db.missingTables();
      const was = state?.ready;
      state = { ready: missing.length === 0, missing, error: null };
      if (state.ready && was !== true) log(JSON.stringify({ level: 'info', event: 'conversation_schema_ready' }));
      if (!state.ready) log(JSON.stringify({ level: 'error', event: 'conversation_schema_missing', missing }));
    } catch (err) {
      // A database that cannot be reached is not the same as a missing migration; do not claim the schema is wrong.
      const message = String(err?.message || err).slice(0, 300);
      state = { ready: state?.ready === true ? true : false, missing: state?.missing ?? [], error: message, unreachable: true };
      log(JSON.stringify({ level: 'error', event: 'conversation_schema_check_failed', message }));
    }
    checkedAt = now();
    return state;
  }

  return {
    /** True/false once checked, null before. */
    ready: () => (state ? state.ready : null),
    /** A ready schema stays ready. A missing one is re-checked at most every 30 seconds, or at once when forced. */
    async ensure({ force = false } = {}) {
      if (state?.ready === true && !force) return state;
      if (inFlight) return inFlight;
      if (state && !force && now() - checkedAt < RECHECK_AFTER_MS) return state;
      inFlight = check().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
