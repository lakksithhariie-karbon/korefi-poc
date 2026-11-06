import { Agent, run, setDefaultOpenAIClient, setTracingDisabled, type AgentInputItem } from '@openai/agents';
import OpenAI from 'openai';
import type { CaseRecord, Settings } from '../shared/types.ts';

const INSTRUCTIONS = `You help restaurant ops staff decide whether to dispute a DoorDash error charge and draft the dispute text. A person reviews and files it themselves. You never file anything.

Use only what is in the conversation: the parsed order JSON, the page text, the screenshot and values computed by code. Parts of the screenshot are blacked out on purpose to hide personal details.
Never invent evidence, times, POS data or photos. If evidence would help but was not provided, say so and use a bracketed placeholder in the draft, for example [POS ticket time].

Rules of thumb:
- Missing or incorrect item complaints are charged to the merchant by default. A dispute needs proof the item was made and handed off.
- Late, never-delivered or damaged-in-transit issues may be DoorDash's cost. Compare the Dasher's actual and quoted pick-up and drop-off times.
- Issues must be raised within 14 days of the order. Trust the days-left value computed by code.
- If every error charge is already decided (approved or denied), say so briefly and do not draft a dispute.

Reply in markdown, under 220 words unless asked for more, with these sections:
**Issue**: one line.
**Recommendation**: File, Skip or Need evidence, plus confidence (low, medium, high).
**Why**: 2 to 4 short bullets.
**Evidence to attach**: a checklist marking what is available and what is missing.
**Draft**: the dispute text, short and factual, written as "we", naming the order ID, item and amount.
For follow-up questions, answer briefly using the same context.`;

const money = (n: number | null) => (n === null ? 'unknown' : `$${n.toFixed(2)}`);

export function caseContext(c: CaseRecord): string {
  const f = c.facts;
  const status = f.decided
    ? 'already decided'
    : f.expired
      ? 'window expired'
      : f.daysLeft === null
        ? 'unknown'
        : `${f.daysLeft} day(s) left`;
  return [
    `A DoorDash order page was captured (order ${c.orderId}).`,
    '',
    'Computed by code (trust these):',
    `- Dispute window: ${status}${f.deadlineIso ? `, deadline ${f.deadlineIso}` : ''}`,
    `- Open error charges total: ${money(f.errorTotal)}`,
    `- Already decided: ${f.decided ? 'yes' : 'no'}`,
    f.faultHint ? `- Hint: ${f.faultHint}` : '',
    c.imageNote ? `- Screenshot: ${c.imageNote}` : '- Screenshot attached (some regions blacked out on purpose).',
    '',
    'Parsed order (JSON):',
    JSON.stringify(c.snapshot),
    '',
    'Page text (personal names removed):',
    c.redactedText.slice(0, 7000),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function contextMessage(c: CaseRecord): AgentInputItem {
  const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: caseContext(c) }];
  if (c.image) content.push({ type: 'input_image', image: c.image });
  return { role: 'user', content } as AgentInputItem;
}

export class Assistant {
  private thread: AgentInputItem[] = [];

  constructor(private settings: Settings) {}

  /** Rebuild a conversation for an old case so follow-up questions have context. */
  seed(c: CaseRecord): void {
    this.thread = [contextMessage(c)];
    if (c.assessment) {
      this.thread.push({
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: c.assessment }],
      } as AgentInputItem);
    }
  }

  async *send(message: AgentInputItem): AsyncGenerator<string> {
    setTracingDisabled(true);
    setDefaultOpenAIClient(
      new OpenAI({
        apiKey: this.settings.apiKey,
        baseURL: this.settings.baseUrl || undefined,
        dangerouslyAllowBrowser: true,
      }),
    );
    const agent = new Agent({
      name: 'Dispute assistant',
      instructions: INSTRUCTIONS,
      ...(this.settings.model ? { model: this.settings.model } : {}),
    });
    const stream = await run(agent, [...this.thread, message], { stream: true });
    for await (const ev of stream) {
      if (ev.type === 'raw_model_stream_event' && ev.data.type === 'output_text_delta') {
        yield ev.data.delta;
      }
    }
    await stream.completed;
    this.thread = stream.history;
  }
}
