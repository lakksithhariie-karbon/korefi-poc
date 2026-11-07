// End-to-end check: loads the built extension in Chromium, captures mock DoorDash pages, and drives the side panel
// against the REAL backend app (HTTP routes, validation, conversations, images) over in-memory storage,
// with a fake agent that follows the same transcript contract as the Pi agent.
// Run: PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers node e2e/run.mjs
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApp } from '../agent-backend/src/app.mjs';
import { createMemoryStore } from '../agent-backend/test/memory-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'e2e', 'out');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const fixture = readFileSync(path.join(root, 'fixtures', 'order-3990CBFD-open.txt'), 'utf8').split('\n').filter(Boolean);
const uberFixture = readFileSync(path.join(root, 'fixtures', 'ubereats-D2D46.txt'), 'utf8').split('\n').filter(Boolean);
// Marker colours: personal details are drawn in magenta (faces) and cyan (names), so a test can prove none reach an image.
// The customer photo is solid orange, so a test can prove it arrives intact.
const svg = (body, w, h) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)}`;
const FACE = svg('<circle cx="22" cy="22" r="22" fill="#ff00ff"/>', 44, 44);
const PHOTO = (w, h) => svg(`<rect width="${w}" height="${h}" fill="#f08a00"/><rect x="20" y="20" width="${w / 3}" height="${h / 4}" fill="#ffd27a"/>`, w, h);
const UBER_STORE = '3f2c9a1e-5b7d-4c11-9a0e-1234567890ab';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const STYLE = `<style>
  body{font:14px system-ui;margin:0;background:#f4f4f4}h1{margin:24px}
  .sheet{position:fixed;right:0;top:0;width:560px;height:100vh;overflow:auto;background:#fff;padding:16px;box-sizing:border-box}
  .line{padding:3px 0}.label{margin-top:14px;font-weight:600}
  .row{display:flex;align-items:center;gap:8px;height:36px}
  .av{display:inline-flex;width:28px;height:28px;border-radius:50%;background:#d33;color:#fff;align-items:center;justify-content:center}
  .chip{background:#def;border-radius:8px;padding:2px 6px}.sub{color:#666;padding:2px 0}
</style>`;

/** The order sheet built from the fixture, with the same Customer / Dasher structure as the real page. */
function orderPage() {
  const parts = [];
  for (let i = 0; i < fixture.length; i++) {
    const l = fixture[i];
    if (l === 'Customer') {
      parts.push('<div class="label">Customer</div>');
      parts.push(`<div class="row"><span class="av">${fixture[i + 1]}</span><span>${fixture[i + 2]}</span><span class="chip">${fixture[i + 3]}</span></div>`);
      parts.push(`<div class="sub">${fixture[i + 4]}</div><div class="sub">${fixture[i + 5]}</div><div class="sub">${fixture[i + 6]}</div>`);
      i += 6;
    } else if (l === 'Dasher') {
      parts.push('<div class="label">Dasher</div>');
      parts.push(`<div class="row"><span class="av">${fixture[i + 1]}</span><span>${fixture[i + 2]}</span><span class="chip">${fixture[i + 3]}</span></div>`);
      i += 3;
    } else if (/left a comment$/.test(l)) {
      // The customer's comment, then the photo they uploaded with it.
      parts.push(`<div class="line">${esc(l)}</div><div class="line">${esc(fixture[i + 1])}</div>`);
      parts.push(`<div class="sub">Customer photo</div><img alt="" src="${PHOTO(200, 150)}" style="width:200px;height:150px;border-radius:6px;display:block">`);
      i += 1;
    } else {
      parts.push(`<div class="line">${esc(l)}</div>`);
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Orders</title>${STYLE}</head><body><h1>Orders</h1><div class="SidesheetBody-sc-gvwomj-1 sheet">${parts.join('')}</div></body></html>`;
}

/** A layout the order parser does not understand, but with Customer and Dasher blocks. Names: Pat Q, Lee R. */
function changedPage() {
  const filler = Array.from({ length: 60 }, (_, i) => `<div class="line">Receipt line ${i + 1}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt</title>${STYLE}</head><body><h1>Receipts</h1>
    <div role="dialog" aria-modal="true" class="SideDrawer sheet">
      <div class="line">Receipt ZXCV9876</div><div class="line">Delivery details</div>
      <div class="label">Customer</div><div class="row"><span class="av">P</span><span>Pat Q</span></div><div class="sub">2 years on DoorDash • 3 orders from your store</div>
      <div class="label">Dasher</div><div class="row"><span class="av">L</span><span>Lee R</span></div>
      <div class="line">Picked up</div>${filler}</div></body></html>`;
}

/** A page with nothing that marks where personal details are. It must never be screenshotted. */
function unknownPage() {
  const filler = Array.from({ length: 40 }, (_, i) => `<div class="line">Something else ${i + 1}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Other</title>${STYLE}</head><body><h1>Other</h1>
    <div role="dialog" aria-modal="true" class="sheet"><div class="line">Welcome back</div>${filler}</div></body></html>`;
}

/**
 * An Uber Eats Manager order drawer: a fixed panel with no dialog role, Base Web markers, the customer at the top in
 * fields marked fs-mask, a courier card with a face photo, and a customer photo under the feedback.
 */
function uberPage() {
  const L = uberFixture;
  const parts = [
    `<div class="row"><span class="av fs-mask pii">${L[0]}</span><div><div class="fs-mask pii">${esc(L[1])}</div><div class="sub">${esc(L[2])}</div></div></div>`,
  ];
  for (let i = 3; i < L.length; i++) {
    const l = L[i];
    if (l === 'YOUWEI') {
      parts.push(`<div class="row" style="height:56px"><img alt="" src="${FACE}" style="width:44px;height:44px;border-radius:50%"><span class="pii">${l}</span><span class="chip">${L[i + 1]}</span><span class="chip">${L[i + 2]}</span><span class="chip">${L[i + 3]}</span></div>`);
      i += 3;
    } else if (l === 'Customer feedback') {
      parts.push(`<div class="label">${l}</div><div class="line">${esc(L[i + 1])}</div><img alt="" src="${PHOTO(330, 300)}" style="width:330px;height:300px;border-radius:8px;display:block"><div class="line">${L[i + 2]}</div>`);
      i += 2;
    } else {
      parts.push(`<div class="line">${esc(l)}</div>`);
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Uber Eats Manager</title>${STYLE}<style>.pii{color:#00e5ff;font-weight:700;font-size:18px}</style></head>
    <body><div data-baseweb="block"><h1>Orders</h1></div>
    <div data-baseweb="block" style="position:fixed;right:0;top:0;width:500px;height:100vh;display:flex;background:#fff">
      <div style="overflow:auto;width:100%;padding:16px;box-sizing:border-box">${parts.join('')}</div></div></body></html>`;
}

const pageFor = (url) => {
  const p = new URL(url, 'http://x').pathname;
  return p === '/changed' ? changedPage() : p === '/unknown' ? unknownPage() : p.startsWith('/ubereats') ? uberPage() : orderPage();
};
const makePortal = () =>
  http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(pageFor(req.url));
  });

// ---- the real backend app over in-memory storage ----
const TOKEN = 't'.repeat(40);
const store = createMemoryStore();
const agentCalls = []; // what the (fake) agent was handed on each turn
const pi = { wakes: 0, bodies: [] };
const backend = createApp({
  store,
  env: { KOREFI_AGENT_TOKEN: TOKEN, OPENAI_API_KEY: 'sk-test' },
  log: () => {},
  investigate: async ({ request, transcript, images }) => {
    agentCalls.push({ request, transcript, images });
    if (/FAIL/.test(request.operatorQuestion || '')) throw new Error('internal detail that must not leak');
    const n = agentCalls.length;
    return {
      recommendation: 'needs_review',
      reasoning_summary: `No history for this store. Missing item on order ${request.orderId}; I looked at ${images.length} image(s). Gather the POS ticket.`,
      missing_evidence: ['POS ticket time'],
      draft_text: `Order ${request.orderId}: we dispute the charge. [verify POS ticket time]`,
      risk_notes: null,
      suggested_followups: n === 1 ? ['What evidence is missing?', 'Check the food photo'] : [],
      model: 'fake',
      tools_used: [{ name: 'get_error_charges', count: 0 }],
      transcript: [...transcript, { role: 'user', content: [{ type: 'text', text: request.operatorQuestion }] }, { role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }], stopReason: 'stop' }],
    };
  },
});
const fakePi = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') pi.wakes++;
  backend.handler(req, res);
});

const listen = (s, host = 'localhost') => new Promise((r) => s.listen(0, host, () => r(s.address().port)));
const portal = makePortal();
const portal2 = makePortal(); // the same pages on an address the manifest does not list
const portalPort = await listen(portal);
const portal2Port = await listen(portal2, '127.0.0.1');
const piPort = await listen(fakePi);

execSync('node build.mjs', { cwd: root, stdio: 'inherit', env: { ...process.env, TEST_ORIGIN: `http://localhost:${portalPort}` } });

const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${path.join(root, 'dist')}`, `--load-extension=${path.join(root, 'dist')}`, '--no-sandbox'],
});

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) failed++;
};
const waitFor = async (fn, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  if (process.env.DEBUG) sw.on('console', (m) => console.log('  [sw]', m.text()));

  const panel = await context.newPage();
  // About the width of Chrome's side panel.
  await panel.setViewportSize({ width: 400, height: 760 });
  const openPanel = async () => {
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(t) { window.__copied = t; } } });
    });
  };
  await openPanel();
  await panel.evaluate(
    (s) => chrome.storage.local.set({ settings: s }),
    { agentUrl: `http://localhost:${piPort}`, agentToken: 't'.repeat(40), operatorId: 'e2e-op', theme: 'light' },
  );
  await openPanel();
  await panel.screenshot({ path: path.join(out, 'panel-empty.png') });

  const getCases = () => panel.evaluate(async () => (await chrome.storage.local.get('cases')).cases ?? []);
  const capture = async (page, urlPattern) => {
    const before = (await getCases()).length;
    await page.bringToFront();
    await panel.evaluate(async (pattern) => {
      const [t] = await chrome.tabs.query({ url: pattern });
      await chrome.runtime.sendMessage({ type: 'CAPTURE_NOW', tabId: t.id });
    }, urlPattern);
    const cases = await waitFor(async () => {
      const c = await getCases();
      return c.length > before ? c : null;
    });
    await panel.bringToFront();
    return cases?.[0] ?? null;
  };
  // Looks inside the stored JPEG: how big it is and how many solid dark bands (the black-out boxes) it has.
  const inspect = (dataUrl) =>
    panel.evaluate(async (u) => {
      const bmp = await createImageBitmap(await (await fetch(u)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      let bands = 0, run = 0, inBand = false;
      for (let y = 0; y < height; y++) {
        let dark = 0;
        for (let x = 0; x < width; x += 2) {
          const i = (y * width + x) * 4;
          if (data[i] < 45 && data[i + 1] < 45 && data[i + 2] < 45) dark++;
        }
        const solid = dark / (width / 2) > 0.8;
        if (solid) run++;
        if (solid && !inBand) inBand = true;
        if ((!solid || y === height - 1) && inBand) {
          if (run >= 18) bands++;
          inBand = false;
          run = 0;
        }
      }
      return { w: width, h: height, bands };
    }, dataUrl);

  // Counts marker-coloured pixels (magenta faces, cyan names) and the share of photo-orange pixels in an image.
  const colours = (dataUrl) =>
    panel.evaluate(async (u) => {
      const bmp = await createImageBitmap(await (await fetch(u)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      let magenta = 0, cyan = 0, orange = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (r > 200 && g < 90 && b > 200) magenta++;
        if (r < 90 && g > 180 && b > 200) cyan++;
        if (r > 200 && g > 100 && g < 170 && b < 60) orange++;
      }
      return { w: bmp.width, h: bmp.height, magenta, cyan, orange: orange / (data.length / 4) };
    }, dataUrl);

  // 0. There is no code path for an unredacted screenshot.
  const bg = readFileSync(path.join(root, 'dist', 'background.js'), 'utf8');
  check('built worker has no unredacted or generic fallback', !/[Uu]nredacted|takeGenericScreenshot/.test(bg));

  // 1. Full order page: capture, full height, redaction, scroll restored.
  const order = await context.newPage();
  await order.goto(`http://localhost:${portalPort}/`);
  await order.evaluate(() => { document.querySelector('[class*=SidesheetBody]').scrollTop = 300; });
  const sheet = await order.evaluate(() => {
    const el = document.querySelector('[class*=SidesheetBody]');
    return { full: el.scrollHeight, view: el.clientHeight, width: el.getBoundingClientRect().width };
  });
  check('mock sheet is taller than the screen', sheet.full > sheet.view * 1.8, JSON.stringify(sheet));
  const c1 = await capture(order, `http://localhost:${portalPort}/*`);
  check('capture stores a case', !!c1);
  if (!c1) throw new Error('no case captured');
  check('order ID parsed', c1.orderId === '3990CBFD', c1.orderId);
  check('open charge detected', c1.facts.errorTotal === 7.99 && !c1.facts.decided, JSON.stringify(c1.facts));
  check('screenshot stored as JPEG', typeof c1.image === 'string' && c1.image.startsWith('data:image/jpeg;base64,'), String(c1.imageNote));
  const shot1 = await inspect(c1.image);
  const expected = sheet.full / sheet.width;
  check('screenshot covers the whole sheet', Math.abs(shot1.h / shot1.w - expected) / expected < 0.08, `${JSON.stringify(shot1)} expected ratio ${expected.toFixed(2)}`);
  check('Customer and Dasher blocks are blacked out', shot1.bands >= 2, JSON.stringify(shot1));
  check('scroll position is restored', (await order.evaluate(() => document.querySelector('[class*=SidesheetBody]').scrollTop)) === 300);
  check('no names in stored text or snapshot', !/Sam P|Dana K/.test(c1.redactedText + JSON.stringify(c1.snapshot)));
  check('DoorDash: the customer photo is found and kept at full size', c1.photos?.length === 1 && (await colours(c1.photos[0])).orange > 0.6, JSON.stringify(c1.photos?.length));
  check('DoorDash capture is marked as DoorDash', c1.platform === 'doordash');
  writeFileSync(path.join(out, 'captured-full.jpg'), Buffer.from(c1.image.split(',')[1], 'base64'));

  // 2. Panel: the screenshot is attached; the first message opens a chat on the server and uploads the slices once.
  panel.on('request', (r) => { if (r.method() === 'POST' && r.url().includes(`:${piPort}/`)) pi.bodies.push({ url: new URL(r.url()).pathname, raw: r.postData() || '', key: r.headers()['idempotency-key'] || null }); });
  await panel.waitForSelector('#attachment:not([hidden])');
  check('screenshot is attached to the composer', true);
  await panel.fill('#prompt', 'Can we dispute this?');
  await panel.press('#prompt', 'Enter');
  const answer1 = await waitFor(async () => {
    const t = await panel.locator('.agent-message .agent-text').last().innerText().catch(() => '');
    return t.includes('No history for this store') ? t : null;
  }, 40000);
  check('answer appears after polling', !!answer1);
  check('woke the backend before investigating', pi.wakes >= 1);
  const opened = pi.bodies.find((b) => b.url === '/v1/conversations');
  const openedBody = opened && JSON.parse(opened.raw);
  check('chat is opened with the order and no store ID', !!openedBody && openedBody.order_id === '3990CBFD' && openedBody.store_id === null);
  check('redacted screenshot slices uploaded once, as JPEG', !!openedBody && openedBody.screenshots.length >= 2 && openedBody.screenshots.every((x) => x.startsWith('data:image/jpeg;base64,')), String(openedBody?.screenshots?.length));
  check('open request contains no personal names', !!opened && !/Sam P|Dana K/.test(opened.raw));
  check('item names reach the agent (not scrubbed)', !!opened && /Wintermelon Lemon/.test(opened.raw));
  check('the customer photo goes first, and the server is told so', !!openedBody && openedBody.screenshots[0] === c1.photos[0] && openedBody.structured_facts.attached_images?.customer_photos === 1 && openedBody.platform === 'doordash');
  const msg1 = pi.bodies.find((b) => b.url.endsWith('/messages'));
  check('the message itself carries no images', !!msg1 && !('screenshots' in JSON.parse(msg1.raw)));
  const keyed = pi.bodies.filter((b) => b.url === '/v1/conversations' || b.url.endsWith('/messages'));
  check('every create and message request carries its own idempotency key', keyed.length >= 2 && keyed.every((b) => /^[0-9a-f-]{36}$/.test(b.key || '')) && new Set(keyed.map((b) => b.key)).size === keyed.length, JSON.stringify(keyed.map((b) => b.key)));
  check('the server stored the chat, its images and both messages', store.conversations.length === 1 && store.images.length === openedBody.screenshots.length && store.messages.length === 2);
  check('first turn: agent got the case facts and every image', agentCalls[0].transcript.length === 0 && agentCalls[0].images.length === openedBody.screenshots.length && agentCalls[0].request.issueCategory === 'Missing entire item', JSON.stringify(agentCalls[0].request.issueCategory));
  check('recommendation shown', (await panel.locator('.assessment .big').last().innerText()) === 'Needs review');
  check('suggested questions come from the server', (await panel.locator('#suggestions button').allInnerTexts()).some((t) => /Check the food photo/.test(t)));
  await panel.waitForTimeout(400);
  await panel.screenshot({ path: path.join(out, 'panel-answer.png') });

  // 3. A suggested question continues the same conversation: saved transcript, images attached again, draft carried.
  await panel.locator('#suggestions button', { hasText: 'What evidence is missing?' }).click();
  await waitFor(() => agentCalls.length > 1, 40000);
  check('follow-up resumes the saved transcript', agentCalls[1]?.transcript.length === 2, String(agentCalls[1]?.transcript.length));
  check('follow-up has the images again, without the panel re-uploading them', agentCalls[1]?.images.length === agentCalls[0].images.length && !('screenshots' in JSON.parse(pi.bodies.filter((b) => b.url.endsWith('/messages')).at(-1).raw)));
  check('follow-up carries the operator draft', /we dispute the charge/.test(agentCalls[1]?.request.previousDraft || ''));
  await waitFor(async () => (await panel.locator('.agent-message').count()) >= 2);

  // 4. More evidence mid-chat: capturing the same order again adds to this chat instead of replacing it.
  const imagesBefore = store.images.length;
  const c1b = await capture(order, `http://localhost:${portalPort}/*`);
  check('a second capture of the same order is taken', !!c1b);
  await panel.waitForSelector('#attachment:not([hidden])');
  check('the chat is kept when more evidence is captured', (await panel.locator('.agent-message').count()) >= 2 && store.conversations.length === 1);
  await panel.fill('#prompt', 'Here is another look at the order');
  await panel.press('#prompt', 'Enter');
  await waitFor(() => agentCalls.length > 2, 40000);
  const withMore = JSON.parse(pi.bodies.filter((b) => b.url.endsWith('/messages')).at(-1).raw);
  check('new images and the new page text go with the message', withMore.screenshots?.length >= 2 && typeof withMore.additional_text === 'string' && withMore.additional_text.length > 0);
  check('the agent sees old and new images together', agentCalls[2]?.images.length === store.images.length && store.images.length > imagesBefore);
  await waitFor(async () => (await panel.locator('.agent-message').count()) >= 3);

  // 5. Draft, copy, confirm: logged against the chat, with no store ID.
  await panel.locator('[data-open="draft"]').last().click();
  await panel.click('#copyDraft');
  await panel.waitForSelector('#confirm:not([hidden])');
  await panel.waitForTimeout(400);
  await panel.screenshot({ path: path.join(out, 'panel-draft.png') });
  check('draft copied to clipboard', /we dispute the charge/.test(await panel.evaluate(() => window.__copied || '')));
  await panel.click('#yesFiled');
  const logged = await waitFor(async () => (await panel.locator('#filingTitle').innerText().catch(() => '')).includes('Marked as disputed'));
  check('filing is logged against the chat without a store ID', !!logged && store.submissions.length === 1 && store.conversations[0].status === 'disputed', JSON.stringify(store.submissions.length));
  check('the chat notes that it was marked disputed', store.messages.some((m) => m.role === 'system' && /Marked as disputed/.test(m.text)));

  // 6. Reopen the panel: the chat comes back from the server, evidence images included. History lists it.
  await openPanel();
  await panel.waitForSelector('.agent-message');
  check('reopening the panel restores the chat', (await panel.locator('.user-bubble .chat-text').count()) >= 3 && (await panel.locator('.agent-message').count()) >= 3);
  check('evidence images are shown from the server', await panel.waitForSelector('.evidence-strip .strip-thumb img', { timeout: 15000 }).then(() => true, () => false));
  check('a disputed chat shows its note', (await panel.locator('.system-note').allInnerTexts()).some((t) => /Marked as disputed/.test(t)));
  await panel.click('#historyButton');
  await panel.waitForSelector('.history-item');
  check('history lists the chat with its status', (await panel.locator('.history-item').count()) === 1 && (await panel.locator('.history-chip.done').count()) === 1);
  await panel.waitForTimeout(400);
  await panel.screenshot({ path: path.join(out, 'panel-history.png') });
  await panel.click('#closeHistory');

  // 7. New chat on a different order, on an address the manifest does not list and a layout the parser does not know.
  await panel.click('#newChat');
  check('new chat starts empty', await panel.locator('#empty').isVisible() && (await panel.locator('.agent-message').count()) === 0);
  const changed = await context.newPage();
  await changed.goto(`http://127.0.0.1:${portal2Port}/changed?orderId=ZXCV9876&storeId=555123`);
  const c2 = await capture(changed, `http://127.0.0.1:${portal2Port}/*`);
  check('unknown layout is captured, store ID read from the address', !!c2 && c2.orderId === 'ZXCV9876' && c2.storeId === '555123', `${c2?.orderId} ${c2?.storeId}`);
  check('unknown layout screenshot is redacted', !!c2?.image && (await inspect(c2.image)).bands >= 1, String(c2?.imageNote));
  check('unknown layout text has no names', !!c2 && !/Pat Q|Lee R/.test(c2.redactedText));
  await panel.waitForSelector('#attachment:not([hidden])');
  await panel.fill('#prompt', 'Check this one');
  await panel.press('#prompt', 'Enter');
  await waitFor(() => agentCalls.length > 3, 40000);
  check('a second chat is opened with the known store ID', store.conversations.length === 2 && agentCalls[3].request.storeId === '555123');
  check('the second chat starts a fresh conversation', agentCalls[3].transcript.length === 0);
  check('second chat request has no names', !pi.bodies.filter((b) => b.url.startsWith('/v1/conversations')).some((b) => /Pat Q|Lee R/.test(b.raw)));
  await waitFor(async () => (await panel.locator('.agent-message').count()) >= 1);

  // 8. History: newest first; open the older chat; it is disputed, so it stays read-only.
  await panel.click('#historyButton');
  await waitFor(async () => (await panel.locator('.history-item').count()) === 2);
  const titles = await panel.locator('.history-title').allInnerTexts();
  check('history shows both chats, newest first', titles.length === 2 && /ZXCV9876/.test(titles[0]) && /3990CBFD/.test(titles[1]), titles.join(' | '));
  await panel.locator('.history-item', { hasText: '3990CBFD' }).click();
  await panel.waitForSelector('.system-note');
  check('opening an older chat shows its messages', (await panel.locator('.user-bubble .chat-text').first().innerText()) === 'Can we dispute this?');
  await panel.fill('#prompt', 'One more thing');
  await panel.press('#prompt', 'Enter');
  check('a disputed chat does not take new questions', await waitFor(async () => /marked as disputed/.test(await panel.locator('.agent-message .agent-text').last().innerText().catch(() => ''))) !== null);
  check('no extra agent run was started', agentCalls.length === 4);

  // 9. A page with no sign of where personal details are: no screenshot, a placeholder order ID, and the chat still works.
  await panel.click('#newChat');
  const unknown = await context.newPage();
  await unknown.goto(`http://localhost:${portalPort}/unknown`);
  const c3 = await capture(unknown, `http://localhost:${portalPort}/unknown`);
  check('page with no redaction anchors is captured as data only', !!c3 && c3.image === null && /No screenshot/.test(c3.imageNote || ''), c3?.imageNote);
  check('placeholder order ID is used', !!c3 && c3.orderId.startsWith('SCREENSHOT-'), c3?.orderId);
  await panel.waitForSelector('#caseMeta:not([hidden])');
  check('operator is asked for the order ID', true);
  check('no attachment when no screenshot', await panel.locator('#attachment').isHidden());
  await panel.fill('#prompt', 'Anything we can do?');
  await panel.press('#prompt', 'Enter');
  await waitFor(() => agentCalls.length > 4, 40000);
  check('data-only chat sends no images', agentCalls[4].images.length === 0 && store.conversations.at(-1) && store.images.filter((i) => i.conversation_id === store.conversations.at(-1).id).length === 0);
  await waitFor(async () => (await panel.locator('.agent-message').count()) >= 1);

  // 10. A failed run explains itself without leaking internals, and leaves a note in the chat.
  await panel.fill('#prompt', 'FAIL this one');
  await panel.press('#prompt', 'Enter');
  const failure = await waitFor(async () => {
    const t = await panel.locator('.agent-message .agent-text').last().innerText().catch(() => '');
    return /Please try again/.test(t) ? t : null;
  }, 40000);
  check('failed run shows a clear message', !!failure);
  check('internal error detail never reaches the panel or the chat', !/internal detail/.test(await panel.content()) && !store.messages.some((m) => /internal detail/.test(m.text)));
  check('the failure is noted in the saved chat', store.messages.some((m) => m.role === 'system' && /could not answer/.test(m.text)));

  // 11. No screenshot anywhere is unredacted: local cases, and the images the server holds.
  const all = await getCases();
  const leaks = [];
  for (const c of all) if (c.image && (await inspect(c.image)).bands < 1) leaks.push(c.orderId);
  check('no stored local screenshot is unredacted', leaks.length === 0, leaks.join(','));
  const perChat = new Map();
  for (const img of store.images) {
    const info = await inspect(`data:${img.mime};base64,${Buffer.from(img.bytes).toString('base64')}`);
    perChat.set(img.conversation_id, (perChat.get(img.conversation_id) || 0) + (info.bands > 0 ? 1 : 0));
  }
  check('each chat with images holds the blacked-out section on the server', [...perChat.values()].every((n) => n >= 1), JSON.stringify([...perChat]));

  // 12. Uber Eats: the drawer is found without a dialog role, the customer and courier are hidden, the photo is kept.
  await panel.click('#newChat');
  const uber = await context.newPage();
  await uber.goto(`http://localhost:${portalPort}/ubereats/manager/home/${UBER_STORE}/orders`);
  const raw = await uber.screenshot();
  const control = await colours(`data:image/png;base64,${raw.toString('base64')}`);
  check('control: the mock page really shows the marker colours', control.magenta > 300 && control.cyan > 50, JSON.stringify(control));
  await uber.evaluate(() => { document.querySelector('[style*="overflow:auto"]').scrollTop = 120; });
  const u = await capture(uber, `http://localhost:${portalPort}/ubereats*`);
  check('Uber Eats capture is recognised', !!u && u.platform === 'ubereats' && u.orderId === 'D2D46', `${u?.platform} ${u?.orderId} ${u?.imageNote}`);
  check('Uber Eats store ID is read from the address', u?.storeId === UBER_STORE, String(u?.storeId));
  check('Uber Eats charge is read', u?.facts.errorTotal === 0.95 && u?.snapshot.errorCharges[0]?.item === 'Summer Night Black Milk Tea', JSON.stringify(u?.facts));
  check('Uber Eats text has no customer or courier names', !!u && !/M\.E\. G|YOUWEI/.test(u.redactedText + JSON.stringify(u.snapshot)));
  check('Uber Eats customer feedback is kept as evidence', /barely even tastes like tea/.test(u?.redactedText || ''));
  const uShot = u?.image ? await colours(u.image) : null;
  check('Uber Eats page screenshot is taken', !!uShot, String(u?.imageNote));
  check('Uber Eats screenshot shows no face and no name', !!uShot && uShot.magenta < 20 && uShot.cyan < 20, JSON.stringify(uShot));
  const uPhoto = u?.photos?.[0] ? await colours(u.photos[0]) : null;
  check('Uber Eats customer photo is captured on its own, at full size', u?.photos?.length === 1 && !!uPhoto && uPhoto.orange > 0.6 && uPhoto.w >= 300, JSON.stringify(uPhoto));
  check('Uber Eats photo carries no face or name', !!uPhoto && uPhoto.magenta < 20 && uPhoto.cyan < 20);
  check('Uber Eats scroll position is restored', (await uber.evaluate(() => document.querySelector('[style*="overflow:auto"]').scrollTop)) === 120);
  await panel.waitForSelector('#attachment:not([hidden])');
  check('the attachment says a customer photo is included', /1 customer photo/.test(await panel.locator('#attachmentTitle').innerText()));
  const before = agentCalls.length;
  await panel.fill('#prompt', 'Can I dispute this?');
  await panel.press('#prompt', 'Enter');
  await waitFor(() => agentCalls.length > before, 40000);
  const uOpen = JSON.parse(pi.bodies.filter((b) => b.url === '/v1/conversations').at(-1).raw);
  check('Uber Eats chat is opened as Uber Eats with the photo first', uOpen.platform === 'ubereats' && uOpen.screenshots[0] === u.photos[0] && uOpen.structured_facts.attached_images.customer_photos === 1);
  check('the agent is told it is an Uber Eats order', agentCalls.at(-1).request.platform === 'ubereats');
  check('the Uber Eats chat request has no names', !/M\.E\. G|YOUWEI/.test(pi.bodies.filter((b) => b.url.startsWith('/v1/conversations')).map((b) => b.raw).join('')));
  await waitFor(async () => (await panel.locator('.agent-message').count()) >= 1);
  await panel.waitForTimeout(400);
  await panel.screenshot({ path: path.join(out, 'panel-ubereats.png') });
  await panel.click('#historyButton');
  await waitFor(async () => (await panel.locator('.history-meta').allInnerTexts()).some((t) => t.startsWith('Uber Eats · Order D2D46')));
  check('history labels the chat as Uber Eats', (await panel.locator('.history-meta').allInnerTexts()).some((t) => t.startsWith('Uber Eats · Order D2D46')));
  await panel.click('#closeHistory');
  await uber.screenshot({ path: path.join(out, 'ubereats-mock.png') });
  writeFileSync(path.join(out, 'ubereats-captured.jpg'), Buffer.from(u.image.split(',')[1], 'base64'));
  writeFileSync(path.join(out, 'ubereats-photo.jpg'), Buffer.from(u.photos[0].split(',')[1], 'base64'));

  await panel.screenshot({ path: path.join(out, 'panel-final.png') });
  await panel.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await panel.waitForTimeout(400);
  await panel.screenshot({ path: path.join(out, 'panel-final-dark.png') });
} finally {
  await context.close();
  portal.close();
  portal2.close();
  fakePi.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
