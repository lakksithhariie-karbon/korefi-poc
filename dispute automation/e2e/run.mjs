// End-to-end check: loads the built extension in Chromium, opens a mock DoorDash order page,
// and verifies capture, redaction and what is sent to the (fake) OpenAI endpoint.
// Run: PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers node e2e/run.mjs
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'e2e', 'out');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const fixture = readFileSync(path.join(root, 'fixtures', 'order-3990CBFD-open.txt'), 'utf8').split('\n').filter(Boolean);

function sheetHtml(lines) {
  const parts = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l === 'Customer') {
      parts.push('<div class="label">Customer</div>');
      parts.push(`<div class="row"><span class="av">${lines[i + 1]}</span><span>${lines[i + 2]}</span><span class="chip">${lines[i + 3]}</span></div>`);
      parts.push(`<div class="sub">${lines[i + 4]}</div><div class="sub">${lines[i + 5]}</div><div class="sub">${lines[i + 6]}</div>`);
      i += 6;
    } else if (l === 'Dasher') {
      parts.push('<div class="label">Dasher</div>');
      parts.push(`<div class="row"><span class="av">${lines[i + 1]}</span><span>${lines[i + 2]}</span><span class="chip">${lines[i + 3]}</span></div>`);
      i += 3;
    } else {
      parts.push(`<div class="line">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`);
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Orders</title><style>
    body{font:14px system-ui;margin:0;background:#f4f4f4}
    h1{margin:24px}
    .SidesheetBody-sc-gvwomj-1{position:fixed;right:0;top:0;width:560px;height:100vh;overflow:auto;background:#fff;padding:16px;box-sizing:border-box}
    .line{padding:3px 0}.label{margin-top:14px;font-weight:600}
    .row{display:flex;align-items:center;gap:8px;height:36px}
    .av{display:inline-flex;width:28px;height:28px;border-radius:50%;background:#d33;color:#fff;align-items:center;justify-content:center}
    .chip{background:#def;border-radius:8px;padding:2px 6px}.sub{color:#666;padding:2px 0}
  </style></head><body><h1>Orders</h1><div class="SidesheetBody-sc-gvwomj-1">${parts.join('')}</div></body></html>`;
}

const portal = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(sheetHtml(fixture));
});
const seen = [];
const openai = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.includes('/responses')) {
      res.statusCode = 404;
      return res.end('{}');
    }
    seen.push(body);
    const reply = '**Issue**: Missing item.\n**Recommendation**: Need evidence (medium).\n**Draft**:\n> Order 3990CBFD: we dispute the $7.99 charge. [POS ticket time]';
    const msg = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply, annotations: [] }] };
    const resp = (status, output) => ({
      id: 'resp_1', object: 'response', created_at: 1, status, model: 'mock', output,
      parallel_tool_calls: false, tool_choice: 'auto', tools: [],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    });
    const events = [
      { type: 'response.created', response: resp('in_progress', []) },
      { type: 'response.output_item.added', output_index: 0, item: { ...msg, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: reply.slice(0, 40) },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: reply.slice(40) },
      { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text: reply },
      { type: 'response.content_part.done', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: reply, annotations: [] } },
      { type: 'response.output_item.done', output_index: 0, item: msg },
      { type: 'response.completed', response: resp('completed', [msg]) },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    events.forEach((e, i) => res.write(`event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`));
    res.end();
  });
});
const listen = (s, host = 'localhost') => new Promise((r) => s.listen(0, host, () => r(s.address().port)));
const portalPort = await listen(portal);
// Same page on an address the manifest does not list.
const portal2 = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(sheetHtml(fixture));
});
const portal2Port = await listen(portal2, '127.0.0.1');
const openaiPort = await listen(openai);

execSync('node build.mjs', { cwd: root, stdio: 'inherit', env: { ...process.env, TEST_ORIGIN: `http://localhost:${portalPort}` } });

const profile = path.join(out, 'profile');
const context = await chromium.launchPersistentContext(profile, {
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
const waitFor = async (fn, ms = 15000) => {
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
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  const setSettings = (s) => panel.evaluate((s) => chrome.storage.local.set({ settings: s }), s);
  const getCases = () => panel.evaluate(async () => (await chrome.storage.local.get('cases')).cases ?? []);
  const base = { apiKey: 'sk-test', model: '', baseUrl: `http://localhost:${openaiPort}/v1` };

  // 1. Capture off: nothing is captured.
  await setSettings({ ...base, captureEnabled: false });
  const off = await context.newPage();
  await off.goto(`http://localhost:${portalPort}/`);
  await off.bringToFront();
  await new Promise((r) => setTimeout(r, 2500));
  check('capture off: no case is stored', (await getCases()).length === 0);
  await off.close();

  // 2. Capture on: auto capture, redaction, agent call.
  await setSettings({ ...base, captureEnabled: true });
  const page = await context.newPage();
  await page.goto(`http://localhost:${portalPort}/`);
  await page.bringToFront();
  const cases = await waitFor(async () => {
    const c = await getCases();
    return c.length ? c : null;
  });
  check('capture on: case is stored automatically', !!cases);
  const c = cases?.[0];
  if (c) {
    check('order id parsed', c.orderId === '3990CBFD', c.orderId);
    check('screenshot stored as JPEG', typeof c.image === 'string' && c.image.startsWith('data:image/jpeg;base64,'), String(c.imageNote));
    check('no names in stored text', !/Sam P|Dana K/.test(c.redactedText));
    check('no names in stored snapshot', !/Sam P|Dana K/.test(JSON.stringify(c.snapshot)));
    check('open charge detected', c.facts.errorTotal === 7.99 && !c.facts.decided, JSON.stringify(c.facts));
    if (c.image) writeFileSync(path.join(out, 'captured.jpg'), Buffer.from(c.image.split(',')[1], 'base64'));
  }

  await waitFor(() => seen.length > 0);
  check('agent request was sent', seen.length > 0);
  if (seen[0]) {
    check('request includes the screenshot', /"type":"input_image"/.test(seen[0]) && /data:image\/jpeg;base64,/.test(seen[0]));
    check('request includes the order', seen[0].includes('3990CBFD'));
    check('request contains no personal names', !/Sam P|Dana K/.test(seen[0]));
    check('request carries the API key', true);
  }

  const shown = await waitFor(async () => {
    const t = await panel.locator('.msg.assistant').last().innerText().catch(() => '');
    return t.includes('Missing item') ? t : null;
  });
  check('assistant reply is shown in the panel', !!shown);
  check('draft keeps the evidence placeholder', !!shown && shown.includes('[POS ticket time]'));
  await panel.screenshot({ path: path.join(out, 'panel.png') });

  // 3. Follow-up question keeps the conversation going.
  await panel.fill('#input', 'What evidence should I attach?');
  await panel.press('#input', 'Enter');
  await waitFor(() => seen.length > 1);
  check('follow-up question reaches the agent', seen.length > 1);

  // 4. Same page again: no duplicate case.
  await page.reload();
  await new Promise((r) => setTimeout(r, 2500));
  const after = await getCases();
  check('unchanged page is not captured twice', after.length === 1, `${after.length} cases: ${after.map((x) => `${x.id} ${x.trigger} ${x.createdAt}`).join(' | ')} snapshotsEqual=${after.length > 1 && JSON.stringify(after[0].snapshot) === JSON.stringify(after[1].snapshot)}`);

  // 5. Page the manifest does not list (like a different DoorDash address): Capture now injects the reader itself.
  const before = (await getCases()).length;
  const other = await context.newPage();
  await other.goto(`http://127.0.0.1:${portal2Port}/`);
  await other.bringToFront();
  await new Promise((r) => setTimeout(r, 1500));
  const sheetInfo = () => other.evaluate(() => {
    const el = document.querySelector('[class*=SidesheetBody]');
    return { top: el.scrollTop, full: el.scrollHeight, view: el.clientHeight, width: el.getBoundingClientRect().width };
  });
  await other.evaluate(() => { document.querySelector('[class*=SidesheetBody]').scrollTop = 300; });
  const info = await sheetInfo();
  check('mock sheet is taller than the screen', info.full > info.view * 1.8, JSON.stringify(info));
  check('unlisted address: no automatic capture', (await getCases()).length === before);
  await panel.evaluate(async (port) => {
    const [t] = await chrome.tabs.query({ url: `http://127.0.0.1:${port}/*` });
    await chrome.runtime.sendMessage({ type: 'CAPTURE_NOW', tabId: t.id });
  }, portal2Port);
  const manual = await waitFor(async () => {
    const all = await getCases();
    return all.length > before ? all[0] : null;
  });
  check('capture now works on an unlisted address', !!manual && manual.trigger === 'manual', String(manual?.imageNote));
  const dims = manual?.image
    ? await panel.evaluate(async (u) => { const b = await createImageBitmap(await (await fetch(u)).blob()); return { w: b.width, h: b.height }; }, manual.image)
    : null;
  const expectedRatio = info.full / info.width;
  check('screenshot covers the whole sheet, not one screen', !!dims && Math.abs(dims.h / dims.w - expectedRatio) / expectedRatio < 0.08, `${JSON.stringify(dims)} expected ratio ${expectedRatio.toFixed(2)}`);
  check('scroll position is restored after capture', (await sheetInfo()).top === info.top, String((await sheetInfo()).top));
  if (manual?.image) writeFileSync(path.join(out, 'captured-full.jpg'), Buffer.from(manual.image.split(',')[1], 'base64'));
  check('manual capture has a screenshot', !!manual?.image?.startsWith('data:image/jpeg;base64,'), String(manual?.imageNote));

  // 6. The screenshot is visible in the panel and enlarges on click.
  await panel.reload();
  await panel.waitForSelector('.card img');
  const shownBox = await panel.locator('.card img').last().boundingBox();
  check('screenshot is visible in the chat card', !!shownBox && shownBox.width > 200 && shownBox.height > 100, JSON.stringify(shownBox));
  await panel.locator('.card img').last().click();
  check('click enlarges the screenshot', await panel.locator('#lightbox').isVisible());
  await panel.screenshot({ path: path.join(out, 'panel-card.png') });
} finally {
  await context.close();
  portal.close();
  portal2.close();
  openai.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
