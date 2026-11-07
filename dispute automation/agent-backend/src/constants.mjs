/** The id used for a store that could not be identified. Investigations and logging both work with it. */
export const UNRESOLVED_STORE = 'unresolved';

/** Recorded on every run so an answer can be traced to the instructions that produced it. Bump when the prompt changes. */
export const PROMPT_VERSION = '2026-11-07.win-1';

/** The tables the chat feature needs. Created by db/migrations/001_conversations.sql, never by the running service. */
export const CONVERSATION_TABLES = ['conversations', 'conversation_messages', 'conversation_runs', 'conversation_state', 'evidence_images'];

/**
 * Which model runs the agent. Vercel AI Gateway when its key is set; otherwise OpenAI directly, the setup before the
 * gateway, so the service keeps answering until AI_GATEWAY_API_KEY is on Render. Null when neither is configured.
 */
export function modelConfig(env) {
  if (env.AI_GATEWAY_API_KEY) return { provider: 'vercel-ai-gateway', id: env.AI_MODEL || 'anthropic/claude-haiku-5.5' };
  if (env.OPENAI_API_KEY) return { provider: 'openai', id: env.OPENAI_MODEL || 'gpt-4.1-mini' };
  return null;
}
