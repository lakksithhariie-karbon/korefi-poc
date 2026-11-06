-- Conversations: a chat per question thread, the agent's saved transcript, and the redacted evidence images it looks at.
--
-- Written against the live dispute_automation schema: uuid keys (like every existing table), and the same
-- tenant-scoped foreign key that submissions uses, so a chat can never point at another tenant's case.
-- Existing tables are not altered. The service role (korefi_dispute_agent_rw) gets read/write on the new
-- tables only; it cannot create or change tables, by design. Apply with `npm run migrate` as an owner role.

CREATE TABLE IF NOT EXISTS dispute_automation.conversations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           text NOT NULL CHECK (length(btrim(tenant_id)) > 0),
  case_id             uuid NOT NULL,
  title               text NOT NULL DEFAULT 'New chat' CHECK (char_length(title) <= 200),
  created_by          text,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'disputed', 'archived')),
  last_recommendation text CHECK (last_recommendation IS NULL OR last_recommendation IN ('dispute', 'needs_review', 'do_not_dispute')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_case_scope_fk FOREIGN KEY (tenant_id, case_id) REFERENCES dispute_automation.cases (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS conversations_tenant_updated_idx ON dispute_automation.conversations (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_case_idx ON dispute_automation.conversations (case_id);

-- What the operator sees, in order. Assistant rows carry the structured answer in `result`.
CREATE TABLE IF NOT EXISTS dispute_automation.conversation_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  conversation_id  uuid NOT NULL REFERENCES dispute_automation.conversations (id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  text             text NOT NULL CHECK (char_length(text) <= 20000),
  result           jsonb,
  investigation_id uuid REFERENCES dispute_automation.investigations (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_messages_conv_idx ON dispute_automation.conversation_messages (conversation_id, seq);
CREATE INDEX IF NOT EXISTS conversation_messages_inv_idx ON dispute_automation.conversation_messages (investigation_id) WHERE investigation_id IS NOT NULL;

-- Which chat an agent run belongs to. Kept here so the existing investigations table is left untouched.
CREATE TABLE IF NOT EXISTS dispute_automation.conversation_runs (
  investigation_id uuid PRIMARY KEY REFERENCES dispute_automation.investigations (id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES dispute_automation.conversations (id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_runs_conv_idx ON dispute_automation.conversation_runs (conversation_id);

-- The agent's own transcript, so the next message continues the same conversation (tool results included).
-- Image data is never stored here; images live in evidence_images and are attached again on every turn.
CREATE TABLE IF NOT EXISTS dispute_automation.conversation_state (
  conversation_id uuid PRIMARY KEY REFERENCES dispute_automation.conversations (id) ON DELETE CASCADE,
  pi_messages     jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Redacted screenshot slices and extra evidence photos. Removed after expires_at. This table is the storage seam:
-- when object storage is chosen, bytes move there and only metadata stays (see cases.screenshot_object_key).
CREATE TABLE IF NOT EXISTS dispute_automation.evidence_images (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  conversation_id uuid NOT NULL REFERENCES dispute_automation.conversations (id) ON DELETE CASCADE,
  case_id         uuid NOT NULL REFERENCES dispute_automation.cases (id),
  mime            text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png')),
  bytes           bytea NOT NULL,
  byte_size       integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_images_conv_idx ON dispute_automation.evidence_images (conversation_id, seq);
CREATE INDEX IF NOT EXISTS evidence_images_expires_idx ON dispute_automation.evidence_images (expires_at);

-- Explicit, so a fresh environment works without relying on default privileges.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'korefi_dispute_agent_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      dispute_automation.conversations,
      dispute_automation.conversation_messages,
      dispute_automation.conversation_runs,
      dispute_automation.conversation_state,
      dispute_automation.evidence_images
    TO korefi_dispute_agent_rw;
  END IF;
END
$grants$;
