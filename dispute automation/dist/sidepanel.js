/* KoreFi Dispute Assistant v0.8 · Chrome capture + Pi agent chats owned by the server.
   No simulated AI answers, no automated DoorDash submission. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = 'https://korefi-pi-dispute-agent.onrender.com';
  const $main = $('main');
  const $thread = $('thread');
  const $prompt = $('prompt');
  let settings = {agentUrl:API,agentToken:'',operatorId:'poc-operator',theme:'dark'};
  let current = null;
  let analysis = null;
  let draftText = '';
  let copiedText = '';
  let draftCopied = false;
  let filing = null;
  let attached = false;
  let busy = false;
  let captureBusy = false;
  let syncBusy = false;
  let activeTab = 'answer';
  let captureTimer = null;
  let progressTimer = null;
  let progressStart = 0;
  let toastTimer = null;
  // The chat lives on the server: the panel sends only the new message, and the agent continues the saved conversation.
  let conversationId = null;
  // The capture whose screenshot is attached to the next message. Null when nothing is attached.
  let attachedCase = null;
  let metaOpen = false;
  let awakeAt = 0;
  let wakePromise = null;

  function hide(id, value = true) { $(id).hidden = value; }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtUSD(n) { return Number.isFinite(Number(n)) ? '$'+Number(n).toFixed(2) : 'Amount unknown'; }
  function icon(name, size=15) {
    const symbols = {
      copy:'<rect x="8" y="8" width="11" height="11" rx="1"/><path d="M16 8V5H5v11h3"/>',
      check:'<path d="M4 12l5 5L20 6"/>',
      search:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 2 16 2 16 0V5M4 12v6c0 3 16 3 16 0v-6"/>',
      arrow:'<path d="M4 12h16m-7-7 7 7-7 7"/>',
      evidence:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
      edit:'<path d="M4 20h16M4 15l11-11 5 5-11 11H4v-5Z"/>',
      warning:'<path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3v.5"/>'
    };
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${symbols[name]||symbols.arrow}</svg>`;
  }
  function toast(s) {
    const el=$('toast');el.textContent=s;el.hidden=!s;clearTimeout(toastTimer);
    if(s)toastTimer=setTimeout(()=>{el.hidden=true;},4300);
  }
  function focusComposer(){ $prompt.focus(); }
  function scrollMain(toTop = false) { $main.scrollTop=toTop?0:$main.scrollHeight; }
  function ready(){ return !!(settings.agentUrl?.trim() && settings.agentToken?.trim()); }
  function connectionUI() {
    $('connectionLabel').textContent=ready()?'Pi set up':'Local';
    $('connectionButton').classList.toggle('connected',ready());
    $('connectionButton').title=ready()?'Pi credentials configured, click to edit':'Connect to Pi agent';
  }
  function theme(to, store=false){
    const next=to==='light'?'light':'dark';
    document.documentElement.setAttribute('data-theme',next);
    document.querySelectorAll('[data-theme-choice]').forEach(b=>{b.classList.toggle('selected',b.dataset.themeChoice===next);b.setAttribute('aria-pressed',String(b.dataset.themeChoice===next));});
    settings.theme=next;
    if(store)void chrome.storage.local.set({settings});
  }
  function showSettings(open){
    hide('settingsPanel',!open);
    $('settingsButton').setAttribute('aria-expanded',String(open));
    if(open){hide('historyPanel');$('agentUrl').value=settings.agentUrl||API;$('agentToken').value=settings.agentToken||'';
      $('operatorId').value=settings.operatorId||'poc-operator';}
    else focusComposer();
  }
  // Everything that belongs to one chat. A new chat, a different order, or an opened conversation all start from here.
  function resetChatState(){
    conversationId=null;analysis=null;draftText='';draftCopied=false;copiedText='';filing=null;attachedCase=null;attached=false;metaOpen=false;
    $thread.replaceChildren();$('evidenceView').replaceChildren();$('draftText').value='';
    hide('empty',false);hide('thread');hide('progress');hide('suggestions');hide('tabs');hide('attachment');hide('draftView');hide('evidenceView');
    hide('confirm');hide('filingState');hide('caseMeta');activeTab='answer';
    $('capture').classList.remove('captured');$prompt.value='';$prompt.style.height='auto';
  }
  function newChat(){
    if(captureBusy||busy){toast('Wait for the agent to finish before starting a new chat.');return;}
    hide('historyPanel');
    resetChatState();current=null;
    $('contextLabel').textContent='DoorDash page';$prompt.placeholder='Ask about a DoorDash order…';
    updateSend();scrollMain(true);focusComposer();
  }
  function updateSend(){
    $('send').disabled=busy||captureBusy||(!$prompt.value.trim()&&!attached);
    $('capture').disabled=captureBusy||busy;
    $('capture').title=captureBusy?'Capturing page…':'Capture and attach DoorDash screenshot';
    $prompt.disabled=busy;
  }
  function setTab(tab){
    activeTab=tab;
    hide('tabs',false);
    document.querySelectorAll('[data-tab]').forEach(b=>{
      const yes=b.dataset.tab===tab;b.classList.toggle('selected',yes);b.setAttribute('aria-selected',String(yes));
    });
    hide('thread',tab!=='answer');
    hide('progress',tab!=='answer'||!busy);
    hide('suggestions',tab!=='answer'||!analysis||busy);
    hide('evidenceView',tab!=='evidence');
    hide('draftView',tab!=='draft');
    if(tab==='evidence')renderEvidence();
    if(tab==='draft')renderDraft();
    scrollMain(tab!=='answer');
  }
  function showThread(){
    hide('empty');hide('thread',false);
    if(activeTab!=='answer')setTab('answer');
  }
  function addUser(text,shotSrc=null){
    showThread();
    const el=document.createElement('div');el.className='user-line';
    const b=document.createElement('div');b.className='user-bubble';
    if(shotSrc){
      const shot=document.createElement('div');shot.className='inline-snapshot';
      const media=document.createElement('div');media.className='shot-thumb';
      const img=document.createElement('img');img.alt='Attached DoorDash screenshot';img.src=shotSrc;media.append(img);
      const meta=document.createElement('div');const name=document.createElement('strong');name.textContent='DoorDash screenshot';
      const small=document.createElement('small');small.textContent=current&&!String(current.orderId||'').startsWith('SCREENSHOT-')?`Order ${current.orderId} · attached`:'Attached to message';
      meta.append(name,small);shot.append(media,meta);b.append(shot);
    }
    const span=document.createElement('span');span.className='chat-text';span.textContent=text;b.append(span);el.append(b);$thread.append(el);scrollMain();
  }
  function addNote(text){
    showThread();
    const el=document.createElement('div');el.className='system-note';el.textContent=text;$thread.append(el);scrollMain();
  }
  function addAssistant(text, type='simple'){
    showThread();
    const el=document.createElement('article');el.className='agent-message';
    const h=document.createElement('div');h.className='agent-head';
    h.innerHTML=`<span class="mini-logo">${icon('arrow',13)}</span><span class="agent-name">KoreFi AI</span><span class="agent-time">Just now</span>`;
    const p=document.createElement('div');p.className='agent-text';p.textContent=text;
    el.append(h,p);$thread.append(el);scrollMain();
    return el;
  }
  function captureAttachment(){
    attached=!!attachedCase?.image;
    if(attached){$('attachmentImage').src=attachedCase.image;
      $('attachmentTitle').textContent=String(attachedCase.orderId||'').startsWith('SCREENSHOT-')?'DoorDash screenshot':`Order ${attachedCase.orderId}`;
      hide('attachment',false);$('capture').classList.add('captured');
    }else{
      hide('attachment');$('capture').classList.remove('captured');
    }
    if(current)$('contextLabel').textContent=String(current.orderId||'').startsWith('SCREENSHOT-')?'Page captured':`Order ${current.orderId}`;
    $prompt.placeholder=attached?'Ask about the attached screenshot…':(current?'Ask about this order…':'Ask about a DoorDash order…');
    updateSend();
  }
  function removeAttachment(){
    attachedCase=null;attached=false;hide('attachment');$('capture').classList.remove('captured');
    $prompt.placeholder=current?'Ask about this order…':'Ask about a DoorDash order…';updateSend();
  }
  async function allCases(){const r=await chrome.storage.local.get('cases');return Array.isArray(r.cases)?r.cases:[];}
  async function getCase(id){return (await allCases()).find(c=>c.id===id)||null;}
  async function patchCase(id,patch){
    const cases=await allCases(),idx=cases.findIndex(c=>c.id===id);
    if(idx<0)throw Error('Capture no longer in browser storage. Capture this order again.');
    cases[idx]={...cases[idx],...patch};await chrome.storage.local.set({cases});
    if(current?.id===id)current=cases[idx];return cases[idx];
  }
  async function findFiling(c){
    if(!c)return null;
    const cases=await allCases();
    return cases.find(x=>x.id===c.id&&x.filing?.confirmedAt)||null;
  }
  async function loadCase(c, fromCapture=false){
    if(!c)return;
    // Capturing the same order again in the middle of a chat adds evidence to that chat instead of replacing it.
    if(fromCapture&&conversationId&&current&&c.orderId===current.orderId){
      attachedCase=c;captureAttachment();
      await patchCase(c.id,{conversationId}).catch(()=>{});
      toast(c.image?'Added to this chat. Send a message to show it to the agent.':(c.imageNote||'Page captured.')+' Send a message to share its text with the agent.');
      return;
    }
    if(fromCapture||(current&&current.id!==c.id))resetChatState();
    current=c;analysis=c.assessment||null;filing=await findFiling(c);
    draftText=analysis?.draft_text||filing?.filing?.draft||'';draftCopied=false;copiedText='';
    attachedCase=c.image&&!c.conversationId?c:null;
    captureAttachment();
    if(fromCapture)toast(c.image?'Screenshot captured and attached. Type a question and send.':(c.imageNote||'Page data captured.')+' You can still investigate.');
    if(filing){renderFiling(filing);}
    caseMetaUI();
  }
  // The order ID is needed to log a filing; the store ID is optional and only unlocks history lookups.
  function caseMetaUI(){
    const placeholder=!!current&&String(current.orderId||'').startsWith('SCREENSHOT-');
    if(!current){hide('caseMeta');return;}
    $('metaOrder').value=placeholder?'':current.orderId;
    $('metaStore').value=current.storeId||'';
    $('metaHint').textContent=placeholder
      ?'The order ID could not be read from the page. Enter it so the dispute can be logged. The store ID is optional.'
      :'The store ID is optional. Without it the agent works from this order and the screenshot alone.';
    hide('caseMeta',!(placeholder||metaOpen));
  }
  async function saveCaseMeta(){
    if(!current)return;
    const orderId=$('metaOrder').value.trim()||current.orderId,storeId=$('metaStore').value.trim();
    if(!/^[A-Za-z0-9._:-]{3,64}$/.test(orderId)||String(orderId).startsWith('SCREENSHOT-')&&!$('metaOrder').value.trim()){toast('Enter the order ID shown on the DoorDash page.');return;}
    if(storeId&&!/^\d{3,32}$/.test(storeId)){toast('The store ID is digits only. Leave it empty if you are unsure.');return;}
    try{await patchCase(current.id,{orderId,storeId:storeId||null});}catch(e){toast(String(e.message||e));return;}
    metaOpen=false;$('contextLabel').textContent=`Order ${orderId}`;caseMetaUI();toast('Saved.');
  }
  function startCapture(){
    captureBusy=true;toast('Capturing the DoorDash page. Keep the order open.');updateSend();
    clearTimeout(captureTimer);captureTimer=setTimeout(()=>{
      if(captureBusy){captureBusy=false;toast('Capture timed out. Keep the DoorDash order open and try again.');updateSend();}
    },60000);
  }
  function endCapture(){captureBusy=false;clearTimeout(captureTimer);captureTimer=null;updateSend();}
  async function capture(){
    if(captureBusy||busy)return;
    let tab;
    try{[tab]=await chrome.tabs.query({active:true,currentWindow:true});}
    catch{toast('Could not access the active tab. Open DoorDash and try again.');return;}
    if(!tab?.id){toast('Open a DoorDash order tab before capturing.');return;}
    if(tab.url&&!/^https?:\/\//i.test(tab.url)){toast('Chrome cannot capture protected browser pages. Open your DoorDash order.');return;}
    startCapture();
    try{await chrome.runtime.sendMessage({type:'CAPTURE_NOW',tabId:tab.id});}
    catch(e){endCapture();toast(`Capture failed: ${String(e.message||e).slice(0,150)}`);}
  }
  function endpointOrigin(value){
    const u=new URL(value.trim());
    if(!(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))||u.username||u.password)
      throw Error('Use a secure HTTPS backend URL (or localhost for testing).');
    return `${u.origin}/*`;
  }
  function scrub(value,key=''){
    // Customer and Dasher details never belong in a request. Item names and order facts are the evidence, so they stay.
    if(/^(customer|dasher|driver)(_?name)?$/i.test(key)||/(phone|e-?mail|address|token|secret|password)/i.test(key))return '[redacted]';
    if(Array.isArray(value))return value.map(v=>scrub(v));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,scrub(v,k)]));
    return value;
  }
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  // A tall screenshot is sent as consecutive slices so the model reads it at a legible size instead of a shrunken strip.
  async function tileScreenshot(dataUri){
    const image=new Image();image.src=dataUri;
    try{await image.decode();}catch{throw Error('Could not process this screenshot. Capture the order again.');}
    const TILE=1400,OVERLAP=80,MAX_HEIGHT=8000;
    const s=Math.min(1,1000/image.naturalWidth,MAX_HEIGHT/image.naturalHeight);
    const w=Math.max(1,Math.round(image.naturalWidth*s)),h=Math.max(1,Math.round(image.naturalHeight*s));
    const tiles=[];
    for(let y=0;y<h;y+=TILE-OVERLAP){
      const th=Math.min(TILE,h-y);
      const canvas=document.createElement('canvas');canvas.width=w;canvas.height=th;
      canvas.getContext('2d').drawImage(image,0,y/s,image.naturalWidth,th/s,0,0,w,th);
      let out=canvas.toDataURL('image/jpeg',.8);
      if(out.length>4_400_000)out=canvas.toDataURL('image/jpeg',.55);
      canvas.width=canvas.height=0;tiles.push(out);
      if(y+TILE>=h)break;
    }
    return tiles;
  }
  function piBase(){const base=settings.agentUrl.trim().replace(/\/+$/,'');endpointOrigin(base);return base;}
  function piHeaders(){return {'Content-Type':'application/json','Authorization':`Bearer ${settings.agentToken.trim()}`};}
  // Render's free plan sleeps when idle. Ping the public health route so the first real request does not pay for the wake-up.
  function wake(){
    if(!settings.agentUrl?.trim())return Promise.resolve();
    if(Date.now()-awakeAt<10*60_000)return Promise.resolve();
    if(wakePromise)return wakePromise;
    wakePromise=fetch(settings.agentUrl.trim().replace(/\/+$/,'')+'/healthz',{signal:AbortSignal.timeout(90000)})
      .then(r=>{if(r.ok)awakeAt=Date.now();}).catch(()=>{}).finally(()=>{wakePromise=null;});
    return wakePromise;
  }
  function describeHttp(status,detail,retry){
    const d=String(detail||'').slice(0,180);
    if(status===401)return 'Agent token was rejected. Update it in Settings.';
    if(status===429)return (d||'The agent is busy.')+(retry?` Try again in ${Math.max(1,Math.ceil(Number(retry)/60))} min.`:'');
    if(status===413)return 'The screenshot is too large to send. Capture the order again.';
    if(status===409)return d||'The agent is still answering your last message.';
    if(status===404)return d||'Not found on the server.';
    if(status===500)return 'The agent hit an error. If chats were just switched on, the database migration may not have been applied yet.';
    if(status===503)return d||'The agent is not available right now. Try again shortly.';
    return `Request failed (HTTP ${status})${d?': '+d:''}`;
  }
  async function piFetch(path,options={}){
    // One key per logical request, reused if the request is retried, so the server does the work once.
    const headers={...piHeaders(),...(options.key?{'Idempotency-Key':options.key}:{})};
    const attempt=()=>fetch(piBase()+path,{method:options.method,body:options.body,headers,signal:AbortSignal.timeout(options.timeout||60000)});
    let response;
    try{response=await attempt();}
    catch{await sleep(4000);try{response=await attempt();}catch{throw Error('Could not reach the KoreFi agent. Check your connection and the backend URL in Settings.');}}
    if(!response.ok){let detail='';try{detail=(await response.json())?.error||'';}catch{}
      throw Error(describeHttp(response.status,detail,response.headers.get('Retry-After')));}
    return response;
  }
  // The investigation runs on the server and is fetched by id, so a slow start or a dropped connection cannot lose it.
  async function pollInvestigation(id){
    const deadline=Date.now()+240000;let misses=0;
    while(Date.now()<deadline){
      await sleep(1500);
      let job;
      try{
        const r=await fetch(`${piBase()}/v1/investigations/${encodeURIComponent(id)}`,{headers:piHeaders(),signal:AbortSignal.timeout(20000)});
        if(r.status===401){const e=Error('Agent token was rejected. Update it in Settings.');e.fatal=true;throw e;}
        if(r.status===404){const e=Error('The server no longer has this investigation. Please send it again.');e.fatal=true;throw e;}
        if(!r.ok)throw Error('HTTP '+r.status);
        job=await r.json();misses=0;
      }catch(e){
        if(e.fatal)throw e;
        if(++misses>=6)throw Error('Lost contact with the agent while it was working. Please send it again.');
        continue;
      }
      if(job.status==='failed')throw Error(job.error||'The investigation failed. Please try again.');
      if(job.status==='completed')return job;
    }
    throw Error('The investigation is taking longer than expected. Please send it again.');
  }
  function caseFacts(c){
    const facts=scrub(c.snapshot||{});
    const reasons=(c.snapshot?.errorCharges||[]).map(x=>x.reason).filter(Boolean);
    const amount=Number(c.facts?.errorTotal??c.snapshot?.errorChargeTotal);
    return {platform:'doordash',operator_id:settings.operatorId||'poc-operator',
      // A missing store ID is fine: the agent still investigates and drafts from the order and screenshot.
      store_id:c.storeId||c.snapshot?.storeId||null,order_id:c.orderId,
      order_url:/^https:\/\/(?:[a-z0-9-]+\.)*doordash\.com\//i.test(c.url||'')?c.url:null,
      issue_category:reasons[0]||null,issue_description:reasons.join('; ').slice(0,1800)||null,
      dispute_amount:Number.isFinite(amount)?Math.abs(amount):null,
      structured_facts:{...facts,extension_rule_estimate:scrub(c.facts||{})},
      redacted_page_text:String(c.redactedText||'').slice(0,11000)||null,
      capture_status:c.image?(c.imageNote?.includes('first ')?'partial':'complete'):'data_only'};
  }
  // Opens the chat on the server the first time something is sent. The redacted screenshot slices are uploaded once, here.
  async function createConversation(shots){
    const created=await (await piFetch('/v1/conversations',{method:'POST',key:crypto.randomUUID(),body:JSON.stringify({...caseFacts(current),screenshots:shots}),timeout:90000})).json();
    if(!created?.conversation_id)throw Error('The agent could not open a chat. Please try again.');
    conversationId=String(created.conversation_id);
    if(created.images_dropped)toast('Image storage is full, so the agent will work from the page text only. Tell an admin.');
    removeAttachment();
    await patchCase(current.id,{conversationId}).catch(()=>{});
  }
  async function callPi(question){
    if(!current)throw Error('Capture an order before starting an investigation.');
    if(!ready())throw Error('Connect your Pi agent in Settings to investigate. Screenshot capture works offline.');
    endpointOrigin(settings.agentUrl.trim());
    await wake();
    const shots=attachedCase?.image?await tileScreenshot(attachedCase.image):[];
    const body={operator_id:settings.operatorId||'poc-operator',text:String(question||'').slice(0,1200),previous_draft:draftText.trim()||null};
    if(!conversationId){
      await createConversation(shots);
    }else if(attachedCase){
      // More evidence for a chat already under way: new images, plus the text of the new capture.
      if(shots.length)body.screenshots=shots;
      if(attachedCase.id!==current.id&&attachedCase.redactedText)body.additional_text=String(attachedCase.redactedText).slice(0,11000);
    }
    const started=await (await piFetch(`/v1/conversations/${encodeURIComponent(conversationId)}/messages`,{method:'POST',key:crypto.randomUUID(),body:JSON.stringify(body),timeout:90000})).json();
    if(started?.images_dropped)toast('Image storage is full, so these images were not saved. The agent will use the text.');
    if(!started?.investigation_id)throw Error('The agent did not accept the message. Please try again.');
    // The server has the images now. Taking the chip away stops a retry from uploading them twice.
    removeAttachment();
    const result=await pollInvestigation(started.investigation_id);
    if(!['dispute','needs_review','do_not_dispute'].includes(result?.recommendation)||!Array.isArray(result.tools_used))
      throw Error('Pi returned an incomplete answer.');
    return result;
  }
  function startProgress(){
    progressStart=Date.now();clearInterval(progressTimer);hide('progress',false);
    $('progress').innerHTML=`<div class="progress-head"><span class="spinner" aria-hidden="true"></span><span>Investigating your order</span><span class="progress-elapsed" id="elapsed">0s</span></div><p class="progress-note" id="progressNote">Pi is checking available financial data, past cases, and evidence. Findings will appear here when the tools finish.</p>`;
    progressTimer=setInterval(()=>{const secs=Math.floor((Date.now()-progressStart)/1000);const t=$('elapsed');if(t)t.textContent=secs+'s';
      const n=$('progressNote');if(n&&secs>=12&&secs<45&&!awakeAt)n.textContent='The agent may be waking up. This can take up to a minute the first time.';},1000);
    scrollMain();
  }
  function stopProgress(){clearInterval(progressTimer);progressTimer=null;hide('progress');}
  const DEFAULT_FOLLOWUPS=['What evidence is missing?','Can you tighten the draft?','Find similar disputes'];
  function showSuggestions(result){
    const asked=(result?.suggested_followups||[]).filter(Boolean).slice(0,4);
    const chips=(asked.length?asked:DEFAULT_FOLLOWUPS).map(text=>({text,run:()=>void send(text)}));
    if(analysis?.draft_text)chips.unshift({text:'Review the dispute draft',run:()=>setTab('draft')});
    if(!filing)chips.push({text:"I've filed it. Mark as disputed",run:()=>setTab('draft')});
    const el=$('suggestions');el.replaceChildren();
    const label=document.createElement('span');label.className='suggest-title';label.textContent='Continue investigating';el.append(label);
    for(const chip of chips){const b=document.createElement('button');b.type='button';b.innerHTML=`${icon('arrow',15)}<span>${esc(chip.text)}</span>`;
      b.addEventListener('click',chip.run);el.append(b);}
    hide('suggestions',false);
  }
  function fmtWhen(iso){try{return new Date(iso).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}catch{return '';}}
  function renderAnalysisCard(result,when='Just now'){
    const label={dispute:'Consider disputing',needs_review:'Needs review',do_not_dispute:'Do not dispute'}[result.recommendation]||'Review';
    const el=document.createElement('article');el.className='agent-message';
    const head=document.createElement('div');head.className='agent-head';head.innerHTML=`<span class="mini-logo">${icon('arrow',13)}</span><span class="agent-name">KoreFi AI</span><span class="agent-time">${esc(when)}</span>`;
    const p=document.createElement('p');p.className='agent-text';p.textContent=result.reasoning_summary||'No reason was provided.';
    const a=document.createElement('div');a.className='assessment';a.innerHTML=`<div class="label">RECOMMENDATION</div><div class="big">${esc(label)}</div>`;
    const missing=Array.isArray(result.missing_evidence)?result.missing_evidence:[];
    const note=document.createElement('div');note.className='evidence-hint';
    const total=(result.tools_used||[]).length;
    note.textContent=`${total} Pi tool ${total===1?'call':'calls'} recorded${missing.length?` · ${missing.length} evidence ${missing.length===1?'gap':'gaps'}`:''}`;
    const actions=document.createElement('div');actions.className='reply-actions';
    actions.innerHTML=`<button type="button" data-copy>${icon('copy')} Copy</button><button type="button" data-evidence>${icon('search')} Evidence</button><button type="button" data-draft>${icon('edit')} Draft</button>`;
    actions.querySelector('[data-copy]').addEventListener('click',()=>void copy(result.reasoning_summary||'', 'Answer copied'));
    actions.querySelector('[data-evidence]').addEventListener('click',()=>setTab('evidence'));
    actions.querySelector('[data-draft]').addEventListener('click',()=>setTab('draft'));
    el.append(head,p,a,note,actions);$thread.append(el);
    return el;
  }
  // The newest answer drives the Evidence and Draft tabs and the suggested next questions.
  function applyAnalysis(result){
    analysis=result;
    if(result.draft_text && !filing && (!draftText || !draftCopied)){
      draftText=result.draft_text;$('draftText').value=draftText;draftCopied=false;copiedText='';hide('confirm');
    }
    hide('tabs',false);showSuggestions(result);scrollMain();
  }
  function addAnalysis(result){renderAnalysisCard(result);applyAnalysis(result);}
  async function run(question){
    if(!current||busy)return;
    const caseId=current.id;
    busy=true;updateSend();showThread();hide('suggestions');toast('');startProgress();
    try{
      const result=await callPi(question);
      if(current?.id!==caseId)return;
      stopProgress();addAnalysis(result);
      awakeAt=Date.now();
      await patchCase(caseId,{assessment:result,conversationId,agentStoreId:result.store_id&&result.store_id!=='unresolved'?result.store_id:(current.storeId||null)}).catch(()=>{});
    }catch(e){stopProgress();const msg=String(e.message||e);addAssistant(msg);toast(msg);}
    finally{busy=false;updateSend();stopProgress();scrollMain();}
  }
  async function send(forced){
    if(busy||captureBusy)return;
    const typed=typeof forced==='string'?forced:$prompt.value.trim();
    const question=typed.trim()||(attached?'Investigate the attached DoorDash order':'');
    if(!question)return;
    if(!current){
      addUser(question);addAssistant('Open a DoorDash order and tap + to capture it. I can investigate as soon as you attach the page.');
      $prompt.value='';updateSend();return;
    }
    if(filing){addAssistant('This chat is already marked as disputed. Start a new chat for another question.');return;}
    if(!ready()){
      toast('Connect Pi once to investigate. Your screenshot remains attached until you send it.');
      showSettings(true);return;
    }
    const shotSrc=attachedCase?.image||null;
    $prompt.value='';$prompt.style.height='auto';
    addUser(question,shotSrc);
    if(activeTab!=='answer')setTab('answer');
    await run(question);
  }
  function renderEvidence(){
    const root=$('evidenceView');root.replaceChildren();
    if(!analysis){root.innerHTML='<span class="section-eyebrow">Investigation</span><h2>Evidence</h2><p class="section-lead">Capture an order and ask KoreFi AI to investigate first.</p>';return;}
    const title=document.createElement('div');title.innerHTML='<span class="section-eyebrow">Investigation sources</span><h2>Evidence reviewed</h2><p class="section-lead">Tool activity reflects actual backend queries. A query returning records is not proof of a successful dispute.</p>';
    root.append(title);
    const friendly={get_order_financials:'DoorDash financial transactions',get_error_charges:'Error charges & adjustments',get_order_issue_reports:'Order issue reports',get_store_patterns:'Historical issue patterns',find_similar_disputes:'Related KoreFi disputes'};
    const calls=analysis.tools_used||[];
    if(!calls.length){const p=document.createElement('p');p.className='section-lead';p.textContent='No completed tool results were reported.';root.append(p);}
    for(const call of calls){
      const card=document.createElement('div');card.className='evidence-card';
      const count=Number(call.count||0);
      card.innerHTML=`<div class="evidence-top">${icon('search')} <span>${esc(friendly[call.name]||call.name)}</span><span class="tiny-status">${count} ${count===1?'record':'records'}</span></div>`;
      const p=document.createElement('p');p.textContent=count>0?`Pi returned ${count} records from this source. See the agent's answer for its interpretation.`:'No matching records were returned by this tool.';card.append(p);root.append(card);
    }
    const missing=Array.isArray(analysis.missing_evidence)?analysis.missing_evidence:[];
    const gap=document.createElement('div');gap.className='evidence-card';
    gap.innerHTML=`<div class="evidence-top">${icon('warning')} Evidence to verify <span class="tiny-status" style="color:var(--brand)">${missing.length} gaps</span></div>`;
    const p=document.createElement('p');p.textContent=missing.length?missing.map(s=>'• '+s).join('\n'):'No missing evidence was listed. Verify the facts independently.';
    gap.append(p);root.append(gap);
    if(analysis.risk_notes){const risk=document.createElement('div');risk.className='evidence-card';risk.innerHTML=`<div class="evidence-top">${icon('warning')} Caveats</div>`;
      const rp=document.createElement('p');rp.textContent=analysis.risk_notes;risk.append(rp);root.append(risk);}
    const draft=document.createElement('button');draft.type='button';draft.className='secondary';draft.textContent='Review dispute draft →';draft.addEventListener('click',()=>setTab('draft'));root.append(draft);
  }
  function renderDraft(){
    $('draftText').value=draftText;
    $('copyDraft').disabled=!draftText.trim();
    $('regenerateDraft').disabled=!current||busy||!!filing;
    $('draftText').disabled=!!filing;
    $('draftHint').textContent=filing?'Submission has already been confirmed for this capture.':
      (analysis?.draft_text?'Verify the draft against DoorDash and supporting records before copying.':'No draft yet. Select Regenerate to request one from Pi.');
    if(filing)renderFiling(filing);
  }
  async function copy(value,message){
    try{await navigator.clipboard.writeText(value);toast(message);return true;}
    catch{toast('Clipboard unavailable. Select and copy the text manually.');return false;}
  }
  async function copyDraft(){
    if(!current||!draftText.trim()){toast('Generate a draft first.');return;}
    const ok=await copy(draftText.trim(),'Draft copied. Submit it in DoorDash, then confirm here.');
    if(ok){draftCopied=true;copiedText=draftText.trim();if(!filing)hide('confirm',false);}
  }
  async function regenerateDraft(){
    if(!current||busy||filing)return;
    const text='Prepare a factual DoorDash dispute draft from the available evidence. Mark unsupported claims with [verify].';
    addUser(text);setTab('answer');await run(text);
    if(analysis?.draft_text){setTab('draft');}
  }
  async function syncFiling(record){
    if(!ready())return {state:'pending',error:'Pi connection missing. Saved in Chrome only.'};
    const url=settings.agentUrl.trim().replace(/\/+$/,'')+'/v1/disputes/confirm';endpointOrigin(url);
    const amount=Number(record.facts?.errorTotal);
    const body={operator_id:settings.operatorId||'poc-operator',conversation_id:record.conversationId||conversationId||null,store_id:record.agentStoreId||record.storeId||null,
      order_id:record.orderId,dispute_text:record.filing.draft,disputed_at:record.filing.confirmedAt,
      order_url:/^https:\/\/(?:[a-z0-9-]+\.)*doordash\.com\//i.test(record.url||'')?record.url:null,
      dispute_amount:Number.isFinite(amount)?Math.abs(amount):null,
      issue_category:(record.snapshot?.errorCharges||[]).map(x=>x.reason).find(Boolean)||null};
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${settings.agentToken.trim()}`},
      body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    if(!response.ok){let message='';try{message=(await response.json())?.error||'';}catch{}
      throw Error(describeHttp(response.status,message,response.headers.get('Retry-After')).replace(/^Request failed/,'Backend returned'));}
    const result=await response.json();
    if(!result?.id||!result?.case_id)throw Error('Backend did not confirm a persisted submission.');
    return {state:'synced',backendId:result.id,error:null};
  }
  function renderFiling(rec){
    if(!rec?.filing)return;
    filing=rec;hide('filingState',false);hide('confirm');
    const synced=rec.filing.syncState==='synced';
    $('filingTitle').textContent=synced?'Dispute logged in KoreFi':'Dispute saved in this browser';
    const date=new Date(rec.filing.confirmedAt).toLocaleString();
    $('filingDescription').textContent=synced?`Confirmed submitted on ${date}. KoreFi's backend accepted the log. DoorDash submission was not automated.`:
      `Confirmed submitted on ${date}. ${rec.filing.syncError||'Database sync pending.'} This is not yet confirmed in Neon.`;
    hide('retrySync',synced);$('retrySync').disabled=syncBusy;
  }
  async function pushFiling(rec){
    if(!rec?.filing||syncBusy||rec.filing.syncState==='synced')return;
    syncBusy=true;renderFiling(rec);
    try{const res=await syncFiling(rec);
      const updated=await patchCase(rec.id,{filing:{...rec.filing,syncState:res.state,backendId:res.backendId||null,syncError:res.error||null,lastSyncAttempt:new Date().toISOString()}});
      renderFiling(updated);
    }catch(e){const updated=await patchCase(rec.id,{filing:{...rec.filing,syncState:'pending',syncError:String(e.message||e),lastSyncAttempt:new Date().toISOString()}});
      renderFiling(updated);
    }finally{syncBusy=false;renderFiling((await getCase(rec.id))||rec);}
  }
  async function confirmSubmitted(){
    if(!current||!draftCopied||copiedText!==draftText.trim()){toast('Copy the final draft before confirming DoorDash submission.');return;}
    if(filing){renderFiling(filing);return;}
    const prior=await findFiling(current);if(prior){filing=prior;renderFiling(prior);return;}
    const duplicate=(await allCases()).find(x=>x.id!==current.id&&x.orderId===current.orderId &&
      x.storeId===current.storeId && x.filing?.confirmedAt && !String(x.orderId).startsWith('SCREENSHOT-'));
    if(duplicate){filing=duplicate;renderFiling(duplicate);toast('This order already has a local filing confirmation.');return;}
    const data={confirmedAt:new Date().toISOString(),draft:copiedText,syncState:'pending',syncError:null,lastSyncAttempt:null,backendId:null};
    const rec=await patchCase(current.id,{status:'filed',filing:data,agentStoreId:current.agentStoreId||current.storeId||null});
    filing=rec;renderFiling(rec);toast('Submission confirmed locally. Syncing to KoreFi…');
    await pushFiling(rec);
    renderDraft();
  }
  // ---- history: every chat on the server, newest first ----
  async function imageDataUrl(convId,imageId){
    const r=await fetch(`${piBase()}/v1/conversations/${encodeURIComponent(convId)}/images/${encodeURIComponent(imageId)}`,{headers:{'Authorization':`Bearer ${settings.agentToken.trim()}`},signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw Error('Image unavailable');
    const blob=await r.blob();
    return await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=reject;fr.readAsDataURL(blob);});
  }
  async function localCaseFor(conv){
    const found=(await allCases()).find(c=>c.conversationId===String(conv.id));
    if(found)return found;
    // Opened on a browser that never captured this order: keep a minimal local record so drafting and logging work here too.
    const rec={id:`conv-${conv.id}`,orderId:conv.order_id,storeId:conv.store_id&&conv.store_id!=='unresolved'?conv.store_id:null,conversationId:String(conv.id),
      createdAt:conv.created_at,trigger:'manual',url:'',snapshot:{orderId:conv.order_id,errorCharges:[],errorChargeTotal:null,disputeStatus:null},redactedText:'',
      image:null,imageNote:null,facts:{errorTotal:Number(conv.error_amount)||0,deadlineIso:null,daysLeft:null,expired:false,decided:false,openErrorCharges:[],faultHint:null},assessment:null,status:'new'};
    const cases=await allCases();const rest=cases.filter(c=>c.id!==rec.id);
    await chrome.storage.local.set({cases:[rec,...rest].slice(0,120)});
    return rec;
  }
  async function openConversation(id){
    if(busy||captureBusy){toast('Wait for the agent to finish first.');return;}
    const detail=await (await piFetch(`/v1/conversations/${encodeURIComponent(id)}`,{timeout:30000})).json();
    const conv=detail.conversation;
    resetChatState();
    conversationId=String(conv.id);
    current=await localCaseFor(conv);
    const local=current.filing?.confirmedAt?current:null;
    filing=local||(conv.status==='disputed'?{id:current.id,filing:{confirmedAt:conv.updated_at,draft:'',syncState:'synced',syncError:null}}:null);
    hide('historyPanel');showThread();
    // Evidence images saved with the chat, for review on any device.
    if(detail.images?.length){
      const strip=document.createElement('div');strip.className='evidence-strip';
      const label=document.createElement('span');label.textContent=`${detail.images.length} evidence image${detail.images.length===1?'':'s'}`;strip.append(label);
      $thread.append(strip);
      for(const image of detail.images){
        const b=document.createElement('button');b.type='button';b.className='strip-thumb';b.title='View image';strip.append(b);
        imageDataUrl(conv.id,image.id).then(src=>{const img=document.createElement('img');img.alt='Evidence image';img.src=src;b.append(img);b.addEventListener('click',()=>openLightbox(src));}).catch(()=>b.remove());
      }
    }
    let last=null;
    for(const m of detail.messages){
      if(m.role==='user')addUser(m.text);
      else if(m.role==='assistant'){last=m.result||{recommendation:'needs_review',reasoning_summary:m.text,tools_used:[],missing_evidence:[]};renderAnalysisCard(last,fmtWhen(m.created_at));}
      else addNote(m.text);
    }
    draftText=last?.draft_text||'';draftCopied=false;copiedText='';
    if(last)applyAnalysis(last);else hide('tabs',false);
    if(filing)renderFiling(filing);
    attachedCase=null;captureAttachment();caseMetaUI();
    if(detail.running){busy=true;updateSend();startProgress();void watchRunning(conv.id);}
    scrollMain();
  }
  // A message sent from another window or before a reload may still be running. Wait for it, then show the answer.
  async function watchRunning(id){
    const deadline=Date.now()+240000;
    while(Date.now()<deadline){
      await sleep(3000);
      try{const d=await (await piFetch(`/v1/conversations/${encodeURIComponent(id)}`,{timeout:20000})).json();
        if(!d.running){busy=false;stopProgress();updateSend();await openConversation(id);return;}
      }catch{}
    }
    busy=false;stopProgress();updateSend();toast('The agent is taking longer than expected. Reopen the chat in a minute.');
  }
  function renderHistory(list){
    const root=$('historyList');root.replaceChildren();
    if(!list.length){const p=document.createElement('p');p.className='section-lead';p.textContent='No chats yet. Capture a DoorDash order and ask a question to start one.';root.append(p);return;}
    const label={dispute:'Consider disputing',needs_review:'Needs review',do_not_dispute:'Do not dispute'};
    for(const c of list){
      const b=document.createElement('button');b.type='button';b.className='history-item';if(c.id===conversationId)b.classList.add('current');
      const chips=[];
      if(c.status==='disputed')chips.push('<span class="history-chip done">Disputed</span>');
      if(c.last_recommendation)chips.push(`<span class="history-chip">${esc(label[c.last_recommendation]||c.last_recommendation)}</span>`);
      b.innerHTML=`<span class="history-title">${esc(c.title||('Order '+c.order_id))}</span><span class="history-meta">Order ${esc(c.order_id)} · ${esc(fmtWhen(c.updated_at))}${c.created_by?' · '+esc(c.created_by):''}</span><span class="history-chips">${chips.join('')}</span>`;
      b.addEventListener('click',()=>void openConversation(c.id).catch(e=>toast(String(e.message||e))));
      root.append(b);
    }
  }
  async function openHistory(){
    hide('settingsPanel');hide('historyPanel',false);
    const root=$('historyList');
    if(!ready()){root.innerHTML='<p class="section-lead">Connect your Pi agent in Settings to see your chats.</p>';return;}
    root.innerHTML='<p class="section-lead">Loading chats…</p>';
    try{await wake();const data=await (await piFetch('/v1/conversations?limit=50',{timeout:60000})).json();renderHistory(data.conversations||[]);}
    catch(e){root.innerHTML='';const p=document.createElement('p');p.className='section-lead';p.textContent=String(e.message||e);root.append(p);}
  }
  async function saveSettings(){
    const url=$('agentUrl').value.trim()||API,token=$('agentToken').value.trim();
    const operatorId=$('operatorId').value.trim()||'poc-operator';
    try{
      const origin=endpointOrigin(url);
      if(token && token.length<32)throw Error('The Pi pilot token must be at least 32 characters.');
      if(origin!==new URL(API).origin+'/*'){
        const ok=await chrome.permissions.request({origins:[origin]});
        if(!ok)throw Error('Chrome permission is required for this backend address.');
      }
      settings={...settings,agentUrl:url,agentToken:token,operatorId};
      await chrome.storage.local.set({settings});connectionUI();showSettings(false);awakeAt=0;void wake();
      toast(token?'Pi credentials saved. You can investigate now.':'Settings saved. Capture works without Pi.');
    }catch(e){toast(String(e.message||e));}
  }
  function openLightbox(src){if(!src)return;$('lightboxImage').src=src;hide('lightbox',false);$('closeLightbox').focus();}
  function closeLightbox(){hide('lightbox');focusComposer();}

  $('officialLogo').addEventListener('error',()=>{hide('officialLogo');hide('logoFallback',false);});
  $('newChat').addEventListener('click',newChat);
  $('historyButton').addEventListener('click',()=>{if($('historyPanel').hidden)void openHistory();else hide('historyPanel');});
  $('closeHistory').addEventListener('click',()=>hide('historyPanel'));
  $('settingsButton').addEventListener('click',()=>showSettings($('settingsPanel').hidden));
  $('connectionButton').addEventListener('click',()=>showSettings(true));
  $('closeSettings').addEventListener('click',()=>showSettings(false));
  $('saveSettings').addEventListener('click',()=>void saveSettings());
  document.querySelectorAll('[data-theme-choice]').forEach(b=>b.addEventListener('click',()=>theme(b.dataset.themeChoice,true))); 
  $('capture').addEventListener('click',()=>void capture());
  $('removeAttachment').addEventListener('click',removeAttachment);
  $('saveMeta').addEventListener('click',()=>void saveCaseMeta());
  const ctx=document.querySelector('.context-indicator');
  ctx.setAttribute('role','button');ctx.setAttribute('tabindex','0');ctx.style.cursor='pointer';ctx.title='Order and store ID';
  const toggleMeta=()=>{if(!current)return;metaOpen=!metaOpen;caseMetaUI();};
  ctx.addEventListener('click',toggleMeta);ctx.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggleMeta();}});
  $('viewAttachment').addEventListener('click',()=>openLightbox(attachedCase?.image));
  $('closeLightbox').addEventListener('click',closeLightbox);
  $('lightbox').addEventListener('click',e=>{if(e.target===e.currentTarget)closeLightbox();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!$('lightbox').hidden)closeLightbox();else if(!$('historyPanel').hidden)hide('historyPanel');else if(!$('settingsPanel').hidden)showSettings(false);}});
  $('chatForm').addEventListener('submit',e=>{e.preventDefault();void send();});
  $prompt.addEventListener('input',()=>{$prompt.style.height='auto';$prompt.style.height=Math.max(43,Math.min($prompt.scrollHeight,115))+'px';updateSend();});
  $prompt.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('chatForm').requestSubmit();}});
  document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>setTab(b.dataset.tab)));
  document.querySelectorAll('[data-query]').forEach(b=>b.addEventListener('click',()=>{$prompt.value=b.dataset.query;updateSend();focusComposer();}));
  $('draftText').addEventListener('input',()=>{draftText=$('draftText').value;if(draftCopied){draftCopied=false;copiedText='';hide('confirm');toast('Draft changed. Copy it again before confirming.');}
    $('copyDraft').disabled=!draftText.trim();});
  $('copyDraft').addEventListener('click',()=>void copyDraft());
  $('regenerateDraft').addEventListener('click',()=>void regenerateDraft());
  $('notYet').addEventListener('click',()=>{hide('confirm');toast('Not marked as disputed. Submit in DoorDash first.');});
  $('yesFiled').addEventListener('click',()=>void confirmSubmitted().catch(e=>toast(String(e.message||e))));
  $('retrySync').addEventListener('click',()=>{if(filing)void pushFiling(filing);});
  chrome.runtime.onMessage.addListener(message=>{
    if(message?.type==='CASE_CAPTURED'){
      endCapture();
      void getCase(message.caseId).then(async c=>{
        if(c){
          // Preserve existing messages so capture can happen at any moment in chat.
          await loadCase(c,true);
          if(!$('empty').hidden){ /* keep the focused home state until user sends */ }
          focusComposer();
        }else toast('Captured data not found. Retry the screenshot.');
      }).catch(e=>toast(String(e.message||e)));
    } else if(message?.type==='CAPTURE_FAILED'){
      endCapture();toast(message.reason||'Could not capture the page.');
    }
    return false;
  });
  async function init(){
    const data=await chrome.storage.local.get(['settings','cases']);
    settings={...settings,...(data.settings||{})};
    delete settings.apiKey;delete settings.loggingToken;delete settings.loggingUrl;delete settings.model;
    theme(settings.theme||'dark');connectionUI();if(ready())void wake();
    const cases=Array.isArray(data.cases)?data.cases:[];
    if(cases.length){
      const latest=cases[0];
      // Reopen the chat you were in. If it cannot be reached, fall back to the captured order.
      if(latest.conversationId&&ready()){
        try{await openConversation(latest.conversationId);}catch{await loadCase(latest,false);}
      }else await loadCase(latest,false);
    }
    updateSend();
  }
  void init().catch(e=>toast(`Could not initialize: ${String(e.message||e)}`));
})();
