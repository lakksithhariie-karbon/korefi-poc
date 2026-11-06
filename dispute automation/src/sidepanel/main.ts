import { getCase, getSettings, listCases, patchCase, setSettings } from '../shared/storage.ts';
import type { CaseRecord, CaseStatus, RuntimeMessage, Settings } from '../shared/types.ts';
import { Assistant, contextMessage } from './agent.ts';
import { extractDraft, renderMarkdown } from './md.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;
let current: CaseRecord | null = null;
let assistant: Assistant | null = null;
let busy = false;

function banner(text: string | null): void {
  const el = $('banner');
  el.hidden = !text;
  el.textContent = text ?? '';
}

function scrollDown(): void {
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}

function addMessage(kind: 'user' | 'assistant' | 'error', html: string): HTMLElement {
  $('messages').querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.innerHTML = html;
  $('messages').append(el);
  scrollDown();
  return el;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function caseCard(c: CaseRecord): HTMLElement {
  const f = c.facts;
  const chips: string[] = [];
  if (f.decided) chips.push(`<span class="chip good">Already ${c.snapshot.disputeStatus ?? 'decided'}</span>`);
  else if (f.errorTotal > 0) chips.push(`<span class="chip crit">Error charge ${usd(f.errorTotal)}</span>`);
  const reason = c.snapshot.errorCharges.find((e) => e.reason)?.reason;
  if (reason) chips.push(`<span class="chip">${escapeHtml(reason)}</span>`);
  if (!f.decided && f.daysLeft !== null) {
    chips.push(
      f.expired
        ? '<span class="chip crit">Window expired</span>'
        : `<span class="chip ${f.daysLeft <= 3 ? 'warn' : ''}">${f.daysLeft} day${f.daysLeft === 1 ? '' : 's'} left</span>`,
    );
  }
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="top"><span class="id">Order ${escapeHtml(c.orderId)}</span><span class="when">${new Date(c.createdAt).toLocaleString()}</span></div>
    <div class="chips">${chips.join('')}</div>
    ${c.image ? `<div class="shot"><img alt="Full order page with personal details blacked out" src="${c.image}" title="Click to enlarge"></div><div class="cap">Full order, scrolled and stitched. Personal details are blacked out. Scroll here, or click to enlarge.</div>` : ''}
    ${c.imageNote ? `<div class="note">${escapeHtml(c.imageNote)}</div>` : ''}`;
  el.querySelector('img')?.addEventListener('click', () => {
    $<HTMLImageElement>('lightbox').querySelector('img')!.src = c.image!;
    $('lightbox').hidden = false;
  });
  const dbg = document.createElement('button');
  dbg.type = 'button';
  dbg.className = 'link';
  dbg.textContent = 'Copy captured data';
  dbg.title = 'Copies the parsed order and page text with names removed, useful when something was read wrong';
  dbg.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ snapshot: c.snapshot, facts: c.facts, redactedText: c.redactedText }, null, 2));
      dbg.textContent = 'Copied';
    } catch {
      dbg.textContent = 'Copy failed';
    }
    setTimeout(() => (dbg.textContent = 'Copy captured data'), 1500);
  });
  el.append(dbg);
  return el;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function addActions(host: HTMLElement, c: CaseRecord, text: string): void {
  const row = document.createElement('div');
  row.className = 'actions';
  const mk = (label: string, fn: (b: HTMLButtonElement) => void | Promise<void>) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => void fn(b));
    row.append(b);
  };
  mk('Copy draft', async (b) => {
    try {
      await navigator.clipboard.writeText(extractDraft(text));
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Copy failed';
    }
    setTimeout(() => (b.textContent = 'Copy draft'), 1500);
  });
  mk('Mark filed', async (b) => {
    await patchCase(c.id, { status: 'filed' });
    b.textContent = 'Marked filed';
    b.disabled = true;
  });
  mk('Skip', async (b) => {
    await patchCase(c.id, { status: 'skipped' });
    b.textContent = 'Skipped';
    b.disabled = true;
  });
  host.append(row);
}

async function streamReply(target: HTMLElement, gen: AsyncGenerator<string>): Promise<string> {
  let text = '';
  for await (const chunk of gen) {
    text += chunk;
    target.innerHTML = renderMarkdown(text);
    scrollDown();
  }
  return text;
}

function requireKey(): boolean {
  if (settings.apiKey) return true;
  banner('Add your OpenAI API key in settings (the gear) to get suggestions.');
  $('settings').hidden = false;
  return false;
}

async function showCase(c: CaseRecord, assess: boolean): Promise<void> {
  current = c;
  assistant = null;
  $('messages').append(caseCard(c));
  scrollDown();
  if (c.assessment) {
    const el = addMessage('assistant', renderMarkdown(c.assessment));
    addActions(el, c, c.assessment);
  }
  if (assess && !c.assessment) await runAssessment(c);
}

async function runAssessment(c: CaseRecord): Promise<void> {
  if (!requireKey() || busy) return;
  busy = true;
  banner(null);
  const bubble = addMessage('assistant', '<p>Reviewing this order…</p>');
  try {
    assistant = new Assistant(settings);
    const text = await streamReply(bubble, assistant.send(contextMessage(c)));
    current = (await patchCase(c.id, { assessment: text })) ?? c;
    addActions(bubble, current, text);
  } catch (err) {
    bubble.className = 'msg error';
    bubble.textContent = errorText(err);
  } finally {
    busy = false;
  }
}

function errorText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/401|invalid api key|incorrect api key/i.test(m)) return 'OpenAI rejected the API key. Check it in settings.';
  return `Something went wrong: ${m}`;
}

async function ask(text: string): Promise<void> {
  if (!current) {
    banner('Capture an order first, then ask about it.');
    return;
  }
  if (!requireKey() || busy) return;
  busy = true;
  addMessage('user', escapeHtml(text));
  const bubble = addMessage('assistant', '<p>…</p>');
  try {
    if (!assistant) {
      assistant = new Assistant(settings);
      assistant.seed(current);
    }
    await streamReply(bubble, assistant.send({ role: 'user', content: text }));
  } catch (err) {
    bubble.className = 'msg error';
    bubble.textContent = errorText(err);
  } finally {
    busy = false;
  }
}

$('lightbox').addEventListener('click', () => ($('lightbox').hidden = true));

// ----- settings and capture toggle -----

function renderToggle(): void {
  const b = $('capture-toggle');
  b.className = `pill ${settings.captureEnabled ? 'on' : 'off'}`;
  b.textContent = settings.captureEnabled ? 'Capturing order pages' : 'Capture off';
  b.setAttribute('aria-pressed', String(settings.captureEnabled));
}

$('capture-toggle').addEventListener('click', async () => {
  settings = await setSettings({ captureEnabled: !settings.captureEnabled });
  renderToggle();
});

$('settings-btn').addEventListener('click', () => {
  const s = $('settings');
  s.hidden = !s.hidden;
  $('settings-btn').setAttribute('aria-expanded', String(!s.hidden));
});

$('save-settings').addEventListener('click', async () => {
  settings = await setSettings({
    apiKey: $<HTMLInputElement>('api-key').value.trim(),
    model: $<HTMLInputElement>('model').value.trim(),
    baseUrl: $<HTMLInputElement>('base-url').value.trim(),
  });
  $('settings').hidden = true;
  banner(null);
  if (current && !current.assessment) void runAssessment(current);
});

$('capture-now').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return banner('Open a DoorDash order page on the current tab first.');
  banner('Capturing the full order sheet. It will scroll for a few seconds, so leave it alone.');
  chrome.runtime.sendMessage({ type: 'CAPTURE_NOW', tabId: tab.id } satisfies RuntimeMessage).catch(() => {});
});

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  void ask(text);
});

// ----- tabs and cases list -----

function selectTab(name: 'chat' | 'cases'): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  }
  $('chat').hidden = name !== 'chat';
  $('cases').hidden = name !== 'cases';
  if (name === 'cases') void renderCases();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
  b.addEventListener('click', () => selectTab(b.dataset.tab as 'chat' | 'cases'));
}

const STATUSES: CaseStatus[] = ['new', 'filed', 'skipped', 'won', 'lost'];

async function renderCases(): Promise<void> {
  const cases = await listCases();
  $('case-count').textContent = `${cases.length} case${cases.length === 1 ? '' : 's'}`;
  const list = $('case-list');
  list.replaceChildren();
  for (const c of cases) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.className = 'open';
    open.type = 'button';
    const left = c.facts.decided ? 'decided' : c.facts.expired ? 'expired' : c.facts.daysLeft === null ? '' : `${c.facts.daysLeft}d left`;
    open.innerHTML = `<b>${escapeHtml(c.orderId)}</b><span>${usd(c.facts.errorTotal)} · ${escapeHtml(left)} · ${new Date(c.createdAt).toLocaleDateString()}</span>`;
    open.addEventListener('click', () => {
      selectTab('chat');
      $('messages').replaceChildren();
      void showCase(c, false);
    });
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `Status for order ${c.orderId}`);
    for (const s of STATUSES) sel.add(new Option(s, s, false, s === c.status));
    sel.addEventListener('change', () => void patchCase(c.id, { status: sel.value as CaseStatus }));
    li.append(open, sel);
    list.append(li);
  }
}

$('export').addEventListener('click', async () => {
  const rows = (await listCases()).map((c) => [
    c.createdAt,
    c.orderId,
    c.snapshot.placedAt ?? '',
    c.snapshot.errorCharges.map((e) => e.reason ?? '').join('; '),
    c.facts.errorTotal.toFixed(2),
    c.snapshot.disputeStatus ?? '',
    c.facts.daysLeft ?? '',
    c.status,
  ]);
  const header = ['captured_at', 'order_id', 'placed_at', 'reason', 'open_error_total', 'status_on_page', 'days_left_at_capture', 'our_status'];
  const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `disputes-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ----- messages from the background worker -----

chrome.runtime.onMessage.addListener((msg: RuntimeMessage) => {
  if (msg.type === 'CASE_CAPTURED') {
    banner(null);
    void getCase(msg.caseId).then((c) => {
      if (!c) return;
      selectTab('chat');
      void showCase(c, true);
    });
  } else if (msg.type === 'CAPTURE_FAILED') {
    banner(msg.reason);
  }
  return false;
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) {
    void getSettings().then((s) => {
      settings = s;
      renderToggle();
    });
  }
});

async function init(): Promise<void> {
  settings = await getSettings();
  $<HTMLInputElement>('api-key').value = settings.apiKey;
  $<HTMLInputElement>('model').value = settings.model;
  $<HTMLInputElement>('base-url').value = settings.baseUrl;
  renderToggle();
  const [latest] = await listCases();
  if (latest) {
    const fresh = Date.now() - new Date(latest.createdAt).getTime() < 10 * 60_000;
    await showCase(latest, fresh);
  } else {
    $('messages').innerHTML =
      '<div class="empty">Open a DoorDash order, then turn on <b>Capture</b> above. The order, a screenshot with personal details blacked out, and a suggested dispute will appear here.</div>';
  }
  if (!settings.apiKey) banner('Add your OpenAI API key in settings (the gear) to get suggestions.');
}

void init();
