import type { OrderSnapshot, RuleFacts } from './types.ts';

/** DoorDash Merchant ToS s3 / s15.1.3: issues must be raised within 14 days of the order. */
export const DISPUTE_WINDOW_DAYS = 14;

const DECIDED = /^(approved|denied|rejected|declined)$/;
const DAY_MS = 86_400_000;

export function assessRules(snapshot: OrderSnapshot, now: Date = new Date()): RuleFacts {
  let deadlineIso: string | null = null;
  let daysLeft: number | null = null;
  let expired = false;
  if (snapshot.placedAt) {
    const deadline = new Date(new Date(snapshot.placedAt).getTime() + DISPUTE_WINDOW_DAYS * DAY_MS);
    deadlineIso = deadline.toISOString();
    const remaining = deadline.getTime() - now.getTime();
    daysLeft = Math.floor(remaining / DAY_MS);
    expired = remaining < 0;
  }

  const openErrorCharges = snapshot.errorCharges.filter(
    (c) => !(c.disputeStatus && DECIDED.test(c.disputeStatus)),
  );
  const decided = snapshot.errorCharges.length > 0 && openErrorCharges.length === 0;
  const errorTotal = openErrorCharges.reduce((sum, c) => sum + Math.abs(c.amount ?? 0), 0);

  const reasons = openErrorCharges.map((c) => c.reason ?? '').join(' ');
  let faultHint: string | null = null;
  if (/missing|incorrect|wrong/i.test(reasons)) {
    faultHint =
      'Missing or incorrect items are charged to the merchant by default (Marketplace addendum s8). A dispute needs proof the item was made and handed off.';
  } else if (/late|never|not delivered|damaged|spilled|cold/i.test(reasons)) {
    faultHint =
      'Delivery-related reasons may be DoorDash\'s cost rather than the merchant\'s. Check the Dasher pick-up and drop-off times.';
  }

  return {
    deadlineIso,
    daysLeft,
    expired,
    decided,
    openErrorCharges,
    errorTotal: Math.round(errorTotal * 100) / 100,
    faultHint,
  };
}
