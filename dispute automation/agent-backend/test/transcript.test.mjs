import test from 'node:test';
import assert from 'node:assert/strict';
import { capTranscript, exportTranscript, isFirstTurn } from '../src/transcript.mjs';

const assistant = (text, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', ...extra });
const user = (content) => ({ role: 'user', content, timestamp: 1 });

test('the stored transcript has no system message and no image data', () => {
  const out = exportTranscript([
    { role: 'system', content: 'SYS', toolsAdded: [{ name: 't' }] },
    user([{ type: 'text', text: 'first question' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }, { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }]),
    assistant('answer'),
  ]);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant']);
  const text = JSON.stringify(out);
  assert.ok(!text.includes('AAAA') && !text.includes('BBBB') && !text.includes('"image"'));
  assert.match(text, /2 evidence images attached here/);
  assert.match(text, /first question/);
});

test('a turn that ended in an error or abort is never saved', () => {
  assert.equal(exportTranscript([user('q'), assistant('x', { stopReason: 'error' })]), null);
  assert.equal(exportTranscript([user('q'), assistant('x', { stopReason: 'aborted' })]), null);
  assert.equal(exportTranscript([user('q')]), null);
  assert.equal(exportTranscript([]), null);
});

test('long tool results are cut, and the oldest are blanked when the whole thing is too big', () => {
  const big = 'x'.repeat(20000);
  const tool = (id) => ({ role: 'toolResult', toolCallId: id, toolName: 't', content: [{ type: 'text', text: big }], isError: false, timestamp: 1 });
  const msgs = [user('q'), assistant('a'), tool('1'), tool('2'), tool('3'), assistant('done')];
  const cut = exportTranscript(msgs, 10_000_000);
  assert.ok(cut[2].content[0].text.length < 6100);
  const small = exportTranscript(msgs, 9_000);
  assert.equal(small.length, msgs.length, 'no message is dropped');
  assert.match(small[2].content[0].text, /omitted/);
  assert.ok(JSON.stringify(small).length <= 12_000);
});

test('capTranscript keeps the conversation when there is nothing to blank', () => {
  const msgs = [user('q'), assistant('a')];
  assert.deepEqual(capTranscript(msgs, 1), msgs);
});

test('the output is plain JSON that survives a round trip', () => {
  const out = exportTranscript([user('q'), assistant('a', { usage: { input: 1 }, fn() {} })]);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

test('first turn means no saved messages', () => {
  assert.equal(isFirstTurn([]), true);
  assert.equal(isFirstTurn(null), true);
  assert.equal(isFirstTurn([user('q')]), false);
});
