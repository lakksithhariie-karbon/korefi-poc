import http from 'node:http';
import { createApp } from './app.mjs';
import { createPgStore } from './data.mjs';
import { investigate } from './agent.mjs';

const PORT = Number(process.env.PORT || 10000);
const app = createApp({ store: createPgStore(process.env), investigate, env: process.env });

const server = http.createServer(app.handler);
server.requestTimeout = 90000;
server.listen(PORT, '0.0.0.0', () => console.log('KoreFi agent listening on ' + PORT));

process.on('unhandledRejection', (err) => console.error(JSON.stringify({ level: 'error', event: 'unhandled_rejection', message: String(err?.message || err).slice(0, 300) })));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
