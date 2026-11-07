# KoreFi Dispute Assistant v0.10.2

A Chrome side-panel extension and a small agent service for delivery-platform disputes, on **DoorDash and Uber Eats**
(Grubhub next). The operator opens an order in the merchant portal, attaches it, asks the agent what to do, edits the
draft, **files the dispute on the platform themselves**, and then confirms. Nothing is ever submitted by this software.

```
DoorDash / Uber Eats tab ── attach (scroll, redact, stitch, customer photos) ──► side panel ── Send ──► agent service (Render) ──► Neon
                                                                                   ▲                      │  chat, images, transcript saved
                                                                                   └─ answer + draft ◄────┘  agent resumes the same conversation
```

## Using it

1. `npm install && npm run build`, then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.
2. Open an order, click the KoreFi icon on that tab. The first time, open the sidebar → **Settings** → **Connection**: agent URL, access token, your name or ID.
3. **+** attaches the order. The first time, Chrome asks to let KoreFi see your tabs: choose **Allow**, or screenshots will only
   work right after clicking the KoreFi icon on that tab. **Send** asks the agent. Ask follow-ups in the same chat; the agent remembers the conversation and your draft.
4. **Draft** under an answer: edit, **Copy draft**, file it on the platform, then **Yes, mark as disputed** to log it.

## What changed in v0.10.2: screenshots no longer depend on clicking the icon

- **The bug.** Chrome takes a screenshot of a tab only if the extension has `activeTab` (granted by clicking its toolbar icon on
  that tab) or `<all_urls>`. Access to doordash.com and ubereats.com does not count. `activeTab` is lost when the tab reloads, when
  the extension is updated, and it is never granted when the panel is opened another way (pinned, or carried over from another tab).
  The page text was still read, so the order showed up, but the screenshot failed with "click the KoreFi icon".
- **Why tests missed it.** The test build gave itself `<all_urls>` up front, so it never ran without the grant.
- **The fix.** The first tap on **+** asks Chrome once for `<all_urls>` (an optional permission, so installing shows no new
  warning). After that, screenshots work on any order tab, after reloads and updates. If the user declines, the old click-the-icon
  route still works and the note says how to allow it. Nothing else changes: capture still only happens on a tap of +, on the tab
  on screen, and redaction still fails closed.
- **New test** `e2e/access.mjs` installs the extension as a user has it (no grant), shows Chrome refusing the screenshot, and checks
  that + asks for access, that declining explains itself, and that Chrome accepts the request (it fails if the manifest does not
  declare `<all_urls>`).

## What changed in v0.10: Uber Eats, and customer photos on both platforms

- **Uber Eats Manager orders.** The extension recognises the platform from the address, finds the order drawer (which has no
  dialog role), and reads the order: issue banner, deduction, timed steps, items with the flagged customisation, the customer's
  feedback, sales, chargeback, fee and net payout. The store UUID is read from the address when present.
- **Uber Eats redaction.** The customer at the top of the drawer and the courier card (name and face photo) are blacked out. Three
  signals combine: names the reader found, fields Uber Eats itself marks private (`fs-mask`), and pictures of people (round or
  small images). The same fail-closed rule applies: if they cannot be located, no screenshot is taken.
- **Customer photos are detected and kept at full size**, on DoorDash and Uber Eats: a large picture, or a picture next to words
  like "photo" or "feedback", that is not a face. Each is scrolled into view and cropped from a screenshot with the same black-out
  boxes applied. Up to three go to the agent first, and the agent is told they are the customer's claim, not proof. If the feedback
  is collapsed ("View more"), the panel says to open it and attach again.
- **The agent knows the platform.** DoorDash orders keep the DoorDash history tools. Other platforms only get KoreFi's own past
  cases, because the history database holds DoorDash data. No dispute deadline is computed for Uber Eats until its terms are read.
- **Backend 0.5.0** accepts `platform` (`doordash`, `ubereats`, `grubhub`; older clients mean DoorDash), stores it on the case,
  and allows up to 9 images per message and 24 per chat. No database migration: the `cases.platform` check already allows all three.
- **v0.9 UI**: a minimal chat in KoreFi's design system (Radix-based gray and orange ramps, Google Sans Flex bundled locally),
  with chats in a slide-out sidebar and the draft and sources as their own screens.

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
