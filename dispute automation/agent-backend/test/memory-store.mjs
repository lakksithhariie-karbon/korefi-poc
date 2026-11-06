// An in-memory stand-in with the same methods as createPgStore, so the HTTP flow can be tested without Neon.
import { UNRESOLVED_STORE } from '../src/constants.mjs';

export function createMemoryStore({ resolve = {} } = {}) {
  let seq = 1;
  const cases = [];
  const investigations = [];
  const submissions = [];
  const toolCalls = [];
  const events = [];

  return {
    cases,
    investigations,
    submissions,
    events,
    async ready() {
      return true;
    },
    async resolveStore(orderId) {
      return resolve[orderId] ?? null;
    },
    async upsertCase(tenant, operator, p) {
      let c = cases.find((x) => x.tenant === tenant && x.platform_store_id === p.storeId && x.platform_order_id === p.orderId);
      if (!c) {
        c = { id: seq++, tenant, platform_store_id: p.storeId, platform_order_id: p.orderId, status: 'new' };
        cases.push(c);
      }
      Object.assign(c, { operator, amount: p.amount ?? c.amount ?? null, capture_status: p.captureStatus, order_url: p.orderUrl ?? c.order_url ?? null });
      return { id: c.id, tenant_id: tenant, platform_store_id: c.platform_store_id, platform_order_id: c.platform_order_id };
    },
    async findCase(tenant, orderId, storeIds) {
      const matches = cases.filter((c) => c.tenant === tenant && c.platform_order_id === orderId && storeIds.includes(c.platform_store_id));
      matches.sort((a, b) => Number(a.platform_store_id === UNRESOLVED_STORE) - Number(b.platform_store_id === UNRESOLVED_STORE));
      const c = matches[0];
      return c ? { id: c.id, platform_store_id: c.platform_store_id, platform_order_id: c.platform_order_id } : null;
    },
    async setCaseStatus(id, status) {
      const c = cases.find((x) => x.id === id);
      if (c && c.status !== 'submitted') c.status = status;
    },
    async recordEvent(caseId, actor, type, details) {
      events.push({ caseId, actor, type, details });
    },
    async createInvestigation(caseId, model) {
      const i = { id: seq++, case_id: caseId, status: 'running', model_id: model, error_summary: null };
      investigations.push(i);
      return i.id;
    },
    async completeInvestigation(id, r) {
      Object.assign(investigations.find((i) => i.id === id), { status: 'completed', ...r });
    },
    async failInvestigation(id, message) {
      const i = investigations.find((x) => x.id === id);
      if (i && i.status === 'running') Object.assign(i, { status: 'failed', error_summary: message });
    },
    async getInvestigation(tenant, id) {
      const i = investigations.find((x) => String(x.id) === String(id));
      const c = i && cases.find((x) => x.id === i.case_id && x.tenant === tenant);
      if (!i || !c) return null;
      return {
        ...i,
        case_id: c.id,
        platform_store_id: c.platform_store_id,
        platform_order_id: c.platform_order_id,
        tools: (i.tools_used || []).map((t) => ({ name: t.name, status: 'completed', count: t.count })),
      };
    },
    async startToolCall(investigationId, name) {
      toolCalls.push({ id: seq++, investigationId, name });
      return toolCalls.at(-1).id;
    },
    async finishToolCall() {},
    async recordSubmission(tenant, caseId, key, actor, disputeText, submittedAt) {
      const existing = submissions.find((s) => s.tenant === tenant && s.key === key);
      if (existing) return { id: existing.id, submitted_at: existing.submittedAt, already_recorded: true };
      const s = { id: seq++, tenant, caseId, key, actor, disputeText, submittedAt };
      submissions.push(s);
      const c = cases.find((x) => x.id === caseId);
      if (c) c.status = 'submitted';
      return { id: s.id, submitted_at: s.submittedAt, already_recorded: false };
    },
    history: {
      async getFinancials() {
        return [];
      },
      async getCharges() {
        return [];
      },
      async getIssueReports() {
        return [];
      },
      async getStorePatterns() {
        return [];
      },
      async similarCases() {
        return [];
      },
    },
  };
}
