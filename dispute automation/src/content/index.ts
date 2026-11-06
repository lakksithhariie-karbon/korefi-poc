// Content script. It answers the extension when the operator presses capture; it never runs on its own.
// It never clicks, navigates, edits the page, or calls any DoorDash endpoint. The one thing it does besides
// reading is scroll the order sheet while a screenshot is taken, then the background worker puts the scroll back.
import { parseOrder, redactText } from '../shared/extract.ts';
import { findOrderId, findStoreId } from '../shared/ids.ts';
import { scrubText } from '../shared/redact.ts';
import type { CaptureContext, FramePayload, PagePayload, RuntimeMessage } from '../shared/types.ts';
import { captureRoot, findOrderRoot, findScroller, redactionRects, scrollMetrics, setScrollTop, viewport } from './dom.ts';

function buildPayload(): PagePayload | null {
  const root = findOrderRoot();
  if (!root) return null;
  const text = root.innerText;
  const { snapshot, names } = parseOrder(text);
  if (!snapshot.orderId) return null;
  return { url: location.href, snapshot, redactedText: scrubText(redactText(text, names)) };
}

/** Works on any DoorDash page, including ones whose layout the parser does not know. */
function buildContext(): CaptureContext {
  const root = captureRoot();
  const text = root.innerText.slice(0, 20000);
  return {
    orderId: findOrderId(location.href, text),
    storeId: findStoreId(location.href, document.body.innerText.slice(0, 20000)),
    title: document.title,
    url: location.href,
    safeText: scrubText(text).slice(0, 9000),
  };
}

/** Optionally scrolls the sheet, waits for it to settle, then measures where personal details sit on screen. */
async function frame(top: number | null): Promise<FramePayload | null> {
  const root = captureRoot();
  const scroller = findScroller(root);
  if (top !== null) {
    setScrollTop(scroller, top);
    await new Promise((r) => setTimeout(r, 350));
  }
  const { names } = parseOrder(root.innerText);
  return { ...scrollMetrics(scroller), rects: redactionRects(root, names), viewport: viewport() };
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
    }
    return false;
  });
}
