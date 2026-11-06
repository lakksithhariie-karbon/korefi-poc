# KoreFi Dispute Assistant · v0.3 Chrome sidebar pilot

A compact **Chrome Manifest V3 side panel** for DoorDash internal operations.

## Workflow

1. **Capture full order:** With the DoorDash order sheet open, click **Capture full-page order**. The extension scrolls the order sheet, redacts identified personal details, and stitches the screenshot. If the scroll was truncated or redaction fails, the UI warns instead of falsely showing a complete screenshot.
2. **Chat about the issue:** Add an OpenAI API key in Settings to ask live questions. The assistant receives the parsed order, redacted page text, and redacted screenshot when available. It is prohibited from inventing evidence.
3. **Prepare dispute text:** Generate a factual, editable dispute response, review it, and copy it to DoorDash.
4. **Confirm manually:** Only after the operator files in DoorDash, click **Yes, disputed**. The status and exact copied text are stored locally first. If a logging endpoint is configured, a POST attempts to sync the submission. **Only HTTP 2xx makes the UI display “Dispute logged in KoreFi”.** A failed sync remains queued locally with a Retry action. Orders already marked filed are not logged twice within a Chrome profile.

## Installation

Extract the release ZIP, open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select the **dist** folder. Open DoorDash, open the relevant order details sheet, and click the KoreFi extension toolbar icon to open its sidebar.

The official wordmark is displayed from `https://www.korefi.ai/korefi-logo.png`, with a text fallback if the browser cannot retrieve it.

## AI setup

Open the Settings icon and enter an OpenAI API key. Default model is `gpt-4.1-mini` (can be overridden). Model requests go directly from the local pilot extension to OpenAI. Do not distribute shared keys in a team production rollout. The extension never submits a dispute to DoorDash.

## KoreFi DB logging integration

Set **KoreFi dispute logging endpoint** to an authenticated HTTPS **POST** endpoint implemented by your backend, and add its bearer token if required. Chrome requests permission for that endpoint's origin when you save Settings. Sample request:

```http
POST /your-backend-route HTTP/1.1
Content-Type: application/json
Authorization: Bearer <internal-ops-token>
Idempotency-Key: doordash:3990CBFD

{
  "platform": "doordash",
  "order_id": "3990CBFD",
  "case_id": "3990CBFD-example",
  "idempotency_key": "doordash:3990CBFD",
  "order_url": "https://merchant.doordash.com/...",
  "disputed_at": "2026-11-06T12:00:00.000Z",
  "dispute_text": "Please review...",
  "dispute_amount": 7.99,
  "error_reason": "Missing item",
  "source": "korefi-chrome-extension"
}
```

Return HTTP **2xx** only after the backend has durably saved the record. Any JSON response may optionally contain `id`, `dispute_id`, or `record_id`. Enforce server-side authentication, authorization, outlet identity, a unique constraint / idempotency key, and validation. The extension has no direct Neon credentials and never claims a local save is a backend save.

For a backend requiring cookies or CORS preflight, configure it to accept extension-origin requests and `Idempotency-Key`, or route requests through an authenticated same-origin gateway. Tokens stored in Chrome are **pilot-only**.

## Safety and known limitations

- Initial DoorDash parser was validated on a limited portal sample; manually verify extracted order IDs, amounts, and screenshot completeness.
- Redaction covers identified names, not every possible field. Don't assume screenshots are fully anonymized; do not upload them to the dispute logging API.
- Screenshotting uses `activeTab`, and works best when the order remains visible, with no manual scrolling during the stitch operation.
- A very long order can exceed the screenshot frame limit; UI will explicitly show a partial-capture warning.
- The 14-day rule is a working assumption and must be verified against actual DoorDash terms.
- Confirmation represents an **operator attestation**, not proof DoorDash accepted the dispute. Recoveries and decisions are outside this minimal flow.
- Per-browser local storage is not a central ops database. To enable real cross-operator logging, configure a KoreFi backend route.

## Development

```bash
npm ci
npm run build
npm test
```

For mock-portal tests, use `npm run e2e` (requires Playwright browser binaries). Only the release `dist` folder is needed for installation.
