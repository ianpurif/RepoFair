export const IMPORT_INDEX_VERSION = 'atlas-source-v2';
export type ImportStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
export type ImportPhase = 'discovering' | 'downloading' | 'parsing' | 'publishing' | 'complete';
export type ImportJob = Readonly<{
  schemaVersion: 1; id: string; repositoryId: string; snapshotId: string; commitSha: string;
  requestedRef: string | null; status: ImportStatus; phase: ImportPhase;
  progress: Readonly<{ discovered: number; eligible: number | null; downloaded: number; reused: number;
    parsed: number; skipped: number; bytesTotal: number | null; bytesProcessed: number }>;
  attempts: number; nextAttemptAt: string | null; updatedAt: string; startedAt: string | null; finishedAt: string | null;
  error: Readonly<{ code: string; retryable: boolean; action: 'retry' | 'reconnect-github' | 'install-app' | 'reduce-scope' | 'contact-admin' | null }> | null;
  canCancel: boolean; canRetry: boolean;
}>;

/** Public progress contains committed counters, never source or credentials. */
export function parseImportJob(value: unknown): ImportJob {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  const integer = (item: unknown) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
  const date = (item: unknown) => typeof item === 'string' && Number.isFinite(Date.parse(item));
  const id = (item: unknown) => typeof item === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item);
  if (!object(value) || value.schemaVersion !== 1 || ![value.id, value.repositoryId, value.snapshotId].every(id)
    || typeof value.commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(value.commitSha)
    || !['queued','running','complete','failed','cancelled'].includes(String(value.status))
    || !['discovering','downloading','parsing','publishing','complete'].includes(String(value.phase))
    || !(value.requestedRef === null || typeof value.requestedRef === 'string' && value.requestedRef.length <= 255)
    || !object(value.progress) || !['discovered','downloaded','reused','parsed','skipped','bytesProcessed'].every(key => integer(value.progress && (value.progress as Record<string,unknown>)[key]))
    || !['eligible','bytesTotal'].every(key => value.progress && ((value.progress as Record<string,unknown>)[key] === null || integer((value.progress as Record<string,unknown>)[key])))
    || !integer(value.attempts) || !date(value.updatedAt)
    || !['nextAttemptAt','startedAt','finishedAt'].every(key => value[key] === null || date(value[key]))
    || typeof value.canCancel !== 'boolean' || typeof value.canRetry !== 'boolean') throw new Error('Invalid import job response');
  const progress = value.progress;
  if ((typeof progress.eligible === 'number' && Number(progress.downloaded) + Number(progress.reused) > progress.eligible)
    || (typeof progress.bytesTotal === 'number' && Number(progress.bytesProcessed) > progress.bytesTotal)
    || (value.status === 'complete' && (value.phase !== 'complete' || value.canCancel || value.canRetry))) throw new Error('Inconsistent import progress');
  if (value.error !== null && (!object(value.error) || typeof value.error.code !== 'string' || !/^[a-z0-9-]{1,100}$/.test(value.error.code)
    || typeof value.error.retryable !== 'boolean' || ![null,'retry','reconnect-github','install-app','reduce-scope','contact-admin'].includes(value.error.action as null))) throw new Error('Invalid import error');
  return value as unknown as ImportJob;
}
