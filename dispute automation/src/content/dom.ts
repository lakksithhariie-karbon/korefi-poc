import type { Rect, Viewport } from '../shared/types.ts';

const ORDER_HEADING = /(^|\n)Order:\s*[A-Z0-9]{4,}/;
const PROFILE_TEXT = /years? on DoorDash|orders? from your store|^\s*Top customer\s*$|Learn more about top customers/i;

/** The order side sheet (or the whole page when the order is shown full-screen). Read-only. */
export function findOrderRoot(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    '[class*="SidesheetBody"], [class*="SidesheetContent"], [role="dialog"], [aria-modal="true"]',
  );
  for (const el of candidates) {
    if (ORDER_HEADING.test(el.innerText)) return el;
  }
  return ORDER_HEADING.test(document.body.innerText) ? document.body : null;
}

export function viewport(): Viewport {
  return { innerWidth: window.innerWidth, innerHeight: window.innerHeight };
}

function toRect(r: DOMRect, pad = 4): Rect {
  return { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 };
}

function visible(r: Rect, vp: Viewport): boolean {
  return r.w > 0 && r.h > 0 && r.x < vp.innerWidth && r.y < vp.innerHeight && r.x + r.w > 0 && r.y + r.h > 0;
}

/**
 * Regions to black out in the screenshot: every text node containing a personal name or customer
 * profile text, widened to its small parent rows so avatars are covered too.
 * Returns null (fail closed) when no name could be located, so no screenshot is taken.
 */
export function computeRects(root: HTMLElement, names: string[]): Rect[] | null {
  if (names.length === 0) return null;
  const vp = viewport();
  const rects: Rect[] = [];
  const found = new Set<string>();

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    const hitName = names.find((n) => text.includes(n));
    if (!hitName && !PROFILE_TEXT.test(text)) continue;
    if (hitName) found.add(hitName);

    const start = node.parentElement;
    if (!start) continue;
    let target: HTMLElement = start;
    for (let i = 0; i < 2; i++) {
      const parent: HTMLElement | null = target.parentElement;
      if (!parent || parent === root) break;
      const pr = parent.getBoundingClientRect();
      if (pr.height > 80 || pr.width > root.getBoundingClientRect().width * 0.98) break;
      target = parent;
    }
    rects.push(toRect(target.getBoundingClientRect()));
  }

  if (names.some((n) => !found.has(n))) return null;
  return rects.filter((r) => visible(r, vp));
}

function scrolls(el: HTMLElement, minHeight: number): boolean {
  return /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) && el.clientHeight >= minHeight && el.scrollHeight > el.clientHeight + 4;
}

/** The element that scrolls the order: the sheet itself, an ancestor, a tall inner pane, or the page. */
export function findScroller(root: HTMLElement): HTMLElement {
  for (let el: HTMLElement | null = root; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (scrolls(el, 1)) return el;
  }
  let best: HTMLElement | null = null;
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (scrolls(el, 200) && (!best || el.scrollHeight > best.scrollHeight)) best = el;
  }
  return best ?? document.documentElement;
}

const isPage = (el: HTMLElement) => el === document.documentElement || el === document.body;

export function scrollMetrics(el: HTMLElement): { scrollTop: number; scrollHeight: number; clientHeight: number; region: Rect } {
  if (isPage(el)) {
    const vp = viewport();
    return {
      scrollTop: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: vp.innerHeight,
      region: { x: 0, y: 0, w: vp.innerWidth, h: vp.innerHeight },
    };
  }
  const r = el.getBoundingClientRect();
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, region: { x: r.left, y: r.top, w: r.width, h: r.height } };
}

/** Moves the sheet's own scroll position, the same as the person scrolling it. Nothing is clicked or sent. */
export function setScrollTop(el: HTMLElement, top: number): void {
  if (isPage(el)) window.scrollTo({ top, behavior: 'instant' });
  else el.scrollTo({ top, behavior: 'instant' });
}
