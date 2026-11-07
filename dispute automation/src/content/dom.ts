import { COMMENTER, EMAIL, PERSON_LABELS, PHONE, STOP_LABELS } from '../shared/redact.ts';
import type { Platform, Rect, Viewport } from '../shared/types.ts';

const ORDER_HEADINGS: Record<Platform, RegExp> = {
  doordash: /(^|\n)Order:\s*[A-Z0-9]{4,}/,
  // "Order D2D46" on a line of its own; "Order details" is lower case and never matches.
  ubereats: /(^|\n)Order\s+[A-Z0-9]{4,16}\s*(\n|$)/,
  grubhub: /(^|\n)Order\s*#?\s*[A-Z0-9-]{4,}/,
};
const PROFILE_TEXT =
  /years? on DoorDash|orders? from your store|^\s*Top customer\s*$|Learn more about top customers|^\s*(New|Returning|Repeat) customer\s*$|orders? delivered\s*$|^\s*\d+\s+orders?\s*$/i;
/** Pages join names with non-breaking spaces and line breaks; compare text with all whitespace folded to one space. */
const fold = (s: string) => s.replace(/\s+/g, ' ').trim();
const FALLBACK_BLOCK_HEIGHT = 170;
/** Where the platform itself marks personal fields (FullStory masking, used by Uber Eats Manager). */
const MASKED = '.fs-mask, [data-fs-mask], [data-private]';
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

function toRect(r: DOMRect, pad = 4): Rect {
  return { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 };
}

function visible(r: Rect, vp: Viewport): boolean {
  return r.w > 0 && r.h > 0 && r.x < vp.innerWidth && r.y < vp.innerHeight && r.x + r.w > 0 && r.y + r.h > 0;
}

function textRect(node: Text): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(node);
  return range.getBoundingClientRect();
}

/** The text's small parent rows, so avatars next to a name are covered too. */
function rowRect(node: Node, root: HTMLElement): DOMRect | null {
  const start = node instanceof HTMLElement ? node : node.parentElement;
  if (!start) return null;
  let target: HTMLElement = start;
  for (let i = 0; i < 2; i++) {
    const parent: HTMLElement | null = target.parentElement;
    if (!parent || parent === root) break;
    const pr = parent.getBoundingClientRect();
    if (pr.height > 80 || pr.width > root.getBoundingClientRect().width * 0.98) break;
    target = parent;
  }
  return target.getBoundingClientRect();
}

const hits = (re: RegExp, text: string): boolean => {
  re.lastIndex = 0;
  return re.test(text);
};

// ---- pictures: customer photos are evidence; faces and avatars are personal details ----

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
  if (p.el.closest(MASKED)) return false;
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

/** Pictures of people: courier faces and avatars. Small pictures that are not customer photos are hidden too, to be safe. */
function personPictures(root: HTMLElement): DOMRect[] {
  return pictures(root)
    .filter((p) => !isCustomerPhoto(p) && (isRound(p.el, p.rect) || (p.rect.width <= 96 && p.rect.height <= 96)))
    .map((p) => p.rect);
}

/**
 * Regions to black out in a screenshot of the current scroll position. Independent signals are combined:
 * known personal names, the blocks under the Customer / Dasher labels (which need no parsing), fields the platform
 * itself marks as private, pictures of people, and emails or phone numbers.
 *
 * Returns null (fail closed) when personal details cannot be located with confidence, and no screenshot is taken:
 * a name the parser found is missing from the page, or the page has no trace of where the details are.
 */
export function redactionRects(root: HTMLElement, names: string[], platform: Platform = 'doordash'): Rect[] | null {
  const vp = viewport();
  const rects: Rect[] = [];
  const found = new Set<string>();
  const sheet = root.getBoundingClientRect();

  const texts: { node: Text; text: string }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const text = fold(node.textContent ?? '');
    if (text) texts.push({ node, text });
  }
  const wanted = [...new Set(names.map(fold).filter(Boolean))];

  let traces = 0;
  for (const { node, text } of texts) {
    const name = wanted.find((n) => text.includes(n));
    if (name) found.add(name);
    if (!name && !PROFILE_TEXT.test(text) && !COMMENTER.test(text) && !hits(EMAIL, text) && !hits(PHONE, text)) continue;
    const row = rowRect(node, root);
    if (row) {
      rects.push(toRect(row));
      traces++;
    }
  }

  for (let i = 0; i < texts.length; i++) {
    if (!PERSON_LABELS.has(texts[i].text.toLowerCase())) continue;
    const label = textRect(texts[i].node);
    let end = label.bottom + FALLBACK_BLOCK_HEIGHT;
    for (let j = i + 1; j < texts.length; j++) {
      if (STOP_LABELS.has(texts[j].text.toLowerCase())) {
        end = Math.min(end, textRect(texts[j].node).top);
        break;
      }
    }
    if (end > label.bottom) {
      rects.push({ x: sheet.left - 2, y: label.bottom + 1, w: sheet.width + 4, h: end - label.bottom - 2 });
      traces++;
    }
  }

  let masked = 0;
  for (const el of root.querySelectorAll<HTMLElement>(MASKED)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    rects.push(toRect(rowRect(el, root) ?? r));
    masked++;
  }
  for (const r of personPictures(root)) rects.push(toRect(r, 2));

  // A name split across elements ("Jeff <span>J</span>") is in no single text node: cover the smallest element holding all of it.
  for (const n of wanted) {
    if (found.has(n)) continue;
    const el = smallestHolding(root, n);
    if (!el) continue;
    rects.push(toRect(rowRect(el, root) ?? el.getBoundingClientRect()));
    found.add(n);
    traces++;
  }

  if (wanted.some((n) => !found.has(n))) return null;
  // Uber Eats has no Customer label to anchor on, so it needs a name or a platform-marked field before anything is captured.
  if (platform !== 'doordash' && wanted.length === 0 && masked === 0) return null;
  if (traces + masked === 0) return null;
  return rects.filter((r) => visible(r, vp));
}

function smallestHolding(root: HTMLElement, name: string): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestLength = Infinity;
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    const text = fold(el.textContent ?? '');
    if (text.length < bestLength && text.length <= name.length + 40 && text.includes(name)) {
      best = el;
      bestLength = text.length;
    }
  }
  return best;
}

/** Text the platform marks as private, so it can be removed from page text as well as from pixels. */
export function maskedTexts(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>(MASKED)]
    .flatMap((el) => el.innerText.split('\n'))
    .map(fold)
    .filter((t) => t.length >= 2 && t.length <= 60);
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
