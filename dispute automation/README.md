# KoreFi Dispute Assistant v0.8

A Chrome side-panel extension and a small agent service for DoorDash disputes. The operator opens an order in the
DoorDash merchant portal, captures it, asks the agent what to do, edits the draft, **files the dispute in DoorDash
themselves**, and then confirms. Nothing is ever submitted to DoorDash by this software.

```
DoorDash tab ── capture (scroll, redact, stitch) ──► side panel ── Send ──► Pi agent service (Render) ──► Neon
                                                         ▲                    │  chat, images, transcript saved
                                                         └─ answer + draft ◄──┘  agent resumes the same conversation
```

## Using it

1. `npm install && npm run build`, then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.
2. Open a DoorDash order, click the KoreFi icon on that tab. Open Settings (sun icon) once: agent URL, your agent token, operator ID.
3. **+** captures the order. **Send** asks the agent. Ask follow-ups in the same chat; the agent remembers the conversation and your draft.
4. **Draft** tab: edit, **Copy dispute**, file it in DoorDash, then **Yes, disputed** to log it.

## What changed in v0.8: chats the server owns

- **The conversation lives on the server.** The panel sends only the new message. The agent resumes the saved conversation
  (its own transcript, tool results included) on every turn, so follow-ups remember what it already looked up.
- **The agent always sees the images.** The redacted screenshot slices (and any extra evidence photos) are stored with the chat
  and attached again on every turn, so a photo of the food can be judged on turn five as well as turn one. They are deleted after
  `IMAGE_RETENTION_DAYS` (30). Chat text and transcripts never contain image data.
- **History and new chat.** The clock button lists every chat, newest first, with its order, recommendation and whether it was
  marked disputed. Open one on any device to read it, see its evidence images, and keep going. New chat starts blank.
- **Capture again mid-chat** (**+** on the same order) adds new evidence to the chat instead of replacing it.
- **Suggested questions come from the agent**, and **Mark as disputed** is a command the backend records, not something the model decides.
- **Database changes are migrations, not runtime magic.** The service's database role cannot create or alter tables (by design). Chats need `db/migrations/001_conversations.sql`, applied once by an owner (`npm run migrate`, see `db/README.md`). Until then chats answer a plain 503 and everything else keeps working.

## What changed in v0.7

- **No unredacted screenshot exists.** If personal details cannot be located and hidden on every screen, no screenshot is taken and the
  agent works from the redacted page text. There is no fallback, no warning and no override. Redaction no longer depends on the parser:
  it uses names the parser found, the blocks under the Customer / Dasher labels, and emails / phone numbers, and covers the
  "left a comment" attribution line.
- **No store ID is not an error.** A store with no history, or one that could not be identified, still gets a full answer and a draft.
  The store ID is read from the page address or text when present, can be typed in by hand, and is optional.
- **Investigations are asynchronous.** The panel pings the backend when it opens (Render's free plan sleeps), starts the investigation,
  and polls for the result, so a slow wake-up or a dropped connection no longer loses the answer.
- **Chat has memory.** Follow-ups send the recent conversation and the current draft. The screenshot stays in context for the case.
  Tall screenshots go as consecutive slices instead of one shrunken strip.
- **Filing is logged even without a store ID or a prior investigation.**
- Per-operator tokens, rate limits, request logging (no bodies, tokens or images), explicit strict database SSL, empty 204 preflight.

## Layout

```
src/background.ts        capture queue; scroll, screenshot, redact, stitch (fails closed)
src/content/             page reader: parse, redaction regions, scrolling (runs only when asked)
src/shared/              parser, rules, text scrubbing, store/order ID detection, storage
src/sidepanel/           chat UI (app.js), history, markup, styles
agent-backend/           Node service: async investigations, Pi agent, Neon store
db/                      reference for the live database, and migrations (000 tracking, 001 conversations) with their runner
e2e/run.mjs              real extension in Chromium against a mock portal and a fake Pi backend
```

## Tests

```bash
npm run typecheck
npm test            # extension unit tests + backend tests (no database, model key or network needed)
npm --prefix agent-backend run test:integration   # the service against a real Postgres branch (see db/README.md)
npm run e2e         # needs the Playwright browser in .browsers (npx playwright install chromium)
```

## What leaves the browser

Only when you press Send: the parsed order facts (no customer or Dasher names), redacted page text, the redacted screenshot slices,
your message, and your draft. They go to your Pi agent service, which sends them to OpenAI. Captures are kept in
`chrome.storage.local`. The backend stores the chat, the agent's transcript (including the records its tools returned),
tool-call counts, and the redacted images for 30 days. Only images that were redacted in the browser are ever uploaded.

## Limits and open decisions

- The parser and the Customer / Dasher anchors were built from one real order page. If DoorDash changes its layout, capture degrades
  to data-only rather than leaking.
- One shared token per operator is a pilot measure. Use `KOREFI_AGENT_TOKENS` for per-operator identity; real sign-in comes later.
- Confirmation is the operator's word that they filed it, not proof that DoorDash accepted it.
- **Who sits at the DoorDash portal is still unresolved.** DoorDash's Merchant Portal Security Terms restrict portal access to the
  merchant itself. Get counsel's view before using this on a merchant's account.
- The 14-day dispute window is a working assumption to verify.
