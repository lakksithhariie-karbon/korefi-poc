/* KoreFi Ops Queue: all records stay in Chrome local storage. No submission automation. */
(() => {
  'use strict';
  const $$ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
  const POLICY_DAYS = 14; // Validate against merchant agreement before relying on it.
  let cases = [], selected = null, filter = 'all', search = '';
  let operator = '';
  let writing = false;
  let refreshRequested = false;
  const storage = chrome.storage.local;

  function daysLeft(c) {
    if (!c?.snapshot?.placedAt) return null;
    const t = new Date(c.snapshot.placedAt).getTime();
    if (!Number.isFinite(t)) return null;
    return Math.ceil((t + POLICY_DAYS * 86400000 - Date.now()) / 86400000);
  }
  const decided = (c) => !!c?.facts?.decided;
  const amount = (c) => Number(c?.facts?.errorTotal || 0);
  const claimType = (c) => {
    const s = (c.snapshot?.errorCharges || []).map(e => e.reason || '').join(' ').toLowerCase();
    return /missing|incorrect|wrong|quality|order /.test(s) ? 'merchant' :
      /late|never|not delivered|damaged|spilled|cold/.test(s) ? 'delivery' : 'unknown';
  };
  const neededEvidence = (c) => {
    const type = claimType(c);
    const all = [{ id:'order', name:'Order screenshot', detected: !!c.image, note:'Captured with personal details redacted' }];
    if (type === 'merchant') all.push(
      {id:'pos', name:'POS / preparation ticket', detected:false, note:'Check item was prepared correctly'},
      {id:'handoff', name:'Handoff evidence', detected:false, note:'Confirm it was handed to the Dasher'}
    );
    else if (type === 'delivery') all.push({id:'times', name:'Pickup / delivery timing', detected:!!(c.snapshot?.pickedUp?.actual && c.snapshot?.droppedOff?.actual), note:'Verify timestamps against the portal'});
    else all.push({id:'support', name:'Supporting documentation', detected:false, note:'Identify why this charge should be disputed'});
    return all;
  };
  function evidenceReady(c) {
    return neededEvidence(c).every(e => e.detected || c.ops?.evidence?.[e.id] === true);
  }
  function decision(c) {
    if (decided(c)) return { type:'skip', label:'Already decided', why:'DoorDash reports that all error charges have been decided.' };
    if (amount(c) <= 0) return { type:'skip', label:'No open charge', why:'No open error charge amount was identified.' };
    const left = daysLeft(c);
    if (left !== null && left < 0) return { type:'skip', label:'Deadline passed', why:'The configured 14-day window has passed. Verify actual portal eligibility.' };
    if (left === null) return { type:'review', label:'Verify deadline', why:'Order date could not be read. Confirm eligibility in DoorDash.' };
    if (!evidenceReady(c)) return { type:'review', label:'Collect evidence', why:'The evidence checklist needs confirmation before filing.' };
    return { type:'candidate', label:'Ready for review', why:'Amount, deadline and evidence checks pass. A human must confirm responsibility before filing.' };
  }
  function priority(c) {
    if (['filed','won','lost','skipped'].includes(c.status) || decision(c).type === 'skip') return 3;
    const left = daysLeft(c);
    return left !== null && left <= 3 ? 0 : decision(c).type === 'candidate' ? 1 : 2;
  }
  function badge(c) {
    const d = decision(c);
    return `<span class="ops-tag ${d.type}">${esc(d.label)}</span>`;
  }
  function recordHistory(c, action, detail = '') {
    c.ops ??= {};
    c.ops.audit ??= [];
    c.ops.audit.push({ at: new Date().toISOString(), by: operator || 'Unassigned', action, detail });
    c.ops.audit = c.ops.audit.slice(-100);
  }
  async function persist(mutator) {
    if (writing) return;
    writing = true;
    try {
      const obj = await storage.get('cases');
      const items = obj.cases || [];
      const current = items.find(c => c.id === selected);
      if (!current) { notify('This case is no longer stored.'); return; }
      mutator(current);
      current.ops ??= {};
      current.ops.updatedAt = new Date().toISOString();
      await storage.set({cases: items});
      cases = items;
      render();
    } catch (error) { notify(`Could not save case: ${error.message}`); }
    finally { writing = false; }
  }
  async function load() {
    const value = await storage.get(['cases','opsUser']);
    cases = value.cases || [];
    operator = value.opsUser || '';
    if ($$('ops-user') && document.activeElement !== $$('ops-user')) $$('ops-user').value = operator;
    if (!selected && cases[0]) selected = cases[0].id;
    if (selected && !cases.find(c => c.id === selected)) selected = cases[0]?.id || null;
    render();
  }
  function notify(message) {
    const el = $$('ops-alert');
    el.hidden = !message;
    el.textContent = message || '';
  }
  function render() {
    if (!$$('ops-list')) return;
    const actionable = cases.filter(c => !['filed','won','lost','skipped'].includes(c.status) && decision(c).type !== 'skip').length;
    const urgent = cases.filter(c => priority(c) === 0).length;
    const recoverable = cases.filter(c => ['new'].includes(c.status)).reduce((sum,c) => sum+amount(c), 0);
    $$('ops-stats').innerHTML = `<div><b>${cases.length}</b><span>Cases on this browser</span></div><div><b>${actionable}</b><span>Needs action</span></div><div><b>${urgent}</b><span>Near deadline</span></div><div><b>${usd(recoverable)}</b><span>Open charges</span></div>`;
    const visible = cases.filter(c => {
      const d = decision(c);
      const ok = filter === 'all' ||
        (filter === 'urgent' && priority(c) === 0) ||
        (filter === 'review' && !['filed','won','lost','skipped'].includes(c.status) && d.type === 'review') ||
        (filter === 'ready' && !['filed','won','lost','skipped'].includes(c.status) && d.type === 'candidate') ||
        (filter === 'filed' && c.status === 'filed') ||
        (filter === 'closed' && ['won','lost','skipped'].includes(c.status));
      return ok && `${c.orderId} ${c.snapshot?.errorCharges?.map(e => e.reason).join(' ')} ${c.ops?.reference || ''}`.toLowerCase().includes(search);
    }).sort((a,b) => priority(a)-priority(b) || (daysLeft(a) ?? 9999)-(daysLeft(b) ?? 9999) || new Date(b.createdAt)-new Date(a.createdAt));
    $$('ops-list').innerHTML = visible.length ? visible.map(c => {
      const left = daysLeft(c);
      const d = decision(c);
      return `<button class="ops-case ${selected===c.id?'selected':''}" type="button" data-case="${esc(c.id)}"><span class="ops-case-head"><b>${esc(c.orderId)}</b>${badge(c)}</span><span>${usd(amount(c))} · ${left===null?'Deadline unknown':left<0?'Deadline passed':`${left} day(s) remaining`} · ${esc(c.status)}</span><small>${esc(c.snapshot?.errorCharges?.map(e=>e.reason).filter(Boolean).join(', ')||'Reason not captured')}</small></button>`;
    }).join('') : '<p class="ops-hint">No cases match these filters.</p>';
    for (const el of $$('ops-list').querySelectorAll('[data-case]')) el.addEventListener('click', () => { selected = el.dataset.case; render(); });
    renderDetail();
  }
  function renderDetail() {
    const c = cases.find(x => x.id === selected);
    const el = $$('ops-detail');
    if (!c) {el.innerHTML = '<p class="ops-hint">Capture a DoorDash order to start your ops queue.</p>'; return;}
    const d = decision(c), left = daysLeft(c);
    const docs = neededEvidence(c);
    const evidence = docs.map(e => `<label class="ops-check"><input type="checkbox" data-evidence="${e.id}" ${e.detected || c.ops?.evidence?.[e.id]?'checked':''} ${e.detected?'disabled':''}><span><b>${esc(e.name)}</b><small>${e.detected?'Detected in captured order. ':''}${esc(e.note)}${!e.detected?'. Tick only after personally verifying the evidence.':''}</small></span></label>`).join('');
    const statuses = ['new','filed','won','lost','skipped'];
    const saved = c.ops || {};
    const closed = ['won','lost','skipped'].includes(c.status);
    el.innerHTML = `
      <div class="ops-detail-top"><h2>Order ${esc(c.orderId)}</h2>${badge(c)}</div>
      <p class="ops-reason">${esc(d.why)}</p>
      <div class="ops-detail-stats"><span><b>${usd(amount(c))}</b><small>Open charge</small></span><span><b>${left===null?'Unknown':left<0?'Expired':`${left}d`}</b><small>Window remaining*</small></span><span><b>${esc(c.status)}</b><small>Internal status</small></span></div>
      <div class="ops-help">* The 14-day window is an unverified POC rule. Confirm the actual deadline and dispute eligibility in DoorDash.</div>
      <h3>Evidence checklist</h3>${evidence}
      <div class="ops-help">Checks record a human verification, not an uploaded file. Keep attachments in the merchant portal or your approved evidence system.</div>
      <h3>Dispute workflow</h3>
      <label>Assigned operator<input id="ops-assignee" type="text" maxlength="100" value="${esc(saved.assignee || '')}" placeholder="Ops owner"></label>
      <label>DoorDash dispute reference<input id="ops-reference" type="text" maxlength="120" value="${esc(saved.reference || '')}" placeholder="Reference after submitting"></label>
      <label>Notes<textarea id="ops-notes" rows="3" maxlength="2000" placeholder="Evidence source, rationale, next action">${esc(saved.notes || '')}</textarea></label>
      <div class="ops-buttons"><button id="ops-save" type="button">Save details</button><button id="ops-open" type="button">Open DoorDash order</button></div>
      <div class="ops-buttons"><button id="ops-filed" type="button" class="ops-primary" ${closed || c.status==='filed' || d.type!=='candidate' ? 'disabled':''}>Confirm filed in DoorDash</button><button id="ops-skip" type="button" ${closed || c.status==='filed'?'disabled':''}>Skip case</button></div>
      ${c.status==='filed'?'<p class="ops-help">Filed is manually confirmed. The extension never submits on your behalf.</p>':''}
      <h3>Outcome and recovery</h3>
      <div class="ops-buttons"><button id="ops-won" type="button" ${c.status!=='filed'&&c.status!=='won'?'disabled':''}>Mark won</button><button id="ops-lost" type="button" ${c.status!=='filed'&&c.status!=='lost'?'disabled':''}>Mark lost</button></div>
      <label>Recovered credit amount (USD)<input id="ops-recovered" type="number" min="0" step="0.01" value="${saved.recoveredAmount == null ? '' : esc(saved.recoveredAmount)}" placeholder="Actual credited amount"></label>
      <label class="ops-inline"><input id="ops-credit" type="checkbox" ${saved.creditReceived?'checked':''}> Credit received / reconciled</label>
      <button id="ops-reconcile" type="button" ${c.status!=='won'?'disabled':''}>Save recovery</button>
      <details class="ops-history"><summary>Activity history (${saved.audit?.length || 0})</summary>${(saved.audit||[]).slice().reverse().map(x => `<p><b>${esc(x.action)}</b> · ${esc(x.by)}<br><small>${esc(new Date(x.at).toLocaleString())} ${esc(x.detail||'')}</small></p>`).join('')||'<p>No activity recorded yet.</p>'}</details>`;
    for (const checkbox of el.querySelectorAll('[data-evidence]')) checkbox.addEventListener('change', (event) => {
      const id = event.target.dataset.evidence, checked = event.target.checked;
      void persist(x => { x.ops ??= {}; x.ops.evidence ??= {}; x.ops.evidence[id] = checked; recordHistory(x, checked?'Evidence verified':'Evidence unverified', id); });
    });
    $$('ops-save').addEventListener('click', () => void persist(x => {
      x.ops ??= {};
      x.ops.assignee = $$('ops-assignee').value.trim();
      x.ops.reference = $$('ops-reference').value.trim();
      x.ops.notes = $$('ops-notes').value.trim();
      recordHistory(x,'Case details updated');
      notify('Case details saved.');
    }));
    $$('ops-open').addEventListener('click', () => {
      if (/^https:\/\/([^/]+\.)?doordash\.com\//i.test(c.url)) chrome.tabs.create({url:c.url});
      else notify('Cannot open an unverified DoorDash URL.');
    });
    $$('ops-filed').addEventListener('click', () => {
      const ref = $$('ops-reference').value.trim();
      if (!ref) return notify('Enter the DoorDash dispute reference before confirming submission.');
      if (!confirm('Confirm you submitted this dispute in DoorDash? The extension has NOT submitted anything.')) return;
      void persist(x => { x.status='filed'; x.ops ??= {}; x.ops.reference=ref; x.ops.filedAt=new Date().toISOString(); x.ops.assignee=$$('ops-assignee').value.trim(); x.ops.notes=$$('ops-notes').value.trim(); recordHistory(x,'Dispute filed manually',ref); notify('Filing recorded.'); });
    });
    $$('ops-skip').addEventListener('click', () => {if (confirm('Skip this dispute and record the decision?')) void persist(x => {x.status='skipped';recordHistory(x,'Skipped manually');});});
    $$('ops-won').addEventListener('click', () => void persist(x => {x.status='won';recordHistory(x,'Marked won','Await credit reconciliation');}));
    $$('ops-lost').addEventListener('click', () => void persist(x => {x.status='lost';recordHistory(x,'Marked lost');}));
    $$('ops-reconcile').addEventListener('click', () => {
      const received = $$('ops-credit').checked;
      const input = $$('ops-recovered').value.trim();
      const value = input === '' ? null : Number(input);
      if (value !== null && (!Number.isFinite(value) || value < 0)) return notify('Recovery amount must be a non-negative number.');
      if (received && value === null) return notify('Enter the actual recovered amount before marking the credit received.');
      void persist(x => { x.ops ??= {}; x.ops.creditReceived=received; x.ops.recoveredAmount=value; recordHistory(x,'Recovery updated',`${received?'Credit received':'Credit not confirmed'}; ${value===null?'amount unknown':usd(value)}`); });
    });
  }
  function exportCsv() {
    const headers=['order_id','placed_at','captured_at','charge_usd','days_left_today','recommendation','internal_status','assignee','dispute_reference','filed_at','credit_received','recovered_usd','notes','evidence_confirmed','last_updated'];
    const rows=cases.map(c => [c.orderId,c.snapshot?.placedAt||'',c.createdAt,amount(c),daysLeft(c)??'',decision(c).label,c.status,c.ops?.assignee||'',c.ops?.reference||'',c.ops?.filedAt||'',c.ops?.creditReceived?'yes':'no',c.ops?.recoveredAmount??'',c.ops?.notes||'',neededEvidence(c).filter(e=>e.detected||c.ops?.evidence?.[e.id]).map(e=>e.id).join(';'),c.ops?.updatedAt||'']);
    const csv=[headers,...rows].map(row=>row.map(s=>`"${String(s).replace(/"/g,'""')}"`).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob(['\ufeff',csv],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download=`korefi-ops-disputes-${new Date().toISOString().slice(0,10)}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function mount() {
    const ops = document.createElement('main');ops.id='ops';ops.hidden=true;
    ops.innerHTML=`<div class="ops-intro"><div><h2>Dispute operations</h2><p>Review each charge, verify evidence and track your actual recovery.</p></div><button id="ops-export" type="button">Export CSV</button></div>
      <div class="ops-stats" id="ops-stats"></div><div id="ops-alert" role="status" hidden></div>
      <div class="ops-controls"><input id="ops-query" type="search" placeholder="Search orders or reference" aria-label="Search cases"><select id="ops-filter" aria-label="Filter cases"><option value="all">All cases</option><option value="urgent">Near deadline</option><option value="review">Needs review</option><option value="ready">Ready to review</option><option value="filed">Filed</option><option value="closed">Closed</option></select></div>
      <div class="ops-workspace"><div class="ops-queue" id="ops-list"></div><div class="ops-detail" id="ops-detail"></div></div>
      <div class="ops-footer"><label>Operator name (stored on this browser)<input id="ops-user" type="text" maxlength="80" placeholder="Enter your name"></label><p>Local pilot only. No cross-device sync, centralized audit or automatic filing.</p></div>`;
    const caseMain=$$('cases');caseMain.insertAdjacentElement('afterend',ops);
    const tab=document.createElement('button');tab.type='button';tab.dataset.tab='ops';tab.setAttribute('role','tab');tab.setAttribute('aria-selected','false');tab.textContent='Ops Queue';document.querySelector('.tabs').append(tab);
    // Existing Chat/Cases listeners were installed before this tab existed.
    // Switch all surfaces explicitly for Ops, and respect programmatic navigation back to Chat.
    tab.addEventListener('click', () => {
      $('chat').hidden = true;
      $('cases').hidden = true;
      ops.hidden = false;
      document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b === tab)));
      void load();
    });
    document.querySelectorAll('.tabs button:not([data-tab="ops"])').forEach(b => b.addEventListener('click', () => { ops.hidden = true; }));
    const sync = () => { if (!$('chat').hidden || !$('cases').hidden) ops.hidden = true; };
    new MutationObserver(sync).observe($('chat'), {attributes:true,attributeFilter:['hidden']});
    new MutationObserver(sync).observe($('cases'), {attributes:true,attributeFilter:['hidden']});
    $$('ops-query').addEventListener('input', e=>{search=e.target.value.toLowerCase().trim();render();});
    $$('ops-filter').addEventListener('change',e=>{filter=e.target.value;render();});
    $$('ops-export').addEventListener('click',exportCsv);
    $$('ops-user').addEventListener('change',async e=>{operator=e.target.value.trim();await storage.set({opsUser:operator});notify('Operator saved for this browser.');});
    chrome.storage.onChanged.addListener((change,area)=>{if(area==='local' && change.cases && !writing){if(!refreshRequested){refreshRequested=true;setTimeout(()=>{refreshRequested=false;void load();},160);}}});
    void load();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mount,{once:true}); else mount();
})();
