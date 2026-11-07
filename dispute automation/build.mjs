// Bundles the extension into dist/. Set TEST_ORIGIN=http://localhost:PORT to also allow a local mock page (tests only).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const shared = { bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', logLevel: 'info' };
await Promise.all([
  build({ ...shared, entryPoints: ['src/background.ts'], outfile: 'dist/background.js' }),
  build({ ...shared, entryPoints: ['src/content/index.ts'], outfile: 'dist/content.js' }),
]);

cpSync('src/sidepanel/sidepanel.html', 'dist/sidepanel.html');
cpSync('src/sidepanel/sidepanel.css', 'dist/sidepanel.css');
cpSync('src/sidepanel/app.js', 'dist/sidepanel.js');
cpSync('src/sidepanel/logo.png', 'dist/logo.png');
// Google Sans Flex (OFL), bundled so the panel never loads a remote font.
cpSync('src/sidepanel/fonts', 'dist/fonts', { recursive: true });

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const testOrigin = process.env.TEST_ORIGIN;
if (testOrigin) {
  // Match patterns take no port: "http://localhost/*" covers the mock portal and the fake backend.
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
