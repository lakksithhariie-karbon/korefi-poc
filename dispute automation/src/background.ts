import { parseOrder } from './shared/extract.ts';
import { assessRules } from './shared/rules.ts';
import { upsertCase } from './shared/storage.ts';
import type { CaptureContext, CaseRecord, FramePayload, PagePayload, PhotoFrame, Rect, RuntimeMessage } from './shared/types.ts';

// Clicking the icon opens the panel. Chrome screenshots a tab only with activeTab (granted by this click, lost when the
// tab reloads or the extension updates) or <all_urls>, which the panel asks for once, the first time + is tapped.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void chrome.sidePanel.open({ tabId: tab.id });
});

// One capture at a time.
let queue: Promise<void> = Promise.resolve();
function enqueue(job: () => Promise<void>): void {
  queue = queue.then(job).catch((err) => console.error('capture failed', err));
}

chrome.runtime.onMessage.addListener((msg: RuntimeMessage) => {
  if (msg.type === 'CAPTURE_NOW') enqueue(() => capture(msg.tabId));
  return false;
});

function fail(reason: string): void {
  chrome.runtime.sendMessage({ type: 'CAPTURE_FAILED', reason } satisfies RuntimeMessage).catch(() => {});
}

/** Asks the page reader, adding it first if this tab was opened before the extension loaded. */
async function askPage<T>(tabId: number, msg: RuntimeMessage): Promise<T> {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as T;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return (await chrome.tabs.sendMessage(tabId, msg)) as T;
  }
}

async function capture(tabId: number): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return fail('That tab is no longer open.');
  }

  let payload: PagePayload | null;
  let context: CaptureContext | null;
  try {
    payload = await askPage<PagePayload | null>(tabId, { type: 'GET_PAYLOAD' });
    context = await askPage<CaptureContext | null>(tabId, { type: 'GET_CAPTURE_CONTEXT' });
  } catch {
    const host = tab.url ? ` (${new URL(tab.url).hostname})` : '';
    return fail(`Could not read this tab${host}. ${NEEDS_ACCESS}`);
  }

  // A page the parser does not understand is still worth investigating: use what the page shows.
  const platform = payload?.platform ?? context?.platform ?? 'doordash';
  const orderId = payload?.snapshot.orderId || context?.orderId || `SCREENSHOT-${Date.now().toString(36).toUpperCase()}`;
  const snapshot = payload?.snapshot ?? { ...parseOrder(`Order: ${orderId}`).snapshot, platform };
  const redactedText = payload?.redactedText ?? context?.safeText ?? '';

  const { image, note } = await takeScreenshot(tab);
  const photos = context?.photoCount ? await takeCustomerPhotos(tab, context.photoCount, context.photoLinks ?? []) : [];
  const record: CaseRecord = {
    id: `${orderId}-${Date.now().toString(36)}`,
    platform,
    orderId,
    storeId: context?.storeId ?? null,
    createdAt: new Date().toISOString(),
    trigger: 'manual',
    url: payload?.url ?? context?.url ?? tab.url ?? '',
    snapshot,
    redactedText,
    image,
    imageNote: [note, context?.hint].filter(Boolean).join(' ') || null,
    photos,
    facts: assessRules(snapshot),
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

const withheld = (why: string) => ({ image: null, note: `No screenshot: ${why}` });
const NEEDS_ACCESS = 'Chrome has not let KoreFi see this tab yet. Tap + and choose Allow when Chrome asks.';

/**
 * Scrolls the order sheet one screen at a time, screenshots each screen exactly as shown, and stitches them into a
 * single tall image. The scroll position is put back afterwards. If the page moves while capturing, the screenshot is
 * dropped, because the stitched image would not match the page.
 */
async function takeScreenshot(tab: chrome.tabs.Tab): Promise<{ image: string | null; note: string | null }> {
  if (!tab.active || tab.id === undefined || tab.windowId === undefined) {
    return { image: null, note: 'No screenshot: the order tab is not the active tab. Switch to it and capture again.' };
  }
  const tabId = tab.id;
  const ask = (top: number | null) => askPage<FramePayload | null>(tabId, { type: 'SCROLL_FRAME', top });

  let start: FramePayload | null = null;
  try {
    start = await ask(null);
    if (!start) return withheld('the page could not be read.');

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
      if (!before) return withheld('the page could not be read.');
      await sleep(Math.max(0, CAPTURE_GAP_MS - (Date.now() - lastShot)));
      const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      lastShot = Date.now();
      // Measure again after the capture; if the sheet moved, this screen would land in the wrong place.
      const after = await ask(null);
      if (!after || Math.abs(after.scrollTop - before.scrollTop) > 1 || !rectsMatch([before.region], [after.region])) {
        return withheld('the page moved while capturing. Leave it alone for a few seconds and capture again.');
      }
      sheet = await paintFrame(sheet, raw, before, maxTop);
    }
    return { image: sheet ? await finish(sheet) : null, note };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/activeTab|all_urls|cannot access/i.test(msg)) {
      return { image: null, note: `No screenshot. ${NEEDS_ACCESS}` };
    }
    return { image: null, note: `No screenshot: ${msg}` };
  } finally {
    if (start) await ask(start.scrollTop).catch(() => {});
  }
}

/**
 * Each customer photo. One with a link to its original (DoorDash) is downloaded at full size; otherwise, or if the
 * download fails, it is scrolled into view and cropped from a screenshot. A photo that moves while capturing is skipped.
 */
async function takeCustomerPhotos(tab: chrome.tabs.Tab, count: number, links: (string | null)[]): Promise<string[]> {
  if (tab.id === undefined || tab.windowId === undefined) return [];
  const tabId = tab.id;
  const photos: string[] = [];
  let start: FramePayload | null = null;
  try {
    start = await askPage<FramePayload | null>(tabId, { type: 'SCROLL_FRAME', top: null });
    for (let i = 0; i < Math.min(count, 3); i++) {
      const link = links[i];
      if (link) {
        try {
          photos.push(await downloadPhoto(link));
          continue;
        } catch (err) {
          console.warn('photo download failed, cropping the screenshot instead', err);
        }
      }
      const before = await askPage<PhotoFrame | null>(tabId, { type: 'PHOTO_FRAME', index: i, scroll: true });
      if (!before) continue;
      await sleep(CAPTURE_GAP_MS);
      const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const after = await askPage<PhotoFrame | null>(tabId, { type: 'PHOTO_FRAME', index: i, scroll: false });
      if (!after || !rectsMatch([before.rect], [after.rect])) continue;
      photos.push(await cropPhoto(raw, before));
    }
  } catch (err) {
    console.warn('customer photos skipped', err);
  } finally {
    if (start) await askPage(tabId, { type: 'SCROLL_FRAME', top: start.scrollTop }).catch(() => {});
  }
  return photos;
}

const MAX_PHOTO_BYTES = 20_000_000;

/** The original photo from its link, scaled so its long side is at most 1600px, as JPEG. */
async function downloadPhoto(link: string): Promise<string> {
  const res = await fetch(link, { credentials: 'omit' });
  if (!res.ok) throw new Error(`photo download: HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith('image/') || blob.size > MAX_PHOTO_BYTES) throw new Error(`photo download: ${blob.type}, ${blob.size} bytes`);
  const bitmap = await createImageBitmap(blob);
  const k = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const out = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * k)), Math.max(1, Math.round(bitmap.height * k)));
  out.getContext('2d')!.drawImage(bitmap, 0, 0, out.width, out.height);
  return blobToDataUrl(await out.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
}

async function cropPhoto(rawDataUrl: string, f: PhotoFrame): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(rawDataUrl)).blob());
  const scale = bitmap.width / f.viewport.innerWidth;
  const sx = Math.max(0, Math.round(f.rect.x * scale));
  const sy = Math.max(0, Math.round(f.rect.y * scale));
  const sw = Math.min(Math.round(f.rect.w * scale), bitmap.width - sx);
  const sh = Math.min(Math.round(f.rect.h * scale), bitmap.height - sy);
  const k = Math.min(1, 1600 / sw);
  const out = new OffscreenCanvas(Math.max(1, Math.round(sw * k)), Math.max(1, Math.round(sh * k)));
  out.getContext('2d')!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return blobToDataUrl(await out.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
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

/** Draws the sheet's part of one screen at its scroll offset on the tall canvas. */
async function paintFrame(sheet: Sheet | null, rawDataUrl: string, f: FramePayload, maxTop: number): Promise<Sheet> {
  const bitmap = await createImageBitmap(await (await fetch(rawDataUrl)).blob());
  const scale = bitmap.width / f.viewport.innerWidth;


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
  next.canvas.getContext('2d')!.drawImage(bitmap, sx, sy, sw, sh, 0, dy, sw, sh);
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
