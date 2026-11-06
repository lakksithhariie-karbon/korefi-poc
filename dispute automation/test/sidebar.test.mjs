import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');

test('Chrome MV3 manifest uses only sidebar workflow',()=>{
  const m=JSON.parse(read('../manifest.json'));
  assert.equal(m.manifest_version,3);
  assert.equal(m.version,'0.3.0');
  assert.equal(m.side_panel.default_path,'sidepanel.html');
  assert.ok(m.host_permissions.some(x=>x.includes('doordash.com')));
  assert.ok(m.optional_host_permissions.includes('https://*/*'));
});
test('official KoreFi logo and exact three workflow steps',()=>{
  const html=read('../src/sidepanel/sidepanel.html');
  assert.ok(html.includes('https://www.korefi.ai/korefi-logo.png'));
  for(const step of ['Capture full order','Ask about this issue','Prepare dispute response'])
    assert.ok(html.includes(step));
  assert.equal((html.match(/class="step-header"/g)||[]).length,3);
  assert.ok(!html.includes('Ops Queue'));
  assert.ok(!html.includes('Activity log'));
});
test('confirmation requires copied text and distinguishes local from remote sync',()=>{
  const source=read('../src/sidepanel/app.js');
  assert.match(source,/copiedText !== \$\('draft-text'\)\.value\.trim\(\)/);
  assert.match(source,/Persist locally BEFORE attempting network sync/);
  assert.match(source,/if \(!response\.ok\) throw new Error/);
  assert.match(source,/state==='synced' \? 'Dispute logged in KoreFi'/);
  assert.match(source,/findExistingFiling\(current\.orderId\)/);
});
