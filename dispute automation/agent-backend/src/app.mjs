import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { UNRESOLVED_STORE } from './constants.mjs';
import { HttpError, idParam, readToken, requiredString, sanitizeCapture, sanitizeConfirm, sanitizeConversationStart, sanitizeMessage } from './validation.mjs';

const TENANT = 'korefi-internal-poc'; // Single internal tenant. Real tenant auth is required before rollout.
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_CONCURRENT_RUNS = 4;
const MAX_IMAGES_PER_CONVERSATION = 12;
const DAY_MS = 86_400_000;

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

export function createApp({ store, investigate, env = process.env, log = (line) => console.log(line), now = Date.now }) {
  const tokens = loadTokens(env);
  const origins = new Set((env.ALLOWED_EXTENSION_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean));
  const requestLimit = createLimiter(Number(env.RATE_REQUESTS_PER_MIN || 240), 60_000, now);
  const investigationLimit = createLimiter(Number(env.RATE_INVESTIGATIONS_PER_10MIN || 60), 600_000, now);
  const running = new Map(); // investigation id -> start time, in this process
  const activeConversations = new Set(); // conversations with a message being answered right now
  const retentionDays = Number(env.IMAGE_RETENTION_DAYS || 30);
  const imageExpiry = () => new Date(now() + retentionDays * DAY_MS);

  function respond(res, code, data, headers = {}) {
    const base = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers };
    if (code === 204) {
      res.writeHead(204, base);
      return res.end();
    }
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...base });
    res.end(JSON.stringify(data));
  }

  function sendBytes(res, mime, bytes) {
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    res.end(bytes);
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

  const publicMessage = (err) => (err instanceof HttpError ? err.message : 'The investigation failed. Please try again.');

  async function runJob({ caseId, id, request }) {
    try {
      const result = await investigate({ store, tenant: TENANT, request, runId: id, env });
      await store.completeInvestigation(id, result);
      await store.setCaseStatus(caseId, result.recommendation === 'dispute' ? 'ready_to_dispute' : 'captured');
    } catch (err) {
      log(JSON.stringify({ level: 'error', event: 'investigation_failed', investigation: String(id), message: String(err?.message || err).slice(0, 300) }));
      await store.failInvestigation(id, publicMessage(err)).catch(() => {});
      await store.setCaseStatus(caseId, 'captured').catch(() => {});
    } finally {
      running.delete(id);
    }
  }

  async function startInvestigation(req, res, who) {
    if (!env.OPENAI_API_KEY) throw new HttpError(503, 'AI provider not configured');
    const body = await jsonBody(req);
    const request = sanitizeCapture(body);
    const operator = who.operator || requiredString(body.operator_id, 'operator_id', 128);
    const wait = investigationLimit(who.key);
    if (wait) throw new HttpError(429, 'Too many investigations. Try again in a few minutes.', { 'Retry-After': String(wait) });
    if (running.size >= MAX_CONCURRENT_RUNS) throw new HttpError(429, 'The agent is busy with other investigations. Try again in a minute.', { 'Retry-After': '30' });

    // A store that cannot be identified is not an error. The agent works from the capture without history.
    request.storeId = request.storeId || (await store.resolveStore(request.orderId).catch(() => null)) || UNRESOLVED_STORE;
    const c = await store.upsertCase(TENANT, operator, request);
    const id = await store.createInvestigation(c.id, env.OPENAI_MODEL || 'gpt-4.1-mini');
    await store.setCaseStatus(c.id, 'investigating');
    running.set(id, now());
    void runJob({ caseId: c.id, id, request });
    return respond(res, 202, {
      investigation_id: id,
      case_id: c.id,
      store_id: request.storeId,
      order_id: request.orderId,
      status: 'running',
      poll_after_ms: 1500,
    });
  }

  async function readInvestigation(res, id) {
    const row = await store.getInvestigation(TENANT, id);
    if (!row) throw new HttpError(404, 'Investigation not found');
    let status = row.status;
    let error = row.error_summary;
    // A run that is marked running but is not running in this process died with a restart. Say so instead of polling forever.
    if (status === 'running' && !running.has(row.id)) {
      error = 'The server restarted while this investigation was running. Please send it again.';
      await store.failInvestigation(row.id, error).catch(() => {});
      status = 'failed';
    }
    const base = { investigation_id: row.id, status, case_id: row.case_id, store_id: row.platform_store_id, order_id: row.platform_order_id };
    if (status === 'running') return respond(res, 200, { ...base, poll_after_ms: 1500 });
    if (status === 'failed') return respond(res, 200, { ...base, error: error || 'The investigation failed. Please try again.' });
    // A chat message keeps its full answer (including suggested follow-ups) with the message itself.
    const message = row.conversation_id ? await store.getMessageForInvestigation(row.id) : null;
    const r = message?.result || {};
    return respond(res, 200, {
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
    return result.recommendation === 'do_not_dispute' ? ['Why not dispute this?', 'What would change your mind?'] : DEFAULT_FOLLOWUPS;
  }

  function decodeImages(list) {
    return list.map((d) => {
      const m = d.match(/^data:(image\/(?:jpeg|png));base64,(.+)$/);
      return { mime: m[1], bytes: Buffer.from(m[2], 'base64') };
    });
  }

  const publicConversation = (c) => ({
    id: String(c.id),
    case_id: String(c.case_id),
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

  // Chats need their tables. If the first check or attempt failed, try again (at most once a minute) and say so plainly.
  async function requireChats() {
    if (store.conversationsReady?.() === true) return;
    const state = await store.ensureConversations?.();
    if (state && !state.ready) throw new HttpError(503, 'Chats are not set up in the database yet. The service will keep trying; if this persists, the database role may not be allowed to create tables.');
  }

  async function startConversation(req, res, who) {
    await requireChats();
    const body = await jsonBody(req);
    const p = sanitizeConversationStart(body);
    const operator = who.operator || requiredString(body.operator_id, 'operator_id', 128);
    if (p.screenshots.length > MAX_IMAGES_PER_CONVERSATION) throw new HttpError(422, 'Too many images');
    p.storeId = p.storeId || (await store.resolveStore(p.orderId).catch(() => null)) || UNRESOLVED_STORE;
    const c = await store.upsertCase(TENANT, operator, p);
    const id = await store.createConversation(TENANT, c.id, operator, p.title || `Order ${p.orderId}`);
    if (p.screenshots.length) await store.saveImages(id, c.id, decodeImages(p.screenshots), imageExpiry());
    return respond(res, 201, { conversation_id: String(id), case_id: String(c.id), store_id: p.storeId, order_id: p.orderId, images: p.screenshots.length });
  }

  async function listConversations(res, url) {
    await requireChats();
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const rows = await store.listConversations(TENANT, limit);
    return respond(res, 200, { conversations: rows.map(publicConversation) });
  }

  async function readConversation(res, id) {
    await requireChats();
    const conv = await store.getConversation(TENANT, id);
    if (!conv) throw new HttpError(404, 'Conversation not found');
    const [messages, images] = await Promise.all([store.listMessages(conv.id), store.listImages(conv.id)]);
    return respond(res, 200, {
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

  async function readImage(res, convId, imageId) {
    await requireChats();
    const conv = await store.getConversation(TENANT, convId);
    if (!conv) throw new HttpError(404, 'Conversation not found');
    const image = await store.getImage(conv.id, imageId);
    if (!image) throw new HttpError(404, 'Image not found or expired');
    return sendBytes(res, image.mime, Buffer.from(image.bytes));
  }

  async function runConversationJob({ conv, id, message }) {
    try {
      const transcript = await store.loadTranscript(conv.id);
      const stored = await store.loadImages(conv.id);
      const images = stored.map((r) => ({ type: 'image', data: Buffer.from(r.bytes).toString('base64'), mimeType: r.mime }));
      const facts = await store.getCaseFacts(conv.case_id);
      const request = {
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
      const { transcript: next, ...result } = await investigate({ store, tenant: TENANT, request, runId: id, env, transcript, images });
      const payload = { ...result, suggested_followups: suggestedFollowups(result) };
      // Order matters: the answer and the transcript are saved before the run is marked completed, so a poll never sees a finished run without its message.
      await store.appendMessage(conv.id, 'assistant', result.reasoning_summary, payload, id);
      if (next) await store.saveTranscript(conv.id, next);
      await store.touchConversation(conv.id, { lastRecommendation: result.recommendation });
      await store.completeInvestigation(id, result);
      await store.setCaseStatus(conv.case_id, result.recommendation === 'dispute' ? 'ready_to_dispute' : 'captured');
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

  async function postMessage(req, res, who, convId) {
    await requireChats();
    if (!env.OPENAI_API_KEY) throw new HttpError(503, 'AI provider not configured');
    const body = await jsonBody(req);
    const message = sanitizeMessage(body);
    const conv = await store.getConversation(TENANT, convId);
    if (!conv) throw new HttpError(404, 'Conversation not found');
    const key = String(conv.id);
    // Claim the chat before any await, so two quick sends cannot both start a run.
    if (activeConversations.has(key)) throw new HttpError(409, 'The agent is still answering your last message in this chat.');
    activeConversations.add(key);
    try {
      const wait = investigationLimit(who.key);
      if (wait) throw new HttpError(429, 'Too many investigations. Try again in a few minutes.', { 'Retry-After': String(wait) });
      if (running.size >= MAX_CONCURRENT_RUNS) throw new HttpError(429, 'The agent is busy with other investigations. Try again in a minute.', { 'Retry-After': '30' });
      if (message.screenshots.length) {
        if ((await store.countImages(conv.id)) + message.screenshots.length > MAX_IMAGES_PER_CONVERSATION) {
          throw new HttpError(422, `A chat can hold at most ${MAX_IMAGES_PER_CONVERSATION} images. Start a new chat for more.`);
        }
        await store.saveImages(conv.id, conv.case_id, decodeImages(message.screenshots), imageExpiry());
      }
      const first = (await store.listMessages(conv.id, 1)).length === 0;
      await store.appendMessage(conv.id, 'user', message.text);
      if (first) await store.touchConversation(conv.id, { title: `${conv.platform_order_id} · ${message.text}`.slice(0, 100) });
      const id = await store.createInvestigation(conv.case_id, env.OPENAI_MODEL || 'gpt-4.1-mini', conv.id);
      await store.setCaseStatus(conv.case_id, 'investigating');
      running.set(id, now());
      void runConversationJob({ conv, id, message });
      return respond(res, 202, { investigation_id: id, conversation_id: key, status: 'running', poll_after_ms: 1500 });
    } catch (err) {
      activeConversations.delete(key);
      throw err;
    }
  }

  async function confirmDispute(req, res, who) {
    const body = await jsonBody(req);
    const p = sanitizeConfirm(body);
    const operator = who.operator || requiredString(body.operator_id, 'operator_id', 128);
    if (p.conversationId) await requireChats();
    const conv = p.conversationId ? await store.getConversation(TENANT, p.conversationId) : null;
    if (p.conversationId && !conv) throw new HttpError(404, 'Conversation not found');
    const resolved = p.storeId || (await store.resolveStore(p.orderId).catch(() => null));
    const candidates = [...new Set([p.storeId, resolved, UNRESOLVED_STORE].filter(Boolean))];
    // A chat knows its own case. Otherwise find it by order, and if the agent never saw the order, log the filing anyway.
    const c =
      (conv && { id: conv.case_id, platform_store_id: conv.platform_store_id }) ||
      (await store.findCase(TENANT, p.orderId, candidates)) ||
      (await store.upsertCase(TENANT, operator, {
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
    const key = `doordash:${c.platform_store_id}:${p.orderId}`;
    const r = await store.recordSubmission(TENANT, c.id, key, operator, p.disputeText, p.submittedAt);
    if (conv && !r.already_recorded) {
      await store.appendMessage(conv.id, 'system', `Marked as disputed by ${operator}. The dispute was filed in DoorDash by the operator.`).catch(() => {});
      await store.touchConversation(conv.id, { status: 'disputed' }).catch(() => {});
    }
    return respond(res, 200, { ...r, case_id: c.id, store_id: c.platform_store_id });
  }

  async function handle(req, res, rid) {
    cors(req, res);
    const route = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && route === '/healthz') return respond(res, 200, { ok: true, service: 'korefi-pi-dispute-agent', version: '0.3.0' });
    if (req.method === 'OPTIONS') return respond(res, 204);
    const who = auth(req);
    res.who = who.operator || who.key;
    const wait = requestLimit(who.key);
    if (wait) throw new HttpError(429, 'Too many requests. Slow down.', { 'Retry-After': String(wait) });

    if (req.method === 'GET' && route === '/readyz') {
      const ok = await store.ready();
      const chats = store.conversationsReady ? ((await store.ensureConversations?.())?.ready ? 'ready' : 'missing') : 'ready';
      return respond(res, 200, { ok, db: ok ? 'connected' : 'unavailable', conversations: chats, model_configured: !!env.OPENAI_API_KEY, store_restrictions: 'derived_from_order' });
    }
    if (req.method === 'POST' && route === '/v1/investigations') return startInvestigation(req, res, who);
    if (req.method === 'POST' && route === '/v1/conversations') return startConversation(req, res, who);
    if (req.method === 'GET' && route === '/v1/conversations') return listConversations(res, new URL(req.url, 'http://localhost'));
    const convRoute = route.match(/^\/v1\/conversations\/([A-Za-z0-9_-]{1,64})(?:\/(messages)|\/images\/([A-Za-z0-9_-]{1,64}))?$/);
    if (convRoute) {
      const [, convId, messages, imageId] = convRoute;
      idParam(convId, 'conversation id');
      if (req.method === 'GET' && !messages && !imageId) return readConversation(res, convId);
      if (req.method === 'POST' && messages) return postMessage(req, res, who, convId);
      if (req.method === 'GET' && imageId) return readImage(res, convId, imageId);
    }
    const poll = route.match(/^\/v1\/investigations\/([A-Za-z0-9_-]{1,64})$/);
    if (req.method === 'GET' && poll) return readInvestigation(res, poll[1]);
    if (req.method === 'POST' && route === '/v1/disputes/confirm') return confirmDispute(req, res, who);
    throw new HttpError(404, 'Not found');
  }

  function handler(req, res) {
    const rid = randomUUID().slice(0, 8);
    const started = now();
    res.setHeader('X-Request-Id', rid);
    res.on('finish', () => {
      // Method, path, status, timing and who. Never bodies, tokens or screenshots.
      log(JSON.stringify({ level: 'info', rid, method: req.method, path: (req.url || '').split('?')[0], status: res.statusCode, ms: now() - started, who: res.who || null }));
    });
    handle(req, res, rid).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(JSON.stringify({ level: 'error', rid, message: String(e?.message || e).slice(0, 300) }));
      if (!res.headersSent) respond(res, status, { error: status === 500 ? 'Request failed; consult server logs' : e.message }, e instanceof HttpError ? e.headers : {});
    });
  }

  return { handler, running };
}

/** Deletes expired evidence images now and every few hours. Safe before migration 001: a missing table is just logged. */
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
