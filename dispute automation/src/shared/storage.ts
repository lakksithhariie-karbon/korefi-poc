import { DEFAULT_SETTINGS, type CaseRecord, type Settings } from './types.ts';

const MAX_CASES = 120;

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function listCases(): Promise<CaseRecord[]> {
  const { cases } = await chrome.storage.local.get('cases');
  return (cases ?? []) as CaseRecord[];
}

export async function getCase(id: string): Promise<CaseRecord | undefined> {
  return (await listCases()).find((c) => c.id === id);
}

export async function upsertCase(record: CaseRecord): Promise<void> {
  const cases = await listCases();
  const i = cases.findIndex((c) => c.id === record.id);
  if (i >= 0) cases[i] = record;
  else cases.unshift(record);
  await chrome.storage.local.set({ cases: cases.slice(0, MAX_CASES) });
}

export async function patchCase(id: string, patch: Partial<CaseRecord>): Promise<CaseRecord | undefined> {
  const existing = await getCase(id);
  if (!existing) return undefined;
  const next = { ...existing, ...patch };
  await upsertCase(next);
  return next;
}
