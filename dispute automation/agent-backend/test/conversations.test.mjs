import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, startMaintenance } from '../src/app.mjs';
import { createMemoryStore } from './memory-store.mjs';

const TOKEN = 'a'.repeat(40);
const jpeg = (tag) => `data:image/jpeg;base64,${Buffer.from(tag).toString('base64')}`;

/** The real HTTP app over in-memory storage, with a fake agent that follows the same transcript contract as the real one. */
async function start({ env = {}, investigate } = {}) {
  const store = createMemoryStore();
  const calls = [];
  const gates = [];
  const agent =
    investigate ||
    (async ({ request, transcript, images }) => {
      calls.push({ request, transcript, images });
      await new Promise((release) => gates.push(release));
      const n = calls.length;
      const next = [...transcript, { role: 'user', content: [{ type: 'text', text: request.operatorQuestion }] }, { role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }], stopReason: 'stop' }];
      return { recommendation: 'needs_review', reasoning_summary: `answer ${n}`, missing_evidence: [], draft_text: `draft ${n}`, risk_notes: null, suggested_followups: n === 1 ? ['Custom next?'] : [], model: 'fake', tools_used: [{ name: 'get_error_charges', count: 0 }], transcript: next };
    });
  const app = createApp({ store, investigate: agent, env: { KOREFI_AGENT_TOKEN: TOKEN, OPENAI_API_KEY: 'sk-test', ...env }, log: () => {} });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, token = TOKEN) =>
    fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = async (method, path, body) => (await call(method, path, body)).json();
  const release = () => gates.splice(0).forEach((g) => g());
  const finish = async (id) => {
    for (let i = 0; i < 200; i++) {
      release();
      const j = await json('GET', `/v1/investigations/${id}`);
      if (j.status !== 'running') return j;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('run never finished');
  };
  return { store, calls, gates, app, call, json, release, finish, close: () => server.close() };
}

const open = (s, extra = {}) => s.json('POST', '/v1/conversations', { operator_id: 'ops-1', order_id: 'ABC12345', issue_category: 'Missing item', dispute_amount: 7.99, structured_facts: { items: [] }, redacted_page_text: 'Order: ABC12345', screenshots: [jpeg('one'), jpeg('two')], ...extra });

test('opening a chat stores the case and the redacted images', async () => {
  const s = await start();
  try {
    const res = await s.call('POST', '/v1/conversations', { operator_id: 'ops-1', order_id: 'ABC12345', screenshots: [jpeg('one'), jpeg('two')] });
    assert.equal(res.status, 201);
    const c = await res.json();
    assert.equal(c.store_id, 'unresolved');
    assert.equal(c.images, 2);
    const detail = await s.json('GET', `/v1/conversations/${c.conversation_id}`);
    assert.equal(detail.conversation.order_id, 'ABC12345');
    assert.equal(detail.images.length, 2);
    assert.deepEqual(detail.messages, []);
  } finally {
    s.close();
  }
});

test('a message is answered, saved, and shows up in the history', async () => {
  const s = await start();
  try {
    const c = await open(s);
    const sent = await s.call('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'Can we dispute this?' });
    assert.equal(sent.status, 202);
    const { investigation_id } = await sent.json();
    const done = await s.finish(investigation_id);
    assert.equal(done.status, 'completed');
    assert.equal(done.conversation_id, c.conversation_id);
    assert.equal(done.draft_text, 'draft 1');
    assert.deepEqual(done.suggested_followups, ['Custom next?']);

    const detail = await s.json('GET', `/v1/conversations/${c.conversation_id}`);
    assert.deepEqual(detail.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(detail.messages[1].result.recommendation, 'needs_review');
    assert.match(detail.conversation.title, /ABC12345 · Can we dispute this\?/);
    assert.equal(detail.conversation.last_recommendation, 'needs_review');

    const list = await s.json('GET', '/v1/conversations');
    assert.equal(list.conversations.length, 1);
    assert.equal(list.conversations[0].id, c.conversation_id);
  } finally {
    s.close();
  }
});

test('the first turn gets the case facts; the follow-up resumes the saved transcript and gets the images again', async () => {
  const s = await start();
  try {
    const c = await open(s);
    const m1 = await s.json('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'Can we dispute this?' });
    await s.finish(m1.investigation_id);
    const m2 = await s.json('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'What evidence is missing?', previous_draft: 'my edit' });
    await s.finish(m2.investigation_id);

    const [first, second] = s.calls;
    assert.deepEqual(first.transcript, []);
    assert.equal(first.request.issueCategory, 'Missing item');
    assert.equal(first.request.amount, 7.99);
    assert.equal(first.request.redactedText, 'Order: ABC12345');
    assert.equal(first.images.length, 2);
    assert.equal(second.transcript.length, 2, 'the first exchange was saved');
    assert.equal(second.images.length, 2, 'images are attached again');
    assert.equal(Buffer.from(second.images[0].data, 'base64').toString(), 'one');
    assert.equal(second.request.previousDraft, 'my edit');
    assert.deepEqual((await s.json('GET', `/v1/investigations/${m2.investigation_id}`)).suggested_followups.length > 0, true, 'a default is supplied when the model gave none');
  } finally {
    s.close();
  }
});

test('more evidence can be added mid-chat, up to a limit', async () => {
  const s = await start();
  try {
    const c = await open(s);
    const m = await s.json('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'Here is the food photo', screenshots: [jpeg('food')], additional_text: 'extra page text' });
    await s.finish(m.investigation_id);
    assert.equal(s.calls[0].images.length, 3);
    assert.equal(s.calls[0].request.additionalText, 'extra page text');
    const more = await s.json('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'more photos', screenshots: Array(9).fill(jpeg('x')) });
    await s.finish(more.investigation_id);
    assert.equal(s.calls[1].images.length, 12);
    const again = await s.json('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'a new capture', screenshots: Array(9).fill(jpeg('z')) });
    await s.finish(again.investigation_id);
    assert.equal(s.calls[2].images.length, 21);
    const full = await s.call('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'even more', screenshots: Array(9).fill(jpeg('y')) });
    assert.equal(full.status, 422);
    assert.match((await full.json()).error, /at most 24 images/);
  } finally {
    s.close();
  }
});

test('a second message while the agent is busy is refused, then accepted', async () => {
  const s = await start();
  try {
    const c = await open(s);
    const m1 = await s.json('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'one' });
    const busy = await s.call('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'two' });
    assert.equal(busy.status, 409);
    await s.finish(m1.investigation_id);
    assert.equal((await s.call('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'two' })).status, 202);
    s.release();
  } finally {
    s.close();
  }
});

test('a failed run leaves a note in the chat and does not corrupt the saved conversation', async () => {
  let n = 0;
  const s = await start({
    investigate: async ({ request, transcript }) => {
      if (++n === 2) throw new Error('db password=hunter2 exploded');
      return { recommendation: 'dispute', reasoning_summary: `ok ${n}`, missing_evidence: [], draft_text: 'd', risk_notes: null, suggested_followups: [], model: 'fake', tools_used: [], transcript: [...transcript, { role: 'user', content: request.operatorQuestion }, { role: 'assistant', content: [{ type: 'text', text: 'a' }], stopReason: 'stop' }] };
    },
  });
  try {
    const c = await open(s);
    const m1 = await s.json('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'one' });
    await s.finish(m1.investigation_id);
    const m2 = await s.json('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'two' });
    const failed = await s.finish(m2.investigation_id);
    assert.equal(failed.status, 'failed');
    assert.ok(!/hunter2/.test(JSON.stringify(failed)));
    const detail = await s.json('GET', `/v1/conversations/${c.conversation_id}`);
    const last = detail.messages.at(-1);
    assert.equal(last.role, 'system');
    assert.match(last.text, /could not answer/);
    assert.ok(!/hunter2/.test(last.text));
    assert.equal(s.store.states.get(c.conversation_id).length, 2, 'the transcript still holds only the successful exchange');
    assert.equal((await s.call('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'three' })).status, 202);
  } finally {
    s.close();
  }
});

test('chats on the same order are separate, and history lists the newest first', async () => {
  const s = await start();
  try {
    const a = await open(s);
    const b = await open(s);
    assert.notEqual(a.conversation_id, b.conversation_id);
    assert.equal(a.case_id, b.case_id, 'one case, two chats');
    const m = await s.json('POST', `/v1/conversations/${a.conversation_id}/messages`, { text: 'older chat, newer activity' });
    await s.finish(m.investigation_id);
    const list = (await s.json('GET', '/v1/conversations')).conversations;
    assert.deepEqual(list.map((c) => c.id), [a.conversation_id, b.conversation_id]);
    const other = await s.json('POST', `/v1/conversations/${b.conversation_id}/messages`, { text: 'b' });
    await s.finish(other.investigation_id);
    assert.deepEqual(s.calls.at(-1).transcript, [], "chat b never sees chat a's transcript");
  } finally {
    s.close();
  }
});

test('images are served back to the history view, and unknown ones are 404', async () => {
  const s = await start();
  try {
    const c = await open(s);
    const detail = await s.json('GET', `/v1/conversations/${c.conversation_id}`);
    const res = await s.call('GET', `/v1/conversations/${c.conversation_id}/images/${detail.images[0].id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'one');
    assert.equal((await s.call('GET', `/v1/conversations/${c.conversation_id}/images/999999`)).status, 404);
    assert.equal((await s.call('GET', '/v1/conversations/999999')).status, 404);
  } finally {
    s.close();
  }
});

test('marking a chat disputed logs the filing, notes it in the chat, and needs no store ID', async () => {
  const s = await start();
  try {
    const c = await open(s);
    const res = await s.json('POST', '/v1/disputes/confirm', { operator_id: 'ops-1', conversation_id: c.conversation_id, order_id: 'ABC12345', dispute_text: 'We dispute.', disputed_at: '2026-11-06T12:00:00Z' });
    assert.equal(res.already_recorded, false);
    assert.equal(String(res.case_id), c.case_id);
    const detail = await s.json('GET', `/v1/conversations/${c.conversation_id}`);
    assert.equal(detail.conversation.status, 'disputed');
    assert.match(detail.messages.at(-1).text, /Marked as disputed/);
    const again = await s.json('POST', '/v1/disputes/confirm', { operator_id: 'ops-1', conversation_id: c.conversation_id, order_id: 'ABC12345', dispute_text: 'We dispute.', disputed_at: '2026-11-06T12:00:00Z' });
    assert.equal(again.already_recorded, true);
    assert.equal((await s.json('GET', `/v1/conversations/${c.conversation_id}`)).messages.filter((m) => /Marked as disputed/.test(m.text)).length, 1);
    assert.equal((await s.call('POST', '/v1/disputes/confirm', { operator_id: 'o', conversation_id: '999999', order_id: 'ABC12345', dispute_text: 'x', disputed_at: '2026-11-06T12:00:00Z' })).status, 404);
  } finally {
    s.close();
  }
});

test('conversation routes need a token and validate their input', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('GET', '/v1/conversations', null, null)).status, 401);
    assert.equal((await s.call('POST', '/v1/conversations', { order_id: 'ABC12345' }, null)).status, 401);
    assert.equal((await s.call('POST', '/v1/conversations', { operator_id: 'o', order_id: 'bad id!' })).status, 422);
    const c = await open(s);
    for (const body of [{}, { text: '' }, { text: 'x'.repeat(1300) }, { text: 'ok', screenshots: ['nope'] }, { text: 'ok', screenshots: Array(10).fill(jpeg('x')) }]) {
      assert.equal((await s.call('POST', `/v1/conversations/${c.conversation_id}/messages`, body)).status, 422, JSON.stringify(body).slice(0, 60));
    }
  } finally {
    s.close();
  }
});

test('images are deleted after their retention period', async () => {
  const s = await start({ env: { IMAGE_RETENTION_DAYS: '0' } });
  try {
    const c = await open(s);
    assert.equal(s.store.images.length, 2);
    const detail = await s.json('GET', `/v1/conversations/${c.conversation_id}`);
    assert.equal(detail.images.length, 0, 'expired images are no longer listed');
    const stop = startMaintenance({ store: s.store, everyMs: 1e9, log: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    assert.equal(s.store.images.length, 0);
  } finally {
    s.close();
  }
});

test('a run that finishes between the poll reading it and checking it is not reported as lost', async () => {
  const s = await start();
  try {
    const c = await open(s);
    const m = await s.json('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'hello' });
    await s.finish(m.investigation_id); // completed for real
    // Make the first read return what a slow database could: the row as it was before completion, with the run already gone.
    const real = s.store.getInvestigation.bind(s.store);
    let reads = 0;
    s.store.getInvestigation = async (...args) => {
      const row = await real(...args);
      return reads++ === 0 ? { ...row, status: 'running' } : row;
    };
    const polled = await s.json('GET', `/v1/investigations/${m.investigation_id}`);
    assert.equal(polled.status, 'completed');
    assert.equal(reads, 2, 'it looked again before deciding');
  } finally {
    s.close();
  }
});

test('an Uber Eats chat keeps its platform from capture to filing', async () => {
  const s = await start();
  try {
    const c = await open(s, { platform: 'ubereats', order_id: 'D2D46', order_url: 'https://merchants.ubereats.com/manager/orders/x' });
    const m = await s.json('POST', `/v1/conversations/${c.conversation_id}/messages`, { text: 'Can we dispute this?' });
    await s.finish(m.investigation_id);
    assert.equal(s.calls[0].request.platform, 'ubereats');
    const list = await s.json('GET', '/v1/conversations');
    assert.equal(list.conversations[0].platform, 'ubereats');
    const filed = await s.json('POST', '/v1/disputes/confirm', { operator_id: 'ops-1', platform: 'ubereats', conversation_id: c.conversation_id, order_id: 'D2D46', dispute_text: 'x', disputed_at: '2026-11-07T10:00:00Z' });
    assert.ok(filed.id);
    assert.ok(s.store.messages.some((x) => x.role === 'system' && /filed in Uber Eats/.test(x.text)));
    // The same order ID on DoorDash is a different case.
    const dd = await open(s, { order_id: 'D2D46' });
    assert.notEqual(dd.case_id, c.case_id);
  } finally {
    s.close();
  }
});
