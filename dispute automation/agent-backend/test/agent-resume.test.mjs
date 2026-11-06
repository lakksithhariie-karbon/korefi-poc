// Drives the real agent code with a fake model: tool call, JSON answer, then a resumed follow-up.
// No network and no OpenAI. Needs the Pi packages from `npm install`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { investigate } from '../src/agent.mjs';
import { createMemoryStore } from './memory-store.mjs';

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const base = { api: 'openai-responses', provider: 'openai', model: 'fake', usage, timestamp: Date.now() };

/** Calls get_error_charges once on a first turn, then answers with JSON. Records every context it was given. */
function fakeModel() {
  const contexts = [];
  const streamFn = (_model, context) => {
    contexts.push(JSON.parse(JSON.stringify(context)));
    const msgs = context.messages;
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const needsTool = !msgs.some((m) => m.role === 'toolResult') && !/Follow-up/.test(JSON.stringify(lastUser));
    const message = needsTool
      ? { ...base, role: 'assistant', content: [{ type: 'toolCall', id: 'call1', name: 'get_error_charges', arguments: {} }], stopReason: 'toolUse' }
      : {
          ...base,
          role: 'assistant',
          content: [{ type: 'text', text: JSON.stringify({ recommendation: 'needs_review', reasoning_summary: `answer ${contexts.length}`, missing_evidence: ['POS'], draft_text: 'draft', suggested_followups: ['Next?'], risk_notes: null }) }],
          stopReason: 'stop',
        };
    const s = createAssistantMessageEventStream();
    queueMicrotask(() => {
      s.push({ type: 'start', partial: message });
      s.push({ type: 'done', reason: message.stopReason, message });
      s.end(message);
    });
    return s;
  };
  return { streamFn, contexts };
}

const request = (over = {}) => ({
  storeId: 'unresolved', orderId: 'ABC12345', issueCategory: 'Missing item', issueDescription: 'Missing entire item', amount: 7.99,
  facts: { items: [{ name: 'Wintermelon Lemon' }] }, redactedText: 'Order: ABC12345', operatorQuestion: 'Can we dispute?',
  previousDraft: null, additionalText: null, screenshots: [], conversation: [], ...over,
});
const img = (data) => ({ type: 'image', data, mimeType: 'image/jpeg' });

test('turn 1 uses a tool and returns a transcript without images or system prompt', async () => {
  const { streamFn } = fakeModel();
  const out = await investigate({ store: createMemoryStore(), tenant: 't', request: request(), runId: 1, env: {}, transcript: [], images: [img('AAAA'), img('BBBB')], streamFn });
  assert.equal(out.recommendation, 'needs_review');
  assert.deepEqual(out.suggested_followups, ['Next?']);
  assert.deepEqual(out.tools_used, [{ name: 'get_error_charges', count: 0 }]);
  assert.deepEqual(out.transcript.map((m) => m.role), ['user', 'assistant', 'toolResult', 'assistant']);
  const text = JSON.stringify(out.transcript);
  assert.ok(!text.includes('AAAA') && !text.includes('BBBB'));
  assert.match(text, /Can we dispute\?/);
});

test('the first prompt tells the agent the store is unknown and describes the image slices', async () => {
  const { streamFn, contexts } = fakeModel();
  await investigate({ store: createMemoryStore(), tenant: 't', request: request(), runId: 1, env: {}, transcript: [], images: [img('AAAA'), img('BBBB')], streamFn });
  const first = JSON.stringify(contexts[0].messages.find((m) => m.role === 'user'));
  assert.match(first, /store unknown/);
  assert.match(first, /2 screenshot images/);
  assert.match(first, /\\"type\\":\\"image\\"|"type":"image"/);
});

test('a follow-up resumes the saved conversation, re-attaches the images and keeps the tool result', async () => {
  const { streamFn, contexts } = fakeModel();
  const store = createMemoryStore();
  const first = await investigate({ store, tenant: 't', request: request(), runId: 1, env: {}, transcript: [], images: [img('AAAA')], streamFn });
  const saved = JSON.parse(JSON.stringify(first.transcript));

  const second = await investigate({
    store, tenant: 't', runId: 2, env: {}, transcript: saved, images: [img('AAAA'), img('CCCC')], streamFn,
    request: request({ operatorQuestion: 'What evidence is missing?', previousDraft: 'My edited draft' }),
  });
  assert.equal(second.reasoning_summary, 'answer 3');
  assert.deepEqual(second.tools_used, [], 'no new lookup was needed');

  const ctx = contexts.at(-1).messages;
  assert.equal(ctx[0].role, 'system', 'the system prompt is rebuilt, not replayed from storage');
  assert.ok(ctx.some((m) => m.role === 'toolResult'), 'earlier tool results are still there');
  const users = ctx.filter((m) => m.role === 'user');
  assert.equal(users.length, 2);
  assert.match(JSON.stringify(users[0]), /Can we dispute\?/);
  const followUp = JSON.stringify(users[1]);
  assert.match(followUp, /What evidence is missing\?/);
  assert.match(followUp, /My edited draft/);
  assert.equal(users[1].content.filter((c) => c.type === 'image').length, 2, 'both images are attached again');
  assert.deepEqual(second.transcript.map((m) => m.role), ['user', 'assistant', 'toolResult', 'assistant', 'user', 'assistant']);
});

test('the legacy stateless call still works and returns no transcript', async () => {
  const { streamFn } = fakeModel();
  const out = await investigate({ store: createMemoryStore(), tenant: 't', request: request({ screenshots: ['data:image/jpeg;base64,AAAA'] }), runId: 1, env: {}, streamFn });
  assert.equal(out.transcript, null);
  assert.equal(out.recommendation, 'needs_review');
});
