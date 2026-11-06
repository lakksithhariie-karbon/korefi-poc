// End-to-end check: loads the built extension in Chromium, captures mock DoorDash pages, and drives the side panel
// against a fake Pi backend that speaks the real async API (202 + polling).
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

const pageFor = (url) => {
  const p = new URL(url, 'http://x').pathname;
  return p === '/changed' ? changedPage() : p === '/unknown' ? unknownPage() : orderPage();
};
const makePortal = () =>
  http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(pageFor(req.url));
  });

// ---- fake Pi backend: same shape as the real service ----
const pi = { bodies: [], confirms: [], wakes: 0, polls: new Map(), next: 1 };
const fakePi = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, data) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (req.method === 'GET' && url.pathname === '/healthz') {
    pi.wakes++;
    return json(200, { ok: true });
  }
  if (req.headers.authorization !== `Bearer ${'t'.repeat(40)}`) return json(401, { error: 'Unauthorized' });
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method === 'POST' && url.pathname === '/v1/investigations') {
      const body = JSON.parse(raw);
      pi.bodies.push({ raw, body });
      const id = String(pi.next++);
      pi.polls.set(id, { reads: 0, fail: /FAIL/.test(body.operator_question || ''), body });
      return json(202, { investigation_id: id, case_id: 1, store_id: body.store_id || 'unresolved', order_id: body.order_id, status: 'running' });
    }
    const poll = url.pathname.match(/^\/v1\/investigations\/(\d+)$/);
    if (req.method === 'GET' && poll) {
      const job = pi.polls.get(poll[1]);
      if (!job) return json(404, { error: 'Investigation not found' });
      if (job.reads++ < 1) return json(200, { investigation_id: poll[1], status: 'running' });
      if (job.fail) return json(200, { investigation_id: poll[1], status: 'failed', error: 'The investigation failed. Please try again.' });
      return json(200, {
        investigation_id: poll[1],
        status: 'completed',
        store_id: job.body.store_id || 'unresolved',
        recommendation: 'needs_review',
        reasoning_summary: `No history for this store. Missing item on order ${job.body.order_id}; gather the POS ticket.`,
        missing_evidence: ['POS ticket time'],
        draft_text: `Order ${job.body.order_id}: we dispute the charge. [verify POS ticket time]`,
        risk_notes: null,
        tools_used: [{ name: 'get_error_charges', count: 0 }],
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/disputes/confirm') {
      const body = JSON.parse(raw);
      pi.confirms.push(body);
      return json(200, { id: 'sub-1', case_id: 1, store_id: body.store_id || 'unresolved', submitted_at: body.disputed_at, already_recorded: false });
    }
    return json(404, { error: 'Not found' });
  });
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
  writeFileSync(path.join(out, 'captured-full.jpg'), Buffer.from(c1.image.split(',')[1], 'base64'));

  // 2. Panel: screenshot is attached; first message uploads it as slices and the answer streams in via polling.
  await panel.waitForSelector('#attachment:not([hidden])');
  check('screenshot is attached to the composer', true);
  await panel.fill('#prompt', 'Can we dispute this?');
  await panel.press('#prompt', 'Enter');
  const answer1 = await waitFor(async () => {
    const t = await panel.locator('.agent-message .agent-text').last().innerText().catch(() => '');
    return t.includes('No history for this store') ? t : null;
  }, 40000);
  check('answer appears after polling', !!answer1);
  const first = pi.bodies[0];
  check('woke the backend before investigating', pi.wakes >= 1);
  check('request has no store ID and still works', first && first.body.store_id === null && first.body.order_id === '3990CBFD');
  check('screenshot sent as JPEG slices', first && Array.isArray(first.body.screenshots) && first.body.screenshots.length >= 2 && first.body.screenshots.every((s) => s.startsWith('data:image/jpeg;base64,')), first && String(first.body.screenshots?.length));
  check('first turn has no conversation', first && first.body.conversation.length === 0);
  check('request contains no personal names', first && !/Sam P|Dana K/.test(first.raw));
  check('item names reach the agent (not scrubbed)', first && /Wintermelon Lemon/.test(first.raw));
  check('recommendation shown', (await panel.locator('.assessment .big').last().innerText()) === 'Needs review');
  await panel.screenshot({ path: path.join(out, 'panel-answer.png') });

  // 3. Follow-up remembers the conversation and the draft, and keeps the screenshot in context.
  await panel.fill('#prompt', 'What evidence is missing?');
  await panel.press('#prompt', 'Enter');
  await waitFor(() => pi.bodies.length > 1, 40000);
  const second = pi.bodies[1];
  check('follow-up carries the earlier turns', second && second.body.conversation.length === 2 && second.body.conversation[0].text === 'Can we dispute this?');
  check('follow-up carries the current draft', second && /we dispute the charge/.test(second.body.previous_draft || ''));
  check('follow-up keeps the screenshot in context', second && second.body.screenshots?.length >= 2);
  await waitFor(async () => (await panel.locator('.agent-message').count()) >= 2);

  // 4. Draft, copy, confirm: logging works with no store ID.
  await panel.click('[data-tab="draft"]');
  await panel.click('#copyDraft');
  await panel.waitForSelector('#confirm:not([hidden])');
  check('draft copied to clipboard', /we dispute the charge/.test(await panel.evaluate(() => window.__copied || '')));
  await panel.click('#yesFiled');
  const logged = await waitFor(async () => (await panel.locator('#filingTitle').innerText().catch(() => '')).includes('logged in KoreFi'));
  check('filing is logged without a store ID', !!logged && pi.confirms.length === 1 && pi.confirms[0].store_id === null && pi.confirms[0].order_id === '3990CBFD', JSON.stringify(pi.confirms));

  // 5. A layout the parser does not know, on an address the manifest does not list: still captured, still redacted.
  await openPanel();
  const changed = await context.newPage();
  await changed.goto(`http://127.0.0.1:${portal2Port}/changed?orderId=ZXCV9876&storeId=555123`);
  const c2 = await capture(changed, `http://127.0.0.1:${portal2Port}/*`);
  check('unknown layout is still captured', !!c2 && c2.orderId === 'ZXCV9876', c2?.orderId);
  check('store ID read from the address', c2?.storeId === '555123', String(c2?.storeId));
  check('unknown layout screenshot is redacted', !!c2?.image && (await inspect(c2.image)).bands >= 1, String(c2?.imageNote));
  check('unknown layout text has no names', !!c2 && !/Pat Q|Lee R/.test(c2.redactedText), c2?.redactedText.slice(0, 200));
  await panel.waitForSelector('#attachment:not([hidden])');
  await panel.fill('#prompt', 'Check this one');
  await panel.press('#prompt', 'Enter');
  await waitFor(() => pi.bodies.length > 2, 40000);
  const third = pi.bodies[2];
  check('store ID reaches the agent when known', third && third.body.store_id === '555123');
  check('unknown layout request has no names', third && !/Pat Q|Lee R/.test(third.raw));

  // 6. A page with no sign of where personal details are: no screenshot at all, and nothing unredacted anywhere.
  await openPanel();
  const unknown = await context.newPage();
  await unknown.goto(`http://localhost:${portalPort}/unknown`);
  const c3 = await capture(unknown, `http://localhost:${portalPort}/unknown`);
  check('page with no redaction anchors is captured as data only', !!c3 && c3.image === null && /No screenshot/.test(c3.imageNote || ''), c3?.imageNote);
  check('placeholder order ID is used', !!c3 && c3.orderId.startsWith('SCREENSHOT-'), c3?.orderId);
  const all = await getCases();
  const leaks = [];
  for (const c of all) if (c.image && (await inspect(c.image)).bands < 1) leaks.push(c.orderId);
  check('no stored screenshot is unredacted', leaks.length === 0, leaks.join(','));
  await panel.waitForSelector('#caseMeta:not([hidden])');
  check('operator is asked for the order ID', true);
  check('no attachment when no screenshot', await panel.locator('#attachment').isHidden());
  await panel.fill('#prompt', 'Anything we can do?');
  await panel.press('#prompt', 'Enter');
  await waitFor(() => pi.bodies.length > 3, 40000);
  const fourth = pi.bodies[3];
  check('data-only investigation sends no screenshot', fourth && !fourth.body.screenshots);
  await panel.fill('#metaOrder', 'QWER4321');
  await panel.fill('#metaStore', '246810');
  await panel.click('#saveMeta');
  const saved = await waitFor(async () => (await getCases())[0].orderId === 'QWER4321');
  check('order and store IDs can be entered by hand', !!saved && (await getCases())[0].storeId === '246810');

  // 7. A failed investigation explains itself.
  await openPanel();
  await panel.fill('#prompt', 'FAIL this one');
  await panel.press('#prompt', 'Enter');
  const failure = await waitFor(async () => {
    const t = await panel.locator('.agent-message .agent-text').last().innerText().catch(() => '');
    return /Please try again/.test(t) ? t : null;
  }, 40000);
  check('failed investigation shows a clear message', !!failure);
  await panel.screenshot({ path: path.join(out, 'panel-final.png') });
} finally {
  await context.close();
  portal.close();
  portal2.close();
  fakePi.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
