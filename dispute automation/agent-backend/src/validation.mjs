export class HttpError extends Error {
  constructor(status,message) {super(message);this.status=status;}
}
export function requiredString(v,name,max=256){
  if(typeof v!=='string'||!v.trim()||v.length>max)throw new HttpError(422,name+' must be a non-empty string (max '+max+')');
  return v.trim();
}
export function optionalString(v,max=4000){
  if(v===undefined||v===null||v==='')return null;
  if(typeof v!=='string'||v.length>max)throw new HttpError(422,'Invalid text field');
  return v.trim()||null;
}
export function money(v){
  if(v===undefined||v===null||v==='')return null;
  const n=Number(v);
  if(!Number.isFinite(n)||n<0||n>1000000)throw new HttpError(422,'Invalid dispute amount');
  return Math.round(n*100)/100;
}
export function parseIso(v,name){
  const s=requiredString(v,name,40);
  if(!Number.isFinite(new Date(s).getTime())||!/Z$|[+-]\d\d:\d\d$/.test(s))throw new HttpError(422,'Invalid '+name);
  return new Date(s).toISOString();
}
export function sanitizeCapture(x){
  if(!x||typeof x!=='object'||Array.isArray(x))throw new HttpError(422,'Expected object');
  if(x.platform!==undefined&&x.platform!=='doordash')throw new HttpError(422,'DoorDash only');
  const storeId=optionalString(x.store_id,128),orderId=requiredString(x.order_id,'order_id',128);
  const orderUrl=optionalString(x.order_url,2000);
  if(orderUrl&&!/^https:\/\/(?:[a-z0-9-]+\.)*doordash\.com(?:\/|$)/i.test(orderUrl))throw new HttpError(422,'Invalid DoorDash URL');
  const facts=x.structured_facts??{};
  if(typeof facts!=='object'||facts===null||Array.isArray(facts)||JSON.stringify(facts).length>12000)throw new HttpError(422,'Invalid structured_facts');
  const screenshot=x.screenshot??null;
  if(screenshot!==null&&(typeof screenshot!=='string'||screenshot.length>5500000||!/^data:image\/(png|jpeg);base64,[a-zA-Z0-9+/=]+$/.test(screenshot)))throw new HttpError(422,'Invalid screenshot');
  return {storeId,orderId,orderUrl,issueCategory:optionalString(x.issue_category,256),
    issueDescription:optionalString(x.issue_description,4000),operatorQuestion:optionalString(x.operator_question,1200),amount:money(x.dispute_amount),
    facts,redactedText:optionalString(x.redacted_page_text,12000),screenshot,
    captureStatus:x.capture_status==='complete'?'complete':x.capture_status==='partial'?'partial':'data_only'};
}
export function validateStore(storeId){
 if(storeId!==null&&storeId!==undefined&&!/^[0-9]{3,32}$/.test(storeId))throw new HttpError(422,'Invalid DoorDash store ID');
 return storeId||null;
}
export function parseAgentOutput(text){
  const clean=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let x;try{x=JSON.parse(clean)}catch{throw Error('Agent returned invalid JSON');}
  if(!x||!['dispute','needs_review','do_not_dispute'].includes(x.recommendation)||typeof x.reasoning_summary!=='string'||typeof x.draft_text!=='string')throw Error('Incomplete agent assessment');
  return {recommendation:x.recommendation,reasoning_summary:x.reasoning_summary.slice(0,5000),
    draft_text:x.draft_text.slice(0,6000),missing_evidence:Array.isArray(x.missing_evidence)?x.missing_evidence.filter(y=>typeof y==='string').slice(0,15):[],
    risk_notes:typeof x.risk_notes==='string'?x.risk_notes.slice(0,2000):null};
}
export function readToken(s){return typeof s==='string'&&s.startsWith('Bearer ')?s.slice(7):'';}
