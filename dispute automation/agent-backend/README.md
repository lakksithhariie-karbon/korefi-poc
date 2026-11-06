# KoreFi Pi Dispute Agent (backend)

Server-side [Pi agent-core](https://github.com/earendil-works/pi) investigation service for the KoreFi Chrome extension.
It investigates and drafts; it never files anything in DoorDash.

## Deploy on Render

Repository `lakksithhariie-karbon/korefi-poc`, Node 22.19+.
Build: `cd 'dispute automation/agent-backend' && npm install --omit=dev --ignore-scripts && npm test`
Start: `node 'dispute automation/agent-backend/src/server.mjs'`

Environment:
- `KOREFI_AGENT_TOKENS` per-operator tokens, `token:operator@example.com,token2:other@example.com`. Each token is at least 32 characters.
  The server then decides who is calling and ignores any operator ID the client sends.
- `KOREFI_AGENT_TOKEN` one shared token (at least 32 characters). Still works; the client must send `operator_id`.
- `DATABASE_URL` Neon role with read/write on `dispute_automation`. `HISTORY_DATABASE_URL` read-only role on `doordash`.
  Both are connected with `sslmode=verify-full` whatever the URL says (local hosts excepted).
- `OPENAI_API_KEY`, optional `OPENAI_MODEL` (default `gpt-4.1-mini`; must accept images).
- `ALLOWED_EXTENSION_ORIGINS` comma-separated `chrome-extension://<id>` origins.
- Optional: `RATE_REQUESTS_PER_MIN` (240), `RATE_INVESTIGATIONS_PER_10MIN` (60). Four investigations run at a time per instance.

## API

All routes except `/healthz` need `Authorization: Bearer <token>`.

- `GET /healthz` public. The extension calls it to wake the service.
- `GET /readyz` database and model status.
- `POST /v1/investigations` returns **202** at once with `{investigation_id, case_id, store_id, status:'running'}`.
  Body: `order_id` (required), optional `store_id`, `order_url`, `issue_category`, `issue_description`, `dispute_amount`,
  `structured_facts`, `redacted_page_text`, `operator_question`, `screenshots` (up to 6 JPEG/PNG data URLs, consecutive slices),
  `conversation` (last turns, `[{role:'user'|'assistant', text}]`), `previous_draft`, `capture_status`.
  A missing `store_id` is normal: it is looked up from the order, otherwise stored as `unresolved`, and the agent works without history.
- `GET /v1/investigations/:id` returns `running`, `failed` (with a safe `error`), or `completed` with `recommendation`,
  `reasoning_summary`, `missing_evidence`, `draft_text`, `risk_notes`, `tools_used`. A run orphaned by a restart is reported as failed.
- `POST /v1/disputes/confirm` records the operator's confirmation once per case. `store_id` is optional; if the order was never
  investigated the case is created. Body: `order_id`, `dispute_text`, `disputed_at` (ISO with timezone), optional `store_id`,
  `order_url`, `dispute_amount`, `issue_category`. Returns `{id, case_id, store_id, submitted_at, already_recorded}`.

The agent's tools are read-only and fixed to the current store and order. Historic issue frequency is not a win rate, and an
adjustment is not proof of a won dispute.

## Tests

`npm test` runs without a database or model: the HTTP flow runs against an in-memory store with the same methods as the Neon one.
The SQL itself is only exercised against real Neon; see `../db/schema.inferred.sql`.
