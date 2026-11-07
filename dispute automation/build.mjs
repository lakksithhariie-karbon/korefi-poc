// Bundles the extension into dist/ (or OUT_DIR). Set TEST_ORIGIN=http://localhost:PORT to also allow a local mock page (tests only).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const dir = process.env.OUT_DIR || 'dist';

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const shared = { bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', logLevel: 'info' };
await Promise.all([
  build({ ...shared, entryPoints: ['src/background.ts'], outfile: `${dir}/background.js` }),
  build({ ...shared, entryPoints: ['src/content/index.ts'], outfile: `${dir}/content.js` }),
]);

cpSync('src/sidepanel/sidepanel.html', `${dir}/sidepanel.html`);
cpSync('src/sidepanel/sidepanel.css', `${dir}/sidepanel.css`);
cpSync('src/sidepanel/app.js', `${dir}/sidepanel.js`);
cpSync('src/sidepanel/logo.png', `${dir}/logo.png`);
// Google Sans Flex (OFL), bundled so the panel never loads a remote font.
cpSync('src/sidepanel/fonts', `${dir}/fonts`, { recursive: true });

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const testOrigin = process.env.TEST_ORIGIN;
if (testOrigin) {
  // Match patterns take no port: "http://localhost/*" covers the mock portal and the fake backend.
  const u = new URL(testOrigin);
  const pattern = `${u.protocol}//${u.hostname}/*`;
  manifest.host_permissions.push(pattern);
  manifest.content_scripts[0].matches.push(pattern);
  // Automation cannot press Chrome's "Allow" prompt, so the test build starts with what that press grants (<all_urls>).
  // TEST_NO_GRANT=1 builds it as a fresh install would be, to check the path where the grant is missing.
  if (!process.env.TEST_NO_GRANT) manifest.host_permissions.push('<all_urls>');
  manifest.name += ' (test build)';
}
writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(testOrigin ? `built ${dir}/ with test origin ${testOrigin}` : `built ${dir}/`);
