/* KoreFi side panel v0.10 · a chat with the KoreFi agent about the DoorDash or Uber Eats order on screen.
   Chats live on the server. No simulated AI answers, no automated submission on any platform. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = 'https://korefi-pi-dispute-agent.onrender.com';
  const $main = $('main');
  const $thread = $('thread');
  const $prompt = $('prompt');
  let settings = {agentUrl:API,agentToken:'',operatorId:'poc-operator',theme:'system'};
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
  let sheet = null;

  const ICONS = {
    copy:'<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    check:'<path d="M20 6 9 17l-5-5"/>',
    draft:'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    sources:'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  const VERDICT = {dispute:'Dispute',needs_review:'Needs review',do_not_dispute:'Do not dispute'};
  const PLATFORMS = {
    doordash:{name:'DoorDash',url:/^https:\/\/(?:[a-z0-9-]+\.)*doordash\.com\//i,store:/^\d{3,32}$/},
    ubereats:{name:'Uber Eats',url:/^https:\/\/(?:[a-z0-9-]+\.)*(?:ubereats|uber)\.com\//i,store:/^[A-Za-z0-9-]{3,64}$/},
    grubhub:{name:'Grubhub',url:/^https:\/\/(?:[a-z0-9-]+\.)*grubhub\.com\//i,store:/^[A-Za-z0-9-]{3,64}$/}
  };
  // Captures made before platforms were added are DoorDash.
  const platformOf = c => PLATFORMS[c?.platform]?c.platform:'doordash';
  const platformName = c => PLATFORMS[platformOf(c)].name;
  const orderUrl = c => PLATFORMS[platformOf(c)].url.test(c?.url||'')?c.url:null;
  const photosOf = c => Array.isArray(c?.photos)?c.photos:[];
  const SOURCE_NAMES = {get_order_financials:'DoorDash transactions',get_error_charges:'Error charges and adjustments',get_order_issue_reports:'Order issue reports',
    get_store_patterns:'Store issue history',find_similar_disputes:'Similar KoreFi disputes'};

  function hide(id, value = true) { $(id).hidden = value; }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  const isPlaceholder = c => String(c?.orderId||'').startsWith('SCREENSHOT-');
  const plural = (n, one, many) => `${n} ${n===1?one:many}`;
  const trimDot = s => String(s).replace(/[.\s]+$/,'');
  function toast(s) {
    const el=$('toast');el.textContent=s;el.hidden=!s;clearTimeout(toastTimer);
    if(s)toastTimer=setTimeout(()=>{el.hidden=true;},4000);
  }
  function focusComposer(){ if(!sheet&&!drawerOpen())$prompt.focus(); }
  function scrollMain(toTop = false) { $main.scrollTop=toTop?0:$main.scrollHeight; }
  function ready(){ return !!(settings.agentUrl?.trim() && settings.agentToken?.trim()); }
  function connectionUI() {
    $('connectionDot').classList.toggle('connected',ready());
    $('connectionDot').title=ready()?'Connected':'Not connected';
  }
  // System follows the operating system. Light or dark is an explicit choice.
  function theme(to, store=false){
    const next=['light','dark'].includes(to)?to:'system';
    document.documentElement.classList.add('no-motion');
    if(next==='system')document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',next);
    requestAnimationFrame(()=>requestAnimationFrame(()=>document.documentElement.classList.remove('no-motion')));
    document.querySelectorAll('[data-theme-choice]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.themeChoice===next)));
    settings.theme=next;
    if(store)void chrome.storage.local.set({settings});
  }

  // ---- drawer and sheets ----
  function drawerOpen(){ return $('historyPanel').classList.contains('open'); }
  function setDrawer(open){
    const d=$('historyPanel');
    d.classList.toggle('open',open);d.inert=!open;
    $('historyButton').setAttribute('aria-expanded',String(open));
    if(open){hide('scrim',false);requestAnimationFrame(()=>$('scrim').classList.add('open'));void loadHistory();$('closeHistory').focus();}
    else{$('scrim').classList.remove('open');setTimeout(()=>{if(!drawerOpen())hide('scrim');},200);$('historyButton').focus();}
  }
  function openSheet(name){
    const ids={draft:'draftView',evidence:'evidenceView',settings:'settingsPanel'};
    for(const [k,id] of Object.entries(ids))hide(id,k!==name);
    sheet=name;
    if(name==='draft')renderDraft();
    if(name==='evidence')renderEvidence();
    if(name==='settings'){
      $('agentUrl').value=settings.agentUrl||API;$('agentToken').value=settings.agentToken||'';$('operatorId').value=settings.operatorId||'poc-operator';
      $('connection').open=!ready();
    }
    if(drawerOpen())setDrawer(false);
    $(ids[name]).querySelector('.sheet-head .icon-button').focus();
  }
  function closeSheet(){
    if(!sheet)return;
    hide('draftView');hide('evidenceView');hide('settingsPanel');sheet=null;focusComposer();
  }

  // Everything that belongs to one chat. A new chat, a different order, or an opened conversation all start from here.
  function resetChatState(){
    conversationId=null;analysis=null;draftText='';draftCopied=false;copiedText='';filing=null;attachedCase=null;attached=false;metaOpen=false;
    $thread.replaceChildren();$('evidenceBody').replaceChildren();$('draftText').value='';
    hide('empty',false);hide('thread');hide('progress');hide('suggestions');hide('attachment');
    hide('confirm');hide('filingState');hide('caseMeta');closeSheet();
    $('capture').classList.remove('captured');$prompt.value='';$prompt.style.height='';
  }
  function newChat(){
    if(captureBusy||busy){toast('Wait for the agent to finish first');return;}
    if(drawerOpen())setDrawer(false);
    resetChatState();current=null;orderUI();
    updateSend();scrollMain(true);focusComposer();
  }
  function updateSend(){
    $('send').disabled=busy||captureBusy||(!$prompt.value.trim()&&!attached);
    $('capture').disabled=captureBusy||busy;
    $('capture').title=captureBusy?'Attaching…':'Attach this page';
    $prompt.disabled=busy;
  }
  function showThread(){ hide('empty');hide('thread',false); }
  function addUser(text,shotSrcs=[]){
    showThread();
    const el=document.createElement('div');el.className='user-line';
    if(shotSrcs.length){
      const row=document.createElement('div');row.className='shot-row';
      shotSrcs.forEach((src,i)=>{
        const b=document.createElement('button');b.type='button';b.className='shot-thumb';b.setAttribute('aria-label',i?'View customer photo':'View attached page');
        const img=document.createElement('img');img.alt='';img.src=src;b.append(img);
        b.addEventListener('click',()=>openLightbox(src));row.append(b);
      });
      el.append(row);
    }
    const bubble=document.createElement('div');bubble.className='user-bubble';
    const span=document.createElement('span');span.className='chat-text';span.textContent=text;bubble.append(span);
    el.append(bubble);$thread.append(el);scrollMain();
  }
  function addNote(text){
    showThread();
    const el=document.createElement('div');el.className='system-note';el.textContent=text;$thread.append(el);scrollMain();
  }
  // Plain replies from the panel itself, such as errors. They are not agent assessments.
  function addAssistant(text, error=false){
    showThread();
    const el=document.createElement('article');el.className='agent-message'+(error?' is-error':'');
    const p=document.createElement('p');p.className='agent-text';p.textContent=text;
    el.append(p);$thread.append(el);scrollMain();
    return el;
  }

  // ---- order context ----
  function orderUI(){
    const chip=$('orderChip');
    if(!current){chip.hidden=true;hide('caseMeta');return;}
    chip.hidden=false;
    chip.textContent=isPlaceholder(current)?'Add order ID':`Order ${current.orderId}`;
    chip.classList.toggle('needs-input',isPlaceholder(current));
    chip.title='Order and store ID';
    caseMetaUI();
  }
  // The order ID is needed to log a filing; the store ID is optional and only unlocks history lookups.
  function caseMetaUI(){
    if(!current){hide('caseMeta');$('orderChip').setAttribute('aria-expanded','false');return;}
    const placeholder=isPlaceholder(current);
    $('metaOrder').value=placeholder?'':current.orderId;
    $('metaStore').value=current.storeId||'';
    $('metaHint').textContent=placeholder
      ?'The order ID could not be read from the page. Enter it so the dispute can be logged.'
      :platformOf(current)==='doordash'?'The store ID is optional. It lets the agent check this store’s history.':'The store ID is optional.';
    const open=placeholder||metaOpen;
    hide('caseMeta',!open);$('orderChip').setAttribute('aria-expanded',String(open));
  }
  async function saveCaseMeta(){
    if(!current)return;
    const orderId=$('metaOrder').value.trim()||current.orderId,storeId=$('metaStore').value.trim();
    if(!/^[A-Za-z0-9._:-]{3,64}$/.test(orderId)||isPlaceholder({orderId})){toast(`Enter the order ID shown on the ${platformName(current)} page`);return;}
    if(storeId&&!PLATFORMS[platformOf(current)].store.test(storeId)){toast(platformOf(current)==='doordash'?'The store ID is digits only. Leave it empty if you are unsure':'That does not look like a store ID. Leave it empty if you are unsure');return;}
    try{await patchCase(current.id,{orderId,storeId:storeId||null});}catch(e){toast(String(e.message||e));return;}
    metaOpen=false;orderUI();toast('Saved');
  }

  function captureAttachment(){
    attached=!!attachedCase?.image;
    if(attached){$('attachmentImage').src=attachedCase.image;
      const n=photosOf(attachedCase).length;
      $('attachmentTitle').textContent=(isPlaceholder(attachedCase)?`${platformName(attachedCase)} page`:`Order ${attachedCase.orderId}`)+(n?` · ${plural(n,'customer photo','customer photos')}`:'');
      hide('attachment',false);$('capture').classList.add('captured');
    }else{
      hide('attachment');$('capture').classList.remove('captured');
    }
    $prompt.placeholder=attached?'Ask about this page':'Ask about this order';
    orderUI();updateSend();
  }
  function removeAttachment(){
    attachedCase=null;attached=false;hide('attachment');$('capture').classList.remove('captured');
    $prompt.placeholder='Ask about this order';updateSend();
  }
  async function allCases(){const r=await chrome.storage.local.get('cases');return Array.isArray(r.cases)?r.cases:[];}
  async function getCase(id){return (await allCases()).find(c=>c.id===id)||null;}
  async function patchCase(id,patch){
    const cases=await allCases(),idx=cases.findIndex(c=>c.id===id);
    if(idx<0)throw Error('This capture is no longer in the browser. Attach the order again.');
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
      toast(c.image?(c.imageNote?`Attached. ${c.imageNote}`:'Attached. Send a message to share it'):`${trimDot(c.imageNote||'Page read')}. Send a message to share it`);
      return;
    }
    if(fromCapture||(current&&current.id!==c.id))resetChatState();
    current=c;analysis=c.assessment||null;filing=await findFiling(c);
    draftText=analysis?.draft_text||filing?.filing?.draft||'';draftCopied=false;copiedText='';
    attachedCase=c.image&&!c.conversationId?c:null;
    captureAttachment();
    if(fromCapture&&!c.image)toast(`${trimDot(c.imageNote||'Page read without a screenshot')}. You can still ask about it`);
    else if(fromCapture&&c.imageNote)toast(c.imageNote);
    if(filing)renderFiling(filing);
  }
  function startCapture(){
    captureBusy=true;updateSend();
    clearTimeout(captureTimer);captureTimer=setTimeout(()=>{
      if(captureBusy){captureBusy=false;toast('Attaching took too long. Keep the order open and try again');updateSend();}
    },60000);
  }
  function endCapture(){captureBusy=false;clearTimeout(captureTimer);captureTimer=null;updateSend();}
  // Screenshots need Chrome's <all_urls> grant (or a fresh toolbar click on that tab). Asked once, from the + tap.
  const SEE_TABS={origins:['<all_urls>']};
  let canSeeTabs=false,askingAccess=false;
  const checkTabAccess=()=>chrome.permissions.contains(SEE_TABS).then(v=>{canSeeTabs=v;},()=>{canSeeTabs=false;});
  function onCaptureClick(){
    if(captureBusy||busy||askingAccess)return;
    // Chrome shows its prompt only during a click, so ask before anything awaits.
    const asked=canSeeTabs?null:chrome.permissions.request(SEE_TABS).catch(()=>false);
    void capture(asked);
  }
  async function capture(asked=null){
    if(captureBusy||busy)return;
    if(asked){askingAccess=true;try{canSeeTabs=await asked;}finally{askingAccess=false;}}
    let tab;
    try{[tab]=await chrome.tabs.query({active:true,currentWindow:true});}
    catch{toast('Could not reach this tab. Open the order and try again');return;}
    if(!tab?.id){toast('Open an order first');return;}
    if(tab.url&&!/^https?:\/\//i.test(tab.url)){toast('Chrome does not allow capturing this page. Open the order');return;}
    startCapture();
    try{await chrome.runtime.sendMessage({type:'CAPTURE_NOW',tabId:tab.id});}
    catch(e){endCapture();toast(`Could not attach the page: ${String(e.message||e).slice(0,150)}`);}
  }

  // ---- talking to the agent ----
  function endpointOrigin(value){
    const u=new URL(value.trim());
    if(!(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))||u.username||u.password)
      throw Error('Use a secure HTTPS address (or localhost for testing).');
    return `${u.origin}/*`;
  }
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  // A tall screenshot is sent as consecutive slices so the model reads it at a legible size instead of a shrunken strip.
  async function tileScreenshot(dataUri){
    const image=new Image();image.src=dataUri;
    try{await image.decode();}catch{throw Error('Could not process this screenshot. Attach the order again.');}
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
    if(status===401)return 'The access token was rejected. Update it in Settings.';
    if(status===429)return (d||'The agent is busy.')+(retry?` Try again in ${Math.max(1,Math.ceil(Number(retry)/60))} min.`:'');
    if(status===413)return 'The screenshot is too large to send. Attach the order again.';
    if(status===409)return d||'The agent is still answering your last message.';
    if(status===404)return d||'Not found on the server.';
    if(status===500)return 'The agent hit an error. Try again in a moment.';
    if(status===503)return d||'The agent is not available right now. Try again shortly.';
    return `Request failed (HTTP ${status})${d?': '+d:''}`;
  }
  async function piFetch(path,options={}){
    // One key per logical request, reused if the request is retried, so the server does the work once.
    const headers={...piHeaders(),...(options.key?{'Idempotency-Key':options.key}:{})};
    const attempt=()=>fetch(piBase()+path,{method:options.method,body:options.body,headers,signal:AbortSignal.timeout(options.timeout||60000)});
    let response;
    try{response=await attempt();}
    catch{await sleep(4000);try{response=await attempt();}catch{throw Error('Could not reach the KoreFi agent. Check your connection, or the agent URL in Settings.');}}
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
        if(r.status===401){const e=Error('The access token was rejected. Update it in Settings.');e.fatal=true;throw e;}
        if(r.status===404){const e=Error('The server lost this answer. Send your message again.');e.fatal=true;throw e;}
        if(!r.ok)throw Error('HTTP '+r.status);
        job=await r.json();misses=0;
      }catch(e){
        if(e.fatal)throw e;
        if(++misses>=6)throw Error('Lost contact with the agent while it was working. Send your message again.');
        continue;
      }
      if(job.status==='failed')throw Error(job.error||'The agent could not finish. Try again.');
      if(job.status==='completed')return job;
    }
    throw Error('This is taking longer than expected. Send your message again.');
  }
  // The charge as the page states it ("Chargeback amount", "Error charge total"). The extension's own estimate is only a
  // fallback: it adds up per-item amounts and reads 0 when the page gives none, as Uber Eats often does.
  function chargeAmount(c){
    const page=c?.snapshot?.errorChargeTotal;
    if(page!=null&&Number.isFinite(Number(page)))return Number(page);
    const estimate=Number(c?.facts?.errorTotal);
    return estimate>0?estimate:NaN;
  }
  function caseFacts(c){
    const facts=c.snapshot||{};
    const reasons=(c.snapshot?.errorCharges||[]).map(x=>x.reason).filter(Boolean);
    const amount=chargeAmount(c);
    const photos=photosOf(c).length;
    return {platform:platformOf(c),operator_id:settings.operatorId||'poc-operator',
      // A missing store ID is fine: the agent still investigates and drafts from the order and screenshot.
      store_id:c.storeId||c.snapshot?.storeId||null,order_id:c.orderId,
      order_url:orderUrl(c),
      issue_category:reasons[0]||null,issue_description:reasons.join('; ').slice(0,1800)||null,
      dispute_amount:Number.isFinite(amount)?Math.abs(amount):null,
      // The server is told which images are customer photos: they always come first.
      structured_facts:{...facts,extension_rule_estimate:c.facts||{},attached_images:{customer_photos:photos}},
      redacted_page_text:String(c.redactedText||'').slice(0,11000)||null,
      capture_status:c.image?(c.imageNote?.includes('first ')?'partial':'complete'):'data_only'};
  }
  // Opens the chat on the server the first time something is sent. The screenshot slices are uploaded once, here.
  async function createConversation(shots){
    const created=await (await piFetch('/v1/conversations',{method:'POST',key:crypto.randomUUID(),body:JSON.stringify({...caseFacts(current),screenshots:shots}),timeout:90000})).json();
    if(!created?.conversation_id)throw Error('The agent could not start a chat. Try again.');
    conversationId=String(created.conversation_id);
    if(created.images_dropped)toast('Image storage is full, so the agent will use the page text only');
    removeAttachment();
    await patchCase(current.id,{conversationId}).catch(()=>{});
  }
  async function callPi(question){
    if(!current)throw Error('Attach an order before asking.');
    if(!ready())throw Error('Connect the agent in Settings first.');
    endpointOrigin(settings.agentUrl.trim());
    await wake();
    // Customer photos first, at full size, then the page as slices. The server is told the split.
    const photos=attachedCase?.image?photosOf(attachedCase):[];
    const shots=attachedCase?.image?[...photos,...await tileScreenshot(attachedCase.image)]:[];
    const body={operator_id:settings.operatorId||'poc-operator',text:String(question||'').slice(0,1200),previous_draft:draftText.trim()||null};
    if(!conversationId){
      await createConversation(shots);
    }else if(attachedCase){
      // More evidence for a chat already under way: new images, plus the text of the new capture.
      if(shots.length)body.screenshots=shots;
      const described=shots.length?`Images attached with this message: ${photos.length?`${plural(photos.length,'customer photo','customer photos')} first, then `:''}${plural(shots.length-photos.length,'slice','slices')} of the order page, top to bottom.`:'';
      const pageText=attachedCase.id!==current.id&&attachedCase.redactedText?String(attachedCase.redactedText).slice(0,10500):'';
      if(described||pageText)body.additional_text=[described,pageText].filter(Boolean).join('\n');
    }
    const started=await (await piFetch(`/v1/conversations/${encodeURIComponent(conversationId)}/messages`,{method:'POST',key:crypto.randomUUID(),body:JSON.stringify(body),timeout:90000})).json();
    if(started?.images_dropped)toast('Image storage is full, so these images were not saved');
    if(!started?.investigation_id)throw Error('The agent did not accept the message. Try again.');
    // The server has the images now. Taking the chip away stops a retry from uploading them twice.
    removeAttachment();
    const result=await pollInvestigation(started.investigation_id);
    if(!['dispute','needs_review','do_not_dispute'].includes(result?.recommendation)||!Array.isArray(result.tools_used))
      throw Error('The agent returned an incomplete answer. Try again.');
    return result;
  }
  // Short waits show nothing. Past a moment, a quiet indicator; past ten seconds, the elapsed time.
  function startProgress(){
    progressStart=Date.now();clearInterval(progressTimer);
    const el=$('progress');
    el.innerHTML='<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>Looking into it</span><span class="elapsed" id="elapsed"></span>';
    progressTimer=setInterval(()=>{
      const secs=Math.floor((Date.now()-progressStart)/1000);
      if(secs>=2&&el.hidden){hide('progress',false);scrollMain();}
      const t=$('elapsed');if(t)t.textContent=secs>=10?secs+'s':'';
      if(secs>=12&&!awakeAt&&!$('wakeNote')){
        const n=document.createElement('p');n.className='thinking-note';n.textContent='The agent is starting up. The first answer can take a minute.';
        el.after(n);n.id='wakeNote';
      }
    },500);
  }
  function stopProgress(){clearInterval(progressTimer);progressTimer=null;hide('progress');$('wakeNote')?.remove();}
  const DEFAULT_FOLLOWUPS=['What evidence is missing?','Make the draft shorter','Find similar disputes'];
  function showSuggestions(result){
    const asked=(result?.suggested_followups||[]).filter(Boolean).slice(0,3);
    const chips=(asked.length?asked:DEFAULT_FOLLOWUPS).map(text=>({text,run:()=>void send(text)}));
    if(!filing&&draftText.trim())chips.push({text:`I filed it in ${platformName(current)}`,run:()=>openSheet('draft')});
    const el=$('suggestions');el.replaceChildren();
    for(const chip of chips){const b=document.createElement('button');b.type='button';b.textContent=chip.text;
      b.addEventListener('click',chip.run);el.append(b);}
    hide('suggestions',false);
  }
  function fmtWhen(iso){try{return new Date(iso).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}catch{return '';}}
  function renderAnalysisCard(result){
    const el=document.createElement('article');el.className='agent-message';
    const verdict=document.createElement('span');verdict.className=`assessment ${result.recommendation}`;
    const big=document.createElement('span');big.className='big';big.textContent=VERDICT[result.recommendation]||'Review';verdict.append(big);
    const p=document.createElement('p');p.className='agent-text';p.textContent=result.reasoning_summary||'No reason was given.';
    const sources=(result.tools_used||[]).length,gaps=Array.isArray(result.missing_evidence)?result.missing_evidence.length:0;
    const meta=document.createElement('p');meta.className='meta';
    meta.textContent=[sources?plural(sources,'source checked','sources checked'):'',gaps?plural(gaps,'thing to verify','things to verify'):''].filter(Boolean).join(' · ');
    const actions=document.createElement('div');actions.className='reply-actions';
    const copyBtn=document.createElement('button');copyBtn.type='button';copyBtn.className='icon-button';copyBtn.title='Copy';copyBtn.setAttribute('aria-label','Copy answer');copyBtn.innerHTML=icon('copy');
    copyBtn.addEventListener('click',async()=>{if(await copy(result.reasoning_summary||'')){copyBtn.innerHTML=icon('check');setTimeout(()=>{copyBtn.innerHTML=icon('copy');},1500);}});
    actions.append(copyBtn);
    if(result.draft_text){const d=document.createElement('button');d.type='button';d.className='text-button';d.dataset.open='draft';d.innerHTML=`${icon('draft')}<span>Draft</span>`;
      d.addEventListener('click',()=>openSheet('draft'));actions.append(d);}
    const s=document.createElement('button');s.type='button';s.className='text-button';s.dataset.open='evidence';s.innerHTML=`${icon('sources')}<span>Sources</span>`;
    s.addEventListener('click',()=>openSheet('evidence'));actions.append(s);
    el.append(verdict,p);if(meta.textContent)el.append(meta);el.append(actions);$thread.append(el);
    return el;
  }
  // The newest answer drives the draft, the sources and the suggested next questions.
  function applyAnalysis(result){
    analysis=result;
    if(result.draft_text && !filing && (!draftText || !draftCopied)){
      draftText=result.draft_text;$('draftText').value=draftText;draftCopied=false;copiedText='';hide('confirm');
    }
    showSuggestions(result);scrollMain();
  }
  function addAnalysis(result){showThread();renderAnalysisCard(result);applyAnalysis(result);}
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
    }catch(e){stopProgress();addAssistant(String(e.message||e),true);}
    finally{busy=false;updateSend();stopProgress();scrollMain();}
  }
  async function send(forced){
    if(busy||captureBusy)return;
    const typed=typeof forced==='string'?forced:$prompt.value.trim();
    const question=typed.trim()||(attached?'Can I dispute this order?':'');
    if(!question)return;
    if(!current){
      addUser(question);addAssistant('Open an order in DoorDash or Uber Eats and tap + to attach it. Then I can look into it.');
      $prompt.value='';$prompt.style.height='';updateSend();return;
    }
    if(filing){addAssistant('This chat is marked as disputed. Start a new chat for anything else.');return;}
    if(!ready()){
      toast('Connect the agent once to start. Your attachment stays here');
      openSheet('settings');return;
    }
    const shotSrcs=attachedCase?.image?[attachedCase.image,...photosOf(attachedCase)]:[];
    $prompt.value='';$prompt.style.height='';
    addUser(question,shotSrcs);
    await run(question);
  }
  function renderEvidence(){
    const root=$('evidenceBody');root.replaceChildren();
    const lead=document.createElement('p');lead.className='lead';root.append(lead);
    if(!analysis){lead.textContent='Ask about an order first.';return;}
    lead.textContent='What the agent looked at for its last answer. Records found are not proof a dispute will succeed.';
    const calls=analysis.tools_used||[];
    if(!calls.length){const p=document.createElement('p');p.className='hint';p.textContent='The agent answered from the attached page only.';root.append(p);}
    const list=document.createElement('div');
    for(const call of calls){
      const row=document.createElement('div');row.className='source';const count=Number(call.count||0);
      row.innerHTML=`<span>${esc(SOURCE_NAMES[call.name]||call.name)}</span><span>${count?plural(count,'record','records'):'Nothing found'}</span>`;
      list.append(row);
    }
    root.append(list);
    const missing=Array.isArray(analysis.missing_evidence)?analysis.missing_evidence:[];
    if(missing.length){
      const h=document.createElement('h3');h.className='section-title';h.textContent='To verify';
      const ul=document.createElement('ul');ul.className='plain-list';
      for(const m of missing){const li=document.createElement('li');li.textContent=m;ul.append(li);}
      root.append(h,ul);
    }
    if(analysis.risk_notes){
      const h=document.createElement('h3');h.className='section-title';h.textContent='Caveats';
      const p=document.createElement('p');p.className='lead';p.textContent=analysis.risk_notes;root.append(h,p);
    }
  }
  function renderDraft(){
    $('draftText').value=draftText;
    $('copyDraft').disabled=!draftText.trim();
    $('regenerateDraft').disabled=!current||busy||!!filing;
    $('draftText').disabled=!!filing;
    const where=platformName(current);
    $('draftLead').textContent=`Check every claim, then submit it in ${where} yourself.`;
    $('confirmTitle').textContent=`Did you submit this in ${where}?`;
    $('confirmText').textContent=`Confirm only after ${where} accepts it. KoreFi records it, it does not submit anything.`;
    $('draftHint').textContent=filing?'':(draftText.trim()?`Check it against ${where} before you copy it.`:'No draft yet. Ask for one, or write a new draft.');
    if(filing)renderFiling(filing);
  }
  async function copy(value,message=''){
    try{await navigator.clipboard.writeText(value);if(message)toast(message);return true;}
    catch{toast('Could not copy. Select the text and copy it yourself');return false;}
  }
  async function copyDraft(){
    if(!current||!draftText.trim()){toast('There is no draft yet');return;}
    const ok=await copy(draftText.trim(),`Copied. Submit it in ${platformName(current)}, then confirm here`);
    if(ok){draftCopied=true;copiedText=draftText.trim();if(!filing)hide('confirm',false);}
  }
  async function regenerateDraft(){
    if(!current||busy||filing)return;
    const text=`Write a factual ${platformName(current)} dispute draft from the evidence. Mark anything unsupported with [verify].`;
    closeSheet();addUser(text);await run(text);
    if(analysis?.draft_text)openSheet('draft');
  }
  async function syncFiling(record){
    if(!ready())return {state:'pending',error:'Not connected to the agent, so it is saved in this browser only.'};
    const url=settings.agentUrl.trim().replace(/\/+$/,'')+'/v1/disputes/confirm';endpointOrigin(url);
    const amount=chargeAmount(record);
    const body={platform:platformOf(record),operator_id:settings.operatorId||'poc-operator',conversation_id:record.conversationId||conversationId||null,store_id:record.agentStoreId||record.storeId||null,
      order_id:record.orderId,dispute_text:record.filing.draft,disputed_at:record.filing.confirmedAt,
      order_url:orderUrl(record),
      dispute_amount:Number.isFinite(amount)?Math.abs(amount):null,
      issue_category:(record.snapshot?.errorCharges||[]).map(x=>x.reason).find(Boolean)||null};
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${settings.agentToken.trim()}`},
      body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    if(!response.ok){let message='';try{message=(await response.json())?.error||'';}catch{}
      throw Error(describeHttp(response.status,message,response.headers.get('Retry-After')));}
    const result=await response.json();
    if(!result?.id||!result?.case_id)throw Error('The server did not confirm it saved the dispute.');
    return {state:'synced',backendId:result.id,error:null};
  }
  function renderFiling(rec){
    if(!rec?.filing)return;
    filing=rec;hide('filingState',false);hide('confirm');
    const synced=rec.filing.syncState==='synced';
    $('filingState').classList.toggle('done',synced);
    $('filingTitle').textContent=synced?'Marked as disputed':'Saved in this browser only';
    const date=new Date(rec.filing.confirmedAt).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    $('filingDescription').textContent=synced?`You confirmed it was submitted in ${platformName(rec)} on ${date}.`:
      `You confirmed it on ${date}. ${rec.filing.syncError||'It has not reached KoreFi yet.'}`;
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
    if(!current||!draftCopied||copiedText!==draftText.trim()){toast('Copy the final draft first');return;}
    if(filing){renderFiling(filing);return;}
    const prior=await findFiling(current);if(prior){filing=prior;renderFiling(prior);return;}
    const duplicate=(await allCases()).find(x=>x.id!==current.id&&x.orderId===current.orderId &&
      x.storeId===current.storeId && x.filing?.confirmedAt && !isPlaceholder(x));
    if(duplicate){filing=duplicate;renderFiling(duplicate);toast('This order is already marked as disputed');return;}
    const data={confirmedAt:new Date().toISOString(),draft:copiedText,syncState:'pending',syncError:null,lastSyncAttempt:null,backendId:null};
    const rec=await patchCase(current.id,{status:'filed',filing:data,agentStoreId:current.agentStoreId||current.storeId||null});
    filing=rec;renderFiling(rec);
    await pushFiling(rec);
    renderDraft();hide('suggestions');
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
    const rec={id:`conv-${conv.id}`,platform:conv.platform||'doordash',photos:[],orderId:conv.order_id,storeId:conv.store_id&&conv.store_id!=='unresolved'?conv.store_id:null,conversationId:String(conv.id),
      createdAt:conv.created_at,trigger:'manual',url:'',snapshot:{orderId:conv.order_id,errorCharges:[],errorChargeTotal:null,disputeStatus:null},redactedText:'',
      image:null,imageNote:null,facts:{errorTotal:Number(conv.error_amount)||0,deadlineIso:null,daysLeft:null,expired:false,decided:false,openErrorCharges:[],faultHint:null},assessment:null,status:'new'};
    const cases=await allCases();const rest=cases.filter(c=>c.id!==rec.id);
    await chrome.storage.local.set({cases:[rec,...rest].slice(0,120)});
    return rec;
  }
  async function openConversation(id){
    if(busy||captureBusy){toast('Wait for the agent to finish first');return;}
    const detail=await (await piFetch(`/v1/conversations/${encodeURIComponent(id)}`,{timeout:30000})).json();
    const conv=detail.conversation;
    resetChatState();
    conversationId=String(conv.id);
    current=await localCaseFor(conv);
    const local=current.filing?.confirmedAt?current:null;
    filing=local||(conv.status==='disputed'?{id:current.id,filing:{confirmedAt:conv.updated_at,draft:'',syncState:'synced',syncError:null}}:null);
    if(drawerOpen())setDrawer(false);
    showThread();
    // Evidence images saved with the chat, for review on any device.
    if(detail.images?.length){
      const strip=document.createElement('div');strip.className='evidence-strip';
      const label=document.createElement('span');label.textContent=plural(detail.images.length,'attached image','attached images');strip.append(label);
      $thread.append(strip);
      for(const image of detail.images){
        const b=document.createElement('button');b.type='button';b.className='strip-thumb';b.setAttribute('aria-label','View image');strip.append(b);
        imageDataUrl(conv.id,image.id).then(src=>{const img=document.createElement('img');img.alt='';img.src=src;b.append(img);b.addEventListener('click',()=>openLightbox(src));}).catch(()=>b.remove());
      }
    }
    let last=null;
    for(const m of detail.messages){
      if(m.role==='user')addUser(m.text);
      else if(m.role==='assistant'){last=m.result||{recommendation:'needs_review',reasoning_summary:m.text,tools_used:[],missing_evidence:[]};renderAnalysisCard(last);}
      else addNote(m.text);
    }
    draftText=last?.draft_text||'';draftCopied=false;copiedText='';
    if(last)applyAnalysis(last);
    if(filing){renderFiling(filing);hide('suggestions');}
    attachedCase=null;captureAttachment();
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
    busy=false;stopProgress();updateSend();toast('The agent is taking longer than expected. Reopen the chat in a minute');
  }
  function renderHistory(list){
    const root=$('historyList');root.replaceChildren();
    if(!list.length){const p=document.createElement('p');p.className='history-empty';p.textContent='No chats yet';root.append(p);return;}
    for(const c of list){
      const b=document.createElement('button');b.type='button';b.className='history-item';if(String(c.id)===conversationId)b.classList.add('current');
      const title=document.createElement('span');title.className='history-title';
      const name=document.createElement('span');name.textContent=c.title||('Order '+c.order_id);title.append(name);
      if(c.status==='disputed'){const chip=document.createElement('span');chip.className='history-chip done';chip.textContent='Disputed';title.append(chip);}
      else if(c.last_recommendation){const chip=document.createElement('span');chip.className='history-chip';chip.textContent=VERDICT[c.last_recommendation]||c.last_recommendation;title.append(chip);}
      const meta=document.createElement('span');meta.className='history-meta';meta.textContent=`${PLATFORMS[c.platform]?.name||'DoorDash'} · Order ${c.order_id} · ${fmtWhen(c.updated_at)}`;
      b.append(title,meta);
      b.addEventListener('click',()=>void openConversation(c.id).catch(e=>toast(String(e.message||e))));
      root.append(b);
    }
  }
  async function loadHistory(){
    const root=$('historyList');
    const note=t=>{root.replaceChildren();const p=document.createElement('p');p.className='history-empty';p.textContent=t;root.append(p);};
    if(!ready()){note('Connect the agent in Settings to see your chats');return;}
    if(!root.children.length)note('Loading');
    try{await wake();const data=await (await piFetch('/v1/conversations?limit=50',{timeout:60000})).json();renderHistory(data.conversations||[]);}
    catch(e){note(String(e.message||e));}
  }
  async function saveSettings(){
    const url=$('agentUrl').value.trim()||API,token=$('agentToken').value.trim();
    const operatorId=$('operatorId').value.trim()||'poc-operator';
    try{
      const origin=endpointOrigin(url);
      if(token && token.length<32)throw Error('The access token must be at least 32 characters.');
      if(origin!==new URL(API).origin+'/*'){
        const ok=await chrome.permissions.request({origins:[origin]});
        if(!ok)throw Error('Chrome needs permission to reach this address.');
      }
      settings={...settings,agentUrl:url,agentToken:token,operatorId};
      await chrome.storage.local.set({settings});connectionUI();closeSheet();awakeAt=0;void wake();
      toast(token?'Connected':'Saved');
    }catch(e){toast(String(e.message||e));}
  }
  function openLightbox(src){if(!src)return;$('lightboxImage').src=src;hide('lightbox',false);$('closeLightbox').focus();}
  function closeLightbox(){hide('lightbox');focusComposer();}

  $('newChat').addEventListener('click',newChat);
  $('drawerNewChat').addEventListener('click',newChat);
  $('historyButton').addEventListener('click',()=>setDrawer(!drawerOpen()));
  $('closeHistory').addEventListener('click',()=>setDrawer(false));
  $('scrim').addEventListener('click',()=>setDrawer(false));
  $('settingsButton').addEventListener('click',()=>openSheet('settings'));
  $('closeSettings').addEventListener('click',closeSheet);
  $('closeDraft').addEventListener('click',closeSheet);
  $('closeEvidence').addEventListener('click',closeSheet);
  $('saveSettings').addEventListener('click',()=>void saveSettings());
  document.querySelectorAll('[data-theme-choice]').forEach(b=>b.addEventListener('click',()=>theme(b.dataset.themeChoice,true)));
  $('capture').addEventListener('click',onCaptureClick);
  chrome.permissions.onAdded.addListener(()=>void checkTabAccess());
  chrome.permissions.onRemoved.addListener(()=>void checkTabAccess());
  $('removeAttachment').addEventListener('click',removeAttachment);
  $('saveMeta').addEventListener('click',()=>void saveCaseMeta());
  $('orderChip').addEventListener('click',()=>{if(!current||isPlaceholder(current))return;metaOpen=!metaOpen;caseMetaUI();if(metaOpen)$('metaStore').focus();});
  $('viewAttachment').addEventListener('click',()=>openLightbox(attachedCase?.image));
  $('closeLightbox').addEventListener('click',closeLightbox);
  document.addEventListener('keydown',e=>{
    if(e.key!=='Escape')return;
    if(!$('lightbox').hidden)closeLightbox();
    else if(drawerOpen())setDrawer(false);
    else if(sheet)closeSheet();
    else if(metaOpen){metaOpen=false;caseMetaUI();}
  });
  $('chatForm').addEventListener('submit',e=>{e.preventDefault();void send();});
  $prompt.addEventListener('input',()=>{$prompt.style.height='auto';$prompt.style.height=Math.min($prompt.scrollHeight,144)+'px';updateSend();});
  $prompt.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('chatForm').requestSubmit();}});
  $('draftText').addEventListener('input',()=>{draftText=$('draftText').value;if(draftCopied){draftCopied=false;copiedText='';hide('confirm');toast('Draft changed. Copy it again before confirming');}
    $('copyDraft').disabled=!draftText.trim();});
  $('copyDraft').addEventListener('click',()=>void copyDraft());
  $('regenerateDraft').addEventListener('click',()=>void regenerateDraft());
  $('notYet').addEventListener('click',()=>{hide('confirm');toast(`Not marked. Submit it in ${platformName(current)} first`);});
  $('yesFiled').addEventListener('click',()=>void confirmSubmitted().catch(e=>toast(String(e.message||e))));
  $('retrySync').addEventListener('click',()=>{if(filing)void pushFiling(filing);});
  chrome.runtime.onMessage.addListener(message=>{
    if(message?.type==='CASE_CAPTURED'){
      endCapture();
      void getCase(message.caseId).then(async c=>{
        if(c){await loadCase(c,true);focusComposer();}
        else toast('The capture was not saved. Try again');
      }).catch(e=>toast(String(e.message||e)));
    } else if(message?.type==='CAPTURE_FAILED'){
      endCapture();toast(message.reason||'Could not attach the page');
    }
    return false;
  });
  async function init(){
    const data=await chrome.storage.local.get(['settings','cases']);
    settings={...settings,...(data.settings||{})};
    delete settings.apiKey;delete settings.loggingToken;delete settings.loggingUrl;delete settings.model;
    theme(settings.theme);connectionUI();if(ready())void wake();void checkTabAccess();
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
  void init().catch(e=>toast(`Could not start: ${String(e.message||e)}`));
})();
