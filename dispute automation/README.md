# Korefi Dispute Assistant (POC)

A Chrome side-panel extension. It reads the DoorDash order page you already have open, saves a
screenshot with customer and Dasher details blacked out, and an AI assistant (OpenAI Agents SDK)
suggests whether to dispute the error charge and drafts the text. **A person reviews and files the
dispute themselves.** The extension never clicks, navigates or calls DoorDash. To screenshot the whole order it scrolls the
order sheet in your own tab (like you scrolling it), then puts the scroll position back.

Data lives in `chrome.storage.local` only. There is no server and no database.

## Try it

```bash
npm install
npm run build          # writes dist/
```

1. Chrome → `chrome://extensions` → turn on Developer mode → **Load unpacked** → choose `dist/`.
2. Open a DoorDash order page, then click the extension icon on that tab. That opens the panel and
   grants screenshot access to this tab (Chrome `activeTab`).
3. In the panel: gear → paste your OpenAI API key → Save. Turn on **Capture**.
4. Open an order. The case appears in the chat with the screenshot and a suggested dispute.
   **Capture now** re-runs it on demand. **Cases** lists everything and exports CSV.

The portal address is set in `manifest.json` (`https://*.doordash.com/*`). If your
portal lives elsewhere, change it in both `host_permissions` and `content_scripts.matches`.

## What leaves the browser

- To OpenAI: the parsed order, the page text with personal names removed, and the redacted screenshot.
- Never sent: customer and Dasher names, customer profile lines, anything inside the black boxes.
- If the personal details cannot be found on the page, no screenshot is taken (fails closed).
- The API key sits in Chrome storage on this computer. Fine for your own machine; move it behind a
  server before anyone else uses this.

## Layout

```
manifest.json         extension manifest (MV3)
build.mjs             esbuild bundler -> dist/
src/content/          page reader (extract, find regions to black out, scroll the sheet for screenshots)
src/background.ts     capture, redact screenshot, save case
src/sidepanel/        chat UI and the Agents SDK wrapper (agent.ts)
src/shared/           parser, redaction, 14-day rules, storage, types
fixtures/             order page text rebuilt from a real portal screenshot (fictional names)
test/                 unit tests for the parser, redaction and rules
e2e/run.mjs           loads the built extension in Chromium against a mock portal and fake OpenAI
```

```bash
npm run typecheck
npm test
npm run e2e            # needs: PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers npx playwright install chromium
```

## Known limits

- Screenshots scroll the order sheet one screen at a time and stitch the screens into one tall image
  (up to 14 screens, about one per second because Chrome limits tab captures). Leave the page alone
  while it runs; if the page moves, the screenshot is withheld rather than risk misplaced black boxes.
- The parser was built from one order page. If DoorDash lays text out differently, use
  **Copy captured data** on the case card and share it so the parser can be tuned.
- `activeTab` is granted per tab until it navigates to a new page. Click the icon again after a full
  page load if the card says the screenshot needs permission.

See [OPS_README.md](OPS_README.md) for the internal ops pilot features.
