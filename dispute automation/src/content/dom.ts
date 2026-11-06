import { COMMENTER, EMAIL, PERSON_LABELS, PHONE, STOP_LABELS } from '../shared/redact.ts';
import type { Rect, Viewport } from '../shared/types.ts';

const ORDER_HEADING = /(^|\n)Order:\s*[A-Z0-9]{4,}/;
const PROFILE_TEXT = /years? on DoorDash|orders? from your store|^\s*Top customer\s*$|Learn more about top customers/i;
const FALLBACK_BLOCK_HEIGHT = 170;

/** The order side sheet (or the whole page when the order is shown full-screen). */
export function findOrderRoot(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    '[class*="SidesheetBody"], [class*="SidesheetContent"], [role="dialog"], [aria-modal="true"]',
  );
  for (const el of candidates) {
    if (ORDER_HEADING.test(el.innerText)) return el;
  }
  return ORDER_HEADING.test(document.body.innerText) ? document.body : null;
}

/** Best guess at the open panel on any DoorDash page, for pages the order parser does not understand. */
export function genericRoot(): HTMLElement {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [aria-modal="true"], [class*="SidesheetBody"], [class*="SidesheetContent"], [class*="drawer" i]',
    ),
  ].filter((el) => el.getBoundingClientRect().height > 140);
  return candidates.find((el) => el.scrollHeight > el.clientHeight + 20) ?? candidates.at(-1) ?? document.documentElement;
}

export const captureRoot = (): HTMLElement => findOrderRoot() ?? genericRoot();

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
function rowRect(node: Text, root: HTMLElement): DOMRect | null {
  const start = node.parentElement;
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

/**
 * Regions to black out in a screenshot of the current scroll position. Three independent signals are combined:
 * known personal names, the blocks under the Customer / Dasher labels (which need no parsing), and emails or phone numbers.
 *
 * Returns null (fail closed) when personal details cannot be located with confidence, and no screenshot is taken:
 * a name the parser found is missing from the page, or the page has no Customer / Dasher block and no other trace of one.
 */
export function redactionRects(root: HTMLElement, names: string[]): Rect[] | null {
  const vp = viewport();
  const rects: Rect[] = [];
  const found = new Set<string>();
  const sheet = root.getBoundingClientRect();

  const texts: { node: Text; text: string }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const text = (node.textContent ?? '').trim();
    if (text) texts.push({ node, text });
  }

  let traces = 0;
  for (const { node, text } of texts) {
    const name = names.find((n) => text.includes(n));
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

  if (names.some((n) => !found.has(n))) return null;
  if (traces === 0) return null;
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
