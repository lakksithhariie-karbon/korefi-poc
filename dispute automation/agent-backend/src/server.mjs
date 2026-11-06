import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { connections,checkDb,upsertCase,confirmSubmission,resolveStoreFromOrder } from './data.mjs';
import { HttpError,sanitizeCapture,validateStore,requiredString,parseIso,readToken } from './validation.mjs';
import { investigate } from './agent.mjs';

const PORT=Number(process.env.PORT||10000);
const tenant='korefi-internal-poc'; // Single internal tenant, real tenant auth required before rollout.
const allowedOrigins=new Set((process.env.ALLOWED_EXTENSION_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean));
function respond(res,code,data){
 res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
 res.end(JSON.stringify(data));
}
function auth(req){
 const expected=process.env.KOREFI_AGENT_TOKEN;
 if(!expected||expected.length<32)throw new HttpError(503,'Service authentication not configured');
 const actual=readToken(req.headers.authorization);
 const a=Buffer.from(actual),b=Buffer.from(expected);
 if(a.length!==b.length||!timingSafeEqual(a,b))throw new HttpError(401,'Unauthorized');
}
async function jsonBody(req){
 let n=0;const chunks=[];
 for await(const c of req){n+=c.length;if(n>6000000)throw new HttpError(413,'Request too large');chunks.push(c);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}
 catch{throw new HttpError(400,'Malformed JSON')}
}
function cors(req,res){
 const origin=req.headers.origin;
 if(origin&&allowedOrigins.has(origin)){
  res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, Idempotency-Key');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Vary','Origin');
 }
}
async function handle(req,res){
 cors(req,res);
 const route=new URL(req.url,'http://localhost').pathname;
 if(req.method==='GET'&&route==='/healthz')return respond(res,200,{ok:true,service:'korefi-pi-dispute-agent',version:'0.1.0'});
 try{
  if(req.method==='OPTIONS')return respond(res,204,{});
  auth(req);
  if(req.method==='GET'&&route==='/readyz'){
   const ok=await checkDb();
   return respond(res,200,{ok,db:ok?'connected':'unavailable',model_configured:!!process.env.OPENAI_API_KEY,store_restrictions:'derived_from_order'});
  }
  if(req.method==='POST'&&route==='/v1/investigations'){
   if(!process.env.OPENAI_API_KEY)throw new HttpError(503,'AI provider not configured');
   const body=await jsonBody(req), p=sanitizeCapture(body);
   validateStore(p.storeId);
   const actor=requiredString(body.operator_id,'operator_id',128);
   const {db,history}=connections();
   p.storeId=p.storeId||(await resolveStoreFromOrder(history,p.orderId))||'unresolved';
   const c=await upsertCase(db,tenant,actor,p);
   const run=await db.query(
    "INSERT INTO dispute_automation.investigations(case_id,agent_runtime,model_id,status) VALUES($1,'pi',$2,'running') RETURNING id",
    [c.id,process.env.OPENAI_MODEL||'gpt-4.1-mini']);
   const runId=run.rows[0].id;
   await db.query("UPDATE dispute_automation.cases SET case_status='investigating',updated_at=now() WHERE id=$1",[c.id]);
   try{
    const result=await investigate({db,history,tenant,request:p,runId});
    await db.query("UPDATE dispute_automation.investigations SET status='completed',recommendation=$2,reasoning_summary=$3,missing_evidence=$4::jsonb,draft_text=$5,risk_notes=$6,completed_at=now() WHERE id=$1",
      [runId,result.recommendation,result.reasoning_summary,JSON.stringify(result.missing_evidence),result.draft_text,result.risk_notes]);
    const status=result.recommendation==='dispute'?'ready_to_dispute':'captured';
    await db.query('UPDATE dispute_automation.cases SET case_status=$2,updated_at=now() WHERE id=$1',[c.id,status]);
    return respond(res,200,{case_id:c.id,investigation_id:runId,store_id:p.storeId,order_id:p.orderId,...result});
   }catch(err){
    await db.query("UPDATE dispute_automation.investigations SET status='failed',error_summary=$2,completed_at=now() WHERE id=$1",[runId,String(err.message||err).slice(0,300)]).catch(()=>{});
    await db.query("UPDATE dispute_automation.cases SET case_status='captured',updated_at=now() WHERE id=$1",[c.id]).catch(()=>{});
    throw err;
   }
  }
  if(req.method==='POST'&&route==='/v1/disputes/confirm'){
   const body=await jsonBody(req);
   const storeId=requiredString(body.store_id,'store_id',128);
   if(storeId!=='unresolved')validateStore(storeId);
   const actor=requiredString(body.operator_id,'operator_id',128);
   const p={storeId,orderId:requiredString(body.order_id,'order_id',128),disputeText:requiredString(body.dispute_text,'dispute_text',6000),submittedAt:parseIso(body.disputed_at,'disputed_at')};
   const {db}=connections();
   const result=await confirmSubmission(db,tenant,actor,p);
   return respond(res,200,result);
  }
  return respond(res,404,{error:'Not found'});
 }catch(e){
  const status=e instanceof HttpError?e.status:500;
  return respond(res,status,{error:status===500?'Request failed; consult server logs':e.message});
 }
}
const server=http.createServer((req,res)=>{void handle(req,res)});
server.requestTimeout=90000;
server.listen(PORT,'0.0.0.0',()=>console.log('KoreFi agent listening on '+PORT));
