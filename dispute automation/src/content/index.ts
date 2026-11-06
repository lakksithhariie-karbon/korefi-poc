// Content script. It reads the order page the person already has open and reports it.
// It never clicks, navigates, edits the page, or calls any DoorDash endpoint. The one thing it does
// besides reading is scroll the order sheet while a screenshot is taken, then put the scroll back.
import { parseOrder, redactText } from '../shared/extract.ts';
import type { FramePayload, PagePayload, RuntimeMessage } from '../shared/types.ts';
import { computeRects, findOrderRoot, findScroller, scrollMetrics, setScrollTop, viewport } from './dom.ts';

function buildPayload(): { payload: PagePayload; names: string[] } | null {
  const root = findOrderRoot();
  if (!root) return null;
  const text = root.innerText;
  const { snapshot, names } = parseOrder(text);
  if (!snapshot.orderId) return null;
  return {
    names,
    payload: {
      url: location.href,
      snapshot,
      redactedText: redactText(text, names),
      rects: computeRects(root, names),
      viewport: viewport(),
    },
  };
}

function signature(p: PagePayload): string {
  let h = 0;
  for (let i = 0; i < p.redactedText.length; i++) h = (h * 31 + p.redactedText.charCodeAt(i)) | 0;
  return `${p.snapshot.orderId}:${h}`;
}

let lastSent = '';
let timer: number | undefined;

function check(): void {
  const built = buildPayload();
  if (!built) {
    lastSent = '';
    return;
  }
  const sig = signature(built.payload);
  if (sig === lastSent) return;
  lastSent = sig;
  const msg: RuntimeMessage = { type: 'ORDER_DETECTED', payload: built.payload };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/** Optionally scrolls the sheet, waits for it to settle, then measures where personal details sit on screen. */
async function frame(top: number | null): Promise<FramePayload | null> {
  const root = findOrderRoot();
  if (!root) return null;
  const scroller = findScroller(root);
  if (top !== null) {
    setScrollTop(scroller, top);
    await new Promise((r) => setTimeout(r, 350));
  }
  const { names } = parseOrder(root.innerText);
  return { ...scrollMetrics(scroller), rects: computeRects(root, names), viewport: viewport() };
}

function start(): void {
  new MutationObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(check, 900);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  check();

  chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
    if (msg.type === 'GET_PAYLOAD') {
      sendResponse(buildPayload()?.payload ?? null);
    } else if (msg.type === 'SCROLL_FRAME') {
      void frame(msg.top).then(sendResponse, () => sendResponse(null));
      return true;
    }
    return false;
  });
}

// The background worker may inject this file again on demand, so only start once per page.
const flag = window as unknown as { __korefiReader?: boolean };
if (!flag.__korefiReader) {
  flag.__korefiReader = true;
  start();
}
