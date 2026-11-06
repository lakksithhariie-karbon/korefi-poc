-- INFERRED from the SQL in agent-backend/src/data.mjs. This is NOT the live schema and has not been applied.
-- The real tables live in Neon. Compare this with them before trusting it, and fix whichever side is wrong.
-- Written with IF NOT EXISTS so running it against a database that already has the tables changes nothing.

CREATE SCHEMA IF NOT EXISTS dispute_automation;

CREATE TABLE IF NOT EXISTS dispute_automation.cases (
  id                 bigserial PRIMARY KEY,
  tenant_id          text NOT NULL,
  platform           text NOT NULL DEFAULT 'doordash',
  -- 'unresolved' when the store could not be identified. Investigations and logging both work with it.
  platform_store_id  text NOT NULL,
  platform_order_id  text NOT NULL,
  order_url          text,
  issue_category     text,
  issue_description  text,
  error_amount       numeric(12,2),
  currency           text NOT NULL DEFAULT 'USD',
  captured_by        text,
  capture_status     text NOT NULL DEFAULT 'data_only',      -- complete | partial | data_only
  case_status        text NOT NULL DEFAULT 'captured',       -- captured | investigating | ready_to_dispute | submitted
  structured_facts   jsonb NOT NULL DEFAULT '{}'::jsonb,
  redacted_page_text text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, platform, platform_store_id, platform_order_id)
);

CREATE TABLE IF NOT EXISTS dispute_automation.case_events (
  id         bigserial PRIMARY KEY,
  case_id    bigint NOT NULL REFERENCES dispute_automation.cases(id),
  actor_type text NOT NULL,
  actor_id   text,
  event_type text NOT NULL,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dispute_automation.investigations (
  id                bigserial PRIMARY KEY,
  case_id           bigint NOT NULL REFERENCES dispute_automation.cases(id),
  agent_runtime     text NOT NULL,
  model_id          text,
  status            text NOT NULL DEFAULT 'running',         -- running | completed | failed
  recommendation    text,                                    -- dispute | needs_review | do_not_dispute
  reasoning_summary text,
  missing_evidence  jsonb,
  draft_text        text,
  risk_notes        text,
  error_summary     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

CREATE TABLE IF NOT EXISTS dispute_automation.agent_tool_calls (
  id               bigserial PRIMARY KEY,
  investigation_id bigint NOT NULL REFERENCES dispute_automation.investigations(id),
  tool_name        text NOT NULL,
  status           text NOT NULL DEFAULT 'running',
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  result_summary   jsonb                                     -- {summary, record_count}; no raw tool data is kept
);

CREATE TABLE IF NOT EXISTS dispute_automation.submissions (
  id                  bigserial PRIMARY KEY,
  case_id             bigint NOT NULL REFERENCES dispute_automation.cases(id),
  tenant_id           text NOT NULL,
  idempotency_key     text NOT NULL,                         -- doordash:<store>:<order>
  submitted_at        timestamptz NOT NULL,
  submitted_by        text,
  dispute_text        text NOT NULL,
  confirmation_source text NOT NULL DEFAULT 'operator_attested',
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS dispute_automation.outcomes (
  id              bigserial PRIMARY KEY,
  submission_id   bigint NOT NULL REFERENCES dispute_automation.submissions(id),
  decision_status text,
  awarded_amount  numeric(12,2)
);

CREATE TABLE IF NOT EXISTS dispute_automation.recovery_adjustments (
  id            bigserial PRIMARY KEY,
  submission_id bigint NOT NULL REFERENCES dispute_automation.submissions(id),
  credit_amount numeric(12,2)
);

-- Read-only history the agent searches lives in the doordash schema (a separate role and database URL):
--   doordash.financial_detailed_transactions, doordash.financial_error_charges_adjustments,
--   doordash.operations_order_missing_incorrect. Their definitions are owned by the data pipeline, not this repo.
