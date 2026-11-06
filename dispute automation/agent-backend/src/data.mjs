import pg from 'pg';
import { HttpError } from './validation.mjs';
let writePool, historyPool;
export function connections(){
  if(!process.env.DATABASE_URL||!process.env.HISTORY_DATABASE_URL)throw new HttpError(503,'Database configuration incomplete');
  if(!writePool)writePool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:6000,statement_timeout:9000});
  if(!historyPool)historyPool=new pg.Pool({connectionString:process.env.HISTORY_DATABASE_URL,max:3,connectionTimeoutMillis:6000,statement_timeout:9000});
  return {db:writePool,history:historyPool};
}
export async function checkDb(){
  const {db,history}=connections();
  const [a,b]=await Promise.all([db.query('SELECT 1 FROM dispute_automation.cases LIMIT 1'),history.query('SELECT 1 FROM doordash.financial_error_charges_adjustments LIMIT 1')]);
  return !!(a&&b);
}
export async function upsertCase(db,tenant,operator,p){
  const {rows}=await db.query(`INSERT INTO dispute_automation.cases
    (tenant_id,platform,platform_store_id,platform_order_id,order_url,issue_category,issue_description,error_amount,currency,captured_by,capture_status,structured_facts,redacted_page_text)
    VALUES($1,'doordash',$2,$3,$4,$5,$6,$7,'USD',$8,$9,$10::jsonb,$11)
    ON CONFLICT (tenant_id,platform,platform_store_id,platform_order_id) DO UPDATE SET
      order_url=EXCLUDED.order_url,issue_category=EXCLUDED.issue_category,
      issue_description=EXCLUDED.issue_description,error_amount=EXCLUDED.error_amount,
      captured_by=EXCLUDED.captured_by,capture_status=EXCLUDED.capture_status,
      structured_facts=EXCLUDED.structured_facts,redacted_page_text=EXCLUDED.redacted_page_text,updated_at=now()
    RETURNING id,tenant_id,platform_store_id,platform_order_id`,[tenant,p.storeId,p.orderId,p.orderUrl,p.issueCategory,p.issueDescription,p.amount,operator,p.captureStatus,JSON.stringify(p.facts),p.redactedText]);
  return rows[0];
}
export async function recordEvent(db,caseId,actorId,type,details={}){
  await db.query(`INSERT INTO dispute_automation.case_events(case_id,actor_type,actor_id,event_type,details)
    VALUES($1,'operator',$2,$3,$4::jsonb)`,[caseId,actorId,type,JSON.stringify(details)]);
}
export async function similarCases(db,tenant,storeId,category,orderId){
  const {rows}=await db.query(`SELECT c.platform_order_id,c.issue_category,c.error_amount,
    o.decision_status,o.awarded_amount,COALESCE(SUM(r.credit_amount),0) AS received_amount,
    i.recommendation,i.reasoning_summary
    FROM dispute_automation.cases c
    LEFT JOIN LATERAL (SELECT id,recommendation,reasoning_summary FROM dispute_automation.investigations
       WHERE case_id=c.id AND status='completed' ORDER BY completed_at DESC LIMIT 1) i ON true
    LEFT JOIN LATERAL (SELECT id FROM dispute_automation.submissions WHERE case_id=c.id ORDER BY submitted_at DESC LIMIT 1) s ON true
    LEFT JOIN dispute_automation.outcomes o ON o.submission_id=s.id
    LEFT JOIN dispute_automation.recovery_adjustments r ON r.submission_id=s.id
    WHERE c.tenant_id=$1 AND c.platform='doordash' AND c.platform_store_id=$2
      AND c.platform_order_id<>$4 AND ($3::text IS NULL OR lower(c.issue_category)=lower($3))
    GROUP BY c.id,c.platform_order_id,c.issue_category,c.error_amount,o.decision_status,o.awarded_amount,i.recommendation,i.reasoning_summary
    ORDER BY c.id DESC LIMIT 8`,[tenant,storeId,category,orderId]);
  return rows;
}
export async function getFinancials(history,storeId,orderId){
  const {rows}=await history.query(`SELECT doordash_order_id,store_id,transaction_type,description,
    final_order_status,error_charges,adjustments,net_total,payout_date,doordash_transaction_id
    FROM doordash.financial_detailed_transactions
    WHERE store_id=$1 AND doordash_order_id=$2 LIMIT 15`,[storeId,orderId]);return rows;
}
export async function getCharges(history,storeId,orderId){
  const {rows}=await history.query(`SELECT doordash_order_id,store_id,transaction_type,description,error_charges,
    adjustments,doordash_transaction_id,delivery_uuid,payout_date
    FROM doordash.financial_error_charges_adjustments
    WHERE store_id=$1 AND doordash_order_id=$2 LIMIT 15`,[storeId,orderId]);return rows;
}
export async function getIssueReports(history,storeId,orderId){
  const {rows}=await history.query(`SELECT dd_order_id,store_id,error_category,item_name,
    quantity,error_charge,modifier_detail
    FROM doordash.operations_order_missing_incorrect
    WHERE store_id=$1 AND dd_order_id=$2 LIMIT 20`,[storeId,orderId]);return rows;
}
export async function getStorePatterns(history,storeId){
  const {rows}=await history.query(`SELECT error_category,COUNT(*)::int AS occurrences
    FROM doordash.operations_order_missing_incorrect WHERE store_id=$1
    GROUP BY error_category ORDER BY COUNT(*) DESC LIMIT 10`,[storeId]);return rows;
}
export async function confirmSubmission(db,tenant,actor,p){
  const {rows}=await db.query(`SELECT id FROM dispute_automation.cases WHERE tenant_id=$1 AND platform='doordash'
    AND platform_store_id=$2 AND platform_order_id=$3`,[tenant,p.storeId,p.orderId]);
  if(!rows[0])throw new HttpError(404,'Order has not been captured; investigate first');
  const caseId=rows[0].id,key=`doordash:${p.storeId}:${p.orderId}`;
  const r=await db.query(`INSERT INTO dispute_automation.submissions
    (case_id,tenant_id,idempotency_key,submitted_at,submitted_by,dispute_text,confirmation_source)
    VALUES($1,$2,$3,$4,$5,$6,'operator_attested')
    ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id,submitted_at`,[caseId,tenant,key,p.submittedAt,actor,p.disputeText]);
  const alreadyRecorded=r.rows.length===0;
  const result=alreadyRecorded?await db.query('SELECT id,submitted_at FROM dispute_automation.submissions WHERE tenant_id=$1 AND idempotency_key=$2',[tenant,key]):r;
  if(!alreadyRecorded){
    await db.query("UPDATE dispute_automation.cases SET case_status='submitted',updated_at=now() WHERE id=$1",[caseId]);
    await recordEvent(db,caseId,actor,'operator_confirmed_submission',{submission_id:result.rows[0].id});
  }
  return {id:result.rows[0].id,case_id:caseId,submitted_at:result.rows[0].submitted_at,already_recorded:alreadyRecorded};
}
