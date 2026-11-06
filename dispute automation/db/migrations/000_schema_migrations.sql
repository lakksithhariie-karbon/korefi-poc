-- Tracks which migrations have been applied, so the runner never repeats one and can spot an edited file.
CREATE TABLE IF NOT EXISTS dispute_automation.schema_migrations (
  version    text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT current_user
);
