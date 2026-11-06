import pg from 'pg';
import { CONVERSATION_TABLES, UNRESOLVED_STORE } from './constants.mjs';
import { createSchemaGuard } from './schema-guard.mjs';
import { withSslMode } from './ssl.mjs';
import { HttpError } from './validation.mjs';

export { UNRESOLVED_STORE, withSslMode };

function makePool(url, name, max) {
  const pool = new pg.Pool({
    connectionString: withSslMode(url),
    max,
    connectionTimeoutMillis: 8000,
    statement_timeout: 20000,
    idleTimeoutMillis: 30000,
    keepAlive: true,
    application_name: name,
  });
  // Without a listener, an idle connection dropped by the database would crash the whole process.
  pool.on('error', (err) => console.error(JSON.stringify({ level: 'error', event: 'pg_pool_error', pool: name, message: String(err?.message || err).slice(0, 200) })));
  return pool;
}

/** Every database call the service makes. Tests use an in-memory version of this same shape. */
export function createPgStore(env = process.env) {
  let writePool;
  let historyPool;

  function pools() {
    if (!env.DATABASE_URL || !env.HISTORY_DATABASE_URL) throw new HttpError(503, 'Database configuration incomplete');
    if (!writePool) writePool = makePool(env.DATABASE_URL, 'korefi-agent-rw', 5);
    if (!historyPool) historyPool = makePool(env.HISTORY_DATABASE_URL, 'korefi-agent-history', 3);
    return { db: writePool, history: historyPool };
  }

  /** Runs several statements as one unit: all of them happen, or none do. */
  async function tx(fn) {
    const { db } = pools();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const insertEvent = (q, caseId, actorType, actorId, type, details) =>
    q.query('INSERT INTO dispute_automation.case_events(case_id,actor_type,actor_id,event_type,details) VALUES($1,$2,$3,$4,$5::jsonb)', [
      caseId,
      actorType,
      actorId,
      type,
      JSON.stringify(details ?? {}),
    ]);

  const guard = createSchemaGuard(
    {
      async missingTables() {
        const { db } = pools();
        const { rows } = await db.query("SELECT t FROM unnest($1::text[]) AS t WHERE to_regclass('dispute_automation.' || t) IS NULL", [CONVERSATION_TABLES]);
        return rows.map((r) => r.t);
      },
    },
    { log: (line) => console.log(line) },
  );

  return {
    /** Chats are usable. Null until the first check. */
    conversationsReady: () => guard.ready(),
    /** Checks that the chat tables exist (never creates them). */
    ensureConversations: (opts) => guard.ensure(opts),

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

    async getCaseFacts(caseId) {
      const { db } = pools();
      const { rows } = await db.query(
        `SELECT id,platform_store_id,platform_order_id,order_url,issue_category,issue_description,error_amount,structured_facts,redacted_page_text
          FROM dispute_automation.cases WHERE id=$1`,
        [caseId],
      );
      return rows[0] || null;
    },

    async setCaseStatus(caseId, status) {
      const { db } = pools();
      await db.query("UPDATE dispute_automation.cases SET case_status=$2,updated_at=now() WHERE id=$1 AND case_status NOT IN ('submitted','closed')", [caseId, status]);
    },

    async recordEvent(caseId, actorType, actorId, type, details = {}) {
      const { db } = pools();
      await insertEvent(db, caseId, actorType, actorId, type, details);
    },

    /** Starts a run. When it belongs to a chat, the link is written in the same transaction. */
    async createInvestigation(caseId, modelId, conversationId = null, promptVersion = null) {
      return tx(async (c) => {
        const { rows } = await c.query(
          "INSERT INTO dispute_automation.investigations(case_id,agent_runtime,model_id,prompt_version,status) VALUES($1,'pi',$2,$3,'running') RETURNING id",
          [caseId, modelId, promptVersion],
        );
        if (conversationId) {
          await c.query('INSERT INTO dispute_automation.conversation_runs(investigation_id,conversation_id) VALUES($1,$2)', [rows[0].id, conversationId]);
        }
        return rows[0].id;
      });
    },

    /** A run that was already given up on (timed out, orphaned) is never flipped back to completed. */
    async completeInvestigation(id, r) {
      const { db } = pools();
      const res = await db.query(
        "UPDATE dispute_automation.investigations SET status='completed',recommendation=$2,reasoning_summary=$3,missing_evidence=$4::jsonb,draft_text=$5,risk_notes=$6,completed_at=now() WHERE id=$1 AND status='running'",
        [id, r.recommendation, r.reasoning_summary, JSON.stringify(r.missing_evidence), r.draft_text, r.risk_notes],
      );
      return res.rowCount > 0;
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
        if (err && err.code === '22P02') return null; // not a valid id
        throw err;
      }
      const row = found.rows[0];
      if (!row) return null;
      const calls = await db.query('SELECT tool_name,status,result_summary FROM dispute_automation.agent_tool_calls WHERE investigation_id=$1 ORDER BY started_at', [id]);
      let conversationId = null;
      try {
        const link = await db.query('SELECT conversation_id FROM dispute_automation.conversation_runs WHERE investigation_id=$1', [id]);
        conversationId = link.rows[0]?.conversation_id ?? null;
      } catch (err) {
        if (!err || err.code !== '42P01') throw err; // 42P01: chats are not set up, so this cannot be a chat run
      }
      return {
        ...row,
        conversation_id: conversationId,
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

    /** Records the operator's confirmation once, atomically. A repeat for the same key returns the first record. */
    async recordSubmission(tenant, caseId, key, actor, disputeText, submittedAt) {
      return tx(async (c) => {
        const inserted = await c.query(
          `INSERT INTO dispute_automation.submissions
            (case_id,tenant_id,idempotency_key,submitted_at,submitted_by,dispute_text,confirmation_source)
            VALUES($1,$2,$3,$4,$5,$6,'operator_attested')
            ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id,submitted_at`,
          [caseId, tenant, key, submittedAt, actor, disputeText],
        );
        if (inserted.rows.length === 0) {
          const existing = await c.query('SELECT id,submitted_at FROM dispute_automation.submissions WHERE tenant_id=$1 AND idempotency_key=$2', [tenant, key]);
          return { id: existing.rows[0].id, submitted_at: existing.rows[0].submitted_at, already_recorded: true };
        }
        const row = inserted.rows[0];
        await c.query("UPDATE dispute_automation.cases SET case_status='submitted',updated_at=now() WHERE id=$1", [caseId]);
        await insertEvent(c, caseId, 'operator', actor, 'operator_confirmed_submission', { submission_id: row.id });
        return { id: row.id, submitted_at: row.submitted_at, already_recorded: false };
      });
    },

    // ---- conversations (db/migrations/001_conversations.sql) ----

    async createConversation(tenant, caseId, operator, title) {
      const { db } = pools();
      const { rows } = await db.query('INSERT INTO dispute_automation.conversations(tenant_id,case_id,created_by,title) VALUES($1,$2,$3,$4) RETURNING id', [
        tenant,
        caseId,
        operator,
        String(title || 'New chat').slice(0, 200),
      ]);
      return rows[0].id;
    },

    async getConversation(tenant, id) {
      const { db } = pools();
      try {
        const { rows } = await db.query(
          `SELECT v.id,v.case_id,v.title,v.status,v.created_by,v.last_recommendation,v.created_at,v.updated_at,
              c.platform_order_id,c.platform_store_id,c.case_status,c.error_amount
            FROM dispute_automation.conversations v JOIN dispute_automation.cases c ON c.id=v.case_id
            WHERE v.id=$1 AND v.tenant_id=$2`,
          [id, tenant],
        );
        return rows[0] || null;
      } catch (err) {
        if (err && err.code === '22P02') return null;
        throw err;
      }
    },

    async listConversations(tenant, limit = 50) {
      const { db } = pools();
      const { rows } = await db.query(
        `SELECT v.id,v.case_id,v.title,v.status,v.created_by,v.last_recommendation,v.created_at,v.updated_at,
            c.platform_order_id,c.platform_store_id,c.error_amount
          FROM dispute_automation.conversations v JOIN dispute_automation.cases c ON c.id=v.case_id
          WHERE v.tenant_id=$1 AND v.status<>'archived' ORDER BY v.updated_at DESC LIMIT $2`,
        [tenant, limit],
      );
      return rows;
    },

    async touchConversation(id, patch = {}) {
      const { db } = pools();
      await db.query(
        `UPDATE dispute_automation.conversations SET
            title=COALESCE($2,title), status=COALESCE($3,status), last_recommendation=COALESCE($4,last_recommendation), updated_at=now()
          WHERE id=$1`,
        [id, patch.title ? String(patch.title).slice(0, 200) : null, patch.status ?? null, patch.lastRecommendation ?? null],
      );
    },

    async appendMessage(conversationId, role, text, result = null, investigationId = null) {
      const { db } = pools();
      const { rows } = await db.query(
        'INSERT INTO dispute_automation.conversation_messages(conversation_id,role,text,result,investigation_id) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING id',
        [conversationId, role, String(text).slice(0, 20000), result ? JSON.stringify(result) : null, investigationId],
      );
      return rows[0].id;
    },

    async listMessages(conversationId, limit = 300) {
      const { db } = pools();
      const { rows } = await db.query(
        'SELECT id,role,text,result,investigation_id,created_at FROM dispute_automation.conversation_messages WHERE conversation_id=$1 ORDER BY seq LIMIT $2',
        [conversationId, limit],
      );
      return rows;
    },

    async getMessageForInvestigation(investigationId) {
      const { db } = pools();
      const { rows } = await db.query(
        "SELECT id,role,text,result FROM dispute_automation.conversation_messages WHERE investigation_id=$1 AND role='assistant' ORDER BY seq DESC LIMIT 1",
        [investigationId],
      );
      return rows[0] || null;
    },

    async loadTranscript(conversationId) {
      const { db } = pools();
      const { rows } = await db.query('SELECT pi_messages FROM dispute_automation.conversation_state WHERE conversation_id=$1', [conversationId]);
      return Array.isArray(rows[0]?.pi_messages) ? rows[0].pi_messages : [];
    },

    async saveTranscript(conversationId, messages) {
      const { db } = pools();
      await db.query(
        `INSERT INTO dispute_automation.conversation_state(conversation_id,pi_messages) VALUES($1,$2::jsonb)
          ON CONFLICT (conversation_id) DO UPDATE SET pi_messages=EXCLUDED.pi_messages,updated_at=now()`,
        [conversationId, JSON.stringify(messages)],
      );
    },

    async countImages(conversationId) {
      const { db } = pools();
      const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM dispute_automation.evidence_images WHERE conversation_id=$1 AND expires_at>now()', [conversationId]);
      return rows[0].n;
    },

    /** Bytes held in evidence images across all chats. Used to keep image storage inside its budget. */
    async imageBytesUsed() {
      const { db } = pools();
      const { rows } = await db.query('SELECT COALESCE(SUM(byte_size),0)::bigint AS bytes FROM dispute_automation.evidence_images');
      return Number(rows[0].bytes);
    },

    /** All the images of a batch are stored, or none are. */
    async saveImages(conversationId, caseId, images, expiresAt) {
      return tx(async (c) => {
        const ids = [];
        for (const img of images) {
          const { rows } = await c.query(
            `INSERT INTO dispute_automation.evidence_images(conversation_id,case_id,mime,bytes,byte_size,expires_at)
              VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
            [conversationId, caseId, img.mime, img.bytes, img.bytes.length, expiresAt],
          );
          ids.push(rows[0].id);
        }
        return ids;
      });
    },

    async listImages(conversationId) {
      const { db } = pools();
      const { rows } = await db.query(
        'SELECT id,mime,byte_size,created_at,expires_at FROM dispute_automation.evidence_images WHERE conversation_id=$1 AND expires_at>now() ORDER BY seq',
        [conversationId],
      );
      return rows;
    },

    async loadImages(conversationId) {
      const { db } = pools();
      const { rows } = await db.query(
        'SELECT id,mime,bytes FROM dispute_automation.evidence_images WHERE conversation_id=$1 AND expires_at>now() ORDER BY seq',
        [conversationId],
      );
      return rows;
    },

    async getImage(conversationId, imageId) {
      const { db } = pools();
      try {
        const { rows } = await db.query(
          'SELECT mime,bytes FROM dispute_automation.evidence_images WHERE conversation_id=$1 AND id=$2 AND expires_at>now()',
          [conversationId, imageId],
        );
        return rows[0] || null;
      } catch (err) {
        if (err && err.code === '22P02') return null;
        throw err;
      }
    },

    /** Deletes images past their expiry. Returns how many went. */
    async purgeExpiredImages() {
      const { db } = pools();
      const r = await db.query('DELETE FROM dispute_automation.evidence_images WHERE expires_at<=now()');
      return r.rowCount;
    },

    async close() {
      await Promise.all([writePool?.end(), historyPool?.end()]);
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
      /** Newest first. (The first version ordered by uuid, which is arbitrary, not chronological.) */
      async similarCases(tenant, storeId, category, orderId) {
        const { db } = pools();
        const { rows } = await db.query(
          `SELECT c.platform_order_id,c.issue_category,c.error_amount,c.created_at,
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
            GROUP BY c.id,c.platform_order_id,c.issue_category,c.error_amount,c.created_at,o.decision_status,o.awarded_amount,i.recommendation,i.reasoning_summary
            ORDER BY c.created_at DESC LIMIT 8`,
          [tenant, storeId, category, orderId],
        );
        return rows;
      },
    },
  };
}
