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
- Optional: `RATE_REQUESTS_PER_MIN` (240), `RATE_INVESTIGATIONS_PER_10MIN` (60), `IMAGE_RETENTION_DAYS` (30), `IMAGE_BUDGET_MB` (200),
  `RUN_TIMEOUT_MS` (110000, hard limit on one agent turn), `TENANT_ID` (`korefi-internal-poc`, must match existing rows).
  Four investigations run at a time per instance. Run a single instance: one-answer-at-a-time and drain are per process.

## Database changes

The service connects with a deliberately limited role (read/write on `dispute_automation`, no `CREATE`) and never changes the
schema. Chats need the tables from `../db/migrations/001_conversations.sql`, applied once by an owner with `npm run migrate`
(see `../db/README.md`). If they are missing the service stays up: chat routes answer 503 ("Chats are not available right now"),
`/readyz` reports `conversations: "missing"`, the older `/v1/investigations` flow keeps working, and the service looks again every
30 seconds, so applying the migration needs no restart.

## API

All routes except `/healthz` need `Authorization: Bearer <token>`.

- `GET /healthz` public. The extension calls it to wake the service.
- `GET /readyz` database and model status.
### Conversations (what the extension uses)

- `POST /v1/conversations` opens a chat on an order and stores the redacted screenshot slices. Same facts as an investigation, no question yet. Returns **201** `{conversation_id, case_id, store_id}`.
- `POST /v1/conversations/:id/messages` `{text, previous_draft?, screenshots?, additional_text?}` returns **202** `{investigation_id}`. Poll it with `GET /v1/investigations/:id`. The agent resumes the saved transcript and gets every stored image again. Extra `screenshots` (or the page text of a new capture) are added to the chat as evidence; a chat holds at most 12 images. One message is answered at a time per chat (409 otherwise).
- `GET /v1/conversations?limit=50` lists chats, newest first. `GET /v1/conversations/:id` returns the chat, its messages (assistant rows carry the structured answer) and its images.
- `GET /v1/conversations/:id/images/:imageId` returns the image bytes.
- `POST /v1/disputes/confirm` also accepts `conversation_id`: the chat is marked disputed and a note is added to it.

Completed runs include `suggested_followups` (from the agent, with sensible defaults).

`POST /v1/conversations` and `POST /v1/conversations/:id/messages` honour an `Idempotency-Key` header: a retry with the same key gets the first answer back and does the work once (kept 15 minutes). Both report `images_dropped` when the image budget is full; the chat carries on from text.

Failures are plain: database trouble is a 503 with `Retry-After`, a run that exceeds `RUN_TIMEOUT_MS` is a failed run with a safe message, and a run lost to a restart is reported as failed rather than polled forever. On a deploy (`SIGTERM`) the service stops accepting connections and waits up to 25 seconds for answers in flight.

### Single investigations (older, stateless)

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

`npm test` runs without a database, an OpenAI key or the network: the HTTP flow runs against an in-memory store with the same methods as the Neon one, and the real agent code (prompts, tools, saving and resuming a conversation) runs against a fake model.

`npm run test:integration` runs the whole service against a real Postgres as the real least-privilege roles (see `../db/README.md`): real uuid keys, tenant-scoped foreign keys, image bytes round-tripped through `bytea`, atomic filing, the real `doordash` history queries, and a proof that the role cannot change the schema. Point it at a Neon branch, never production. It found two bugs the in-memory tests could not (a stale-read race that reported finished answers as failed, and an arbitrary ordering in the similar-cases query).
The SQL itself is only exercised against real Neon; see `../db/schema.inferred.sql`.
