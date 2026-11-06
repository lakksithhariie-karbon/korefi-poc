import pg from 'pg';
import { UNRESOLVED_STORE } from './constants.mjs';
import { withSslMode } from './ssl.mjs';
import { HttpError } from './validation.mjs';

export { UNRESOLVED_STORE };
export { withSslMode };

/** Every database call the service makes. Tests use an in-memory version of this same shape. */
export function createPgStore(env = process.env) {
  let writePool;
  let historyPool;

  function pools() {
    if (!env.DATABASE_URL || !env.HISTORY_DATABASE_URL) throw new HttpError(503, 'Database configuration incomplete');
    const options = { max: 3, connectionTimeoutMillis: 6000, statement_timeout: 9000 };
    if (!writePool) writePool = new pg.Pool({ connectionString: withSslMode(env.DATABASE_URL), ...options });
    if (!historyPool) historyPool = new pg.Pool({ connectionString: withSslMode(env.HISTORY_DATABASE_URL), ...options });
    return { db: writePool, history: historyPool };
  }

  return {
    async ready() {
      const { db, history } = pools();
      const [a, b] = await Promise.all([
        db.query('SELECT 1 FROM dispute_automation.cases LIMIT 1'),
        history.query('SELECT 1 FROM doordash.financial_error_charges_adjustments LIMIT 1'),
      ]);
      return !!(a && b);
    },

    async resolveStore(orderId) {
      if (!orderId || String(orderId).startsWith('SCREENSHOT-')) return null;
      const { history } = pools();
      const { rows } = await history.query(
        `SELECT DISTINCT store_id FROM (
          SELECT store_id FROM doordash.financial_error_charges_adjustments WHERE doordash_order_id=$1
          UNION ALL
          SELECT store_id FROM doordash.financial_detailed_transactions WHERE doordash_order_id=$1
        ) AS source WHERE store_id IS NOT NULL AND store_id ~ '^[0-9]{3,32}$' LIMIT 2`,
        [orderId],
      );
      return rows.length === 1 ? rows[0].store_id : null;
    },

    async upsertCase(tenant, operator, p) {
      const { db } = pools();
      const { rows } = await db.query(
        `INSERT INTO dispute_automation.cases
          (tenant_id,platform,platform_store_id,platform_order_id,order_url,issue_category,issue_description,error_amount,currency,captured_by,capture_status,structured_facts,redacted_page_text)
          VALUES($1,'doordash',$2,$3,$4,$5,$6,$7,'USD',$8,$9,$10::jsonb,$11)
          ON CONFLICT (tenant_id,platform,platform_store_id,platform_order_id) DO UPDATE SET
            order_url=COALESCE(EXCLUDED.order_url,dispute_automation.cases.order_url),
            issue_category=COALESCE(EXCLUDED.issue_category,dispute_automation.cases.issue_category),
            issue_description=COALESCE(EXCLUDED.issue_description,dispute_automation.cases.issue_description),
            error_amount=COALESCE(EXCLUDED.error_amount,dispute_automation.cases.error_amount),
            captured_by=EXCLUDED.captured_by,capture_status=EXCLUDED.capture_status,
            structured_facts=EXCLUDED.structured_facts,redacted_page_text=COALESCE(EXCLUDED.redacted_page_text,dispute_automation.cases.redacted_page_text),updated_at=now()
          RETURNING id,tenant_id,platform_store_id,platform_order_id`,
        [tenant, p.storeId, p.orderId, p.orderUrl, p.issueCategory, p.issueDescription, p.amount, operator, p.captureStatus, JSON.stringify(p.facts), p.redactedText],
      );
      return rows[0];
    },

    /** The case for an order, preferring a real store over the unresolved placeholder. */
    async findCase(tenant, orderId, storeIds) {
      const { db } = pools();
      const { rows } = await db.query(
        `SELECT id,platform_store_id,platform_order_id FROM dispute_automation.cases
          WHERE tenant_id=$1 AND platform='doordash' AND platform_order_id=$2 AND platform_store_id = ANY($3::text[])
          ORDER BY (platform_store_id=$4) ASC, updated_at DESC LIMIT 1`,
        [tenant, orderId, storeIds, UNRESOLVED_STORE],
      );
      return rows[0] || null;
    },

    async setCaseStatus(caseId, status) {
      const { db } = pools();
      await db.query("UPDATE dispute_automation.cases SET case_status=$2,updated_at=now() WHERE id=$1 AND case_status<>'submitted'", [caseId, status]);
    },

    async recordEvent(caseId, actorId, type, details = {}) {
      const { db } = pools();
      await db.query(
        `INSERT INTO dispute_automation.case_events(case_id,actor_type,actor_id,event_type,details)
          VALUES($1,'operator',$2,$3,$4::jsonb)`,
        [caseId, actorId, type, JSON.stringify(details)],
      );
    },

    async createInvestigation(caseId, modelId) {
      const { db } = pools();
      const { rows } = await db.query(
        "INSERT INTO dispute_automation.investigations(case_id,agent_runtime,model_id,status) VALUES($1,'pi',$2,'running') RETURNING id",
        [caseId, modelId],
      );
      return rows[0].id;
    },

    async completeInvestigation(id, r) {
      const { db } = pools();
      await db.query(
        "UPDATE dispute_automation.investigations SET status='completed',recommendation=$2,reasoning_summary=$3,missing_evidence=$4::jsonb,draft_text=$5,risk_notes=$6,completed_at=now() WHERE id=$1",
        [id, r.recommendation, r.reasoning_summary, JSON.stringify(r.missing_evidence), r.draft_text, r.risk_notes],
      );
    },

    async failInvestigation(id, message) {
      const { db } = pools();
      await db.query("UPDATE dispute_automation.investigations SET status='failed',error_summary=$2,completed_at=now() WHERE id=$1 AND status='running'", [
        id,
        String(message || 'Investigation failed').slice(0, 300),
      ]);
    },

    /** One investigation with its tool calls, or null. Scoped to the tenant through its case. */
    async getInvestigation(tenant, id) {
      const { db } = pools();
      let found;
      try {
        found = await db.query(
          `SELECT i.id,i.status,i.recommendation,i.reasoning_summary,i.missing_evidence,i.draft_text,i.risk_notes,i.model_id,i.error_summary,
              c.id AS case_id,c.platform_store_id,c.platform_order_id
            FROM dispute_automation.investigations i JOIN dispute_automation.cases c ON c.id=i.case_id
            WHERE i.id=$1 AND c.tenant_id=$2`,
          [id, tenant],
        );
      } catch (err) {
        if (err && err.code === '22P02') return null; // not a valid id for this column
        throw err;
      }
      const row = found.rows[0];
      if (!row) return null;
      const calls = await db.query('SELECT tool_name,status,result_summary FROM dispute_automation.agent_tool_calls WHERE investigation_id=$1 ORDER BY id', [id]);
      return {
        ...row,
        tools: calls.rows.map((t) => ({ name: t.tool_name, status: t.status, count: Number(t.result_summary?.record_count ?? 0) })),
      };
    },

    async startToolCall(investigationId, name) {
      const { db } = pools();
      const { rows } = await db.query('INSERT INTO dispute_automation.agent_tool_calls(investigation_id,tool_name) VALUES($1,$2) RETURNING id', [investigationId, name]);
      return rows[0].id;
    },

    async finishToolCall(id, status, summary) {
      const { db } = pools();
      await db.query('UPDATE dispute_automation.agent_tool_calls SET status=$2,finished_at=now(),result_summary=$3::jsonb WHERE id=$1', [id, status, JSON.stringify(summary)]);
    },

    /** Records the operator's confirmation once. A repeat for the same case returns the first record. */
    async recordSubmission(tenant, caseId, key, actor, disputeText, submittedAt) {
      const { db } = pools();
      const r = await db.query(
        `INSERT INTO dispute_automation.submissions
          (case_id,tenant_id,idempotency_key,submitted_at,submitted_by,dispute_text,confirmation_source)
          VALUES($1,$2,$3,$4,$5,$6,'operator_attested')
          ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id,submitted_at`,
        [caseId, tenant, key, submittedAt, actor, disputeText],
      );
      const alreadyRecorded = r.rows.length === 0;
      const result = alreadyRecorded
        ? await db.query('SELECT id,submitted_at FROM dispute_automation.submissions WHERE tenant_id=$1 AND idempotency_key=$2', [tenant, key])
        : r;
      if (!alreadyRecorded) {
        await db.query("UPDATE dispute_automation.cases SET case_status='submitted',updated_at=now() WHERE id=$1", [caseId]);
        await this.recordEvent(caseId, actor, 'operator_confirmed_submission', { submission_id: result.rows[0].id });
      }
      return { id: result.rows[0].id, submitted_at: result.rows[0].submitted_at, already_recorded: alreadyRecorded };
    },

    history: {
      async getFinancials(storeId, orderId) {
        const { history } = pools();
        const { rows } = await history.query(
          `SELECT doordash_order_id,store_id,transaction_type,description,
            final_order_status,error_charges,adjustments,net_total,payout_date,doordash_transaction_id
            FROM doordash.financial_detailed_transactions
            WHERE store_id=$1 AND doordash_order_id=$2 LIMIT 15`,
          [storeId, orderId],
        );
        return rows;
      },
      async getCharges(storeId, orderId) {
        const { history } = pools();
        const { rows } = await history.query(
          `SELECT doordash_order_id,store_id,transaction_type,description,error_charges,
            adjustments,doordash_transaction_id,delivery_uuid,payout_date
            FROM doordash.financial_error_charges_adjustments
            WHERE store_id=$1 AND doordash_order_id=$2 LIMIT 15`,
          [storeId, orderId],
        );
        return rows;
      },
      async getIssueReports(storeId, orderId) {
        const { history } = pools();
        const { rows } = await history.query(
          `SELECT dd_order_id,store_id,error_category,item_name,
            quantity,error_charge,modifier_detail
            FROM doordash.operations_order_missing_incorrect
            WHERE store_id=$1 AND dd_order_id=$2 LIMIT 20`,
          [storeId, orderId],
        );
        return rows;
      },
      async getStorePatterns(storeId) {
        const { history } = pools();
        const { rows } = await history.query(
          `SELECT error_category,COUNT(*)::int AS occurrences
            FROM doordash.operations_order_missing_incorrect WHERE store_id=$1
            GROUP BY error_category ORDER BY COUNT(*) DESC LIMIT 10`,
          [storeId],
        );
        return rows;
      },
      async similarCases(tenant, storeId, category, orderId) {
        const { db } = pools();
        const { rows } = await db.query(
          `SELECT c.platform_order_id,c.issue_category,c.error_amount,
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
            ORDER BY c.id DESC LIMIT 8`,
          [tenant, storeId, category, orderId],
        );
        return rows;
      },
    },
  };
}
