import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { PROMPT_VERSION, UNRESOLVED_STORE, modelConfig } from './constants.mjs';
import { HttpError, idParam, readToken, requiredString, sanitizeCapture, sanitizeConfirm, sanitizeConversationStart, sanitizeMessage } from './validation.mjs';

// Answers that come with something for the operator to file: a dispute, or a goodwill request through the same form.
const FILEABLE = new Set(['dispute', 'goodwill']);
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_CONCURRENT_RUNS = 4;
// Two captures of a long order with customer photos fit; more than that should be a new chat.
const MAX_IMAGES_PER_CONVERSATION = 24;
const DAY_MS = 86_400_000;
const VERSION = '0.8.1';
const PLATFORM_NAMES = { doordash: 'DoorDash', ubereats: 'Uber Eats', grubhub: 'Grubhub' };

const sha = (s) => createHash('sha256').update(s).digest();

/**
 * KOREFI_AGENT_TOKENS="token1:alice@korefi.ai,token2:bob@korefi.ai" gives each operator a token, and the server then
 * decides who is calling. KOREFI_AGENT_TOKEN (one shared token) still works; the client names the operator then.
 */
export function loadTokens(env) {
  const tokens = new Map();
  for (const part of (env.KOREFI_AGENT_TOKENS || '').split(',')) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf(':');
    const token = i < 0 ? s : s.slice(0, i);
    const operator = i < 0 ? null : s.slice(i + 1).trim() || null;
    if (token.length >= 32) tokens.set(token, operator);
  }
  const shared = env.KOREFI_AGENT_TOKEN;
  if (shared && shared.length >= 32 && !tokens.has(shared)) tokens.set(shared, null);
  return tokens;
}

/** A fixed-window counter per caller. Enough to stop a runaway client; not a billing control. */
export function createLimiter(max, windowMs, now = Date.now) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      hits.set(key, { start: t, count: 1 });
      return 0;
    }
    entry.count++;
    return entry.count > max ? Math.ceil((entry.start + windowMs - t) / 1000) : 0;
  };
}

/**
 * A retried request (same Idempotency-Key from the same caller) gets the first answer back instead of doing the work
 * twice. A failed first attempt is forgotten, so the retry can succeed. Entries expire and the table is bounded.
 */
export function createIdempotency({ ttlMs = 15 * 60_000, max = 500, now = Date.now } = {}) {
  const entries = new Map();
  return {
    run(key, fn) {
      const t = now();
      for (const [k, e] of entries) if (t - e.at > ttlMs) entries.delete(k);
      const seen = entries.get(key);
      if (seen) return seen.promise;
      if (entries.size >= max) entries.delete(entries.keys().next().value);
      const promise = Promise.resolve()
        .then(fn)
        .catch((err) => {
          entries.delete(key);
          throw err;
        });
      entries.set(key, { promise, at: t });
      return promise;
    },
  };
}

const reply = (code, body, headers = {}) => ({ code, body, headers });

/** The platform's decision on a dispute, as an order page shows it ("Dispute rejected"), in the outcomes table's terms. */
export function pageDecision(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'approved') return 'won';
  if (['denied', 'rejected', 'declined'].includes(s)) return 'denied';
  if (['pending', 'in review', 'submitted'].includes(s)) return 'pending';
  return null;
}


/** Database trouble the operator cannot fix is a 503 with a plain message, not a bare 500. */
function toHttpError(err) {
  if (err instanceof HttpError) return err;
  const code = err?.code;
  if (code === '57014') return new HttpError(503, 'The database is busy. Please try again in a moment.', { 'Retry-After': '5' });
  if (code === '53300' || code === '57P03' || (typeof code === 'string' && code.startsWith('08')) || ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].includes(code) || /timeout exceeded when trying to connect|Connection terminated/i.test(err?.message || '')) {
    return new HttpError(503, 'The database is not reachable right now. Please try again in a moment.', { 'Retry-After': '5' });
  }
  return null;
}

export function createApp({ store, investigate, env = process.env, log = (line) => console.log(line), now = Date.now }) {
  const TENANT = env.TENANT_ID || 'korefi-internal-poc'; // Single internal tenant. Real tenant auth is required before external rollout.
  const MODEL = modelConfig(env)?.id ?? 'unconfigured';
  const RUN_TIMEOUT_MS = Number(env.RUN_TIMEOUT_MS || 110_000);
  const IMAGE_BUDGET_BYTES = Number(env.IMAGE_BUDGET_MB || 200) * 1024 * 1024;
  const retentionDays = Number(env.IMAGE_RETENTION_DAYS || 30);
  const imageExpiry = () => new Date(now() + retentionDays * DAY_MS);

  const tokens = loadTokens(env);
  const origins = new Set((env.ALLOWED_EXTENSION_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean));
  const requestLimit = createLimiter(Number(env.RATE_REQUESTS_PER_MIN || 240), 60_000, now);
  const investigationLimit = createLimiter(Number(env.RATE_INVESTIGATIONS_PER_10MIN || 60), 600_000, now);
  const idempotency = createIdempotency({ now });
  const running = new Map(); // investigation id -> start time, in this process
  const activeConversations = new Set(); // conversations with a message being answered right now
  const startedAt = now();

  // ---- http plumbing ----

  function send(res, { code, body, headers }) {
    const base = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers };
    if (code === 204) {
      res.writeHead(204, base);
      return res.end();
    }
    if (body && body.__bytes) {
      res.writeHead(code, { ...base, 'Content-Type': body.mime, 'Content-Length': body.bytes.length, 'Cache-Control': 'private, max-age=300' });
      return res.end(body.bytes);
    }
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...base });
    res.end(JSON.stringify(body));
  }

  function auth(req) {
    if (!tokens.size) throw new HttpError(503, 'Service authentication not configured');
    const given = sha(readToken(req.headers.authorization));
    for (const [token, operator] of tokens) {
      if (timingSafeEqual(given, sha(token))) return { operator, key: sha(token).toString('hex').slice(0, 12) };
    }
    throw new HttpError(401, 'Unauthorized');
  }

  async function jsonBody(req) {
    let n = 0;
    const chunks = [];
    for await (const c of req) {
      n += c.length;
      if (n > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large');
      chunks.push(c);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'Malformed JSON');
    }
  }

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
  }

  const publicMessage = (err) => {
    const http = toHttpError(err);
    return http ? http.message : 'The investigation failed. Please try again.';
  };

  /** Best-effort audit trail in the existing case_events table. It never blocks or fails the request. */
  const audit = (caseId, actorType, actorId, type, details) => Promise.resolve(store.recordEvent?.(caseId, actorType, actorId, type, details)).catch(() => {});

  const withTimeout = (promise, ms, message) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new HttpError(504, message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };

  // ---- single investigations (the original stateless flow) ----

  async function runJob({ caseId, id, request }) {
    try {
      const result = await withTimeout(investigate({ store, tenant: TENANT, request, runId: id, env, log }), RUN_TIMEOUT_MS, 'The agent took too long. Please try again.');
      await store.completeInvestigation(id, result);
      await store.setCaseStatus(caseId, FILEABLE.has(result.recommendation) ? 'ready_to_dispute' : 'captured');
    } catch (err) {
      log(JSON.stringify({ level: 'error', event: 'investigation_failed', investigation: String(id), message: String(err?.message || err).slice(0, 300) }));
      await store.failInvestigation(id, publicMessage(err)).catch(() => {});
      await store.setCaseStatus(caseId, 'captured').catch(() => {});
    } finally {
      running.delete(id);
    }
  }

  async function startInvestigation(req, who) {
    if (!modelConfig(env)) throw new HttpError(503, 'AI provider not configured');
    const body = await jsonBody(req);
    const request = sanitizeCapture(body);
    const operator = who.operator || requiredString(body.operator_id, 'operator_id', 128);
    const wait = investigationLimit(who.key);
    if (wait) throw new HttpError(429, 'Too many investigations. Try again in a few minutes.', { 'Retry-After': String(wait) });
    if (running.size >= MAX_CONCURRENT_RUNS) throw new HttpError(429, 'The agent is busy with other investigations. Try again in a minute.', { 'Retry-After': '30' });

    // A store that cannot be identified is not an error. The agent works from the capture without history.
    request.storeId = request.storeId || (await store.resolveStore(request.orderId).catch(() => null)) || UNRESOLVED_STORE;
    const c = await store.upsertCase(TENANT, operator, request);
    const id = await store.createInvestigation(c.id, MODEL, null, PROMPT_VERSION);
    await store.setCaseStatus(c.id, 'investigating');
    running.set(id, now());
    void runJob({ caseId: c.id, id, request });
    return reply(202, { investigation_id: id, case_id: c.id, store_id: request.storeId, order_id: request.orderId, status: 'running', poll_after_ms: 1500 });
  }

  async function readInvestigation(id) {
    let row = await store.getInvestigation(TENANT, id);
    if (!row) throw new HttpError(404, 'Investigation not found');
    // A run that is marked running but is not running in this process died with a restart. Say so instead of polling forever.
    // But the row may simply be stale: a run saves its result and only then leaves `running`, so a run that has just
    // finished is not in `running` while the row we read a moment ago still says running. Read it again before deciding.
    if (row.status === 'running' && !running.has(row.id)) {
      row = (await store.getInvestigation(TENANT, id)) || row;
    }
    let status = row.status;
    let error = row.error_summary;
    if (status === 'running' && !running.has(row.id)) {
      error = 'The server restarted while this was running. Please send it again.';
      await store.failInvestigation(row.id, error).catch(() => {});
      status = 'failed';
    }
    const base = { investigation_id: row.id, status, case_id: row.case_id, store_id: row.platform_store_id, order_id: row.platform_order_id };
    if (status === 'running') return reply(200, { ...base, poll_after_ms: 1500 });
    if (status === 'failed') return reply(200, { ...base, error: error || 'The investigation failed. Please try again.' });
    // A chat message keeps its full answer (including suggested follow-ups) with the message itself.
    const message = row.conversation_id ? await store.getMessageForInvestigation(row.id) : null;
    const r = message?.result || {};
    return reply(200, {
      ...base,
      ...(row.conversation_id ? { conversation_id: String(row.conversation_id), message_id: message ? String(message.id) : null } : {}),
      recommendation: r.recommendation ?? row.recommendation,
      reasoning_summary: r.reasoning_summary ?? row.reasoning_summary,
      missing_evidence: r.missing_evidence ?? (Array.isArray(row.missing_evidence) ? row.missing_evidence : []),
      draft_text: r.draft_text ?? (row.draft_text || ''),
      risk_notes: r.risk_notes ?? row.risk_notes,
      suggested_followups: r.suggested_followups ?? [],
      model: row.model_id,
      tools_used: r.tools_used ?? (row.tools || []).map((t) => ({ name: t.name, count: t.count })),
    });
  }

  // ---- conversations: a chat the server owns, resumed by the agent on every message ----

  const DEFAULT_FOLLOWUPS = ['What evidence is missing?', 'Can you tighten the draft?', 'Find similar disputes'];
  function suggestedFollowups(result) {
    const given = (result.suggested_followups || []).filter(Boolean);
    if (given.length) return given.slice(0, 4);
    if (result.recommendation === 'goodwill') return ['Why goodwill, not a dispute?', 'What would let us dispute?', 'Can you tighten the draft?'];
    return result.recommendation === 'do_not_dispute' ? ['Why not dispute this?', 'What would change your mind?'] : DEFAULT_FOLLOWUPS;
  }

  function decodeImages(list) {
    return list.map((d) => {
      const m = d.match(/^data:(image\/(?:jpeg|png));base64,(.+)$/);
      return { mime: m[1], bytes: Buffer.from(m[2], 'base64') };
    });
  }

  /**
   * Stores evidence images inside the storage budget (the database has a hard size limit that would stop every write
   * if it were reached). Over budget, it sweeps expired images first; if still over, the images are skipped and the
   * caller is told, so the chat carries on from text instead of failing.
   */
  async function storeImages(conv, dataUrls) {
    if (!dataUrls.length) return { stored: 0, dropped: 0 };
    const decoded = decodeImages(dataUrls);
    const incoming = decoded.reduce((n, d) => n + d.bytes.length, 0);
    let used = await store.imageBytesUsed();
    if (used + incoming > IMAGE_BUDGET_BYTES) {
      await store.purgeExpiredImages().catch(() => {});
      used = await store.imageBytesUsed();
    }
    if (used + incoming > IMAGE_BUDGET_BYTES) {
      log(JSON.stringify({ level: 'warn', event: 'image_budget_full', usedBytes: used, incomingBytes: incoming }));
      return { stored: 0, dropped: decoded.length };
    }
    await store.saveImages(conv.id, conv.case_id, decoded, imageExpiry());
    return { stored: decoded.length, dropped: 0 };
  }

  const publicConversation = (c) => ({
    id: String(c.id),
    case_id: String(c.case_id),
    platform: c.platform || 'doordash',
    order_id: c.platform_order_id,
    store_id: c.platform_store_id,
    title: c.title,
    status: c.status,
    created_by: c.created_by,
    last_recommendation: c.last_recommendation,
    case_status: c.case_status ?? null,
    error_amount: c.error_amount != null ? Number(c.error_amount) : null,
    created_at: c.created_at,
    updated_at: c.updated_at,
  });

  // Chats need their tables. If the first check failed, look again (at most every 30 seconds) and say so plainly.
  async function requireChats() {
    if (store.conversationsReady?.() === true) return;
    const state = await store.ensureConversations?.();
    if (state && !state.ready) {
      throw new HttpError(503, 'Chats are not available right now. The database setup for chats is incomplete. Your other work is not affected.', { 'Retry-After': '30' });
    }
  }

  async function startConversation(req, who) {
    await requireChats();
    const body = await jsonBody(req);
    const p = sanitizeConversationStart(body);
    const operator = who.operator || requiredString(body.operator_id, 'operator_id', 128);
    if (p.screenshots.length > MAX_IMAGES_PER_CONVERSATION) throw new HttpError(422, 'Too many images');
    p.storeId = p.storeId || (await store.resolveStore(p.orderId, p.platform).catch(() => null)) || UNRESOLVED_STORE;
    // The dispute status this order showed the last time it was captured, before this capture replaces it.
    const before = await Promise.resolve(store.findCase(TENANT, p.orderId, [p.storeId], p.platform)).catch(() => null);
    const seen = before ? (await Promise.resolve(store.getCaseFacts(before.id)).catch(() => null))?.structured_facts?.disputeStatus : null;
    const c = await store.upsertCase(TENANT, operator, p);
    // An order reopened after its dispute was decided: save the result on the KoreFi filing, so later cases at this store
    // learn from it. Only a change counts: a page that already said "rejected" when the dispute was filed is an older decision.
    const decision = pageDecision(p.facts?.disputeStatus);
    if (decision && decision !== pageDecision(seen)) {
      const saved = await Promise.resolve(store.recordOutcome?.(c.id, decision)).catch(() => null);
      if (saved?.changed) log(JSON.stringify({ level: 'info', event: 'dispute_outcome_recorded', case: String(c.id), order: p.orderId, result: decision, previous: saved.previous }));
    }
    const id = await store.createConversation(TENANT, c.id, operator, p.title || `Order ${p.orderId}`);
    const images = await storeImages({ id, case_id: c.id }, p.screenshots);
    void audit(c.id, 'operator', operator, 'conversation_opened', { conversation_id: String(id), images: images.stored });
    return reply(201, {
      conversation_id: String(id),
      case_id: String(c.id),
      store_id: p.storeId,
      order_id: p.orderId,
      images: images.stored,
      images_dropped: images.dropped,
    });
  }

  async function listConversations(url) {
    await requireChats();
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const rows = await store.listConversations(TENANT, limit);
    return reply(200, { conversations: rows.map(publicConversation) });
  }

  async function readConversation(id) {
    await requireChats();
    const conv = await store.getConversation(TENANT, id);
    if (!conv) throw new HttpError(404, 'Conversation not found');
    const [messages, images] = await Promise.all([store.listMessages(conv.id), store.listImages(conv.id)]);
    return reply(200, {
      conversation: publicConversation(conv),
      running: activeConversations.has(String(conv.id)),
      messages: messages.map((m) => ({
        id: String(m.id),
        role: m.role,
        text: m.text,
        result: m.result || null,
        investigation_id: m.investigation_id != null ? String(m.investigation_id) : null,
        created_at: m.created_at,
      })),
      images: images.map((i) => ({ id: String(i.id), mime: i.mime, created_at: i.created_at })),
    });
  }

  async function readImage(convId, imageId) {
    await requireChats();
    const conv = await store.getConversation(TENANT, convId);
    if (!conv) throw new HttpError(404, 'Conversation not found');
    const image = await store.getImage(conv.id, imageId);
    if (!image) throw new HttpError(404, 'Image not found or expired');
    return reply(200, { __bytes: true, mime: image.mime, bytes: Buffer.from(image.bytes) });
  }

  async function runConversationJob({ conv, id, message, operator }) {
    try {
      const transcript = await store.loadTranscript(conv.id);
      const stored = await store.loadImages(conv.id);
      const images = stored.map((r) => ({ type: 'image', data: Buffer.from(r.bytes).toString('base64'), mimeType: r.mime }));
      const facts = await store.getCaseFacts(conv.case_id);
      const request = {
        platform: facts?.platform || conv.platform || 'doordash',
        storeId: conv.platform_store_id,
        orderId: conv.platform_order_id,
        orderUrl: facts?.order_url ?? null,
        issueCategory: facts?.issue_category ?? null,
        issueDescription: facts?.issue_description ?? null,
        amount: facts?.error_amount != null ? Number(facts.error_amount) : null,
        facts: facts?.structured_facts ?? {},
        redactedText: facts?.redacted_page_text ?? null,
        operatorQuestion: message.text,
        previousDraft: message.previousDraft,
        additionalText: message.additionalText,
        screenshots: [],
        conversation: [],
      };
      const { transcript: next, ...result } = await withTimeout(
        investigate({ store, tenant: TENANT, request, runId: id, env, transcript, images, log }),
        RUN_TIMEOUT_MS,
        'The agent took too long. Please try again.',
      );
      const payload = { ...result, suggested_followups: suggestedFollowups(result) };
      // Order matters: the answer and the transcript are saved before the run is marked completed, so a poll never sees a finished run without its message.
      await store.appendMessage(conv.id, 'assistant', result.reasoning_summary, payload, id);
      if (next) await store.saveTranscript(conv.id, next);
      await store.touchConversation(conv.id, { lastRecommendation: result.recommendation });
      await store.completeInvestigation(id, result);
      await store.setCaseStatus(conv.case_id, FILEABLE.has(result.recommendation) ? 'ready_to_dispute' : 'captured');
      void audit(conv.case_id, 'agent', result.model || MODEL, 'agent_answered', { conversation_id: String(conv.id), investigation_id: String(id), recommendation: result.recommendation });
    } catch (err) {
      log(JSON.stringify({ level: 'error', event: 'conversation_run_failed', investigation: String(id), conversation: String(conv.id), message: String(err?.message || err).slice(0, 300) }));
      const why = publicMessage(err);
      await store.appendMessage(conv.id, 'system', `The agent could not answer this message: ${why}`, null, id).catch(() => {});
      await store.failInvestigation(id, why).catch(() => {});
      await store.setCaseStatus(conv.case_id, 'captured').catch(() => {});
    } finally {
      running.delete(id);
      activeConversations.delete(String(conv.id));
    }
  }

  async function postMessage(req, who, convId) {
    await requireChats();
    if (!modelConfig(env)) throw new HttpError(503, 'AI provider not configured');
    const body = await jsonBody(req);
    const message = sanitizeMessage(body);
    const conv = await store.getConversation(TENANT, convId);
    if (!conv) throw new HttpError(404, 'Conversation not found');
    const operator = who.operator || (typeof body.operator_id === 'string' && body.operator_id.trim() ? body.operator_id.trim().slice(0, 128) : 'unknown');
    const key = String(conv.id);
    // Claim the chat before any await, so two quick sends cannot both start a run.
    if (activeConversations.has(key)) throw new HttpError(409, 'The agent is still answering your last message in this chat.');
    activeConversations.add(key);
    try {
      const wait = investigationLimit(who.key);
      if (wait) throw new HttpError(429, 'Too many investigations. Try again in a few minutes.', { 'Retry-After': String(wait) });
      if (running.size >= MAX_CONCURRENT_RUNS) throw new HttpError(429, 'The agent is busy with other investigations. Try again in a minute.', { 'Retry-After': '30' });
      let images = { stored: 0, dropped: 0 };
      if (message.screenshots.length) {
        if ((await store.countImages(conv.id)) + message.screenshots.length > MAX_IMAGES_PER_CONVERSATION) {
          throw new HttpError(422, `A chat can hold at most ${MAX_IMAGES_PER_CONVERSATION} images. Start a new chat for more.`);
        }
        images = await storeImages(conv, message.screenshots);
        if (images.stored) void audit(conv.case_id, 'operator', operator, 'evidence_added', { conversation_id: String(conv.id), images: images.stored });
      }
      const first = (await store.listMessages(conv.id, 1)).length === 0;
      await store.appendMessage(conv.id, 'user', message.text);
      if (first) await store.touchConversation(conv.id, { title: `${conv.platform_order_id} · ${message.text}`.slice(0, 100) });
      const id = await store.createInvestigation(conv.case_id, MODEL, conv.id, PROMPT_VERSION);
      await store.setCaseStatus(conv.case_id, 'investigating');
      running.set(id, now());
      void runConversationJob({ conv, id, message, operator });
      return reply(202, { investigation_id: id, conversation_id: key, status: 'running', poll_after_ms: 1500, images_dropped: images.dropped });
    } catch (err) {
      activeConversations.delete(key);
      throw err;
    }
  }

  async function confirmDispute(req, who) {
    const body = await jsonBody(req);
    const p = sanitizeConfirm(body);
    const operator = who.operator || requiredString(body.operator_id, 'operator_id', 128);
    if (p.conversationId) await requireChats();
    const conv = p.conversationId ? await store.getConversation(TENANT, p.conversationId) : null;
    if (p.conversationId && !conv) throw new HttpError(404, 'Conversation not found');
    const resolved = p.storeId || (await store.resolveStore(p.orderId, p.platform).catch(() => null));
    const candidates = [...new Set([p.storeId, resolved, UNRESOLVED_STORE].filter(Boolean))];
    // A chat knows its own case. Otherwise find it by order, and if the agent never saw the order, log the filing anyway.
    const c =
      (conv && { id: conv.case_id, platform_store_id: conv.platform_store_id }) ||
      (await store.findCase(TENANT, p.orderId, candidates, p.platform)) ||
      (await store.upsertCase(TENANT, operator, {
        platform: p.platform,
        storeId: resolved || UNRESOLVED_STORE,
        orderId: p.orderId,
        orderUrl: p.orderUrl,
        issueCategory: p.issueCategory,
        issueDescription: null,
        amount: p.amount,
        captureStatus: 'data_only',
        facts: {},
        redactedText: null,
      }));
    const on = conv?.platform || p.platform;
    const key = `${on}:${c.platform_store_id}:${p.orderId}`;
    const r = await store.recordSubmission(TENANT, c.id, key, operator, p.disputeText, p.submittedAt);
    if (conv && !r.already_recorded) {
      await store.appendMessage(conv.id, 'system', `Marked as disputed by ${operator}. The dispute was filed in ${PLATFORM_NAMES[on] || 'the platform'} by the operator.`).catch(() => {});
      await store.touchConversation(conv.id, { status: 'disputed' }).catch(() => {});
    }
    return reply(200, { ...r, case_id: c.id, store_id: c.platform_store_id });
  }

  // ---- routing ----

  /** Returns the reply for a request that has passed authentication and rate limiting. */
  async function route(req, who, url) {
    const path = url.pathname;
    const idem = req.headers['idempotency-key'];
    const once = (fn) => {
      if (idem === undefined) return fn();
      if (typeof idem !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(idem)) throw new HttpError(422, 'Invalid Idempotency-Key');
      return idempotency.run(`${who.key}:${req.method}:${path}:${idem}`, fn);
    };

    if (req.method === 'GET' && path === '/readyz') {
      const ok = await store.ready();
      const chats = store.conversationsReady ? ((await store.ensureConversations?.())?.ready ? 'ready' : 'missing') : 'ready';
      return reply(200, { ok, db: ok ? 'connected' : 'unavailable', conversations: chats, model_configured: !!modelConfig(env), model: MODEL, store_restrictions: 'derived_from_order' });
    }
    if (req.method === 'POST' && path === '/v1/investigations') return once(() => startInvestigation(req, who));
    const poll = path.match(/^\/v1\/investigations\/([A-Za-z0-9_-]{1,64})$/);
    if (req.method === 'GET' && poll) return readInvestigation(poll[1]);
    if (req.method === 'POST' && path === '/v1/conversations') return once(() => startConversation(req, who));
    if (req.method === 'GET' && path === '/v1/conversations') return listConversations(url);
    const conv = path.match(/^\/v1\/conversations\/([A-Za-z0-9_-]{1,64})(?:\/(messages)|\/images\/([A-Za-z0-9_-]{1,64}))?$/);
    if (conv) {
      const [, convId, messages, imageId] = conv;
      idParam(convId, 'conversation id');
      if (req.method === 'GET' && !messages && !imageId) return readConversation(convId);
      if (req.method === 'POST' && messages) return once(() => postMessage(req, who, convId));
      if (req.method === 'GET' && imageId) return readImage(convId, imageId);
    }
    if (req.method === 'POST' && path === '/v1/disputes/confirm') return confirmDispute(req, who);
    throw new HttpError(404, 'Not found');
  }

  async function handle(req, res) {
    cors(req, res);
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return send(res, reply(200, { ok: true, service: 'korefi-pi-dispute-agent', version: VERSION, model: MODEL, commit: (env.RENDER_GIT_COMMIT || '').slice(0, 7) || null, uptime_s: Math.round((now() - startedAt) / 1000) }));
    }
    if (req.method === 'OPTIONS') return send(res, reply(204));
    const who = auth(req);
    res.who = who.operator || who.key;
    const wait = requestLimit(who.key);
    if (wait) throw new HttpError(429, 'Too many requests. Slow down.', { 'Retry-After': String(wait) });
    send(res, await route(req, who, url));
    // A replayed request never read its body; let the connection move on.
    req.resume();
  }

  function handler(req, res) {
    const rid = randomUUID().slice(0, 8);
    const started = now();
    res.setHeader('X-Request-Id', rid);
    res.on('finish', () => {
      // Method, path, status, timing and who. Never bodies, tokens or images.
      log(JSON.stringify({ level: 'info', rid, method: req.method, path: (req.url || '').split('?')[0], status: res.statusCode, ms: now() - started, who: res.who || null }));
    });
    handle(req, res).catch((e) => {
      const http = toHttpError(e);
      if (!http) log(JSON.stringify({ level: 'error', rid, message: String(e?.message || e).slice(0, 300), code: e?.code || null }));
      // A request body that was never read would hold the connection open.
      req.resume();
      if (!res.headersSent) send(res, reply(http ? http.status : 500, { error: http ? http.message : 'Request failed; consult server logs', request_id: rid }, http ? http.headers : {}));
    });
  }

  /** Resolves when no agent run is in flight, or after `ms`, so a deploy does not cut an answer off mid-way. */
  async function drain(ms = 25_000) {
    const end = now() + ms;
    while (running.size > 0 && now() < end) await new Promise((r) => setTimeout(r, 200));
    return running.size === 0;
  }

  return { handler, running, drain };
}

/** Deletes expired evidence images now and every few hours. A missing table is just logged. */
export function startMaintenance({ store, log = (line) => console.log(line), everyMs = 6 * 3_600_000 }) {
  const sweep = async () => {
    try {
      const n = await store.purgeExpiredImages();
      if (n) log(JSON.stringify({ level: 'info', event: 'images_purged', count: n }));
    } catch (err) {
      log(JSON.stringify({ level: 'warn', event: 'image_purge_skipped', message: String(err?.message || err).slice(0, 200) }));
    }
  };
  void sweep();
  const timer = setInterval(sweep, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
