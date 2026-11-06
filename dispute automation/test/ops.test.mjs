import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Service-worker regression tests run without browser or npm dependencies.
const workerCode = readFileSync(new URL('../src/ops/ops-worker.js', import.meta.url), 'utf8');
const mockCase = (id, orderId, createdAt, extra = {}) => ({
  id, orderId, createdAt, snapshot: { placedAt:'2026-11-01T10:00' },
  facts: {errorTotal:15}, status:'new', image:null, assessment:null, ...extra,
});
function setup(records) {
  let onChange;
  const state = {cases: records};
  let handle;
  const chrome = {storage:{onChanged:{addListener(fn){onChange=fn}}, local:{
    async get(){return state},async set(patch){Object.assign(state,patch);}
  }}};
  runInNewContext(workerCode,{chrome,setTimeout(fn){handle=fn},clearTimeout(){},console});
  return {state, notify(){onChange({cases:true},'local')}, async flush(){await handle()}};
}
test('normalizes repeat capture but retains filed workflow and reference',async()=>{
  const env=setup([
    mockCase('newer','ORD-1','2026-11-03T12:00:00Z',{image:'new image'}),
    mockCase('old','ORD-1','2026-11-02T12:00:00Z',{status:'filed',ops:{reference:'DD-123',audit:[{action:'Filed'}]},assessment:'reviewed'}),
  ]);
  env.notify();await env.flush();
  assert.equal(env.state.cases.length,1);
  assert.equal(env.state.cases[0].status,'filed');
  assert.equal(env.state.cases[0].ops.reference,'DD-123');
  assert.equal(env.state.cases[0].image,'new image');
});
test('does not collapse order refs with different placement timestamps',async()=>{
  const env=setup([
    mockCase('a','SHORT','2026-11-02T12:00:00Z'),
    mockCase('b','SHORT','2026-11-03T12:00:00Z',{snapshot:{placedAt:'2026-11-03T10:00'}}),
  ]);
  env.notify();await env.flush();assert.equal(env.state.cases.length,2);
});
test('extension metadata includes new ops files',()=>{
  const m=JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url),'utf8'));
  assert.equal(m.manifest_version,3);
  assert.ok(readFileSync(new URL('../src/sidepanel/sidepanel.html',import.meta.url),'utf8').includes('ops.js'));
});
