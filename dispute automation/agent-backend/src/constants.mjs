/** The id used for a store that could not be identified. Investigations and logging both work with it. */
export const UNRESOLVED_STORE = 'unresolved';

/** Recorded on every run so an answer can be traced to the instructions that produced it. Bump when the prompt changes. */
export const PROMPT_VERSION = '2026-11-12.key-points-1';

/** The longest dispute text each platform's form takes, in characters (from the ops playbook). Grubhub takes longer texts. */
export const DRAFT_LIMITS = { doordash: 500, ubereats: 400 };

/** What the agent may recommend. Goodwill asks for a reversal without disputing, when the evidence is on the customer's side. */
export const RECOMMENDATIONS = ['dispute', 'goodwill', 'needs_review', 'do_not_dispute'];

/** The tables the chat feature needs. Created by db/migrations/001_conversations.sql, never by the running service. */
export const CONVERSATION_TABLES = ['conversations', 'conversation_messages', 'conversation_runs', 'conversation_state', 'evidence_images'];

/**
 * Which model runs the agent. Vercel AI Gateway when its key is set, Meta's Muse Ember unless AI_MODEL says otherwise
 * (in a test on a real customer photo it found a hair on the box lid that Claude Haiku 5.5 missed); otherwise OpenAI directly, the setup before the
 * gateway, so the service keeps answering until AI_GATEWAY_API_KEY is on Render. Null when neither is configured.
 */
export function modelConfig(env) {
  if (env.AI_GATEWAY_API_KEY) return { provider: 'vercel-ai-gateway', id: env.AI_MODEL || 'meta/muse-ember' };
  if (env.OPENAI_API_KEY) return { provider: 'openai', id: env.OPENAI_MODEL || 'gpt-4.1-mini' };
  return null;
}
