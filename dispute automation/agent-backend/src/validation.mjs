export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function requiredString(v, name, max = 256) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new HttpError(422, name + ' must be a non-empty string (max ' + max + ')');
  return v.trim();
}

export function optionalString(v, max = 4000) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw new HttpError(422, 'Invalid text field');
  return v.trim() || null;
}

export function money(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1000000) throw new HttpError(422, 'Invalid dispute amount');
  return Math.round(n * 100) / 100;
}

export function parseIso(v, name) {
  const s = requiredString(v, name, 40);
  if (!Number.isFinite(new Date(s).getTime()) || !/Z$|[+-]\d\d:\d\d$/.test(s)) throw new HttpError(422, 'Invalid ' + name);
  return new Date(s).toISOString();
}

/** Order IDs are a short code. Placeholders such as SCREENSHOT-AB12 are allowed when the page could not be parsed. */
export function orderId(v) {
  const s = requiredString(v, 'order_id', 64);
  if (!/^[A-Za-z0-9._:-]{3,64}$/.test(s)) throw new HttpError(422, 'Invalid order_id');
  return s;
}

/** A DoorDash store ID is optional. A missing one is normal (a first dispute for a store has no history). */
export function validateStore(storeId) {
  if (storeId !== null && storeId !== undefined && !/^[0-9]{3,32}$/.test(storeId)) throw new HttpError(422, 'Invalid DoorDash store ID');
  return storeId || null;
}

function orderUrl(v) {
  const url = optionalString(v, 2000);
  if (url && !/^https:\/\/(?:[a-z0-9-]+\.)*doordash\.com(?:\/|$)/i.test(url)) throw new HttpError(422, 'Invalid DoorDash URL');
  return url;
}

const IMAGE = /^data:image\/(png|jpeg);base64,[a-zA-Z0-9+/=]+$/;
const MAX_IMAGE_CHARS = 4500000;
const MAX_TOTAL_IMAGE_CHARS = 12000000;
const MAX_IMAGES = 6;

function screenshots(x) {
  const list = [];
  if (x.screenshot !== undefined && x.screenshot !== null) list.push(x.screenshot);
  if (x.screenshots !== undefined && x.screenshots !== null) {
    if (!Array.isArray(x.screenshots)) throw new HttpError(422, 'Invalid screenshots');
    list.push(...x.screenshots);
  }
  if (list.length > MAX_IMAGES) throw new HttpError(422, 'At most ' + MAX_IMAGES + ' screenshot images are accepted');
  let total = 0;
  for (const s of list) {
    if (typeof s !== 'string' || s.length > MAX_IMAGE_CHARS || !IMAGE.test(s)) throw new HttpError(422, 'Invalid screenshot');
    total += s.length;
  }
  if (total > MAX_TOTAL_IMAGE_CHARS) throw new HttpError(422, 'Screenshots are too large');
  return list;
}

function conversation(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 40) throw new HttpError(422, 'Invalid conversation');
  return v.slice(-12).map((m) => {
    if (!m || typeof m !== 'object' || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string') {
      throw new HttpError(422, 'Invalid conversation');
    }
    return { role: m.role, text: m.text.slice(0, 2500) };
  });
}

export function sanitizeCapture(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new HttpError(422, 'Expected object');
  if (x.platform !== undefined && x.platform !== 'doordash') throw new HttpError(422, 'DoorDash only');
  const storeId = validateStore(optionalString(x.store_id, 128));
  const facts = x.structured_facts ?? {};
  if (typeof facts !== 'object' || facts === null || Array.isArray(facts) || JSON.stringify(facts).length > 12000) {
    throw new HttpError(422, 'Invalid structured_facts');
  }
  return {
    storeId,
    orderId: orderId(x.order_id),
    orderUrl: orderUrl(x.order_url),
    issueCategory: optionalString(x.issue_category, 256),
    issueDescription: optionalString(x.issue_description, 4000),
    operatorQuestion: optionalString(x.operator_question, 1200),
    amount: money(x.dispute_amount),
    facts,
    redactedText: optionalString(x.redacted_page_text, 12000),
    screenshots: screenshots(x),
    conversation: conversation(x.conversation),
    previousDraft: optionalString(x.previous_draft, 6000),
    captureStatus: x.capture_status === 'complete' ? 'complete' : x.capture_status === 'partial' ? 'partial' : 'data_only',
  };
}

/** A database id as it appears in a URL or body. */
export function idParam(v, name = 'id') {
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new HttpError(422, 'Invalid ' + name);
  return s;
}

/** Starts a chat about an order. The same facts a first investigation carries, but no question yet. */
export function sanitizeConversationStart(x) {
  const c = sanitizeCapture({ ...(x && typeof x === 'object' ? x : {}), operator_question: null, conversation: null, previous_draft: null });
  const title = optionalString(x.title, 120);
  return { ...c, title };
}

/** One message in a chat. It may bring new evidence: extra images, or the text of a fresh capture. */
export function sanitizeMessage(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new HttpError(422, 'Expected object');
  return {
    text: requiredString(x.text, 'text', 1200),
    screenshots: screenshots(x),
    additionalText: optionalString(x.additional_text, 12000),
    previousDraft: optionalString(x.previous_draft, 6000),
  };
}

export function sanitizeConfirm(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new HttpError(422, 'Expected object');
  return {
    conversationId: x.conversation_id === undefined || x.conversation_id === null ? null : idParam(x.conversation_id, 'conversation_id'),
    storeId: validateStore(optionalString(x.store_id, 128)),
    orderId: orderId(x.order_id),
    disputeText: requiredString(x.dispute_text, 'dispute_text', 6000),
    submittedAt: parseIso(x.disputed_at, 'disputed_at'),
    amount: money(x.dispute_amount),
    orderUrl: orderUrl(x.order_url),
    issueCategory: optionalString(x.issue_category, 256),
  };
}

const RECOMMENDATIONS = ['dispute', 'needs_review', 'do_not_dispute'];

/**
 * Reads the agent's reply. Anything usable is kept: a model that answers in plain text during a follow-up
 * should still reach the operator, not fail the whole request.
 */
export function parseAgentOutput(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('The agent returned an empty answer');
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let x = null;
  for (const candidate of [clean, clean.slice(clean.indexOf('{'), clean.lastIndexOf('}') + 1)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        x = parsed;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  if (!x || typeof x.reasoning_summary !== 'string') {
    return {
      recommendation: 'needs_review',
      reasoning_summary: raw.slice(0, 5000),
      draft_text: '',
      missing_evidence: [],
      suggested_followups: [],
      risk_notes: 'The agent did not return a structured assessment. Read the answer and verify it.',
    };
  }
  return {
    recommendation: RECOMMENDATIONS.includes(x.recommendation) ? x.recommendation : 'needs_review',
    reasoning_summary: x.reasoning_summary.slice(0, 5000),
    draft_text: typeof x.draft_text === 'string' ? x.draft_text.slice(0, 6000) : '',
    missing_evidence: Array.isArray(x.missing_evidence) ? x.missing_evidence.filter((y) => typeof y === 'string').slice(0, 15) : [],
    suggested_followups: Array.isArray(x.suggested_followups)
      ? x.suggested_followups.filter((y) => typeof y === 'string' && y.trim()).map((y) => y.trim().slice(0, 90)).slice(0, 4)
      : [],
    risk_notes: typeof x.risk_notes === 'string' ? x.risk_notes.slice(0, 2000) : null,
  };
}

export function readToken(s) {
  return typeof s === 'string' && s.startsWith('Bearer ') ? s.slice(7) : '';
}
