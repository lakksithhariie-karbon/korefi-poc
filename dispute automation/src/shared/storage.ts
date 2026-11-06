import type { CaseRecord } from './types.ts';

const MAX_CASES = 120;

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
