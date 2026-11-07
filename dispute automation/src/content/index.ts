// Content script. It answers the extension when the operator presses capture; it never runs on its own.
// It never clicks, navigates, edits the page, or calls any platform endpoint. The one thing it does besides
// reading is scroll the order sheet while a screenshot is taken, then the background worker puts the scroll back.
import { parseOrder, redactText } from '../shared/extract.ts';
import { parseUberOrder } from '../shared/extract-ubereats.ts';
import { findOrderId, findStoreId } from '../shared/ids.ts';
import { detectPlatform } from '../shared/platform.ts';
import { scrubText } from '../shared/redact.ts';
import type { CaptureContext, FramePayload, PagePayload, ParsedOrder, PhotoFrame, Platform, RuntimeMessage } from '../shared/types.ts';
import {
  captureRoot,
  customerPhotos,
  findOrderRoot,
  findScroller,
  intersect,
  maskedTexts,
  redactionRects,
  scrollMetrics,
  setScrollTop,
  viewport,
} from './dom.ts';

const platform = (): Platform => detectPlatform(location.href, document);
const parse = (text: string, on: Platform): ParsedOrder => (on === 'ubereats' ? parseUberOrder(text) : parseOrder(text));

/** Names to hide: those the parser found, plus anything the platform itself marks as private. */
function personalNames(root: HTMLElement, on: Platform): string[] {
  const { names } = parse(root.innerText, on);
  return [...new Set([...names, ...maskedTexts(root)])];
}

function buildPayload(): PagePayload | null {
  const on = platform();
  const root = findOrderRoot(on);
  if (!root) return null;
  const text = root.innerText;
  const { snapshot } = parse(text, on);
  if (!snapshot.orderId) return null;
  return { platform: on, url: location.href, snapshot, redactedText: scrubText(redactText(text, personalNames(root, on))) };
}

/** Works on any order page, including ones whose layout the parser does not know. */
function buildContext(): CaptureContext {
  const on = platform();
  const root = captureRoot(on);
  const text = root.innerText.slice(0, 20000);
  const collapsed = /Customer feedback/i.test(text) && /(^|\n)View more(\n|$)/i.test(text);
  return {
    platform: on,
    orderId: findOrderId(location.href, text),
    storeId: findStoreId(location.href, document.body.innerText.slice(0, 20000), on),
    title: document.title,
    url: location.href,
    safeText: scrubText(redactText(text, personalNames(root, on))).slice(0, 9000),
    photoCount: customerPhotos(root).length,
    hint: collapsed ? 'Open "View more" under Customer feedback on the page, then attach again to include every customer photo.' : null,
  };
}

const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));

/** Optionally scrolls the sheet, waits for it to settle, then measures where personal details sit on screen. */
async function frame(top: number | null): Promise<FramePayload | null> {
  const on = platform();
  const root = captureRoot(on);
  const scroller = findScroller(root);
  if (top !== null) {
    setScrollTop(scroller, top);
    await settle();
  }
  return { ...scrollMetrics(scroller), rects: redactionRects(root, personalNames(root, on), on), viewport: viewport() };
}

/** Scrolls one customer photo into view (when asked), waits for it to load, and measures it and the details around it. */
async function photoFrame(index: number, scroll: boolean): Promise<PhotoFrame | null> {
  const on = platform();
  const root = captureRoot(on);
  const photo = customerPhotos(root)[index];
  if (!photo) return null;
  const scroller = findScroller(root);
  const { scrollTop, region } = scrollMetrics(scroller);
  if (scroll) {
    setScrollTop(scroller, scrollTop + photo.getBoundingClientRect().top - region.y - 16);
    await settle();
    for (let i = 0; i < 6 && photo instanceof HTMLImageElement && !photo.complete; i++) await settle(250);
  }
  const vp = viewport();
  const shown = intersect(
    { x: photo.getBoundingClientRect().left, y: photo.getBoundingClientRect().top, w: photo.getBoundingClientRect().width, h: photo.getBoundingClientRect().height },
    intersect(scrollMetrics(scroller).region, { x: 0, y: 0, w: vp.innerWidth, h: vp.innerHeight }) ?? { x: 0, y: 0, w: 0, h: 0 },
  );
  if (!shown) return null;
  return { rect: shown, rects: redactionRects(root, personalNames(root, on), on), viewport: vp };
}

// The background worker may inject this file again on demand, so only listen once per page.
const flag = window as unknown as { __korefiReader?: boolean };
if (!flag.__korefiReader) {
  flag.__korefiReader = true;
  chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
    if (msg.type === 'GET_PAYLOAD') {
      sendResponse(buildPayload());
    } else if (msg.type === 'GET_CAPTURE_CONTEXT') {
      sendResponse(buildContext());
    } else if (msg.type === 'SCROLL_FRAME') {
      void frame(msg.top).then(sendResponse, () => sendResponse(null));
      return true;
    } else if (msg.type === 'PHOTO_FRAME') {
      void photoFrame(msg.index, msg.scroll).then(sendResponse, () => sendResponse(null));
      return true;
    }
    return false;
  });
}
