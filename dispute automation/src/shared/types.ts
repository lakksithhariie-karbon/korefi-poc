import type { Platform } from './platform.ts';

export type { Platform };

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

export interface TimelineEvent {
  time: string;
  event: string;
}

/** What the content script reads off an order page. Contains no customer, Dasher or courier names. */
export interface OrderSnapshot {
  /** Absent on captures made before platforms were added, which were all DoorDash. */
  platform?: Platform;
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
  /** Uber Eats shows the order's progress as timed steps. */
  timeline?: TimelineEvent[];
  /** The restaurant name and address line, when the page shows it. */
  shop?: string | null;
}

export interface ParsedOrder {
  snapshot: OrderSnapshot;
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
  viewport: Viewport;
}

/** What the page reader found on an order sheet the parser understands. */
export interface PagePayload {
  platform: Platform;
  url: string;
  snapshot: OrderSnapshot;
  /** The page text as shown (the name is kept from when it was redacted). */
  redactedText: string;
}

/** What the page reader can say about any order page, even one the parser does not understand. */
export interface CaptureContext {
  platform: Platform;
  orderId: string | null;
  storeId: string | null;
  title: string;
  url: string;
  /** The page text as shown. */
  safeText: string;
  /** How many customer-uploaded photos are on the order right now. */
  photoCount: number;
  /** Something the operator can do on the page for a better capture, such as expanding collapsed feedback. */
  hint: string | null;
}

/** One customer photo, scrolled into view and measured, ready to be cropped from a screenshot. */
export interface PhotoFrame {
  /** The photo's visible area (viewport CSS px). */
  rect: Rect;
  viewport: Viewport;
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
  platform: Platform;
  orderId: string;
  /** Store ID when the page revealed it. Investigations work without it. */
  storeId: string | null;
  createdAt: string;
  trigger: 'manual';
  url: string;
  snapshot: OrderSnapshot;
  /** The page text as shown (the name is kept from when it was redacted). */
  redactedText: string;
  /** The order page screenshot as shown, as a JPEG data URL. Null when it could not be taken. */
  image: string | null;
  imageNote: string | null;
  /** Photos the customer uploaded with their complaint, as JPEG data URLs at full size. */
  photos: string[];
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
  | { type: 'SCROLL_FRAME'; top: number | null }
  | { type: 'PHOTO_FRAME'; index: number; scroll: boolean };
