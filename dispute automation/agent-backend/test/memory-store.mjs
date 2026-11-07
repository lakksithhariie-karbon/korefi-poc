// An in-memory stand-in with the same methods as createPgStore, so the HTTP flow can be tested without Neon.
import { randomUUID } from 'node:crypto';
import { UNRESOLVED_STORE } from '../src/constants.mjs';

export function createMemoryStore({ resolve = {}, chats = 'ready' } = {}) {
  let seq = 1; // ordering only; ids are uuids, like the real database
  const uid = () => randomUUID();
  const cases = [];
  const investigations = [];
  const submissions = [];
  const outcomes = [];
  const toolCalls = [];
  const events = [];
  const conversations = [];
  const messages = [];
  const states = new Map();
  const images = [];

  // chats: 'ready' behaves like a database with the tables; 'missing' like one the service may not create them in.
  const chatState = chats === 'missing' ? { ready: false, missing: ['conversations'], error: 'permission denied for schema dispute_automation' } : null;

  return {
    ...(chatState ? { conversationsReady: () => false, ensureConversations: async () => chatState } : {}),
    cases,
    investigations,
    submissions,
    outcomes,
    events,
    conversations,
    messages,
    states,
    images,
    async ready() {
      return true;
    },
    async resolveStore(orderId, platform = 'doordash') {
      return platform === 'doordash' ? resolve[orderId] ?? null : null;
    },
    async upsertCase(tenant, operator, p) {
      const platform = p.platform || 'doordash';
      let c = cases.find((x) => x.tenant === tenant && x.platform === platform && x.platform_store_id === p.storeId && x.platform_order_id === p.orderId);
      if (!c) {
        c = { id: uid(), tenant, platform, platform_store_id: p.storeId, platform_order_id: p.orderId, status: 'new' };
        cases.push(c);
      }
      Object.assign(c, {
        operator,
        amount: p.amount ?? c.amount ?? null,
        capture_status: p.captureStatus,
        order_url: p.orderUrl ?? c.order_url ?? null,
        issue_category: p.issueCategory ?? c.issue_category ?? null,
        issue_description: p.issueDescription ?? c.issue_description ?? null,
        structured_facts: p.facts ?? c.structured_facts ?? {},
        redacted_page_text: p.redactedText ?? c.redacted_page_text ?? null,
      });
      return { id: c.id, tenant_id: tenant, platform_store_id: c.platform_store_id, platform_order_id: c.platform_order_id };
    },
    async findCase(tenant, orderId, storeIds, platform = 'doordash') {
      const matches = cases.filter((c) => c.tenant === tenant && c.platform === platform && c.platform_order_id === orderId && storeIds.includes(c.platform_store_id));
      matches.sort((a, b) => Number(a.platform_store_id === UNRESOLVED_STORE) - Number(b.platform_store_id === UNRESOLVED_STORE));
      const c = matches[0];
      return c ? { id: c.id, platform_store_id: c.platform_store_id, platform_order_id: c.platform_order_id } : null;
    },
    async setCaseStatus(id, status) {
      const c = cases.find((x) => x.id === id);
      if (c && !['submitted', 'closed'].includes(c.status)) c.status = status;
    },
    async recordEvent(caseId, actorType, actorId, type, details = {}) {
      events.push({ caseId, actorType, actorId, type, details });
    },
    async createInvestigation(caseId, model, conversationId = null, promptVersion = null) {
      const i = { id: uid(), case_id: caseId, status: 'running', model_id: model, error_summary: null, conversation_id: conversationId, prompt_version: promptVersion };
      investigations.push(i);
      return i.id;
    },
    async completeInvestigation(id, r) {
      const i = investigations.find((x) => x.id === id);
      if (!i || i.status !== 'running') return false;
      Object.assign(i, { status: 'completed', ...r });
      return true;
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
        conversation_id: i.conversation_id ?? null,
        platform_store_id: c.platform_store_id,
        platform_order_id: c.platform_order_id,
        tools: (i.tools_used || []).map((t) => ({ name: t.name, status: 'completed', count: t.count })),
      };
    },
    async startToolCall(investigationId, name) {
      toolCalls.push({ id: uid(), investigationId, name });
      return toolCalls.at(-1).id;
    },
    async finishToolCall() {},
    async recordSubmission(tenant, caseId, key, actor, disputeText, submittedAt) {
      const existing = submissions.find((s) => s.tenant === tenant && s.key === key);
      if (existing) return { id: existing.id, submitted_at: existing.submittedAt, already_recorded: true };
      const s = { id: uid(), tenant, caseId, key, actor, disputeText, submittedAt };
      submissions.push(s);
      const c = cases.find((x) => x.id === caseId);
      if (c) c.status = 'submitted';
      return { id: s.id, submitted_at: s.submittedAt, already_recorded: false };
    },
    async recordOutcome(caseId, decision) {
      const s = submissions.filter((x) => x.caseId === caseId).at(-1);
      if (!s) return null;
      const o = outcomes.find((x) => x.submissionId === s.id);
      if (o?.decision === decision) return { changed: false };
      const previous = o?.decision ?? null;
      if (o) o.decision = decision;
      else outcomes.push({ submissionId: s.id, decision });
      return { submission_id: s.id, previous, changed: true };
    },
    // ---- conversations ----
    async getCaseFacts(caseId) {
      const c = cases.find((x) => x.id === caseId);
      return c && { id: c.id, platform: c.platform, platform_store_id: c.platform_store_id, platform_order_id: c.platform_order_id, order_url: c.order_url, issue_category: c.issue_category, issue_description: c.issue_description, error_amount: c.amount, structured_facts: c.structured_facts, redacted_page_text: c.redacted_page_text };
    },
    async createConversation(tenant, caseId, operator, title) {
      const v = { id: uid(), tenant, case_id: caseId, title, created_by: operator, status: 'open', last_recommendation: null, created_at: new Date(Date.now() + seq++), updated_at: new Date(Date.now() + seq++) };
      conversations.push(v);
      return v.id;
    },
    async getConversation(tenant, id) {
      const v = conversations.find((x) => String(x.id) === String(id) && x.tenant === tenant);
      const c = v && cases.find((x) => x.id === v.case_id);
      return v && { ...v, platform: c.platform, platform_order_id: c.platform_order_id, platform_store_id: c.platform_store_id, case_status: c.status, error_amount: c.amount };
    },
    async listConversations(tenant, limit = 50) {
      return conversations
        .filter((v) => v.tenant === tenant)
        .filter((v) => v.status !== 'archived')
        .sort((a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at)
        .slice(0, limit)
        .map((v) => {
          const c = cases.find((x) => x.id === v.case_id);
          return { ...v, platform: c.platform, platform_order_id: c.platform_order_id, platform_store_id: c.platform_store_id, error_amount: c.amount };
        });
    },
    async touchConversation(id, patch = {}) {
      const v = conversations.find((x) => x.id === id);
      if (!v) return;
      if (patch.title) v.title = patch.title;
      if (patch.status) v.status = patch.status;
      if (patch.lastRecommendation) v.last_recommendation = patch.lastRecommendation;
      v.updated_at = new Date(Date.now() + seq++); // strictly increasing so ordering is deterministic
    },
    async appendMessage(conversationId, role, text, result = null, investigationId = null) {
      const m = { id: uid(), seq: seq++, conversation_id: conversationId, role, text, result, investigation_id: investigationId, created_at: new Date() };
      messages.push(m);
      return m.id;
    },
    async listMessages(conversationId, limit = 300) {
      return messages.filter((m) => m.conversation_id === conversationId).slice(0, limit);
    },
    async getMessageForInvestigation(investigationId) {
      return [...messages].reverse().find((m) => m.investigation_id === investigationId && m.role === 'assistant') || null;
    },
    async loadTranscript(conversationId) {
      return JSON.parse(JSON.stringify(states.get(conversationId) || []));
    },
    async saveTranscript(conversationId, msgs) {
      states.set(conversationId, JSON.parse(JSON.stringify(msgs)));
    },
    async imageBytesUsed() {
      return images.reduce((n, i) => n + i.bytes.length, 0);
    },
    async countImages(conversationId) {
      return images.filter((i) => i.conversation_id === conversationId).length;
    },
    async saveImages(conversationId, caseId, list, expiresAt) {
      return list.map((img) => {
        const row = { id: uid(), seq: seq++, conversation_id: conversationId, case_id: caseId, mime: img.mime, bytes: img.bytes, expires_at: expiresAt, created_at: new Date() };
        images.push(row);
        return row.id;
      });
    },
    async listImages(conversationId) {
      return images.filter((i) => i.conversation_id === conversationId && i.expires_at > new Date());
    },
    async loadImages(conversationId) {
      return images.filter((i) => i.conversation_id === conversationId && i.expires_at > new Date());
    },
    async getImage(conversationId, imageId) {
      return images.find((i) => i.conversation_id === conversationId && String(i.id) === String(imageId) && i.expires_at > new Date()) || null;
    },
    async purgeExpiredImages() {
      const before = images.length;
      for (let i = images.length - 1; i >= 0; i--) if (images[i].expires_at <= new Date()) images.splice(i, 1);
      return before - images.length;
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
