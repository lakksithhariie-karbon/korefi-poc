// Saves and restores the agent's own conversation. Pi messages are plain JSON, so a conversation can be stored and
// resumed in a fresh agent. Two rules keep it safe and small:
//   - Image data is never stored in the transcript. Images live in evidence_images and are attached again each turn.
//   - The system prompt and tool list are not stored. They are rebuilt on every resume, so prompt changes take effect.

const MAX_TOOL_TEXT = 6000;
const MAX_TRANSCRIPT_BYTES = 600_000;
const OMITTED = '[older tool result omitted to keep this chat small]';

const clone = (v) => JSON.parse(JSON.stringify(v));

/** The messages to store after a turn, or null when the turn ended badly and must not be saved. */
export function exportTranscript(messages, maxBytes = MAX_TRANSCRIPT_BYTES) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || last.stopReason === 'error' || last.stopReason === 'aborted') return null;

  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user' && Array.isArray(m.content)) {
      const kept = m.content.filter((c) => c.type !== 'image');
      const dropped = m.content.length - kept.length;
      if (dropped) kept.push({ type: 'text', text: `[${dropped} evidence image${dropped > 1 ? 's' : ''} attached here; they are attached again on every turn]` });
      out.push({ ...m, content: kept });
    } else if (m.role === 'toolResult') {
      const content = (m.content || [])
        .filter((c) => c.type !== 'image')
        .map((c) => (c.type === 'text' && c.text.length > MAX_TOOL_TEXT ? { ...c, text: c.text.slice(0, MAX_TOOL_TEXT) + ' …[cut]' } : c));
      out.push({ ...m, content });
    } else {
      out.push(m);
    }
  }
  return capTranscript(clone(out), maxBytes);
}

/** Blanks the oldest tool results until the transcript fits. The conversation itself is never dropped. */
export function capTranscript(messages, maxBytes = MAX_TRANSCRIPT_BYTES) {
  let size = JSON.stringify(messages).length;
  for (let i = 0; i < messages.length && size > maxBytes; i++) {
    const m = messages[i];
    if (m.role !== 'toolResult') continue;
    const before = JSON.stringify(m.content).length;
    m.content = [{ type: 'text', text: OMITTED }];
    size -= before - JSON.stringify(m.content).length;
  }
  return messages;
}

/** True when the saved transcript has no prior turn, so this is the first message of the conversation. */
export const isFirstTurn = (transcript) => !Array.isArray(transcript) || transcript.length === 0;
