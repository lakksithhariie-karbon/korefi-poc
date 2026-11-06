// Bundles the extension into dist/. Set TEST_ORIGIN=http://localhost:PORT to also allow a local mock page (tests only).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const shared = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

await Promise.all([
  build({ ...shared, entryPoints: ['src/background.ts'], outfile: 'dist/background.js' }),
  build({ ...shared, entryPoints: ['src/content/index.ts'], outfile: 'dist/content.js' }),
  build({ ...shared, entryPoints: ['src/sidepanel/main.ts'], outfile: 'dist/sidepanel.js' }),
]);

cpSync('src/sidepanel/sidepanel.html', 'dist/sidepanel.html');
cpSync('src/sidepanel/sidepanel.css', 'dist/sidepanel.css');
cpSync('src/ops/ops.js', 'dist/ops.js');
cpSync('src/ops/ops.css', 'dist/ops.css');
cpSync('src/ops/ops-worker.js', 'dist/ops-worker.js');
writeFileSync('dist/background.js', `importScripts(\"ops-worker.js\");\n${readFileSync('dist/background.js','utf8')}`);

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const testOrigin = process.env.TEST_ORIGIN;
if (testOrigin) {
  // Match patterns take no port: "http://localhost/*" covers the mock portal and the fake API server.
  const u = new URL(testOrigin);
  const pattern = `${u.protocol}//${u.hostname}/*`;
  manifest.host_permissions.push(pattern);
  manifest.content_scripts[0].matches.push(pattern);
  // Automation cannot click the toolbar icon, so the test build grants what that click would (activeTab).
  manifest.host_permissions.push('<all_urls>');
  manifest.name += ' (test build)';
}
writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));
console.log(testOrigin ? `built dist/ with test origin ${testOrigin}` : 'built dist/');
