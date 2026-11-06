export interface TimePair {
  actual: string | null;
  quoted: string | null;
}

export interface ItemLine {
  qty: number;
  name: string;
  options: string[];
  price: number | null;
}

export interface ErrorCharge {
  item: string;
  options: string[];
  reason: string | null;
  disputeStatus: string | null;
  amount: number | null;
  customerComment: string | null;
}

export interface Transaction {
  id: string;
  kind: string;
  amount: number | null;
}

/** What the content script reads off a DoorDash order page. Contains no customer or Dasher names. */
export interface OrderSnapshot {
  orderId: string;
  placedAtText: string | null;
  /** Local time, YYYY-MM-DDTHH:mm */
  placedAt: string | null;
  status: string | null;
  disputeStatus: string | null;
  notice: string | null;
  channel: string | null;
  fulfillment: string | null;
  pickedUp: TimePair;
  droppedOff: TimePair;
  items: ItemLine[];
  subtotal: number | null;
  tax: number | null;
  commissionPct: number | null;
  commission: number | null;
  orderTotal: number | null;
  errorCharges: ErrorCharge[];
  errorChargeTotal: number | null;
  errorCredit: number | null;
  estimatedPayout: number | null;
  transactions: Transaction[];
}

export interface ParsedOrder {
  snapshot: OrderSnapshot;
  /** Personal names found on the page. Used only to redact; never leave the content script. */
  names: string[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  innerWidth: number;
  innerHeight: number;
}

/** One scroll position of the order sheet, measured in the page. */
export interface FramePayload {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** The visible area of the sheet within the viewport (CSS px). */
  region: Rect;
  /** Regions (viewport CSS px) covering personal details at this scroll position. Null when they could not be located. */
  rects: Rect[] | null;
  viewport: Viewport;
}

/** What the page reader found on an order sheet the parser understands. Contains no customer or Dasher names. */
export interface PagePayload {
  url: string;
  snapshot: OrderSnapshot;
  redactedText: string;
}

/** What the page reader can say about any DoorDash page, even one the parser does not understand. */
export interface CaptureContext {
  orderId: string | null;
  storeId: string | null;
  title: string;
  url: string;
  /** Page text with personal details removed. */
  safeText: string;
}

export interface RuleFacts {
  deadlineIso: string | null;
  daysLeft: number | null;
  expired: boolean;
  decided: boolean;
  openErrorCharges: ErrorCharge[];
  errorTotal: number;
  faultHint: string | null;
}

export type CaseStatus = 'new' | 'filed' | 'skipped' | 'won' | 'lost';

export interface CaseRecord {
  id: string;
  orderId: string;
  /** DoorDash store ID when the page revealed it. Investigations work without it. */
  storeId: string | null;
  createdAt: string;
  trigger: 'manual';
  url: string;
  snapshot: OrderSnapshot;
  redactedText: string;
  /** Redacted JPEG data URL. Absent when personal details could not be hidden, in which case no screenshot is taken. */
  image: string | null;
  imageNote: string | null;
  facts: RuleFacts;
  assessment: unknown | null;
  status: CaseStatus;
}

export type RuntimeMessage =
  | { type: 'CAPTURE_NOW'; tabId: number }
  | { type: 'CASE_CAPTURED'; caseId: string }
  | { type: 'CAPTURE_FAILED'; reason: string }
  | { type: 'GET_PAYLOAD' }
  | { type: 'GET_CAPTURE_CONTEXT' }
  | { type: 'SCROLL_FRAME'; top: number | null };
