# Database (Neon: project `korefi-dump`, database `neondb`, schema `dispute_automation`)

This is the reference for what is actually in production, read from the live database on 2026-11-06, plus how changes are made.

## Roles and who may do what

| Role | Used by | Rights |
|---|---|---|
| `neondb_owner` | people / CI running migrations | owns every schema and table; can create and alter |
| `korefi_dispute_agent_rw` | the backend (`DATABASE_URL`) | `SELECT, INSERT, UPDATE, DELETE` on `dispute_automation` tables. **No `CREATE`, cannot alter.** Tables the owner creates in this schema grant it read/write automatically (default privileges), and each migration also grants explicitly |
| `korefi_dispute_history_ro` | the backend (`HISTORY_DATABASE_URL`) | `SELECT` on the `doordash` schema only |

The service never changes the schema, and a test asserts that no DDL appears in its source. Schema changes are migrations.

## Existing tables (before migration 001)

All primary keys are `uuid` (`gen_random_uuid()`), all timestamps `timestamptz`.

- `cases`: one per order. `(tenant_id, platform, platform_store_id, platform_order_id)` is unique, as is `(tenant_id, id)` (used by tenant-scoped foreign keys). `case_status` is one of captured, investigating, ready_to_dispute, submitted, closed. `platform_store_id` is `unresolved` when the store is unknown. Unused so far: `screenshot_object_key`, `location_id`.
- `investigations`: one agent run per row (`status` running/completed/failed/cancelled; `recommendation` dispute/needs_review/do_not_dispute). Has `prompt_version` and `usage_summary` (the service now fills `prompt_version`).
- `agent_tool_calls`: one per tool call (`status` running/completed/failed/blocked), counts in `result_summary`.
- `submissions`: the operator's attested filing. Unique `(tenant_id, idempotency_key)`; foreign key `(tenant_id, case_id)` to `cases`.
- `case_events`: audit trail (`actor_type` operator/agent/system). The service writes conversation_opened, evidence_added, agent_answered, operator_confirmed_submission.
- `outcomes`, `recovery_adjustments`: decisions and credits per submission (not written by the service yet).
- `evidence`: evidence metadata with an `object_key` for object storage (not written yet).

Read-only history the agent searches, in the `doordash` schema: `financial_detailed_transactions`, `financial_error_charges_adjustments`, `operations_order_missing_incorrect`. All columns are text; they are small (thousands of rows) and have no indexes.

## Migrations (`db/migrations`)

- `000_schema_migrations`: the tracking table (`version`, `checksum`).
- `001_conversations`: `conversations`, `conversation_messages`, `conversation_runs`, `conversation_state`, `evidence_images`. Tenant-scoped like `submissions`; no existing table is altered.

Rules: one file per change, numbered, never edited after it has been applied (the runner refuses a changed file), additive where possible, no `BEGIN`/`COMMIT` inside (the runner wraps each file in a transaction).

### Applying

```bash
# As neondb_owner, with the DIRECT connection string (host without "-pooler"; the pooler breaks the advisory lock).
MIGRATION_DATABASE_URL='postgresql://neondb_owner:…@ep-….neon.tech/neondb?sslmode=require' npm --prefix agent-backend run migrate -- --dry-run
MIGRATION_DATABASE_URL='…' npm --prefix agent-backend run migrate
```

Always rehearse on a Neon branch first: create a branch of `production`, apply there, run the integration tests against it as the
service roles, and only then apply to production.

```bash
INTEGRATION_DATABASE_URL='<service-role url on the branch>' INTEGRATION_HISTORY_DATABASE_URL='<history-role url on the branch>' \
  npm --prefix agent-backend run test:integration
```

## Storage

The Neon project limit is 1 GiB per branch, and the database already holds other data. Evidence images are stored as `bytea` in
`evidence_images` and capped by `IMAGE_BUDGET_MB` (default 200); when the budget is full the service stops saving images and tells the
operator instead of failing, and images expire after `IMAGE_RETENTION_DAYS` (30). `evidence_images` is the seam for moving bytes to object
storage later (`evidence.object_key` and `cases.screenshot_object_key` already exist for that).
