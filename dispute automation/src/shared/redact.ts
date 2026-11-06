// Redaction that does not depend on the order parser, so it still works when DoorDash changes its layout.

/** Section labels that start a block of personal details. */
export const PERSON_LABELS = new Set(['customer', 'dasher', 'driver']);

/** Section labels that end such a block. */
export const STOP_LABELS = new Set([
  'customer',
  'dasher',
  'driver',
  'picked up',
  'dropped off',
  'pick up location',
  'pickup location',
  'channel',
  'fulfillment',
  'order details',
  'error charges',
  'associated transactions',
]);

/** "<Name> left a comment" on an error charge. */
export const COMMENTER = /^(.+) left a comment$/i;

export const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Separators are required so long transaction IDs are not mistaken for phone numbers.
export const PHONE = /(?:\+?1[-. ]?)?(?:\(\d{3}\)|\b\d{3})[-. ]\d{3}[-. ]\d{4}\b/g;

const MAX_BLOCK_LINES = 12;

/** Replaces the lines under each Customer / Dasher / Driver label, and any email or phone number. */
export function scrubText(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (COMMENTER.test(line)) {
      out.push('[PERSON] left a comment');
      continue;
    }
    out.push(line);
    if (!PERSON_LABELS.has(line.toLowerCase())) continue;
    let skipped = 0;
    while (i + 1 < lines.length && skipped < MAX_BLOCK_LINES) {
      const next = lines[i + 1].toLowerCase();
      if (next && STOP_LABELS.has(next)) break;
      i++;
      if (lines[i]) skipped++;
    }
    if (skipped) out.push('[redacted]');
  }
  return out.join('\n').replace(EMAIL, '[email]').replace(PHONE, '[phone]');
}
