import type {
  ErrorCharge,
  ItemLine,
  OrderSnapshot,
  ParsedOrder,
  TimePair,
  Transaction,
} from './types.ts';

const MONEY_LINE = /^([-−–+]?)\s*US?\$\s?([\d,]+(?:\.\d{1,2})?)$/;
const MONEY_TRAILING = /\s([-−–+]?\s*US?\$\s?[\d,]+(?:\.\d{1,2})?)$/;
const QTY = /^(\d+)\s*[×x](?:\s+(.*))?$/i;
const DISPUTE_CHIP = /^Dispute (approved|denied|rejected|declined|pending|in review|submitted|eligible|available)$/i;
const REASON = /^(missing|incorrect|wrong|late|never|not delivered|damaged|spilled|quality|cold|order )/i;
const TIME = /^\d{1,2}:\d{2}\s*[ap]m$/i;
const QUOTED = /^\(Quoted:\s*(.+)\)$/i;
const PROFILE_NOISE = /years? on DoorDash|orders? from your store|^new to DoorDash$|^(new|returning|repeat) customer$|orders? delivered$/i;
const UI_NOISE = /^(top customer|learn more about top customers|report|rate dasher)$/i;

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

export function parseMoney(s: string): number | null {
  const m = s.trim().match(MONEY_LINE);
  if (!m) return null;
  const v = parseFloat(m[2].replace(/,/g, ''));
  return m[1] === '-' || m[1] === '−' || m[1] === '–' ? -v : v;
}

function isMoneyLine(l: string): boolean {
  return MONEY_LINE.test(l.trim());
}

/** Value for a label row: same line ("Tax  US$0.00") or one of the next two lines. */
function valueAfter(lines: string[], i: number, window = 2): number | null {
  const trailing = lines[i].match(MONEY_TRAILING);
  if (trailing) return parseMoney(trailing[1].replace(/\s+/g, ''));
  for (let j = i + 1; j <= i + window && j < lines.length; j++) {
    if (isMoneyLine(lines[j])) return parseMoney(lines[j]);
  }
  return null;
}

export function parsePlacedAt(text: string): string | null {
  const m = text.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*([ap]m)/i);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  let hour = parseInt(m[4], 10) % 12;
  if (m[6].toLowerCase() === 'pm') hour += 12;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${m[3]}-${pad(month + 1)}-${pad(parseInt(m[1], 10))}T${pad(hour)}:${m[5]}`;
}

interface Entry {
  qty: number;
  rest: string[];
}

function splitEntries(block: string[]): Entry[] {
  const out: Entry[] = [];
  let cur: Entry | null = null;
  for (const l of block) {
    const m = l.match(QTY);
    if (m) {
      cur = { qty: parseInt(m[1], 10), rest: m[2] ? [m[2]] : [] };
      out.push(cur);
    } else if (cur) {
      cur.rest.push(l);
    }
  }
  return out;
}

function parseItem(e: Entry): ItemLine {
  let name = '';
  let price: number | null = null;
  const options: string[] = [];
  for (const l of e.rest) {
    if (isMoneyLine(l)) {
      if (price === null) price = parseMoney(l);
    } else if (!name) {
      name = l;
    } else {
      options.push(l);
    }
  }
  return { qty: e.qty, name, options, price };
}

function parseErrorEntry(e: Entry, names: string[]): ErrorCharge {
  const out: ErrorCharge = {
    item: '', options: [], reason: null, disputeStatus: null, amount: null, customerComment: null,
  };
  let expectComment = false;
  for (const l of e.rest) {
    const commenter = l.match(/^(.+) left a comment$/);
    if (isMoneyLine(l)) {
      if (out.amount === null) out.amount = parseMoney(l);
    } else if (commenter) {
      names.push(commenter[1]);
      expectComment = true;
    } else if (expectComment) {
      out.customerComment = l.replace(/^["“”']+|["“”']+$/g, '');
      expectComment = false;
    } else if (DISPUTE_CHIP.test(l)) {
      out.disputeStatus = l.replace(/^Dispute /i, '').toLowerCase();
    } else if (out.reason === null && REASON.test(l) && l.length < 60) {
      out.reason = l;
    } else if (!out.item) {
      out.item = l;
    } else {
      out.options.push(l);
    }
  }
  return out;
}

export function parseOrder(rawText: string): ParsedOrder {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const find = (pred: (l: string) => boolean, from = 0, to = lines.length): number => {
    for (let i = Math.max(from, 0); i < to; i++) if (pred(lines[i])) return i;
    return -1;
  };

  const names: string[] = [];
  const iOrder = find((l) => /^Order:\s*\S+/.test(l));
  const orderId = iOrder >= 0 ? lines[iOrder].replace(/^Order:\s*/, '').trim() : '';
  const iPlaced = find((l) => /^Order placed:/i.test(l));
  const placedAtText = iPlaced >= 0 ? lines[iPlaced].replace(/^Order placed:\s*/i, '') : null;

  const iDelivery = find((l) => l === 'Delivery details');
  const iDetails = find((l) => l === 'Order details');
  const iErr = find((l) => l === 'Error charges', Math.max(iDetails, 0));
  const iErrSub = find((l) => l === 'Error charge subtotal', Math.max(iErr, 0));
  const iAssoc = find((l) => /^Associated transactions/i.test(l));

  const headerEnd = iDelivery >= 0 ? iDelivery : iDetails >= 0 ? iDetails : lines.length;
  const header = lines.slice(Math.max(iOrder, 0) + 1, headerEnd);
  const status = header.find((l) => /^(Completed|Cancelled|Canceled|Refunded|In progress|Active|Scheduled)$/i.test(l)) ?? null;
  const disputeChip = header.find((l) => DISPUTE_CHIP.test(l));
  const disputeStatus = disputeChip ? disputeChip.replace(/^Dispute /i, '').toLowerCase() : null;
  const notice = header.find((l) => l.length > 30 && /dispute/i.test(l)) ?? null;

  // Delivery section: customer, dasher, handoff times, channel.
  const dEnd = iDetails >= 0 ? iDetails : lines.length;
  const iCustomer = find((l) => l === 'Customer', iDelivery, dEnd);
  const iDasher = find((l) => l === 'Dasher', iDelivery, dEnd);
  const iPicked = find((l) => l === 'Picked up', iDelivery, dEnd);
  const nameAfter = (from: number, to: number): string | null => {
    for (let i = from + 1; i < to; i++) {
      const l = lines[i];
      if (l.length <= 1 || UI_NOISE.test(l) || PROFILE_NOISE.test(l)) continue;
      return l;
    }
    return null;
  };
  if (iCustomer >= 0) {
    const n = nameAfter(iCustomer, iDasher > iCustomer ? iDasher : iPicked > iCustomer ? iPicked : dEnd);
    if (n) names.push(n);
  }
  if (iDasher >= 0) {
    const n = nameAfter(iDasher, iPicked > iDasher ? iPicked : dEnd);
    if (n) names.push(n);
  }

  const pairs: TimePair[] = [];
  for (let i = Math.max(iPicked, iDelivery, 0); i < dEnd; i++) {
    if (!TIME.test(lines[i])) continue;
    const q = lines[i + 1]?.match(QUOTED);
    pairs.push({ actual: lines[i], quoted: q ? q[1] : null });
  }
  const none: TimePair = { actual: null, quoted: null };
  const channelLine = lines.slice(Math.max(iDelivery, 0), dEnd).find((l) => /^(Marketplace|Storefront|Drive)$/i.test(l)) ?? null;
  const fulfillLine = lines.slice(Math.max(iDelivery, 0), dEnd).find((l) => /^(DoorDash delivery|Self[- ]delivery|Pickup|Dine[- ]in)$/i.test(l)) ?? null;

  // Order details: items and totals.
  const odEnd = iErr >= 0 ? iErr : iAssoc >= 0 ? iAssoc : lines.length;
  const iSubtotal = find((l) => l === 'Subtotal', iDetails, odEnd);
  const itemBlock = iDetails >= 0 ? lines.slice(iDetails + 1, iSubtotal >= 0 ? iSubtotal : odEnd) : [];
  const items = splitEntries(itemBlock).map(parseItem);
  const rowValue = (label: string | RegExp, from: number, to: number): number | null => {
    const i = find((l) => (typeof label === 'string' ? l === label : label.test(l)), from, to);
    return i >= 0 ? valueAfter(lines, i) : null;
  };
  const iCommission = find((l) => /^Commission/i.test(l), iDetails, odEnd);
  const commissionPct = iCommission >= 0 ? parseFloat(lines[iCommission].match(/\(([\d.]+)%\)/)?.[1] ?? 'NaN') : NaN;

  // Error charges.
  const errBlock = iErr >= 0 ? lines.slice(iErr + 1, iErrSub >= 0 ? iErrSub : iAssoc >= 0 ? iAssoc : lines.length) : [];
  const errorCharges = splitEntries(errBlock).map((e) => parseErrorEntry(e, names));
  const tailFrom = iErrSub >= 0 ? iErrSub : iErr >= 0 ? iErr : 0;

  // Associated transactions.
  const transactions: Transaction[] = [];
  if (iAssoc >= 0) {
    for (let i = iAssoc + 1; i < lines.length; i++) {
      const m = lines[i].match(/^Transaction #(\d+)\s*[-–]\s*(.+?)(?:\s+([-−–+]?\s*US?\$\s?[\d,]+(?:\.\d{1,2})?))?$/);
      if (!m) continue;
      const amount = m[3] ? parseMoney(m[3].replace(/\s+/g, '')) : valueAfter(lines, i);
      transactions.push({ id: m[1], kind: m[2], amount });
    }
  }

  const snapshot: OrderSnapshot = {
    platform: 'doordash',
    orderId,
    placedAtText,
    placedAt: placedAtText ? parsePlacedAt(placedAtText) : null,
    status,
    disputeStatus,
    notice,
    channel: channelLine,
    fulfillment: fulfillLine,
    pickedUp: pairs[0] ?? { ...none },
    droppedOff: pairs[1] ?? { ...none },
    items,
    subtotal: rowValue('Subtotal', iDetails, odEnd),
    tax: rowValue('Tax', iDetails, odEnd),
    commissionPct: Number.isNaN(commissionPct) ? null : commissionPct,
    commission: iCommission >= 0 ? valueAfter(lines, iCommission) : null,
    orderTotal: rowValue('Order total', iDetails, odEnd),
    errorCharges,
    errorChargeTotal: rowValue('Error charge total', tailFrom, lines.length),
    errorCredit: rowValue(/^Error charge credit/i, tailFrom, lines.length),
    estimatedPayout: rowValue('Estimated payout', tailFrom, lines.length),
    transactions,
  };

  return { snapshot, names: [...new Set(names.filter((n) => n.length >= 2))] };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes personal names, customer profile lines and avatar initials from page text. Names match whole words only. */
export function redactText(text: string, names: string[]): string {
  let out = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => l.length > 1 && !UI_NOISE.test(l) && !PROFILE_NOISE.test(l))
    .join('\n');
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(n)}(?![A-Za-z0-9])`, 'g'), '[PERSON]');
  }
  return out;
}
