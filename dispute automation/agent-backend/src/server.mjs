import http from 'node:http';
import { createApp, startMaintenance } from './app.mjs';
import { createPgStore } from './data.mjs';
import { investigate } from './agent.mjs';

const PORT = Number(process.env.PORT || 10000);
const logLine = (level, event, extra = {}) => console.log(JSON.stringify({ level, event, ...extra }));

const store = createPgStore(process.env);
const app = createApp({ store, investigate, env: process.env });

const server = http.createServer(app.handler);
// Render's proxy keeps connections open for 60s; a shorter server timeout makes it send requests down a closed socket (502s).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 90_000;

// Chats need their tables, which are created by migrations, never by this service. Report, do not block, if they are missing.
await store.ensureConversations().catch(() => {});
startMaintenance({ store });

server.listen(PORT, '0.0.0.0', () => logLine('info', 'listening', { port: PORT, commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null }));

// A deploy sends SIGTERM. Stop taking new connections, let answers already being written finish, then leave cleanly.
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logLine('info', 'shutting_down', { signal, runs: app.running.size });
  server.close();
  const clean = await app.drain(25_000);
  logLine(clean ? 'info' : 'warn', clean ? 'drained' : 'drain_timeout', { runs: app.running.size });
  await store.close?.().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Anything that escapes is logged, and a truly unexpected exception exits so the platform restarts a clean process.
process.on('unhandledRejection', (err) => logLine('error', 'unhandled_rejection', { message: String(err?.message || err).slice(0, 300) }));
process.on('uncaughtException', (err) => {
  logLine('error', 'uncaught_exception', { message: String(err?.message || err).slice(0, 300) });
  process.exit(1);
});
