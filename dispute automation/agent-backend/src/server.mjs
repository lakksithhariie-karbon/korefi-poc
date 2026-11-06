import http from 'node:http';
import { createApp, startMaintenance } from './app.mjs';
import { createPgStore } from './data.mjs';
import { investigate } from './agent.mjs';

const PORT = Number(process.env.PORT || 10000);
const store = createPgStore(process.env);
const app = createApp({ store, investigate, env: process.env });
// Create the conversation tables with this service's own role if they are missing. Never blocks or crashes the boot.
await store.ensureConversations();
startMaintenance({ store });

const server = http.createServer(app.handler);
server.requestTimeout = 90000;
server.listen(PORT, '0.0.0.0', () => console.log('KoreFi agent listening on ' + PORT));

process.on('unhandledRejection', (err) => console.error(JSON.stringify({ level: 'error', event: 'unhandled_rejection', message: String(err?.message || err).slice(0, 300) })));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
