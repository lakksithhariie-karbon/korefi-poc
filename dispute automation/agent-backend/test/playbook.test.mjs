// The ops playbook: loaded into the agent, the goodwill verdict, and the per-platform draft limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { INSTRUCTIONS, PLAYBOOK, draftLength, investigate } from '../src/agent.mjs';
import { DRAFT_LIMITS } from '../src/constants.mjs';
import { buildFollowUpPrompt, buildPrompt } from '../src/prompt.mjs';
import { parseAgentOutput } from '../src/validation.mjs';
import { createMemoryStore } from './memory-store.mjs';

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const base = { api: 'openai-responses', provider: 'openai', model: 'fake', usage, timestamp: Date.now() };

/** Answers each prompt with the next draft from `drafts`, never calling a tool. Records the prompts it saw. */
function fakeModel(drafts) {
  const prompts = [];
  let n = 0;
  const streamFn = (_model, context) => {
    const lastUser = [...context.messages].reverse().find((m) => m.role === 'user');
    prompts.push(JSON.stringify(lastUser.content));
    const draft = drafts[Math.min(n++, drafts.length - 1)];
    const message = { ...base, role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ recommendation: 'dispute', reasoning_summary: 'r', missing_evidence: [], draft_text: draft, risk_notes: null }) }], stopReason: 'stop' };
    const s = createAssistantMessageEventStream();
    queueMicrotask(() => {
      s.push({ type: 'start', partial: message });
      s.push({ type: 'done', reason: 'stop', message });
      s.end(message);
    });
    return s;
  };
  return { streamFn, prompts, calls: () => n };
}

const request = (platform, over = {}) => ({
  platform, storeId: 'unresolved', orderId: 'ABC12345', issueCategory: 'Missing item', issueDescription: null, amount: 7.99,
  facts: {}, redactedText: 'Order ABC12345', operatorQuestion: null, previousDraft: null, additionalText: null, screenshots: [], conversation: [], ...over,
});
const run = (platform, streamFn, logs = []) =>
  investigate({ store: createMemoryStore(), tenant: 't', request: request(platform), runId: 1, env: {}, transcript: [], images: [], streamFn, log: (l) => logs.push(JSON.parse(l)) });

test('the whole playbook goes to the agent with its instructions', () => {
  assert.ok(INSTRUCTIONS.endsWith(PLAYBOOK));
  for (const part of ['Dispute decision framework', 'Highest-converting arguments', 'Goodwill path', 'Evidence to attach', 'Appeals: when a dispute is denied', 'Grubhub: portal and email together']) {
    assert.match(PLAYBOOK, new RegExp(part), part);
  }
  assert.match(INSTRUCTIONS, /FOLLOW THE PLAYBOOK/);
});

test('store practices are stated as fact, order facts still come from the evidence', () => {
  assert.match(INSTRUCTIONS, /standard practices in the playbook \(2-step check, wastage log.*\) are confirmed facts for every store: state them plainly, without \[verify\]/);
  assert.match(INSTRUCTIONS, /Everything about this order .* must come from the evidence/);
  assert.match(INSTRUCTIONS, /NEVER MAKE UP FACTS/);
});

test('win rates only guide the approach and never reach the operator', () => {
  assert.match(PLAYBOOK, /~78%/);
  assert.match(INSTRUCTIONS, /never give the operator a win rate, a percentage or a chance of winning/);
});

test('goodwill is a verdict of its own', () => {
  assert.match(INSTRUCTIONS, /'dispute','goodwill','needs_review','do_not_dispute'/);
  assert.match(INSTRUCTIONS, /Recommend goodwill when the evidence is on the customer's side/);
  const out = parseAgentOutput(JSON.stringify({ recommendation: 'goodwill', reasoning_summary: 'Clear photo of the wrong drink.', draft_text: 'We take this feedback seriously.' }));
  assert.equal(out.recommendation, 'goodwill');
});

test('every turn states the platform\'s draft limit', () => {
  assert.deepEqual(DRAFT_LIMITS, { doordash: 500, ubereats: 400 });
  assert.match(buildPrompt(request('doordash')), /Draft limit: at most 500 characters, counting spaces \(the DoorDash dispute form\)/);
  assert.match(buildPrompt(request('ubereats')), /Draft limit: at most 400 characters/);
  assert.match(buildPrompt(request('grubhub')), /Grubhub takes longer texts/);
  assert.match(buildFollowUpPrompt({ question: 'Shorter?', platform: 'ubereats' }), /at most 400 characters/);
});

test('a draft over the limit is sent back once and the shorter one is kept', async () => {
  const { streamFn, prompts, calls } = fakeModel(['x'.repeat(430), 'y'.repeat(390)]);
  const logs = [];
  const out = await run('ubereats', streamFn, logs);
  assert.equal(calls(), 2);
  assert.match(prompts[1], /Your draft_text is 430 characters\. The Uber Eats dispute form takes at most 400 characters/);
  assert.equal(out.draft_text, 'y'.repeat(390));
  assert.doesNotMatch(out.risk_notes || '', /over the/);
  assert.deepEqual(logs.filter((l) => l.event.startsWith('agent_draft_')).map((l) => [l.event, l.chars, l.fits]), [['agent_draft_too_long', 430, undefined], ['agent_draft_shortened', 390, true]]);
});

test('a draft still too long after one retry reaches the operator with a warning', async () => {
  const { streamFn, calls } = fakeModel(['x'.repeat(620), 'y'.repeat(540)]);
  const out = await run('doordash', streamFn);
  assert.equal(calls(), 2, 'only one retry');
  assert.equal(out.draft_text, 'y'.repeat(540));
  assert.match(out.risk_notes, /The draft is 540 characters, over the DoorDash limit of 500\. Shorten it before filing\./);
});

test('a draft within the limit, or on Grubhub, is not sent back', async () => {
  const ok = fakeModel(['x'.repeat(500)]);
  await run('doordash', ok.streamFn);
  assert.equal(ok.calls(), 1, '500 characters fits DoorDash');
  const gh = fakeModel(['x'.repeat(1500)]);
  await run('grubhub', gh.streamFn);
  assert.equal(gh.calls(), 1);
});

test('characters are counted as the operator sees them', () => {
  assert.equal(draftLength('café ☕'), 6);
  assert.equal(draftLength(null), 0);
});
