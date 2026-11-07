# KoreFi Dispute Assistant v0.11.1

A Chrome side-panel extension and a small agent service for delivery-platform disputes, on **DoorDash and Uber Eats**
(Grubhub next). The operator opens an order in the merchant portal, attaches it, asks the agent what to do, edits the
draft, **files the dispute on the platform themselves**, and then confirms. Nothing is ever submitted by this software.

```
DoorDash / Uber Eats tab ── attach (scroll, stitch, customer photos) ──► side panel ── Send ──► agent service (Render) ──► Neon
                                                                                   ▲                      │  chat, images, transcript saved
                                                                                   └─ answer + draft ◄────┘  agent resumes the same conversation
```

## Using it

1. `npm install && npm run build`, then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.
2. Open an order, click the KoreFi icon on that tab. The first time, open the sidebar → **Settings** → **Connection**: agent URL, access token, your name or ID.
3. **+** attaches the order. The first time, Chrome asks to let KoreFi see your tabs: choose **Allow**, or screenshots will only
   work right after clicking the KoreFi icon on that tab. **Send** asks the agent. Ask follow-ups in the same chat; the agent remembers the conversation and your draft.
4. **Draft** under an answer: edit, **Copy draft**, file it on the platform, then **Yes, mark as disputed** to log it.

## v0.11.1 and backend 0.6.1: the page's own dispute rules, the real charge, honest token counts

- **Closed dispute windows.** The agent reads the platform's rules on the page first: deadlines, notices such as Uber Eats'
  "orders placed more than 30 days ago can't be disputed", and whether the page offers a Dispute button or only Contact support.
  When the dispute route is closed it says so first, then fights through the route that is still open. The server also spots
  such a notice in the page text and puts it in front of the agent. PROMPT_VERSION `2026-11-07.win-2`.
- **The real charge.** The extension sent its own estimate (the sum of per-item amounts), which is $0 when the page gives no
  per-item amount, so every case was saved at $0.00. It now sends the page's own total ("Chargeback amount", "Error charge
  total"), falling back to the estimate only when the page has none. Fixture `ubereats-365D6-closed.txt` (names changed).
- **Token counts.** Claude reuses most of its prompt from a cache, so `tokens_in` now counts the whole prompt (new + cached);
  `cached_in` and `new_tokens_in` show the split.
- An Uber Eats answer no longer says "DoorDash-only history": the note for other platforms now names KoreFi's own past cases.

## Backend 0.6.0: an agent that fights for the money, on Vercel AI Gateway, with every step logged

- **New goal.** The agent disputes every error charge unless the evidence clearly shows the store made the mistake, and argues
  the strongest honest case. It never makes up facts: anything unconfirmed goes in the draft as `[verify]`. `dispute` is now the
  default; `do_not_dispute` needs clear proof of the store's mistake. Drafts read like a store manager wrote them.
  PROMPT_VERSION `2026-11-07.win-1`.
- **Model.** With `AI_GATEWAY_API_KEY` set, the agent runs on Vercel AI Gateway, model `AI_MODEL` (default
  `anthropic/claude-haiku-5.5`). Without it, the service keeps using OpenAI directly (`OPENAI_API_KEY`, `OPENAI_MODEL`).
  `/healthz` shows the model in use.
- **Every agent step is logged** as one JSON line in Render's Logs tab: `agent_run_started` (model, order, question),
  `agent_model_replied` (tokens in/out, tools it asked for), `agent_tool_called` / `agent_tool_finished` (rows, time),
  `agent_run_finished` (verdict, total tokens, cost, time) and `agent_answer` (the full reply and draft). Failures log
  `agent_run_failed`. Search the logs for a run id to follow one run.
- **Learning from this store's past disputes.** `find_similar_disputes` now returns, for the same store and platform, the dispute
  text that was filed and its result. When an order filed through KoreFi is opened again and its page shows a new decision
  ("Dispute rejected", "approved", "in review"), the result is saved to `outcomes`. A status the page already showed when the
  dispute was filed is not counted, since it belongs to an older dispute.

## What changed in v0.11.0: no masking

- **Everything is captured as the page shows it**, on every platform: the screenshot has no black boxes, and the page text
  sent to the agent keeps names, emails and phone numbers. The user's decision on 2026-11-07 (ZDR is enabled on the model side).
- **Why.** v0.10 treated Uber Eats' `fs-mask` marker as "personal details". Uber also puts it on money and the item list, so on
  live order C6005 almost the whole screenshot was blacked out. The mock pages had the marker only on names, so tests passed.
- **Deleted, not switched off:** the black-out boxes, the text scrubber (`src/shared/redact.ts`), name collection in both order
  readers, and the panel's key-based scrubbing of order facts. A screenshot is now dropped only if the page moves while capturing.
- **Customer photos** are found even inside parts Uber marks private, and are taken whenever the page has them.
- **Backend 0.5.1**: the prompt no longer tells the agent that details are blacked out (PROMPT_VERSION `2026-11-07.no-masking-1`).
  The API field and database column are still named `redacted_page_text`; they now hold the page text as shown.
- **Tests** now prove the opposite of before: no black boxes in any stored or uploaded image, names and the courier's face appear
  in the screenshot, and an Uber page with `fs-mask` on the items and money (like C6005) is captured in full.

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
