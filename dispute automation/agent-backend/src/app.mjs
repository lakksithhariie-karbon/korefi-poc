import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { UNRESOLVED_STORE } from './constants.mjs';
import { HttpError, readToken, requiredString, sanitizeCapture, sanitizeConfirm } from './validation.mjs';

const TENANT = 'korefi-internal-poc'; // Single internal tenant. Real tenant auth is required before rollout.
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_CONCURRENT_RUNS = 4;

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

  function respond(res, code, data, headers = {}) {
    const base = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers };
    if (code === 204) {
      res.writeHead(204, base);
      return res.end();
    }
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...base });
    res.end(JSON.stringify(data));
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
    return respond(res, 200, {
      ...base,
      recommendation: row.recommendation,
      reasoning_summary: row.reasoning_summary,
      missing_evidence: Array.isArray(row.missing_evidence) ? row.missing_evidence : [],
      draft_text: row.draft_text || '',
      risk_notes: row.risk_notes,
      model: row.model_id,
      tools_used: (row.tools || []).map((t) => ({ name: t.name, count: t.count })),
    });
  }

  async function confirmDispute(req, res, who) {
    const body = await jsonBody(req);
    const p = sanitizeConfirm(body);
    const operator = who.operator || requiredString(body.operator_id, 'operator_id', 128);
    const resolved = p.storeId || (await store.resolveStore(p.orderId).catch(() => null));
    const candidates = [...new Set([p.storeId, resolved, UNRESOLVED_STORE].filter(Boolean))];
    // The operator may have filed without asking the agent first. Log the filing anyway.
    const c =
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
    return respond(res, 200, { ...r, case_id: c.id, store_id: c.platform_store_id });
  }

  async function handle(req, res, rid) {
    cors(req, res);
    const route = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && route === '/healthz') return respond(res, 200, { ok: true, service: 'korefi-pi-dispute-agent', version: '0.2.0' });
    if (req.method === 'OPTIONS') return respond(res, 204);
    const who = auth(req);
    res.who = who.operator || who.key;
    const wait = requestLimit(who.key);
    if (wait) throw new HttpError(429, 'Too many requests. Slow down.', { 'Retry-After': String(wait) });

    if (req.method === 'GET' && route === '/readyz') {
      const ok = await store.ready();
      return respond(res, 200, { ok, db: ok ? 'connected' : 'unavailable', model_configured: !!env.OPENAI_API_KEY, store_restrictions: 'derived_from_order' });
    }
    if (req.method === 'POST' && route === '/v1/investigations') return startInvestigation(req, res, who);
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
