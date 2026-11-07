import type { Platform, Rect, Viewport } from '../shared/types.ts';

const ORDER_HEADINGS: Record<Platform, RegExp> = {
  doordash: /(^|\n)Order:\s*[A-Z0-9]{4,}/,
  // "Order D2D46" on a line of its own; "Order details" is lower case and never matches.
  ubereats: /(^|\n)Order\s+[A-Z0-9]{4,16}\s*(\n|$)/,
  grubhub: /(^|\n)Order\s*#?\s*[A-Z0-9-]{4,}/,
};
const PANELS = '[class*="SidesheetBody"], [class*="SidesheetContent"], [data-baseweb="drawer"], [role="dialog"], [aria-modal="true"]';
const PHOTO_CONTEXT = /photo|picture|image|feedback|comment|evidence/i;
export const MAX_PHOTOS = 3;

/** Uber Eats' drawer has no dialog role: climb from the "Order D2D46" heading to the fixed panel that holds it. */
function panelAroundHeading(heading: RegExp): HTMLElement | null {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').trim();
    if (text.length > 24 || !heading.test(`\n${text}\n`)) continue;
    for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
      const pos = getComputedStyle(el).position;
      if ((pos === 'fixed' || pos === 'absolute') && el.getBoundingClientRect().height > 300) return el;
    }
  }
  return null;
}

/** The order side sheet (or the whole page when the order is shown full-screen). */
export function findOrderRoot(platform: Platform = 'doordash'): HTMLElement | null {
  const heading = ORDER_HEADINGS[platform];
  for (const el of document.querySelectorAll<HTMLElement>(PANELS)) {
    if (heading.test(el.innerText)) return el;
  }
  if (platform !== 'doordash') {
    const panel = panelAroundHeading(heading);
    if (panel) return panel;
  }
  return heading.test(document.body.innerText) ? document.body : null;
}

/** Best guess at the open panel on any order page, for pages the order parser does not understand. */
export function genericRoot(): HTMLElement {
  const candidates = [...document.querySelectorAll<HTMLElement>(`${PANELS}, [class*="drawer" i]`)].filter(
    (el) => el.getBoundingClientRect().height > 140,
  );
  return candidates.find((el) => el.scrollHeight > el.clientHeight + 20) ?? candidates.at(-1) ?? document.documentElement;
}

export const captureRoot = (platform: Platform = 'doordash'): HTMLElement => findOrderRoot(platform) ?? genericRoot();

export function viewport(): Viewport {
  return { innerWidth: window.innerWidth, innerHeight: window.innerHeight };
}

// ---- pictures: customer photos are evidence ----

interface Picture {
  el: HTMLElement;
  rect: DOMRect;
}

function isRound(el: HTMLElement, rect: DOMRect): boolean {
  for (let e: HTMLElement | null = el, i = 0; e && i < 3; e = e.parentElement, i++) {
    const radius = getComputedStyle(e).borderTopLeftRadius;
    const px = radius.endsWith('%') ? (parseFloat(radius) / 100) * rect.width : parseFloat(radius);
    if (px >= rect.width * 0.4) return true;
  }
  return false;
}

/** Images and background images inside the order panel that are big enough to be a picture rather than an icon. */
function pictures(root: HTMLElement): Picture[] {
  const out: Picture[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('img, [role="img"], *')) {
    const isImg = el instanceof HTMLImageElement || el.getAttribute('role') === 'img';
    if (!isImg && !getComputedStyle(el).backgroundImage.startsWith('url(')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) continue;
    out.push({ el, rect });
  }
  return out;
}

/** A photo the customer uploaded: a large picture, or a picture next to words like "photo" or "feedback". Never a face. */
function isCustomerPhoto(p: Picture): boolean {
  if (p.rect.width < 48 || p.rect.height < 48 || isRound(p.el, p.rect)) return false;
  if (p.rect.width >= 120 && p.rect.height >= 120) return true;
  for (let e = p.el.parentElement, i = 0; e && i < 4; e = e.parentElement, i++) {
    const text = e.innerText ?? '';
    if (text.length < 600 && PHOTO_CONTEXT.test(text)) return true;
  }
  return false;
}

/** Customer photos on the order, in page order. */
export function customerPhotos(root: HTMLElement): HTMLElement[] {
  return pictures(root)
    .filter(isCustomerPhoto)
    .slice(0, MAX_PHOTOS)
    .map((p) => p.el);
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

/** The part of `a` inside `b`, or null when they do not overlap. */
export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}
