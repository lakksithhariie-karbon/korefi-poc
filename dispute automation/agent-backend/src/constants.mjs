/** The id used for a store that could not be identified. Investigations and logging both work with it. */
export const UNRESOLVED_STORE = 'unresolved';

/** Recorded on every run so an answer can be traced to the instructions that produced it. Bump when the prompt changes. */
export const PROMPT_VERSION = '2026-11-07.platforms-1';

/** The tables the chat feature needs. Created by db/migrations/001_conversations.sql, never by the running service. */
export const CONVERSATION_TABLES = ['conversations', 'conversation_messages', 'conversation_runs', 'conversation_state', 'evidence_images'];
