-- KoreFi dispute assistant: conversations, saved chat state, and evidence images.
--
-- The backend applies this itself when it starts, with its own limited database role, if the tables are missing.
-- It is written so that works: it only creates NEW tables in the dispute_automation schema, so the role ends up owning them
-- and needs no grants. It does not alter, and does not add foreign keys to, any existing table (those would need
-- ownership of, or REFERENCES on, tables this role may not own). Cross-table links are plain ids.
-- Safe to run again: everything is IF NOT EXISTS. Running it by hand as an admin is only needed if the backend
-- role is not allowed to create tables; in that case also grant that role access to the five new tables.

BEGIN;

-- One chat. A case (order) can have many chats.
CREATE TABLE IF NOT EXISTS dispute_automation.conversations (
  id                  bigserial PRIMARY KEY,
  tenant_id           text   NOT NULL,
  case_id             bigint NOT NULL,                         -- dispute_automation.cases.id
  title               text   NOT NULL DEFAULT 'New chat',
  created_by          text,
  status              text   NOT NULL DEFAULT 'open',          -- open | disputed
  last_recommendation text,                                    -- dispute | needs_review | do_not_dispute
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_tenant_updated_idx ON dispute_automation.conversations (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_case_idx           ON dispute_automation.conversations (case_id);

-- What the operator sees in the chat, in order. Assistant rows carry the structured answer in `result`.
CREATE TABLE IF NOT EXISTS dispute_automation.conversation_messages (
  id               bigserial PRIMARY KEY,
  conversation_id  bigint NOT NULL REFERENCES dispute_automation.conversations(id) ON DELETE CASCADE,
  role             text   NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  text             text   NOT NULL,
  result           jsonb,                                      -- recommendation, draft, missing evidence, follow-ups, tools used
  investigation_id bigint,                                     -- dispute_automation.investigations.id
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_messages_conv_idx ON dispute_automation.conversation_messages (conversation_id, id);
CREATE INDEX IF NOT EXISTS conversation_messages_inv_idx  ON dispute_automation.conversation_messages (investigation_id);

-- Which chat an agent run belongs to (kept here so the existing investigations table is left alone).
CREATE TABLE IF NOT EXISTS dispute_automation.conversation_runs (
  investigation_id bigint PRIMARY KEY,                         -- dispute_automation.investigations.id
  conversation_id  bigint NOT NULL REFERENCES dispute_automation.conversations(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The agent's own transcript, so the next message continues the same conversation (tool results included).
-- Image data is never stored here; images live in evidence_images and are attached again on every turn.
CREATE TABLE IF NOT EXISTS dispute_automation.conversation_state (
  conversation_id bigint PRIMARY KEY REFERENCES dispute_automation.conversations(id) ON DELETE CASCADE,
  pi_messages     jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Redacted screenshot slices and any extra evidence photos. Deleted after expires_at (default 30 days).
CREATE TABLE IF NOT EXISTS dispute_automation.evidence_images (
  id              bigserial PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES dispute_automation.conversations(id) ON DELETE CASCADE,
  case_id         bigint NOT NULL,                             -- dispute_automation.cases.id
  mime            text   NOT NULL,
  bytes           bytea  NOT NULL,
  byte_size       integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_images_conv_idx    ON dispute_automation.evidence_images (conversation_id, id);
CREATE INDEX IF NOT EXISTS evidence_images_expires_idx ON dispute_automation.evidence_images (expires_at);

COMMIT;
