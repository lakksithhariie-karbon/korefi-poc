import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.mjs';
import { createMemoryStore } from './memory-store.mjs';

const TOKEN = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

const RESULT = {
  recommendation: 'needs_review',
  reasoning_summary: 'No history for this store. From the order: a missing item.',
  missing_evidence: ['POS ticket'],
  draft_text: 'We dispute the charge on order ABC12345. [verify]',
  risk_notes: null,
  model: 'test-model',
  tools_used: [{ name: 'get_error_charges', count: 0 }],
};

/** Starts the real HTTP handler on a free port with in-memory storage and a controllable agent. */
async function start({ env = {}, resolve = {}, investigate } = {}) {
  const store = createMemoryStore({ resolve });
  const logs = [];
  const gates = [];
  const seen = [];
  const agent =
    investigate ||
    (async ({ request }) => {
      seen.push(request);
      await new Promise((release) => gates.push(release));
      return RESULT;
    });
  const app = createApp({
    store,
    investigate: agent,
    env: { KOREFI_AGENT_TOKEN: TOKEN, OPENAI_API_KEY: 'sk-test', ...env },
    log: (line) => logs.push(line),
  });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, token = TOKEN, headers = {}) =>
    fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  const poll = async (id, until = (j) => j.status !== 'running') => {
    for (let i = 0; i < 100; i++) {
      const j = await (await call('GET', `/v1/investigations/${id}`)).json();
      if (until(j)) return j;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('investigation never finished');
  };
  return { store, logs, gates, seen, app, call, poll, close: () => server.close() };
}

const capture = (extra = {}) => ({ operator_id: 'ops-1', order_id: 'ABC12345', structured_facts: {}, ...extra });

test('health is public, everything else needs a token', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('GET', '/healthz', null, null)).status, 200);
    assert.equal((await s.call('GET', '/readyz', null, null)).status, 401);
    assert.equal((await s.call('GET', '/readyz', null, 'wrong'.repeat(10))).status, 401);
    assert.equal((await s.call('POST', '/v1/investigations', capture(), null)).status, 401);
    assert.equal((await s.call('GET', '/readyz')).status, 200);
  } finally {
    s.close();
  }
});

test('an investigation returns at once and the result is fetched by polling', async () => {
  const s = await start();
  try {
    const start1 = await s.call('POST', '/v1/investigations', capture({ store_id: '28006527', screenshots: [IMG, IMG] }));
    assert.equal(start1.status, 202);
    const started = await start1.json();
    assert.equal(started.status, 'running');
    assert.equal(started.store_id, '28006527');

    const running = await (await s.call('GET', `/v1/investigations/${started.investigation_id}`)).json();
    assert.equal(running.status, 'running');

    s.gates.forEach((release) => release());
    const done = await s.poll(started.investigation_id);
    assert.equal(done.status, 'completed');
    assert.equal(done.recommendation, 'needs_review');
    assert.equal(done.draft_text, RESULT.draft_text);
    assert.deepEqual(done.missing_evidence, ['POS ticket']);
    assert.equal(s.seen[0].screenshots.length, 2);
  } finally {
    s.close();
  }
});

test('an unknown store still gets a full response (no history is normal)', async () => {
  const s = await start();
  try {
    const started = await (await s.call('POST', '/v1/investigations', capture())).json();
    assert.equal(started.store_id, 'unresolved');
    s.gates.forEach((release) => release());
    const done = await s.poll(started.investigation_id);
    assert.equal(done.status, 'completed');
    assert.ok(done.draft_text.length > 0);
    assert.equal(s.seen[0].storeId, 'unresolved');
  } finally {
    s.close();
  }
});

test('the store is looked up from the order when the page did not reveal it', async () => {
  const s = await start({ resolve: { ABC12345: '555123' } });
  try {
    const started = await (await s.call('POST', '/v1/investigations', capture())).json();
    assert.equal(started.store_id, '555123');
    s.gates.forEach((release) => release());
    await s.poll(started.investigation_id);
  } finally {
    s.close();
  }
});

test('follow-up turns carry the conversation and the current draft', async () => {
  const s = await start();
  try {
    const conversation = [
      { role: 'user', text: 'Can we dispute?' },
      { role: 'assistant', text: 'Probably. Evidence is thin.' },
    ];
    const started = await (await s.call('POST', '/v1/investigations', capture({ conversation, previous_draft: 'My draft', operator_question: 'Shorten it' }))).json();
    s.gates.forEach((release) => release());
    await s.poll(started.investigation_id);
    assert.equal(s.seen[0].conversation.length, 2);
    assert.equal(s.seen[0].previousDraft, 'My draft');
    assert.equal(s.seen[0].operatorQuestion, 'Shorten it');
  } finally {
    s.close();
  }
});

test('bad input is refused with a clear 422', async () => {
  const s = await start();
  try {
    const bad = [
      capture({ store_id: 'not-a-store' }),
      capture({ order_id: 'has spaces!' }),
      capture({ order_url: 'https://example.com/x' }),
      capture({ dispute_amount: -1 }),
      capture({ conversation: [{ role: 'system', text: 'x' }] }),
      capture({ screenshots: ['not an image'] }),
      capture({ screenshots: Array(7).fill(IMG) }),
    ];
    for (const body of bad) assert.equal((await s.call('POST', '/v1/investigations', body)).status, 422, JSON.stringify(body).slice(0, 80));
    assert.equal((await s.call('GET', '/v1/investigations/does-not-exist')).status, 404);
  } finally {
    s.close();
  }
});

test('a failed run reports a safe message, never internals', async () => {
  const s = await start({
    investigate: async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
    },
  });
  try {
    const started = await (await s.call('POST', '/v1/investigations', capture())).json();
    const done = await s.poll(started.investigation_id);
    assert.equal(done.status, 'failed');
    assert.ok(!/hunter2|ECONNREFUSED|10\.0\.0\.5/.test(JSON.stringify(done)));
    assert.match(done.error, /try again/i);
  } finally {
    s.close();
  }
});

test('a run orphaned by a restart is reported as failed instead of polling forever', async () => {
  const s = await start();
  try {
    const started = await (await s.call('POST', '/v1/investigations', capture())).json();
    s.app.running.clear(); // what a restart does: the in-memory run is gone, the row still says running
    const done = await s.poll(started.investigation_id);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /restarted/i);
  } finally {
    s.close();
  }
});

test('confirming works without a store ID and is recorded once', async () => {
  const s = await start();
  try {
    const started = await (await s.call('POST', '/v1/investigations', capture())).json();
    s.gates.forEach((release) => release());
    await s.poll(started.investigation_id);

    const body = { operator_id: 'ops-1', order_id: 'ABC12345', dispute_text: 'We dispute this.', disputed_at: '2026-11-06T12:00:00Z' };
    const first = await (await s.call('POST', '/v1/disputes/confirm', body)).json();
    assert.equal(first.already_recorded, false);
    assert.equal(first.store_id, 'unresolved');
    assert.equal(first.case_id, started.case_id);

    const again = await (await s.call('POST', '/v1/disputes/confirm', body)).json();
    assert.equal(again.already_recorded, true);
    assert.equal(again.id, first.id);
    assert.equal(s.store.submissions.length, 1);
  } finally {
    s.close();
  }
});

test('confirming an order the agent never saw still logs the filing', async () => {
  const s = await start();
  try {
    const res = await s.call('POST', '/v1/disputes/confirm', {
      operator_id: 'ops-1',
      order_id: 'NEVERSEEN1',
      dispute_text: 'Filed by hand.',
      disputed_at: '2026-11-06T12:00:00Z',
      dispute_amount: 7.99,
    });
    assert.equal(res.status, 200);
    assert.equal(s.store.submissions.length, 1);
    assert.equal(s.store.cases.length, 1);
  } finally {
    s.close();
  }
});

test('a later store ID finds the case that was filed under the unresolved placeholder', async () => {
  const s = await start();
  try {
    const started = await (await s.call('POST', '/v1/investigations', capture())).json();
    s.gates.forEach((release) => release());
    await s.poll(started.investigation_id);
    const res = await (
      await s.call('POST', '/v1/disputes/confirm', { operator_id: 'o', order_id: 'ABC12345', store_id: '777888', dispute_text: 'x', disputed_at: '2026-11-06T12:00:00Z' })
    ).json();
    assert.equal(res.case_id, started.case_id);
    assert.equal(s.store.cases.length, 1);
  } finally {
    s.close();
  }
});

test('per-operator tokens decide who is calling; the shared token needs a named operator', async () => {
  const s = await start({ env: { KOREFI_AGENT_TOKENS: `${OTHER}:dana@korefi.ai` } });
  try {
    const own = await (await s.call('POST', '/v1/investigations', { order_id: 'ABC12345', operator_id: 'someone-else' }, OTHER)).json();
    s.gates.forEach((release) => release());
    await s.poll(own.investigation_id);
    assert.equal(s.store.cases[0].operator, 'dana@korefi.ai');
    assert.equal((await s.call('POST', '/v1/investigations', { order_id: 'ABC12346' })).status, 422);
  } finally {
    s.close();
  }
});

test('requests are rate limited with Retry-After', async () => {
  const s = await start({ env: { RATE_REQUESTS_PER_MIN: '3' } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await s.call('GET', '/readyz')).status, 200);
    const limited = await s.call('GET', '/readyz');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally {
    s.close();
  }
});

test('too many runs at once are turned away politely', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 4; i++) assert.equal((await s.call('POST', '/v1/investigations', capture({ order_id: `ORDER${i}00` }))).status, 202);
    const busy = await s.call('POST', '/v1/investigations', capture({ order_id: 'ORDER900' }));
    assert.equal(busy.status, 429);
    s.gates.forEach((release) => release());
  } finally {
    s.close();
  }
});

test('preflight answers 204 with no body, and only for allowed origins', async () => {
  const s = await start({ env: { ALLOWED_EXTENSION_ORIGINS: 'chrome-extension://abc' } });
  try {
    const ok = await s.call('OPTIONS', '/v1/investigations', null, null, { Origin: 'chrome-extension://abc' });
    assert.equal(ok.status, 204);
    assert.equal(await ok.text(), '');
    assert.equal(ok.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
    const other = await s.call('OPTIONS', '/v1/investigations', null, null, { Origin: 'https://evil.example' });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  } finally {
    s.close();
  }
});

test('request logs carry method, path and status but never tokens, bodies or images', async () => {
  const s = await start();
  try {
    const started = await (await s.call('POST', '/v1/investigations', capture({ screenshots: [IMG], redacted_page_text: 'secret page text' }))).json();
    s.gates.forEach((release) => release());
    await s.poll(started.investigation_id);
    const text = s.logs.join('\n');
    const post = s.logs.map((l) => JSON.parse(l)).find((l) => l.method === 'POST');
    assert.equal(post.path, '/v1/investigations');
    assert.equal(post.status, 202);
    assert.ok(!text.includes(TOKEN));
    assert.ok(!text.includes('secret page text'));
    assert.ok(!text.includes('base64'));
  } finally {
    s.close();
  }
});
