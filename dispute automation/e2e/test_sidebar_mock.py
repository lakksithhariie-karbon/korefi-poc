"""Browser UI smoke test with a mocked Chrome extension runtime (not a DoorDash integration test)."""
import json
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
MOCK=r'''(() => {
 const sample={
  id:'3990CBFD-demo',orderId:'3990CBFD',createdAt:new Date().toISOString(),url:'https://merchant.doordash.com/orders/3990CBFD',
  snapshot:{errorCharges:[{reason:'Missing item',amount:7.99}],errorChargeTotal:7.99,disputeStatus:null},
  redactedText:'Order 3990CBFD missing item charge $7.99',facts:{errorTotal:7.99,expired:false,deadlineIso:null},
  image:null,imageNote:'Screenshot withheld: mock browser capture is unavailable.',status:'new'
 };
 const state={settings:{captureEnabled:false},cases:[]};
 let listener=()=>{};
 window.chrome={
  storage:{local:{async get(keys){if(typeof keys==='string')return {[keys]:state[keys]};return state},async set(value){Object.assign(state,value)}},onChanged:{addListener(){}}},
  runtime:{onMessage:{addListener(fn){listener=fn}},async sendMessage(msg){if(msg.type==='CAPTURE_NOW'){state.cases=[sample];setTimeout(()=>listener({type:'CASE_CAPTURED',caseId:sample.id}),50)} }},
  tabs:{async query(){return [{id:1,url:sample.url}]}},
  permissions:{async request(){return true}}
 };
 window.__state=state;
 Object.defineProperty(navigator,'clipboard',{value:{async writeText(text){window.__copied=text}}});
 window.fetch=async(url,options)=>{
  if(String(url).includes('/responses'))return new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'Please review the $7.99 missing-item charge for order 3990CBFD. [Attach verified proof before submitting].'}]}]}),{status:200,headers:{'content-type':'application/json'}});
  if(String(url).includes('korefi.test'))return new Response(JSON.stringify({id:'saved-123'}),{status:200,headers:{'content-type':'application/json'}});
  throw new Error('Unexpected network request: '+url);
 };
})();'''
server=ThreadingHTTPServer(("127.0.0.1",0),partial(SimpleHTTPRequestHandler,directory=str(ROOT/"dist")))
threading.Thread(target=server.serve_forever,daemon=True).start()
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':414,'height':930})
 # Mock the Chrome runtime in about:blank; container browser policy blocks URL navigation.
 errors=[]
 page.on('pageerror',lambda e: errors.append(str(e)))
 html=(ROOT/'dist/sidepanel.html').read_text()
 html=html.replace('<link rel="stylesheet" href="sidepanel.css">','<style>'+ (ROOT/'dist/sidepanel.css').read_text()+'</style>')
 html=html.replace('<script src="sidepanel.js"></script>', '')
 page.set_content(html)
 page.evaluate(MOCK)
 page.add_script_tag(content=(ROOT/'dist/sidepanel.js').read_text())
 page.wait_for_selector('h1')
 assert page.locator('h1').inner_text()=='Resolve this dispute'
 assert page.locator('.brand img').get_attribute('src')=='https://www.korefi.ai/korefi-logo.png'
 assert page.locator('#generate-btn').is_disabled()
 page.locator('#capture-btn').click()
 page.locator('#capture-result:not([hidden])').wait_for()
 assert page.locator('#order-id').inner_text()=='Order 3990CBFD'
 assert not page.locator('#generate-btn').is_disabled()
 page.locator('#settings-toggle').click()
 page.locator('#api-key').fill('sk-test')
 page.locator('#save-settings').click()
 page.locator('#chat-input').fill('Can we dispute?')
 page.locator('#send-btn').click()
 page.wait_for_function("document.querySelectorAll('.message.assistant').length >= 2")
 page.locator('#generate-btn').click()
 page.locator('#draft-block:not([hidden])').wait_for()
 assert '3990CBFD' in page.locator('#draft-text').input_value()
 page.locator('#copy-btn').click()
 page.locator('#confirm-block:not([hidden])').wait_for()
 # Editing after copying must require fresh copy.
 page.locator('#draft-text').fill('Revised draft for order 3990CBFD')
 assert page.locator('#confirm-block').is_hidden()
 page.locator('#copy-btn').click()
 assert not page.locator('#confirm-block').is_hidden()
 page.locator('#not-yet-btn').click()
 assert page.locator('#saved-block').is_hidden()
 page.locator('#copy-btn').click()
 page.locator('#yes-btn').click()
 page.locator('#saved-block:not([hidden])').wait_for()
 page.wait_for_function("document.querySelector('#saved-description').textContent.includes('NOT yet confirmed in the database')")
 assert 'locally' in page.locator('#saved-title').inner_text().lower()
 assert page.evaluate('window.__state.cases[0].status')=='filed'
 assert page.evaluate('window.__state.cases[0].filing.draft')=='Revised draft for order 3990CBFD'
 print('PASS: no key -> capture -> chat -> generate -> copy -> edit invalidation -> confirm -> local pending sync')
 page.screenshot(path=str(ROOT/'sidebar-test-preview.png'))
 # Backend success path using an explicit endpoint (not a hardcoded service).
 page.locator('#settings-toggle').click()
 page.locator('#logging-url').fill('https://korefi.test/disputes')
 page.locator('#save-settings').click()
 page.locator('#retry-btn').click()
 page.wait_for_function("document.querySelector('#saved-title').textContent.includes('logged in KoreFi')")
 assert page.evaluate('window.__state.cases[0].filing.syncState')=='synced'
 print('PASS: explicit backend endpoint -> HTTP 2xx -> marked synced')
 # Browser must have no uncaught JS errors.
 assert not errors, errors
 print('PASS: no uncaught JS errors')
 browser.close()

server.shutdown()
