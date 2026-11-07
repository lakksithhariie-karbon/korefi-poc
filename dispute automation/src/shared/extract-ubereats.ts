// Reads an Uber Eats Manager order drawer into the same snapshot the DoorDash reader produces.
// The drawer text runs: customer (initials, name, "New customer"), "Order D2D46", date, shop, the issue banner,
// "Delivery details" (courier), "Order details" (timed steps, items with flagged options and customer feedback), then money.
import type { ErrorCharge, ItemLine, OrderSnapshot, ParsedOrder, TimelineEvent } from './types.ts';

const MONEY = /^([-−–+]?)\s*(?:US|CA|A)?\$\s?([\d,]+(?:\.\d{1,2})?)$/;
const ORDER = /^Order\s+([A-Z0-9]{4,16})$/;
const DATE = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/;
const TIME24 = /^\d{1,2}:\d{2}$/;
const QTY = /^\d{1,3}$/;
const OPTION_HEADER = /^\((?:OPTIONAL|REQUIRED)\)/i;
const FLAG = /(customi[sz]ation (?:reported )?wrong|wrong item|item missing|missing item|missing|incorrect|wrong)/i;
const STATUS = /^Dispute (approved|denied|rejected|declined|pending|in review|submitted)$/i;
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

export function parseMoneyAny(s: string): number | null {
  const m = s.trim().match(MONEY);
  if (!m) return null;
  const v = parseFloat(m[2].replace(/,/g, ''));
  return m[1] && m[1] !== '+' ? -v : v;
}
const isMoney = (l: string) => MONEY.test(l.trim());

/** "18 Oct 2026" and "16:57" as local YYYY-MM-DDTHH:mm. */
export function uberPlacedAt(date: string | null, time: string | null): string | null {
  const m = date?.match(DATE);
  if (!m) return null;
  const month = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const [h, min] = (time ?? '00:00').split(':').map((x) => parseInt(x, 10));
  return `${m[3]}-${pad(month + 1)}-${pad(parseInt(m[1], 10))}T${pad(h)}:${pad(min)}`;
}

interface Item extends ItemLine {
  flags: string[];
  flaggedOptions: string[];
  feedback: string | null;
}

export function parseUberOrder(rawText: string): ParsedOrder {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const find = (pred: (l: string) => boolean, from = 0, to = lines.length): number => {
    for (let i = Math.max(from, 0); i < to; i++) if (pred(lines[i])) return i;
    return -1;
  };
  const iOrder = find((l) => ORDER.test(l));
  const orderId = iOrder >= 0 ? lines[iOrder].match(ORDER)![1] : '';

  const iDelivery = find((l) => l === 'Delivery details');
  const iDetails = find((l) => l === 'Order details');
  const headEnd = iDelivery >= 0 ? iDelivery : iDetails >= 0 ? iDetails : lines.length;
  const head = lines.slice(iOrder + 1, headEnd);
  const dateLine = head.find((l) => DATE.test(l)) ?? null;
  const shop = head.find((l) => l !== dateLine && /\(.+\)|avenue|street|road|blvd|ave\b|st\b/i.test(l) && !/deducted|reported|dispute/i.test(l)) ?? null;
  const bannerStart = head.findIndex((l) => l !== dateLine && l !== shop && !DATE.test(l));
  const banner = bannerStart >= 0 ? head.slice(bannerStart).filter((l) => l !== 'Dispute' && l !== shop) : [];
  const deducted = banner.map((l) => l.match(/\$([\d,]+(?:\.\d{1,2})?)\s+deducted/i)).find(Boolean);
  const issueHeadline = banner.find((l) => FLAG.test(l) && l.length < 60) ?? null;
  const disputeOffered = head.includes('Dispute');
  const statusLine = lines.find((l) => STATUS.test(l));

  // Timed steps, then items until the money lines.
  const timeline: TimelineEvent[] = [];
  let i = iDetails >= 0 ? iDetails + 1 : lines.length;
  while (i + 1 < lines.length && TIME24.test(lines[i]) && !TIME24.test(lines[i + 1])) {
    timeline.push({ time: lines[i], event: lines[i + 1] });
    i += 2;
  }
  const iMoney = find((l) => /^Sales\b/i.test(l), i);
  const end = iMoney >= 0 ? iMoney : lines.length;

  const items: Item[] = [];
  let item: Item | null = null;
  let header: string | null = null;
  let lastOption: string | null = null;
  for (let j = i; j < end; j++) {
    const l = lines[j];
    if (OPTION_HEADER.test(l)) {
      header = l;
      continue;
    }
    if (/^Customer feedback$/i.test(l)) {
      const said: string[] = [];
      for (j = j + 1; j < end && !/^View (less|more)$/i.test(lines[j]) && !OPTION_HEADER.test(lines[j]) && !QTY.test(lines[j]); j++) said.push(lines[j]);
      if (/^View (less|more)$/i.test(lines[j] ?? '')) j++;
      j--;
      if (item) item.feedback = said.join(' ').trim() || null;
      continue;
    }
    if (/^View (less|more)$/i.test(l)) continue;
    if (QTY.test(l) && j + 1 < end) {
      const name = lines[j + 1];
      if (header && item) {
        // An option chosen for the current item, such as "No Ice" under "(OPTIONAL) Change Ice Level".
        lastOption = `${header.replace(OPTION_HEADER, '').trim()}: ${name}`;
        item.options.push(lastOption);
        header = null;
      } else {
        item = { qty: parseInt(l, 10), name, options: [], price: null, flags: [], flaggedOptions: [], feedback: null };
        items.push(item);
        lastOption = null;
      }
      j++;
      continue;
    }
    if (!item) continue;
    if (isMoney(l)) {
      if (item.price === null && !lastOption) item.price = parseMoneyAny(l);
      continue;
    }
    if (FLAG.test(l) && l.length < 60) {
      if (lastOption) item.flaggedOptions.push(`${lastOption} (${l})`);
      else item.flags.push(l);
    }
  }

  const value = (label: RegExp): number | null => {
    const k = find((l) => label.test(l), end);
    if (k < 0) return null;
    const same = lines[k].match(/((?:[-−–+]\s*)?(?:US|CA|A)?\$\s?[\d,]+(?:\.\d{1,2})?)$/);
    if (same && lines[k] !== same[1]) return parseMoneyAny(same[1].replace(/\s+/g, ''));
    for (let n = k + 1; n <= k + 3 && n < lines.length; n++) if (isMoney(lines[n])) return parseMoneyAny(lines[n]);
    return null;
  };
  const chargeback = value(/^Chargeback amount/i);
  const deductedAmount = deducted ? -parseFloat(deducted[1].replace(/,/g, '')) : null;
  const errorTotal = chargeback ?? deductedAmount;

  const flagged = items.filter((x) => x.flags.length || x.flaggedOptions.length);
  const status = statusLine ? statusLine.replace(/^Dispute /i, '').toLowerCase() : disputeOffered ? 'available' : null;
  const errorCharges: ErrorCharge[] = (flagged.length ? flagged : issueHeadline ? [null] : []).map((x) => ({
    item: x?.name ?? '',
    options: x?.flaggedOptions ?? [],
    reason: x?.flags[0] ?? (x?.flaggedOptions.length ? 'Customisation reported wrong' : issueHeadline),
    disputeStatus: status,
    amount: flagged.length <= 1 ? errorTotal : null,
    customerComment: x?.feedback ?? items.find((y) => y.feedback)?.feedback ?? null,
  }));

  const step = (re: RegExp) => timeline.find((t) => re.test(t.event))?.time ?? null;
  const snapshot: OrderSnapshot = {
    platform: 'ubereats',
    orderId,
    placedAtText: dateLine ? [dateLine, timeline[0]?.time].filter(Boolean).join(' ') : null,
    placedAt: uberPlacedAt(dateLine, timeline[0]?.time ?? null),
    status: step(/delivered/i) ? 'Delivered' : timeline.at(-1)?.event ?? null,
    disputeStatus: status,
    notice: banner.join(' ').slice(0, 600) || null,
    channel: 'Uber Eats',
    fulfillment: timeline.some((t) => /courier|delivered to customer/i.test(t.event)) ? 'Uber delivery' : null,
    pickedUp: { actual: step(/courier departs|picked up/i), quoted: null },
    droppedOff: { actual: step(/delivered/i), quoted: null },
    items: items.map(({ qty, name, options, price }) => ({ qty, name, options, price })),
    subtotal: value(/^Sales\b/i),
    tax: value(/^Tax\b/i),
    commissionPct: null,
    commission: value(/^Marketplace Fee/i),
    orderTotal: null,
    errorCharges,
    errorChargeTotal: errorTotal,
    errorCredit: null,
    estimatedPayout: value(/^Net payout/i),
    transactions: [],
    timeline,
    shop,
  };
  return { snapshot };
}
