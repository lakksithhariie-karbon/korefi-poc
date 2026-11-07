// Fresh-install check: the extension built as a user installs it, with no screenshot grant yet.
// run.mjs starts from the granted state because automation cannot press Chrome's "Allow" prompt; this file covers the
// state before it, which is where the live "No screenshot" bug came from (Chrome refuses captureVisibleTab without
// activeTab or <all_urls>, and the host permissions for doordash.com and ubereats.com do not count).
// Run: PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers node e2e/access.mjs
import { execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'e2e', 'out-access');
rmSync(out, { recursive: true, force: true });
const ext = path.join(out, 'ext');

const pickup = readFileSync(path.join(root, 'fixtures', 'ubereats-5DE2A-pickup.txt'), 'utf8').split('\n').filter(Boolean);
const portal = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Uber Eats Manager</title><div data-baseweb="drawer">${pickup.map((l) => `<div>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`).join('')}</div>`);
});
const port = await new Promise((r) => portal.listen(0, 'localhost', () => r(portal.address().port)));
execSync('node build.mjs', { cwd: root, stdio: 'inherit', env: { ...process.env, OUT_DIR: ext, TEST_ORIGIN: `http://localhost:${port}`, TEST_NO_GRANT: '1' } });

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) failed++;
};

// The shipped manifest: the grant is optional, so installing still shows no "all websites" warning.
const shipped = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
check('the shipped manifest only asks for <all_urls> when + is tapped', shipped.optional_host_permissions.includes('<all_urls>') && !shipped.host_permissions.includes('<all_urls>'));

const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-sandbox'],
});
try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const order = await context.newPage();
  await order.goto(`http://localhost:${port}/orders`);

  // 1. The bug as it happened live: the page is read, but Chrome refuses the screenshot.
  const refusal = await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://localhost/*' });
    return chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' }).then(() => 'captured', (e) => e.message);
  });
  check('without the grant Chrome refuses the screenshot (the live bug)', /activeTab/.test(refusal), refusal);

  // 2. Tapping + asks Chrome for the grant, during the tap.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.evaluate(() => {
    window.__asked = [];
    chrome.permissions.request = async (p) => { window.__asked.push(p); return false; }; // the user picks "Deny"
  });
  await panel.click('#capture');
  const asked = await panel.evaluate(() => window.__asked);
  check('tapping + asks for screenshot access', asked.length === 1 && asked[0].origins?.[0] === '<all_urls>', JSON.stringify(asked));

  // 3. Declined: the order is still read, no screenshot is taken, and the note says how to fix it.
  await order.bringToFront();
  await panel.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://localhost/*' });
    await chrome.runtime.sendMessage({ type: 'CAPTURE_NOW', tabId: t.id });
  });
  let c = null;
  for (let i = 0; i < 60 && !c; i++) {
    await new Promise((r) => setTimeout(r, 250));
    c = (await panel.evaluate(async () => (await chrome.storage.local.get('cases')).cases ?? []))[0] ?? null;
  }
  check('declined: the order is still read', c?.orderId === '5DE2A', JSON.stringify(c?.orderId));
  check('declined: no screenshot, and the note says to tap + and allow', !!c && !c.image && /Tap \+ and choose Allow/.test(c.imageNote ?? ''), String(c?.imageNote));
  const toast = await panel.locator('#toast').innerText().catch(() => '');
  check('declined: the panel shows that note', /choose Allow/.test(toast), toast);

  // 4. The real request from a tap is accepted by Chrome: it opens its prompt instead of rejecting it.
  await panel.reload();
  await panel.evaluate(() => {
    const real = chrome.permissions.request.bind(chrome.permissions);
    window.__result = 'prompt open';
    chrome.permissions.request = (p) => real(p).then((v) => { window.__result = `answered ${v}`; return v; }, (e) => { window.__result = `rejected: ${e.message}`; return false; });
  });
  await panel.click('#capture');
  await new Promise((r) => setTimeout(r, 2000));
  const result = await panel.evaluate(() => window.__result);
  check('Chrome opens its "Allow" prompt for the tap', result === 'prompt open', result);
} finally {
  await context.close().catch(() => {});
  portal.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
