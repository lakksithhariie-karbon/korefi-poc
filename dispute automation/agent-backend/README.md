# KoreFi Pi Dispute Agent Backend (POC)

Server-side [Pi agent-core](https://github.com/earendil-works/pi) investigation service for KoreFi's DoorDash Chrome extension. This is a pilot, not autonomous DoorDash submission.

## Deploy on Render

Repository: `lakksithhariie-karbon/korefi-poc`
Build: `cd 'dispute automation/agent-backend' && npm install --omit=dev --ignore-scripts`
Start: `node 'dispute automation/agent-backend/src/server.mjs'`
Runtime: Node 22.19+ (Ohio).

Environment:
- `KOREFI_AGENT_TOKEN` (random secret, at least 32 chars)
- `DATABASE_URL` (Neon role with read/write only in `dispute_automation`)
- `HISTORY_DATABASE_URL` (Neon read-only role scoped to `doordash`)
- `OPENAI_API_KEY` (server-side key, needed for investigations)
- `OPENAI_MODEL` (optional, defaults `gpt-4.1-mini`)
- `ALLOWED_EXTENSION_ORIGINS` (comma-separated Chrome extension origins after extension IDs are known)

Endpoints:
- `GET /healthz` public liveness
- `GET /readyz` bearer-authenticated role checks + model setup status
- `POST /v1/investigations` bearer-authenticated, inputs: `operator_id`, optional `store_id`, `order_id`, `order_url`, `issue_category`, `issue_description`, `dispute_amount`, `structured_facts`, `redacted_page_text`, optional redacted `screenshot`. Persists case, agent investigation, tool call metadata. Image bytes not saved in database.
- `POST /v1/disputes/confirm` bearer-authenticated, inputs: `operator_id`, optional `store_id`, `order_id`, `dispute_text`, `disputed_at` (ISO with timezone). This is an operator attestation, not DoorDash submission. Duplicate confirmations are idempotent.

The backend uses read-only tools scoped to the current store: order financials, error charges, order issue reports, store issue frequencies and prior KoreFi cases. Historic error frequency is NOT a dispute win rate; missing historical outcomes must be described as unknown.

Run `npm test` after dependencies are installed.

Security: The POC has one shared bearer token and self-reported operator IDs. Before team rollout, add real user auth, per-merchant access controls, rate limiting, protected sensitive data, approved Chrome origins and end-to-end live portal tests. The existing sidebar v0.3 needs a follow-up integration change to call the agent and send store_id. Never put server tokens into GitHub or distributable extension code.
