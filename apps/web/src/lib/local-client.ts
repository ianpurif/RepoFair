import type { Activity, AiAnswer, FederationResult, FixtureId, FixtureProviderInfo, LocalAnswer, LocalIndex, SourceEvidence } from '@atlas/contracts';

export const fixtures: readonly { id: FixtureId; name: string; version: string; detail: string }[] = [
  { id: 'jobboard-app@1.0.0', name: 'jobboard-app', version: '1.0.0', detail: 'Application' },
  { id: 'jobboard-app@2.0.0', name: 'jobboard-app', version: '2.0.0', detail: 'Application · retry-kit 2.0.0' },
  { id: 'retry-kit@1.0.0', name: 'retry-kit', version: '1.0.0', detail: 'Dependency' },
  { id: 'retry-kit@2.0.0', name: 'retry-kit', version: '2.0.0', detail: 'Dependency · changed behavior' },
  { id: 'event-log@1.0.0', name: 'event-log', version: '1.0.0', detail: 'Dependency' },
];
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `Request failed (${response.status}).`;
    throw new Error(error);
  }
  if (!result || typeof result !== 'object') throw new Error('The server returned an invalid response.');
  return result as T;
}
export function loadFixture(id: FixtureId, signal?: AbortSignal) {
  return request<LocalIndex>(`/api/fixtures?id=${encodeURIComponent(id)}`, { ...(signal ? { signal } : {}) });
}
export function askLocal(fixtureId: FixtureId, question: string, signal?: AbortSignal) {
  return request<LocalAnswer>('/api/questions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fixtureId, question }), ...(signal ? { signal } : {}) });
}
export function askAi(fixtureId: FixtureId, question: string, approveAiDisclosure: boolean, signal?: AbortSignal) {
  return request<AiAnswer>('/api/ai/questions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fixtureId, question, approveAiDisclosure }), ...(signal ? { signal } : {}) });
}
export function loadSource(fixtureId: FixtureId, path: string, startLine: number, endLine: number, signal?: AbortSignal) {
  const params = new URLSearchParams({ fixtureId, path, startLine: String(startLine), endLine: String(endLine) });
  return request<SourceEvidence>(`/api/source?${params}`, { ...(signal ? { signal } : {}) });
}
export function discoverProviders(signal?: AbortSignal) { return request<FixtureProviderInfo[]>('/api/providers', { ...(signal ? { signal } : {}) }); }
export function retrieveProviders(fixtureId: FixtureId, approvedProviderIds: readonly string[], externalQuestion: string, signal?: AbortSignal) {
  return request<FederationResult>('/api/federation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fixtureId, approvedProviderIds, externalQuestion }), ...(signal ? { signal } : {}) });
}
const HISTORY_KEY = 'atlas-fixture-activity-v1';
export function recordActivities(activities: readonly Activity[]) {
  try {
    const entries = readActivities();
    const ids = new Set(entries.map(entry => entry.id));
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify([...activities.filter(entry => !ids.has(entry.id)), ...entries].slice(0, 100)));
    window.dispatchEvent(new Event('atlas-activity'));
  } catch { /* Session storage is optional. Current activity remains visible. */ }
}
export function readActivities(): Activity[] {
  try {
    const entries: unknown = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? '[]');
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry): entry is Activity => !!entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.operation === 'string' && typeof entry.startedAt === 'string' && typeof entry.durationMs === 'number' && (entry.status === 'complete' || entry.status === 'failed') && typeof entry.detail === 'string');
  } catch { return []; }
}
export function clientActivity(operation: string, startedAt: string, durationMs: number, status: Activity['status'], detail: string): Activity {
  return { id: crypto.randomUUID(), operation, startedAt, durationMs: Math.round(durationMs), status, detail };
}
export function clearActivities() { sessionStorage.removeItem(HISTORY_KEY); window.dispatchEvent(new Event('atlas-activity')); }
