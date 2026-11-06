import { assessRules } from './shared/rules.ts';
import { getSettings, listCases, stableStringify, upsertCase } from './shared/storage.ts';
import type { CaseRecord, FramePayload, PagePayload, Rect, RuntimeMessage } from './shared/types.ts';

chrome.runtime.onInstalled.addListener(() => void updateBadge());

// Clicking the icon opens the panel and, through activeTab, lets us screenshot this tab until it navigates away.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void chrome.sidePanel.open({ tabId: tab.id });
});
chrome.runtime.onStartup.addListener(() => void updateBadge());
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) void updateBadge();
});

async function updateBadge(): Promise<void> {
  const { captureEnabled } = await getSettings();
  await chrome.action.setBadgeText({ text: captureEnabled ? 'ON' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#B3261E' });
  await chrome.action.setTitle({
    title: captureEnabled ? 'Korefi Dispute Assistant: capturing order pages' : 'Korefi Dispute Assistant: capture is off',
  });
}

// One capture at a time, so the duplicate check always sees the previous capture already saved.
let queue: Promise<void> = Promise.resolve();
function enqueue(job: () => Promise<void>): void {
  queue = queue.then(job).catch((err) => console.error('capture failed', err));
}

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender) => {
  if (msg.type === 'ORDER_DETECTED' && sender.tab) {
    const tab = sender.tab;
    enqueue(() => handleDetected(tab, msg.payload, 'auto'));
  } else if (msg.type === 'CAPTURE_NOW') {
    enqueue(() => handleManual(msg.tabId));
  }
  return false;
});

async function readPayload(tabId: number): Promise<PagePayload | null> {
  const ask = () => chrome.tabs.sendMessage(tabId, { type: 'GET_PAYLOAD' } satisfies RuntimeMessage) as Promise<PagePayload | null>;
  try {
    return await ask();
  } catch {
    // No reader on this tab (page opened before the extension loaded, or on an address the manifest does not list).
    // Clicking the toolbar icon grants activeTab, which lets us add the reader now.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await ask();
  }
}

async function handleManual(tabId: number): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return fail('That tab is no longer open.');
  }
  let payload: PagePayload | null;
  try {
    payload = await readPayload(tabId);
  } catch {
    const host = tab.url ? ` (${new URL(tab.url).hostname})` : '';
    return fail(`Could not read this tab${host}. Click the Korefi icon in the toolbar on the DoorDash order tab, then press Capture now.`);
  }
  if (!payload) return fail('No order is open on this tab. Open an order so its details sheet is showing.');
  await handleDetected(tab, payload, 'manual');
}

function fail(reason: string): void {
  chrome.runtime.sendMessage({ type: 'CAPTURE_FAILED', reason } satisfies RuntimeMessage).catch(() => {});
}

async function handleDetected(tab: chrome.tabs.Tab, payload: PagePayload, trigger: 'auto' | 'manual'): Promise<void> {
  const settings = await getSettings();
  if (trigger === 'auto' && !settings.captureEnabled) return;

  const existing = await listCases();
  const last = existing.find((c) => c.orderId === payload.snapshot.orderId);
  // chrome.storage returns keys sorted, so compare with a key-sorted serialization.
  const duplicate = !!last && stableStringify(last.snapshot) === stableStringify(payload.snapshot);
  console.debug('[capture]', trigger, payload.snapshot.orderId, { stored: existing.length, duplicate });
  if (trigger === 'auto' && duplicate) return;

  const { image, note } = await takeRedactedScreenshot(tab, payload);
  const record: CaseRecord = {
    id: `${payload.snapshot.orderId}-${Date.now().toString(36)}`,
    orderId: payload.snapshot.orderId,
    createdAt: new Date().toISOString(),
    trigger,
    url: payload.url,
    snapshot: payload.snapshot,
    redactedText: payload.redactedText,
    image,
    imageNote: note,
    facts: assessRules(payload.snapshot),
    assessment: null,
    status: 'new',
  };
  await upsertCase(record);
  chrome.runtime.sendMessage({ type: 'CASE_CAPTURED', caseId: record.id } satisfies RuntimeMessage).catch(() => {});
}

const MAX_FRAMES = 14;
// Chrome allows about two captureVisibleTab calls per second.
const CAPTURE_GAP_MS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const withheld = (why: string) => ({ image: null, note: `Screenshot withheld: ${why}` });

/**
 * Scrolls the order sheet one screen at a time, screenshots each screen, blacks out personal details
 * in each one, and stitches them into a single tall image. The scroll position is put back afterwards.
 * Fails closed: if the details cannot be located on any screen, or the page moved while capturing, no image is kept.
 */
async function takeRedactedScreenshot(
  tab: chrome.tabs.Tab,
  payload: PagePayload,
): Promise<{ image: string | null; note: string | null }> {
  if (!payload.rects) return withheld('personal details could not be located on the page to black out.');
  if (!tab.active || tab.id === undefined || tab.windowId === undefined) {
    return { image: null, note: 'Screenshot skipped: the order tab is not the active tab.' };
  }
  const tabId = tab.id;
  const ask = (top: number | null) =>
    chrome.tabs.sendMessage(tabId, { type: 'SCROLL_FRAME', top } satisfies RuntimeMessage) as Promise<FramePayload | null>;

  let start: FramePayload | null = null;
  try {
    start = await ask(null);
    if (!start) return withheld('the order sheet is no longer on the page.');

    const maxTop = Math.max(0, start.scrollHeight - start.clientHeight);
    const stride = Math.max(100, start.clientHeight - 40);
    const tops: number[] = [];
    for (let t = 0; t < maxTop; t += stride) tops.push(t);
    tops.push(maxTop);
    let note: string | null = null;
    if (tops.length > MAX_FRAMES) {
      tops.length = MAX_FRAMES;
      note = `Screenshot covers the first ${MAX_FRAMES} screens of a very long order.`;
    }

    let sheet: Sheet | null = null;
    let lastShot = 0;
    for (const top of tops) {
      const before = await ask(top);
      if (!before?.rects) return withheld('personal details could not be located on the page to black out.');
      await sleep(Math.max(0, CAPTURE_GAP_MS - (Date.now() - lastShot)));
      const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      lastShot = Date.now();
      // Measure again after the capture; if anything moved, the black-out boxes may be misplaced.
      const after = await ask(null);
      if (!after?.rects || Math.abs(after.scrollTop - before.scrollTop) > 1 || !rectsMatch(before.rects, after.rects)) {
        return withheld('the page moved while capturing. Press Capture now again and leave the page alone for a few seconds.');
      }
      sheet = await paintFrame(sheet, raw, before, maxTop);
    }
    return { image: sheet ? await finish(sheet) : null, note };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/activeTab|all_urls/.test(msg)) {
      return { image: null, note: 'Screenshot needs permission: click the Korefi icon in the toolbar on this tab once, then press Capture now.' };
    }
    return { image: null, note: `Screenshot failed: ${msg}` };
  } finally {
    if (start) await ask(start.scrollTop).catch(() => {});
  }
}

function rectsMatch(a: Rect[], b: Rect[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => ['x', 'y', 'w', 'h'].every((k) => Math.abs(r[k as keyof Rect] - b[i][k as keyof Rect]) <= 2));
}

interface Sheet {
  canvas: OffscreenCanvas;
  /** Device pixels per CSS pixel. */
  scale: number;
  /** Bottom edge painted so far, in canvas pixels. */
  painted: number;
}

/** Redacts one screen and draws the sheet's part of it at its scroll offset on the tall canvas. */
async function paintFrame(sheet: Sheet | null, rawDataUrl: string, f: FramePayload, maxTop: number): Promise<Sheet> {
  const bitmap = await createImageBitmap(await (await fetch(rawDataUrl)).blob());
  const scale = bitmap.width / f.viewport.innerWidth;

  const screen = new OffscreenCanvas(bitmap.width, bitmap.height);
  const sctx = screen.getContext('2d')!;
  sctx.drawImage(bitmap, 0, 0);
  sctx.fillStyle = '#111111';
  for (const r of f.rects ?? []) sctx.fillRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);

  const sx = Math.max(0, Math.round(f.region.x * scale));
  const sy = Math.max(0, Math.round(f.region.y * scale));
  const sw = Math.min(Math.round(f.region.w * scale), bitmap.width - sx);
  const sh = Math.min(Math.round(f.region.h * scale), bitmap.height - sy);

  const next: Sheet = sheet ?? {
    canvas: new OffscreenCanvas(sw, Math.round((maxTop + f.region.h) * scale)),
    scale,
    painted: 0,
  };
  const dy = Math.round(f.scrollTop * scale);
  next.canvas.getContext('2d')!.drawImage(screen, sx, sy, sw, sh, 0, dy, sw, sh);
  next.painted = Math.max(next.painted, Math.min(dy + sh, next.canvas.height));
  return next;
}

async function finish(sheet: Sheet): Promise<string> {
  const k = Math.min(1, 1100 / sheet.canvas.width);
  const out = new OffscreenCanvas(Math.round(sheet.canvas.width * k), Math.round(sheet.painted * k));
  out.getContext('2d')!.drawImage(sheet.canvas, 0, 0, sheet.canvas.width, sheet.painted, 0, 0, out.width, out.height);
  return blobToDataUrl(await out.convertToBlob({ type: 'image/jpeg', quality: 0.72 }));
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(bin)}`;
}
