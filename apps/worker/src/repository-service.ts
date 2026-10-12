import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { ImportJob, ImportPhase, RepositoryGraphPage, RepositoryIndex, Scope, Snapshot, SourceEvidence } from '../../../packages/contracts/src/index.ts';
import { IMPORT_INDEX_VERSION, parseImportJob } from '../../../packages/contracts/src/import.ts';
import { GIT_LIMITS } from '../../../packages/core/src/local/limits.ts';
import { evidenceId, validateSourceIndex } from '../../../packages/core/src/local/validation.ts';
import { isSafeRelativePath } from '../../../packages/core/src/evidence.ts';
import type { ParseRepositoryInput } from '../../../packages/core/src/local/index.ts';
import { isExactVersion } from '../../../packages/core/src/versions.ts';
import { AtlasDatabaseError } from './database.ts';
import type { AtlasDatabase, AtlasTransaction } from './database.ts';
import { GitHubError } from './github.ts';
import type { GitHubDiscoveryCheckpoint, GitHubTreeFile } from './github.ts';
import { githubForPrincipal } from './clerk-github.ts';

export class RepositoryServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 503) { super(message); this.name = 'RepositoryServiceError'; }
}
function fail(code: string, message: string, status = 503): never { throw new RepositoryServiceError(code, message, status); }
/** Match SQL capacity triggers; caller already owns the repository lock. */
export async function assertImportHistoryCapacity(tx:AtlasTransaction,workspaceId:string,snapshot:boolean):Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`atlas-import-capacity:${workspaceId}`]);
  const counts=(await tx.query<{snapshots:number;jobs:number}>('SELECT (SELECT count(*)::int FROM atlas.snapshots WHERE workspace_id=$1) AS snapshots,(SELECT count(*)::int FROM atlas.jobs WHERE workspace_id=$1) AS jobs',[workspaceId])).rows[0];
  if(!counts||counts.jobs>=1000||snapshot&&counts.snapshots>=100)fail('import-history-limit','Workspace history is limited to 100 snapshots and 1000 import jobs. Ask an administrator to review retention before importing another version.',422);
}
function uuid(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) return fail('invalid-id', 'Invalid repository or workspace identifier', 400);
  return value.toLowerCase();
}
function principal(value: string): void { if (typeof value !== 'string' || !/^user_[A-Za-z0-9]+$/.test(value)) fail('denied', 'Verified sign-in is required', 401); }
function githubId(value: unknown): number {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return fail('repository-unavailable', 'Repository integration is unavailable', 404);
  return number;
}
export function parseGitHubRepositoryUrl(value: string): Readonly<{ owner: string; name: string }> {
  if (typeof value !== 'string' || value.length > 500) return fail('invalid-url', 'Use an HTTPS GitHub repository URL', 400);
  let url: URL; try { url = new URL(value); } catch { return fail('invalid-url', 'Use an HTTPS GitHub repository URL', 400); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return fail('invalid-url', 'Use https://github.com/owner/repository', 400);
  const parts = url.pathname.replace(/\/$/, '').split('/');
  if (parts.length !== 3 || !parts[1] || !parts[2]) return fail('invalid-url', 'Use a repository URL with exactly an owner and name', 400);
  const owner = parts[1]; const name = parts[2].replace(/\.git$/, '');
  if (![owner, name].every(part => /^[A-Za-z0-9_.-]{1,100}$/.test(part) && part !== '.' && part !== '..')) return fail('invalid-url', 'Invalid GitHub repository name', 400);
  return { owner, name };
}
function refValue(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 255 || /[\s?#\\]/.test(value) || value.startsWith('-')) return fail('invalid-ref', 'Use a valid branch, tag or immutable commit', 400);
  return value;
}
function errorCode(error: unknown): string {
  if (error instanceof RepositoryServiceError) return error.code;
  if (error instanceof GitHubError) return `github-${error.code}`;
  if (error instanceof AtlasDatabaseError) return `database-${error.code}`;
  return 'worker-failed';
}
type Membership = { role: string; revision: string };
type RepositoryAccessRow = {
  id: string; workspace_id: string; permission_revision: string;
  github_repository_id: string | number; github_installation_id: string | number; github_owner: string; github_name: string; access_revoked: boolean;
};
type RepositoryRow = RepositoryAccessRow & { name: string; visibility: 'private' | 'public' };
type JobRow = { id: string; snapshot_id: string; repository_id: string; revision: string; requested_ref: string | null;
  status: ImportJob['status']; phase: ImportPhase; attempts: number; error_code: string | null; error_retryable: boolean;
  files_discovered: number; files_eligible: number | null; files_downloaded: number; files_reused: number; files_parsed: number; files_skipped: number;
  bytes_total: number | string | null; bytes_processed: number | string; next_attempt_at: Date | string; updated_at: Date | string;
  started_at: Date | string | null; finished_at: Date | string | null };
type ClaimedJob = RepositoryRow & { job_id: string; snapshot_id: string; principal_id: string; member_revision: string;
  repository_revision: string; commit_sha: string; attempts: number; phase: ImportPhase; claim_token: string; index_version: string };
type Manifest = { tree_sha: string; files: GitHubTreeFile[]; limitations: string[]; discovery_state: Omit<GitHubDiscoveryCheckpoint, 'files' | 'limitations'> };
export type RepositorySummary = Readonly<{ id: string; workspaceId: string; name: string; githubUrl: string; visibility: 'private' | 'public'; status: string;
  snapshotId: string | null; commitSha: string | null; errorCode: string | null; latestSnapshotId: string | null; latestCommitSha: string | null; job: ImportJob | null }>;
export type QueuedRepositoryImport = Readonly<{ repositoryId: string; snapshotId: string; jobId: string | null; status: 'queued' | 'running' | 'complete'; commitSha: string }>;
export type WorkerResult = Readonly<{ status: 'idle' | 'progress' | 'complete' | 'retrying' | 'failed' | 'unknown' | 'superseded'; jobId?: string; code?: string; phase?: ImportPhase }>;
const JOB_COLUMNS = `j.*,s.repository_id,s.revision,s.requested_ref`;
const MAX_FAILURES = 5;
function jobAction(code: string | null): NonNullable<ImportJob['error']>['action'] {
  if (!code) return null;
  if (code === 'github-rate-limit') return 'retry';
  if (code === 'github-unauthorized') return 'reconnect-github';
  if (code === 'access-revoked' || code === 'repository-unavailable') return 'install-app';
  if (['github-configuration','github-invalid','source-integrity','checkpoint-invalid','database-query','worker-failed'].includes(code)) return 'contact-admin';
  if (code.includes('limit') || code === 'parser-timeout') return 'reduce-scope';
  if (code.startsWith('parser-') || code === 'index-version-changed' || code === 'denied' || code === 'authorization-changed') return 'contact-admin';
  return 'retry';
}
function jobResponse(row: JobRow, canControl = true): ImportJob {
  const date = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();
  return parseImportJob({ schemaVersion: 1, id: row.id, repositoryId: row.repository_id, snapshotId: row.snapshot_id, commitSha: row.revision,
    requestedRef: row.requested_ref, status: row.status, phase: row.phase,
    progress: { discovered: row.files_discovered, eligible: row.files_eligible, downloaded: row.files_downloaded, reused: row.files_reused,
      parsed: row.files_parsed, skipped: row.files_skipped, bytesTotal: row.bytes_total === null ? null : Number(row.bytes_total), bytesProcessed: Number(row.bytes_processed) },
    attempts: row.attempts, nextAttemptAt: row.status === 'queued' ? date(row.next_attempt_at) : null, updatedAt: date(row.updated_at),
    startedAt: date(row.started_at), finishedAt: date(row.finished_at),
    error: row.error_code ? { code: row.error_code, retryable: row.error_retryable, action: jobAction(row.error_code) } : null,
    canCancel: canControl && (row.status === 'queued' || row.status === 'running'), canRetry: canControl && ((row.status === 'failed' && row.error_retryable) || row.status === 'cancelled' && row.error_code !== 'access-revoked') });
}
function verifiedContent(file: { path: string; text: string; blobSha: string }, expected: GitHubTreeFile): void {
  const bytes = Buffer.from(file.text, 'utf8');
  if (file.path !== expected.path || file.blobSha !== expected.blobSha || bytes.length !== expected.size || bytes.length > 262_144 || file.text.includes('\0')
    || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== expected.blobSha) fail('source-integrity', 'Repository source does not match its immutable blob', 422);
}
async function membership(transaction: AtlasTransaction, principalId: string, workspaceId: string, write: boolean, lock = false): Promise<Membership> {
  const row = (await transaction.query<Membership>(`SELECT role, revision::text AS revision FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2${lock ? ' FOR SHARE' : ''}`, [workspaceId, principalId])).rows[0];
  if (!row || (write && !['owner', 'admin'].includes(row.role))) return fail('denied', 'Workspace permission is required', 403);
  return row;
}
function ensureRevision(actual: string, expected: string): void { if (actual !== expected) fail('authorization-changed', 'Repository permissions changed; request access again', 403); }
function selectedRepository(row: RepositoryAccessRow) {
  if (row.access_revoked || !row.github_owner || !row.github_name) return fail('repository-unavailable', 'Repository is unavailable', 404);
  return { owner: row.github_owner, name: row.github_name, repositoryId: githubId(row.github_repository_id), installationId: githubId(row.github_installation_id) };
}
/** Bundled trusted parser path comes from server configuration, never repository input. */
export async function parseRepositoryIsolated(input: ParseRepositoryInput, env: Readonly<Record<string, string | undefined>>, options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {}): Promise<RepositoryIndex> {
  if ('bun' in process.versions) return fail('parser-runtime', 'The isolated repository parser requires the Node runtime');
  const cwd = process.cwd(); const root = basename(cwd) === 'web' && basename(dirname(cwd)) === 'apps' ? resolve(cwd, '../..') : cwd;
  const script = env.ATLAS_PARSER_SCRIPT ?? resolve(root, '.atlas/repository-parser-child.mjs');
  if (!isAbsolute(script)) return fail('parser-unavailable', 'Configure an absolute trusted parser script path');
  try { const info = await lstat(script); if (!info.isFile() || info.isSymbolicLink() || info.size > 32_000_000) throw new Error(); }
  catch { return fail('parser-unavailable', 'The bundled repository parser is unavailable'); }
  if (input.files.length > GIT_LIMITS.files || input.files.some(file => Buffer.byteLength(file.text, 'utf8') > 262_144)
    || input.files.reduce((total, file) => total + Buffer.byteLength(file.text, 'utf8'), 0) > GIT_LIMITS.totalCharacters) return fail('source-limit', 'Repository exceeds the supported source limits', 422);
  if (options.signal?.aborted) return fail('worker-interrupted', 'Repository import was interrupted');
  const timeout = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) return fail('parser-unavailable', 'Invalid trusted parser deadline');
  return new Promise<RepositoryIndex>((resolveIndex, reject) => {
    let settled = false; let size = 0; const output: Buffer[] = [];
    const child = spawn(process.execPath, ['--max-old-space-size=768', script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { NODE_ENV: 'production', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}) } });
    const onAbort = (): void => finish(new RepositoryServiceError('worker-interrupted', 'Repository import was interrupted'));
    const timer = setTimeout(() => finish(new RepositoryServiceError('parser-timeout', 'Repository parsing exceeded its hard time limit', 422)), timeout);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    function finish(error?: RepositoryServiceError, index?: RepositoryIndex): void {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      if (error) { child.kill(); reject(error); } else if (index) resolveIndex(index);
    }
    child.once('error', () => finish(new RepositoryServiceError('parser-unavailable', 'Repository parser could not start')));
    child.stdin.on('error', () => finish(new RepositoryServiceError('parser-failed', 'Repository parser rejected its input', 422)));
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 160_000_000) return finish(new RepositoryServiceError('source-limit', 'Parsed repository exceeds the response limit', 422)); output.push(chunk); });
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) {
        const allowed = new Set(['parser-input-limit', 'parser-source-count', 'parser-source-file', 'parser-line-limit', 'parser-total-limit',
          'parser-time-limit', 'parser-ast-limit', 'parser-graph-limit', 'parser-manifest-invalid', 'parser-lock-invalid',
          'parser-evidence-invalid', 'parser-limitations-invalid', 'parser-dependency-invalid', 'parser-failed']);
        let diagnostic = 'parser-failed';
        try { const value: unknown = JSON.parse(Buffer.concat(output).toString('utf8'));
          if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' && allowed.has(value.error)) diagnostic = value.error;
        } catch { /* Raw child output is never surfaced. */ }
        return finish(new RepositoryServiceError(diagnostic, 'Repository source could not be parsed within its supported bounds', 422));
      }
      try {
        const value: unknown = JSON.parse(Buffer.concat(output).toString('utf8')); validateSourceIndex(value);
        if (value.mode !== 'git' || JSON.stringify(value.snapshot) !== JSON.stringify(input.snapshot) || JSON.stringify(value.scope) !== JSON.stringify(input.scope)
          || value.files.length !== input.files.length || value.files.some((file, position) => file.path !== input.files[position]?.path || file.text !== input.files[position]?.text)) throw new Error();
        finish(undefined, value);
      } catch { finish(new RepositoryServiceError('parser-failed', 'Repository parser returned invalid source evidence', 422)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** The optional server-owned adapter exists for isolated integration tests/benchmarks. */
export function createRepositoryService(database: AtlasDatabase, env: Readonly<Record<string, string | undefined>>, dependencies: Readonly<{ githubForPrincipal?: typeof githubForPrincipal }> = {}) {
  const linkGitHub = dependencies.githubForPrincipal ?? githubForPrincipal;
  async function member(principalId: string, workspaceId: string, write: boolean) {
    principal(principalId); uuid(workspaceId);
    return database.withPrincipalTransaction(principalId, tx => membership(tx, principalId, workspaceId, write));
  }
  async function freshRepository(principalId: string, row: RepositoryAccessRow) {
    const linked = await linkGitHub(principalId, env);
    const authorized = await linked.client.authorizeRepository(linked.user, selectedRepository(row));
    return { ...linked, authorized };
  }
  /** Only minimal authorization candidates are read before fresh GitHub proof. */
  async function access(principalId: string, repositoryId: string, write = false) {
    principal(principalId); uuid(repositoryId);
    const row = await database.withAdminTransaction(async tx => (await tx.query<RepositoryAccessRow & { role: string; member_revision: string }>(`SELECT r.id,r.workspace_id,r.permission_revision::text,
      r.github_repository_id,r.github_installation_id,r.github_owner,r.github_name,r.access_revoked,m.role,m.revision::text AS member_revision
      FROM atlas.repositories r JOIN atlas.memberships m ON m.workspace_id=r.workspace_id
      WHERE r.id=$1 AND m.principal_id=$2 AND NOT r.access_revoked`, [repositoryId, principalId])).rows[0]);
    if (!row) return fail('repository-unavailable', 'Repository is unavailable', 404);
    if (write && !['owner','admin'].includes(row.role)) return fail('denied', 'Workspace administration is required', 403);
    await freshRepository(principalId, row); return row;
  }
  async function authorized<T>(principalId: string, repositoryId: string, write: boolean, work: (tx: AtlasTransaction, repository: RepositoryRow, scope: Scope) => Promise<T>): Promise<T> {
    const initial = await access(principalId, repositoryId, write);
    const execute = async (tx: AtlasTransaction) => {
      await tx.query("SELECT set_config('atlas.authorized_repository_ids',$1,true)", [JSON.stringify([repositoryId])]);
      const repository = (await tx.query<RepositoryRow>(`SELECT *,permission_revision::text FROM atlas.repositories WHERE id=$1 AND workspace_id=$2 AND NOT access_revoked${write ? ' FOR UPDATE' : ''}`, [repositoryId, initial.workspace_id])).rows[0];
      if (!repository) return fail('repository-unavailable', 'Repository is unavailable', 404);
      ensureRevision(repository.permission_revision, initial.permission_revision);
      const grant = await membership(tx, principalId, repository.workspace_id, write, write); ensureRevision(grant.revision, initial.member_revision);
      const result = await work(tx, repository, { tenantId: repository.workspace_id, principalId, permissionRevision: `${grant.revision}:${repository.permission_revision}` });
      // Authenticated SQL is intentionally SELECT-only. RLS checks every read;
      // recheck revisions before returning, without granting UPDATE for locks.
      if (!write) {
        const current = await membership(tx, principalId, repository.workspace_id, false); ensureRevision(current.revision, grant.revision);
        const final = (await tx.query<{ permission_revision: string }>('SELECT permission_revision::text FROM atlas.repositories WHERE id=$1 AND workspace_id=$2 AND NOT access_revoked', [repositoryId, repository.workspace_id])).rows[0];
        if (!final) return fail('repository-unavailable', 'Repository access was revoked', 403); ensureRevision(final.permission_revision, repository.permission_revision);
      }
      return result;
    };
    return write ? database.withAdminTransaction(execute) : database.withPrincipalTransaction(principalId, execute);
  }
  async function latestJob(tx: AtlasTransaction, repositoryId: string, workspaceId: string, lock = false, jobId?: string): Promise<JobRow | undefined> {
    return (await tx.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM atlas.jobs j JOIN atlas.snapshots s ON s.id=j.snapshot_id AND s.workspace_id=j.workspace_id
      WHERE s.repository_id=$1 AND j.workspace_id=$2${jobId ? ' AND j.id=$3' : ''} ORDER BY s.created_at DESC,j.created_at DESC,j.id DESC LIMIT 1${lock ? ' FOR UPDATE OF j' : ''}`, jobId ? [repositoryId, workspaceId, jobId] : [repositoryId, workspaceId])).rows[0];
  }
  async function queueImport(principalId: string, workspaceId: string, url: string, ref?: string): Promise<QueuedRepositoryImport> {
    const selected = parseGitHubRepositoryUrl(url); if (ref !== undefined) refValue(ref);
    const initial = await member(principalId, workspaceId, true);
    const linked = await linkGitHub(principalId, env);
    const live = await linked.client.authorizeRepository(linked.user, selected);
    const requestedRef = refValue(ref ?? live.defaultBranch); const commit = await linked.client.resolveCommit(live, requestedRef);
    return database.withAdminTransaction(async tx => {
      const row = (await tx.query<RepositoryRow>(`INSERT INTO atlas.repositories(id,workspace_id,name,visibility,github_repository_id,github_installation_id,github_owner,github_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,github_repository_id) DO UPDATE SET
        name=excluded.name,visibility=excluded.visibility,github_installation_id=excluded.github_installation_id,github_owner=excluded.github_owner,github_name=excluded.github_name,
        permission_revision=CASE WHEN atlas.repositories.access_revoked OR atlas.repositories.github_installation_id IS DISTINCT FROM excluded.github_installation_id THEN atlas.repositories.permission_revision+1 ELSE atlas.repositories.permission_revision END,
        access_revoked=false RETURNING *,permission_revision::text`, [randomUUID(), workspaceId, live.fullName, live.private ? 'private' : 'public', live.id, live.installationId, live.owner, live.name])).rows[0];
      if (!row) return fail('database-failed', 'Repository could not be queued');
      const current = await membership(tx, principalId, workspaceId, true, true); ensureRevision(current.revision, initial.revision);
      let snapshot = (await tx.query<{ id: string; status: string; tree_sha: string | null }>('SELECT id,status,tree_sha FROM atlas.snapshots WHERE repository_id=$1 AND workspace_id=$2 AND revision=$3 AND index_version=$4', [row.id, workspaceId, commit.sha, IMPORT_INDEX_VERSION])).rows[0];
      if (snapshot?.tree_sha && snapshot.tree_sha !== commit.treeSha) return fail('source-integrity', 'Immutable repository tree changed', 422);
      if (!snapshot) {await assertImportHistoryCapacity(tx,workspaceId,true);snapshot = (await tx.query<{ id: string; status: string; tree_sha: string | null }>(`INSERT INTO atlas.snapshots(id,workspace_id,repository_id,revision,status,requested_ref,tree_sha,index_version,base_snapshot_id)
        VALUES($1,$2,$3,$4,'queued',$5,$6,$7,(SELECT id FROM atlas.snapshots WHERE repository_id=$3 AND workspace_id=$2 AND status='complete' ORDER BY indexed_at DESC NULLS LAST,created_at DESC LIMIT 1)) RETURNING id,status,tree_sha`, [randomUUID(), workspaceId, row.id, commit.sha, requestedRef, commit.treeSha, IMPORT_INDEX_VERSION])).rows[0];}
      if (!snapshot) return fail('database-failed', 'Snapshot could not be queued');
      if (snapshot.status === 'complete') return { repositoryId: row.id, snapshotId: snapshot.id, jobId: null, status: 'complete', commitSha: commit.sha };
      const existing = (await tx.query<{ id: string; status: 'queued' | 'running' }>("SELECT id,status FROM atlas.jobs WHERE snapshot_id=$1 AND workspace_id=$2 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [snapshot.id, workspaceId])).rows[0];
      if (existing) return { repositoryId: row.id, snapshotId: snapshot.id, jobId: existing.id, status: existing.status, commitSha: commit.sha };
      await assertImportHistoryCapacity(tx,workspaceId,false);
      const previous = (await tx.query<{ phase: ImportPhase }>('SELECT phase FROM atlas.jobs WHERE snapshot_id=$1 AND workspace_id=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [snapshot.id, workspaceId])).rows[0];
      const phase = previous?.phase && previous.phase !== 'complete' ? previous.phase : 'discovering';
      const job = (await tx.query<{ id: string }>(`INSERT INTO atlas.jobs(workspace_id,snapshot_id,principal_id,permission_revision,repository_permission_revision,status,phase)
        VALUES($1,$2,$3,$4,$5,'queued',$6) RETURNING id`, [workspaceId, snapshot.id, principalId, current.revision, row.permission_revision, phase])).rows[0];
      if (!job) return fail('database-failed', 'Import job could not be queued');
      if (previous) await tx.query(`UPDATE atlas.jobs j SET files_discovered=old.files_discovered,files_eligible=old.files_eligible,files_downloaded=old.files_downloaded,
        files_reused=old.files_reused,files_parsed=old.files_parsed,files_skipped=old.files_skipped,bytes_total=old.bytes_total,bytes_processed=old.bytes_processed
        FROM (SELECT * FROM atlas.jobs WHERE snapshot_id=$1 AND id<>$2 ORDER BY created_at DESC LIMIT 1) old WHERE j.id=$2`, [snapshot.id, job.id]);
      await tx.query("UPDATE atlas.snapshots SET status='queued',requested_ref=$1,tree_sha=$2 WHERE id=$3 AND workspace_id=$4 AND status<>'complete'", [requestedRef, commit.treeSha, snapshot.id, workspaceId]);
      return { repositoryId: row.id, snapshotId: snapshot.id, jobId: job.id, status: 'queued', commitSha: commit.sha };
    });
  }
  async function getJob(principalId: string, repositoryId: string): Promise<ImportJob | null> {
    return authorized(principalId, repositoryId, false, async (tx, repository) => {
      const row = await latestJob(tx, repositoryId, repository.workspace_id);
      const grant = await membership(tx, principalId, repository.workspace_id, false);
      return row ? jobResponse(row, ['owner','admin'].includes(grant.role)) : null;
    });
  }
  async function cancelImport(principalId: string, repositoryId: string, expectedJobId?: string): Promise<ImportJob> {
    if (expectedJobId) uuid(expectedJobId);
    return authorized(principalId, repositoryId, true, async (tx, repository) => {
      const row = await latestJob(tx, repositoryId, repository.workspace_id, true, expectedJobId);
      if (!row) return fail('job-unavailable', 'Import job is unavailable', 404);
      if (row.status === 'queued' || row.status === 'running') {
        await tx.query("UPDATE atlas.jobs SET status='cancelled',claim_token=NULL,lease_until=NULL,error_code=NULL,error_retryable=false,finished_at=now(),updated_at=now() WHERE id=$1", [row.id]);
        await tx.query("UPDATE atlas.snapshots SET status='cancelled' WHERE id=$1 AND workspace_id=$2 AND status<>'complete'", [row.snapshot_id, repository.workspace_id]);
      }
      return jobResponse((await latestJob(tx, repositoryId, repository.workspace_id, false, row.id))!);
    });
  }
  async function retryImport(principalId: string, repositoryId: string, expectedJobId?: string): Promise<ImportJob> {
    if (expectedJobId) uuid(expectedJobId);
    return authorized(principalId, repositoryId, true, async (tx, repository, scope) => {
      const row = await latestJob(tx, repositoryId, repository.workspace_id, true, expectedJobId);
      if (!row) return fail('job-unavailable', 'Import job is unavailable', 404);
      if (row.status === 'queued' || row.status === 'running' || row.status === 'complete') return jobResponse(row);
      const active = (await tx.query<{ id: string }>("SELECT id FROM atlas.jobs WHERE snapshot_id=$1 AND status IN ('queued','running') FOR UPDATE", [row.snapshot_id])).rows[0];
      if (active) return jobResponse((await latestJob(tx, repositoryId, repository.workspace_id, false, active.id))!);
      const snapshot = (await tx.query<{ status: string; index_version: string }>('SELECT status,index_version FROM atlas.snapshots WHERE id=$1 AND workspace_id=$2 AND repository_id=$3 FOR UPDATE', [row.snapshot_id, repository.workspace_id, repositoryId])).rows[0];
      if (!snapshot || snapshot.status === 'complete') return fail('job-unavailable', 'This snapshot is already complete', 409);
      if (snapshot.index_version !== IMPORT_INDEX_VERSION) return fail('index-version-changed', 'Import the repository again with the current index version', 409);
      if (!jobResponse(row).canRetry) return fail('job-not-retryable', 'Resolve the import error before importing again', 409);
      await tx.query(`UPDATE atlas.jobs SET status='queued',principal_id=$1,permission_revision=$2,repository_permission_revision=$3,
        lease_until=NULL,claim_token=NULL,next_attempt_at=now(),updated_at=now(),finished_at=NULL,error_code=NULL,error_retryable=false WHERE id=$4`, [principalId, scope.permissionRevision.split(':')[0], repository.permission_revision, row.id]);
      await tx.query("UPDATE atlas.snapshots SET status='queued' WHERE id=$1 AND workspace_id=$2 AND status<>'complete'", [row.snapshot_id, repository.workspace_id]);
      return jobResponse((await latestJob(tx, repositoryId, repository.workspace_id, false, row.id))!);
    });
  }
  async function listRepositories(principalId: string, workspaceId: string): Promise<readonly RepositorySummary[]> {
    const initial = await member(principalId, workspaceId, false);
    const rows = await database.withAdminTransaction(async tx => (await tx.query<RepositoryAccessRow>(`SELECT r.id,r.workspace_id,r.permission_revision::text,
      r.github_repository_id,r.github_installation_id,r.github_owner,r.github_name,r.access_revoked FROM atlas.repositories r JOIN atlas.memberships m ON m.workspace_id=r.workspace_id
      WHERE r.workspace_id=$1 AND m.principal_id=$2 AND NOT r.access_revoked AND r.github_repository_id IS NOT NULL ORDER BY r.id LIMIT 100`, [workspaceId, principalId])).rows);
    if (!rows.length) return [];
    const linked = await linkGitHub(principalId, env); const allowed: RepositoryAccessRow[] = [];
    for (const row of rows) {
      try { await linked.client.authorizeRepository(linked.user, selectedRepository(row)); allowed.push(row); }
      catch (error) { if (error instanceof GitHubError && error.code === 'unauthorized') continue; throw error; }
    }
    return database.withPrincipalTransaction(principalId, async tx => {
      await tx.query("SELECT set_config('atlas.authorized_repository_ids',$1,true)", [JSON.stringify(allowed.map(row => row.id))]);
      const current = await membership(tx, principalId, workspaceId, false); ensureRevision(current.revision, initial.revision);
      const summaries: RepositorySummary[] = [];
      for (const row of allowed) {
        const repository = (await tx.query<{ name: string; visibility: 'private' | 'public'; permission_revision: string }>('SELECT name,visibility,permission_revision::text FROM atlas.repositories WHERE id=$1 AND workspace_id=$2 AND NOT access_revoked', [row.id, workspaceId])).rows[0];
        if (!repository || repository.permission_revision !== row.permission_revision) continue;
        const latest = (await tx.query<{ id: string; revision: string; status: string }>('SELECT id,revision,status FROM atlas.snapshots WHERE repository_id=$1 AND workspace_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1', [row.id, workspaceId])).rows[0];
        const readable = (await tx.query<{ id: string; revision: string }>("SELECT id,revision FROM atlas.snapshots WHERE repository_id=$1 AND workspace_id=$2 AND status='complete' ORDER BY indexed_at DESC NULLS LAST,created_at DESC,id DESC LIMIT 1", [row.id, workspaceId])).rows[0];
        const job = await latestJob(tx, row.id, workspaceId);
        summaries.push({ id: row.id, workspaceId, name: repository.name, githubUrl: `https://github.com/${row.github_owner}/${row.github_name}`, visibility: repository.visibility,
          status: latest?.status ?? 'unindexed', snapshotId: readable?.id ?? null, commitSha: readable?.revision ?? null, errorCode: job?.error_code ?? null,
          latestSnapshotId: latest?.id ?? null, latestCommitSha: latest?.revision ?? null, job: job ? jobResponse(job, ['owner','admin'].includes(current.role)) : null });
      }
      return summaries;
    });
  }
  async function completedSnapshot(tx: AtlasTransaction, repository: RepositoryRow, snapshotId?: string): Promise<Snapshot & { indexedAt: string }> {
    if (snapshotId) uuid(snapshotId);
    const snapshot = (await tx.query<{ id: string; revision: string; status: string; indexed_at: Date | string | null; created_at: Date | string }>(`SELECT id,revision,status,indexed_at,created_at FROM atlas.snapshots
      WHERE repository_id=$1 AND workspace_id=$2${snapshotId ? ' AND id=$3' : " AND status='complete'"} ORDER BY indexed_at DESC NULLS LAST,created_at DESC,id DESC LIMIT 1`, snapshotId ? [repository.id, repository.workspace_id, snapshotId] : [repository.id, repository.workspace_id])).rows[0];
    if (!snapshot) return fail(snapshotId ? 'snapshot-unavailable' : 'index-not-ready', snapshotId ? 'Snapshot is unavailable' : 'Repository indexing has not completed', snapshotId ? 404 : 202);
    if (snapshot.status !== 'complete') return fail('index-not-ready', 'This repository snapshot has not completed', 202);
    return { repositoryId: repository.id, snapshotId: snapshot.id, kind: 'git', revision: snapshot.revision, indexedAt: new Date(snapshot.indexed_at ?? snapshot.created_at).toISOString() };
  }
  async function storedGraph(tx: AtlasTransaction, repository: RepositoryRow, snapshot: Snapshot, scope: Scope): Promise<RepositoryIndex> {
    const graph = (await tx.query<{ graph: unknown }>('SELECT graph FROM atlas.graphs WHERE snapshot_id=$1 AND workspace_id=$2', [snapshot.snapshotId, repository.workspace_id])).rows[0]?.graph;
    if (!graph || typeof graph !== 'object') return fail('index-unavailable', 'Indexed source evidence is unavailable');
    const stored = graph as RepositoryIndex;
    if (stored.mode !== 'git' || stored.snapshot?.repositoryId !== repository.id || stored.snapshot.snapshotId !== snapshot.snapshotId || stored.snapshot.revision !== snapshot.revision
      || !Array.isArray(stored.nodes) || !Array.isArray(stored.edges) || !Array.isArray(stored.evidence) || stored.nodes.length > GIT_LIMITS.nodes || stored.edges.length > GIT_LIMITS.edges || stored.evidence.length > GIT_LIMITS.evidence) return fail('index-unavailable', 'Index identity differs from its authorized snapshot');
    return { ...stored, scope, files: [], evidence: stored.evidence.map(item => ({ ...item, scope })) };
  }
  async function getIndex(principalId: string, repositoryId: string, snapshotId?: string): Promise<RepositoryIndex> {
    if (snapshotId) uuid(snapshotId);
    return authorized(principalId, repositoryId, false, async (tx, repository, scope) => {
      const snapshot = await completedSnapshot(tx, repository, snapshotId); const graph = await storedGraph(tx, repository, snapshot, scope);
      const files = (await tx.query<{ path: string; text: string; lineCount: number }>(`SELECT path,content AS text,(length(content)-length(replace(content,E'\n',''))+1)::int AS "lineCount" FROM atlas.source_files WHERE snapshot_id=$1 AND workspace_id=$2 ORDER BY path`, [snapshot.snapshotId, repository.workspace_id])).rows;
      const index = { ...graph, files }; validateSourceIndex(index); return index;
    });
  }
  async function getGraph(principalId: string, repositoryId: string, options: Readonly<{ snapshotId?: string; folder?: string; query?: string; cursor?: number; limit?: number; nodeId?: string }> = {}): Promise<RepositoryGraphPage> {
    const cursor = options.cursor ?? 0; const limit = options.limit ?? 120;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > GIT_LIMITS.nodes || !Number.isSafeInteger(limit) || limit < 1 || limit > 160
      || options.folder !== undefined && options.folder !== '' && !isSafeRelativePath(options.folder) || options.query !== undefined && (typeof options.query !== 'string' || options.query.length > 200)
      || options.nodeId !== undefined && (typeof options.nodeId !== 'string' || options.nodeId.length > 2000)) return fail('invalid-graph-query', 'Invalid graph page selection', 400);
    if (options.snapshotId) uuid(options.snapshotId);
    return authorized(principalId, repositoryId, false, async (tx, repository, scope) => {
      const snapshot = await completedSnapshot(tx, repository, options.snapshotId); const graph = await storedGraph(tx, repository, snapshot, scope);
      const files = (await tx.query<{ path: string; lineCount: number; bytes: number }>(`SELECT path,(length(content)-length(replace(content,E'\n',''))+1)::int AS "lineCount",octet_length(content)::int AS bytes
        FROM atlas.source_files WHERE snapshot_id=$1 AND workspace_id=$2 ORDER BY path`, [snapshot.snapshotId, repository.workspace_id])).rows;
      const pathForNode = (node: RepositoryIndex['nodes'][number]) => node.kind === 'file' ? node.label : node.kind === 'symbol' ? node.localId.slice(0, node.localId.lastIndexOf('#')) : '';
      const folderCounts = new Map<string, number>();
      for (const file of files) { const parts = file.path.split('/'); parts.pop(); for (let depth = 1; depth <= parts.length; depth++) { const folder = parts.slice(0, depth).join('/'); folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1); } }
      let candidates = graph.nodes;
      if (options.nodeId) {
        const selected = graph.nodes.find(node => node.id === options.nodeId);
        if (!selected) return fail('node-unavailable', 'Graph node is unavailable in this snapshot', 404);
        const neighbors = new Set([selected.id]);
        for (const edge of graph.edges) if (edge.from === selected.id || edge.to === selected.id) { neighbors.add(edge.from); neighbors.add(edge.to); }
        candidates = [selected, ...graph.nodes.filter(node => node.id !== selected.id && neighbors.has(node.id))];
      } else if (!options.folder && !options.query) candidates = graph.nodes.filter(node => node.kind === 'file' || node.kind === 'package');
      if (options.folder) candidates = candidates.filter(node => pathForNode(node).startsWith(`${options.folder}/`));
      if (options.query) { const query = options.query.toLowerCase(); candidates = candidates.filter(node => node.label.toLowerCase().includes(query) || node.localId.toLowerCase().includes(query)); }
      const nodes = candidates.slice(cursor, cursor + limit); const selectedIds = new Set(nodes.map(node => node.id));
      const edges = graph.edges.filter(edge => selectedIds.has(edge.from) && selectedIds.has(edge.to)).slice(0, 400);
      const wantedEvidence = new Set(edges.map(edge => edge.evidenceId)); const filePaths = new Set(nodes.map(pathForNode).filter(Boolean));
      const evidence: SourceEvidence[] = []; let evidenceBytes = 2;
      for (const item of graph.evidence) {
        if (!wantedEvidence.has(item.id)) continue;
        const bytes = Buffer.byteLength(JSON.stringify(item),'utf8') + (evidence.length ? 1 : 0);
        if (evidenceBytes + bytes > 262_144) continue;
        evidence.push(item); evidenceBytes += bytes;
      }
      const retainedEvidence = new Set(evidence.map(item => item.id));
      return { ...graph, nodes, edges: edges.filter(edge => retainedEvidence.has(edge.evidenceId)), evidence, dependencies: graph.dependencies.filter(item => filePaths.has(item.sourcePath)).slice(0, 160),
        unresolved: graph.unresolved.slice(0, 100), limitations: graph.limitations.slice(0, 100), files: files.filter(file => filePaths.has(file.path)),
        folders: [...folderCounts].map(([path, fileCount]) => ({ path, fileCount })).filter(item => options.folder ? item.path.startsWith(`${options.folder}/`) && !item.path.slice(options.folder.length + 1).includes('/') : !item.path.includes('/')).slice(0, 160),
        page: { cursor, nextCursor: cursor + limit < candidates.length ? cursor + limit : null, totalNodes: candidates.length, totalFiles: files.length, limit } };
    });
  }
  async function getSource(principalId: string, repositoryId: string, snapshotId: string, path: string, startLine = 1, endLine?: number): Promise<SourceEvidence> {
    uuid(snapshotId);
    if (!isSafeRelativePath(path) || !Number.isSafeInteger(startLine) || startLine < 1 || startLine > GIT_LIMITS.linesPerFile || endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < startLine || endLine > GIT_LIMITS.linesPerFile || endLine - startLine + 1 > 120)) return fail('invalid-source-range', 'Use a safe source path and at most 120 lines', 400);
    return authorized(principalId, repositoryId, false, async (tx, repository, scope) => {
      const snapshot = await completedSnapshot(tx, repository, snapshotId);
      const file = (await tx.query<{ line_count: number; original: string }>(`SELECT (length(content)-length(replace(content,E'\n',''))+1)::int AS line_count,
        array_to_string((string_to_array(replace(content,E'\r\n',E'\n'),E'\n'))[$4:$5],E'\n') AS original
        FROM atlas.source_files WHERE snapshot_id=$1 AND workspace_id=$2 AND path=$3`, [snapshotId, repository.workspace_id, path, startLine, endLine ?? startLine + 119])).rows[0];
      if (!file) return fail('source-unavailable', 'Source file is unavailable in this snapshot', 404);
      const last = endLine ?? Math.min(startLine + 119, file.line_count);
      if (startLine > file.line_count || last > file.line_count) return fail('invalid-source-range', 'Source range is outside the verified file', 400);
      const { indexedAt, ...identity } = snapshot; const source = { ...identity, path, startLine, endLine: last };
      return { id: evidenceId({ snapshot: identity }, path, startLine, last), scope, source, original: file.original, observedAt: indexedAt, providerId: null, provenance: 'parsed-source' };
    });
  }
  /** Every staged read and write is fenced by repository, membership, claim and lease. */
  async function owned<T>(job: ClaimedJob, work: (tx: AtlasTransaction) => Promise<T>): Promise<T> {
    return database.withAdminTransaction(async tx => {
      const repository = (await tx.query<{ permission_revision: string; access_revoked: boolean }>('SELECT permission_revision::text,access_revoked FROM atlas.repositories WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [job.id, job.workspace_id])).rows[0];
      if (!repository || repository.access_revoked) return fail('repository-unavailable', 'Repository access was revoked', 403);
      ensureRevision(repository.permission_revision, job.repository_revision);
      const grant = await membership(tx, job.principal_id, job.workspace_id, true, true); ensureRevision(grant.revision, job.member_revision);
      const lease = (await tx.query<{ status: string; claim_token: string | null; live: boolean }>('SELECT status,claim_token::text,lease_until>now() AS live FROM atlas.jobs WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [job.job_id, job.workspace_id])).rows[0];
      if (!lease || lease.status !== 'running' || lease.claim_token !== job.claim_token || !lease.live) return fail('job-lease-lost', 'The import claim is no longer owned by this worker', 409);
      const snapshot = (await tx.query<{ status: string; index_version: string }>('SELECT status,index_version FROM atlas.snapshots WHERE id=$1 AND repository_id=$2 AND workspace_id=$3 FOR UPDATE', [job.snapshot_id, job.id, job.workspace_id])).rows[0];
      if (!snapshot || snapshot.status === 'complete') return fail('job-lease-lost', 'The import snapshot is no longer writable', 409);
      if (snapshot.index_version !== IMPORT_INDEX_VERSION) return fail('index-version-changed', 'Import the repository again with the current parser', 409);
      return work(tx);
    });
  }
  async function release(tx: AtlasTransaction, job: ClaimedJob, phase: ImportPhase): Promise<void> {
    await tx.query("UPDATE atlas.jobs SET status='queued',phase=$1,claim_token=NULL,lease_until=NULL,next_attempt_at=now(),updated_at=now(),error_code=NULL,error_retryable=false WHERE id=$2 AND claim_token=$3", [phase, job.job_id, job.claim_token]);
  }
  /** A web caller must supply both fields from its verified session and route. */
  async function processOne(options: Readonly<{ signal?: AbortSignal; principalId?: string; repositoryId?: string }> = {}): Promise<WorkerResult> {
    if ((options.principalId === undefined) !== (options.repositoryId === undefined)) return fail('invalid-job-scope', 'A verified principal and repository are required together', 400);
    if (options.signal?.aborted) return { status: 'idle' };
    const target = options.principalId !== undefined && options.repositoryId !== undefined
      ? { principalId: options.principalId, repository: await access(options.principalId, options.repositoryId, true) } : null;
    const job = await database.withAdminTransaction(async tx => {
      // Targeted requests prove access before reading jobs, then lock and
      // recheck the same repository and membership before a claim can be made.
      const repository = target
        ? (await tx.query<RepositoryRow>(`SELECT r.*,r.permission_revision::text FROM atlas.repositories r
          WHERE r.id=$1 AND r.workspace_id=$2 AND NOT r.access_revoked FOR UPDATE OF r SKIP LOCKED`, [target.repository.id, target.repository.workspace_id])).rows[0]
        : (await tx.query<RepositoryRow>(`SELECT r.*,r.permission_revision::text FROM atlas.repositories r WHERE EXISTS
        (SELECT 1 FROM atlas.jobs j JOIN atlas.snapshots s ON s.id=j.snapshot_id AND s.workspace_id=j.workspace_id WHERE s.repository_id=r.id AND j.workspace_id=r.workspace_id
          AND j.next_attempt_at<=now() AND (j.status='queued' OR j.status='running' AND (j.lease_until IS NULL OR j.lease_until<now())))
        ORDER BY (SELECT min(j.updated_at) FROM atlas.jobs j JOIN atlas.snapshots s ON s.id=j.snapshot_id WHERE s.repository_id=r.id AND j.status IN ('queued','running')),r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`)).rows[0];
      if (!repository) return null;
      if (target) {
        ensureRevision(repository.permission_revision, target.repository.permission_revision);
        const requester = await membership(tx, target.principalId, repository.workspace_id, true, true);
        ensureRevision(requester.revision, target.repository.member_revision);
      }
      const selected = (await tx.query<Omit<ClaimedJob, keyof RepositoryRow | 'claim_token'>>(`SELECT j.id AS job_id,j.snapshot_id,j.principal_id,j.permission_revision::text AS member_revision,
        j.repository_permission_revision::text AS repository_revision,s.revision AS commit_sha,s.index_version,j.attempts,j.phase
        FROM atlas.jobs j JOIN atlas.snapshots s ON s.id=j.snapshot_id AND s.workspace_id=j.workspace_id WHERE s.repository_id=$1 AND j.workspace_id=$2
        AND j.next_attempt_at<=now() AND (j.status='queued' OR j.status='running' AND (j.lease_until IS NULL OR j.lease_until<now()))
        ORDER BY j.updated_at,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`, [repository.id, repository.workspace_id])).rows[0];
      if (!selected) return null;
      const token = randomUUID();
      await tx.query("UPDATE atlas.jobs SET status='running',claim_token=$1,lease_until=now()+interval '2 minutes',heartbeat_at=now(),updated_at=now(),started_at=coalesce(started_at,now()) WHERE id=$2", [token, selected.job_id]);
      await tx.query("UPDATE atlas.snapshots SET status='running' WHERE id=$1 AND workspace_id=$2 AND status<>'complete'", [selected.snapshot_id, repository.workspace_id]);
      return { ...repository, ...selected, claim_token: token } as ClaimedJob;
    });
    if (!job) return { status: 'idle' };
    const ownedSlice = <T>(work: (tx: AtlasTransaction) => Promise<T>): Promise<T> => owned(job, async tx => {
      if (target) {
        const requester = await membership(tx, target.principalId, job.workspace_id, true, true);
        ensureRevision(requester.revision, target.repository.member_revision);
      }
      return work(tx);
    });
    const freshSliceRepository = async () => {
      const linked = await freshRepository(job.principal_id, job);
      if (target && target.principalId !== job.principal_id) await freshRepository(target.principalId, job);
      return linked;
    };
    const controller = new AbortController(); const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let heartbeatFailure: unknown; let heartbeatWork: Promise<void> | undefined; let active = true;
    const deadline = setTimeout(() => { heartbeatFailure = new RepositoryServiceError('worker-timeout', 'Import slice exceeded its deadline'); controller.abort(); }, 100_000);
    const heartbeat = setInterval(() => {
      if (!active || heartbeatWork) return;
      heartbeatWork = ownedSlice(tx => tx.query("UPDATE atlas.jobs SET heartbeat_at=now(),lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=$1 AND claim_token=$2", [job.job_id, job.claim_token]).then(() => {}))
        .catch(error => { heartbeatFailure = error; controller.abort(); }).finally(() => { heartbeatWork = undefined; });
    }, 15_000);
    const stopHeartbeat = async () => { active = false; clearInterval(heartbeat); clearTimeout(deadline); if (heartbeatWork) await heartbeatWork; };
    const checkAbort = () => { if (heartbeatFailure) throw heartbeatFailure; if (signal.aborted) return fail('worker-interrupted', 'Repository import was interrupted'); };
    try {
      const grant = await member(job.principal_id, job.workspace_id, true); ensureRevision(grant.revision, job.member_revision);
      await ownedSlice(async () => {}); checkAbort();
      const linked = await freshSliceRepository(); checkAbort();
      if (job.phase === 'discovering') {
        const saved = await ownedSlice(async tx => (await tx.query<Manifest>('SELECT tree_sha,files,limitations,discovery_state FROM atlas.import_manifests WHERE snapshot_id=$1 AND workspace_id=$2', [job.snapshot_id, job.workspace_id])).rows[0]);
        const checkpoint = saved ? { ...saved.discovery_state, files: saved.files, limitations: saved.limitations } : undefined;
        const next = await linked.client.discoverSnapshot(linked.authorized, job.commit_sha, checkpoint, { signal }); checkAbort();
        const totalBytes = next.files.reduce((sum, file) => sum + file.size, 0); const { files, limitations, ...state } = next;
        await stopHeartbeat(); checkAbort();
        await ownedSlice(async tx => {
          await tx.query(`INSERT INTO atlas.import_manifests(snapshot_id,workspace_id,tree_sha,files,limitations,discovery_state) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)
            ON CONFLICT(snapshot_id) DO UPDATE SET files=excluded.files,limitations=excluded.limitations,discovery_state=excluded.discovery_state`, [job.snapshot_id, job.workspace_id, next.treeSha, JSON.stringify(files), JSON.stringify(limitations), JSON.stringify(state)]);
          const tree = await tx.query('UPDATE atlas.snapshots SET tree_sha=$1 WHERE id=$2 AND workspace_id=$3 AND (tree_sha IS NULL OR tree_sha=$1) RETURNING id', [next.treeSha, job.snapshot_id, job.workspace_id]);
          if (!tree.rows[0]) return fail('source-integrity', 'Immutable repository tree changed', 422);
          await tx.query('UPDATE atlas.jobs SET files_discovered=$1,files_eligible=$2,files_skipped=$3,bytes_total=$4 WHERE id=$5 AND claim_token=$6', [next.discovered, next.complete ? files.length : null, next.skipped, next.complete ? totalBytes : null, job.job_id, job.claim_token]);
          await release(tx, job, next.complete ? 'downloading' : 'discovering');
        });
        return { status: 'progress', jobId: job.job_id, phase: next.complete ? 'downloading' : 'discovering' };
      }
      if (job.phase === 'downloading') {
        const selected = await ownedSlice(async tx => {
          const manifest = (await tx.query<Manifest>('SELECT tree_sha,files,limitations,discovery_state FROM atlas.import_manifests WHERE snapshot_id=$1 AND workspace_id=$2', [job.snapshot_id, job.workspace_id])).rows[0];
          if (!manifest?.discovery_state.complete) return fail('checkpoint-invalid', 'Import discovery checkpoint is unavailable');
          const files = (await tx.query<{ path: string; size: number; blobSha: string; reusedText: string | null }>(`WITH selected AS MATERIALIZED (
            SELECT f.path,f.size,f."blobSha" FROM atlas.import_manifests m CROSS JOIN LATERAL jsonb_to_recordset(m.files) AS f(path text,size integer,"blobSha" text)
            LEFT JOIN atlas.import_files staged ON staged.snapshot_id=m.snapshot_id AND staged.workspace_id=m.workspace_id AND staged.path=f.path
            WHERE m.snapshot_id=$1 AND m.workspace_id=$2 AND staged.path IS NULL ORDER BY f.path LIMIT 32)
            SELECT f.path,f.size,f."blobSha",reuse.content AS "reusedText" FROM selected f
            LEFT JOIN LATERAL (SELECT source.content FROM atlas.source_files source JOIN atlas.snapshots s ON s.id=source.snapshot_id AND s.workspace_id=source.workspace_id
              WHERE s.repository_id=$3 AND s.workspace_id=$2 AND s.status='complete' AND s.index_version=$4 AND source.blob_sha=f."blobSha" AND octet_length(source.content)=f.size ORDER BY s.indexed_at DESC NULLS LAST LIMIT 1) reuse ON true
            ORDER BY f.path`, [job.snapshot_id, job.workspace_id, job.id, IMPORT_INDEX_VERSION])).rows;
          return { manifest, files };
        });
        const needed = selected.files.filter(file => file.reusedText === null);
        const downloaded = await linked.client.downloadFiles(linked.authorized, needed, { signal }); checkAbort();
        if (downloaded.length !== needed.length) return fail('source-integrity', 'Source download is incomplete', 422);
        const downloadByPath = new Map(downloaded.map(file => [file.path, file]));
        const staged = selected.files.map(file => {
          const fetched = file.reusedText !== null ? { path: file.path, text: file.reusedText, blobSha: file.blobSha } : downloadByPath.get(file.path);
          if (!fetched) return fail('source-integrity', 'Source download is incomplete', 422);
          verifiedContent(fetched, file); return { path: file.path, size: file.size, blob_sha: file.blobSha, content: fetched.text, reused: file.reusedText !== null };
        });
        await freshSliceRepository(); checkAbort(); await stopHeartbeat(); checkAbort();
        const phase = await ownedSlice(async tx => {
          await tx.query(`INSERT INTO atlas.import_files(snapshot_id,workspace_id,path,blob_sha,size,content,reused)
            SELECT $1,$2,f.path,f.blob_sha,f.size,f.content,f.reused FROM jsonb_to_recordset($3::jsonb) AS f(path text,blob_sha text,size integer,content text,reused boolean)
            ON CONFLICT(snapshot_id,path) DO NOTHING`, [job.snapshot_id, job.workspace_id, JSON.stringify(staged)]);
          const counts = (await tx.query<{ downloaded: number; reused: number; bytes: string }>('SELECT count(*) FILTER(WHERE NOT reused)::int AS downloaded,count(*) FILTER(WHERE reused)::int AS reused,coalesce(sum(size),0)::text AS bytes FROM atlas.import_files WHERE snapshot_id=$1 AND workspace_id=$2', [job.snapshot_id, job.workspace_id])).rows[0]!;
          const next = counts.downloaded + counts.reused === selected.manifest.files.length ? 'parsing' : 'downloading';
          await tx.query('UPDATE atlas.jobs SET files_downloaded=$1,files_reused=$2,bytes_processed=$3 WHERE id=$4 AND claim_token=$5', [counts.downloaded, counts.reused, counts.bytes, job.job_id, job.claim_token]);
          await release(tx, job, next); return next;
        });
        return { status: 'progress', jobId: job.job_id, phase };
      }
      if (job.phase !== 'parsing' && job.phase !== 'publishing') return fail('checkpoint-invalid', 'Import phase is invalid');
      const staged = await ownedSlice(async tx => {
        const manifest = (await tx.query<Manifest>('SELECT tree_sha,files,limitations,discovery_state FROM atlas.import_manifests WHERE snapshot_id=$1 AND workspace_id=$2', [job.snapshot_id, job.workspace_id])).rows[0];
        if (!manifest?.discovery_state.complete) return fail('checkpoint-invalid', 'Import discovery checkpoint is unavailable');
        const files = (await tx.query<{ path: string; text: string; blobSha: string }>('SELECT path,content AS text,blob_sha AS "blobSha" FROM atlas.import_files WHERE snapshot_id=$1 AND workspace_id=$2 ORDER BY path', [job.snapshot_id, job.workspace_id])).rows;
        if (files.length !== manifest.files.length) return fail('checkpoint-invalid', 'Source checkpoint is incomplete');
        const expected = new Map(manifest.files.map(file => [file.path, file]));
        for (const file of files) { const match = expected.get(file.path); if (!match) return fail('source-integrity', 'Source checkpoint is outside the immutable manifest', 422); verifiedContent(file, match); }
        return { manifest, files };
      });
      let manifest: Record<string, unknown> | null = null;
      const text = staged.files.find(file => file.path === 'package.json')?.text;
      if (text !== undefined) { try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) manifest = value as Record<string, unknown>; } catch { return fail('parser-manifest-invalid', 'Repository package metadata is invalid', 422); } }
      const packageName = typeof manifest?.name === 'string' && manifest.name.trim() ? manifest.name : null;
      const version = typeof manifest?.version === 'string' && isExactVersion(manifest.version) ? manifest.version : null;
      const input: ParseRepositoryInput = { scope: { tenantId: job.workspace_id, principalId: job.principal_id, permissionRevision: `${job.member_revision}:${job.repository_revision}` },
        snapshot: { repositoryId: job.id, snapshotId: job.snapshot_id, kind: 'git', revision: job.commit_sha }, packageName, version,
        observedAt: new Date().toISOString(), files: staged.files.map(file => ({ path: file.path, text: file.text })) };
      const parsed = await parseRepositoryIsolated(input, env, { signal }); checkAbort();
      const index: RepositoryIndex = { ...parsed, limitations: [...parsed.limitations, ...staged.manifest.limitations].slice(0, 100) };
      validateSourceIndex(index);
      await ownedSlice(async tx => { await tx.query("UPDATE atlas.jobs SET phase='publishing',files_parsed=$1,updated_at=now() WHERE id=$2 AND claim_token=$3", [index.files.length, job.job_id, job.claim_token]); });
      await freshSliceRepository(); checkAbort(); await stopHeartbeat(); checkAbort();
      await ownedSlice(async tx => {
        // Publish graph and source together, with no per-file SQL loop and no
        // mutation of any previously completed snapshot.
        await tx.query(`INSERT INTO atlas.source_files(workspace_id,snapshot_id,path,content,blob_sha)
          SELECT workspace_id,snapshot_id,path,content,blob_sha FROM atlas.import_files WHERE snapshot_id=$1 AND workspace_id=$2
          ON CONFLICT(snapshot_id,path) DO UPDATE SET content=excluded.content,blob_sha=excluded.blob_sha`, [job.snapshot_id, job.workspace_id]);
        await tx.query('INSERT INTO atlas.graphs(workspace_id,snapshot_id,graph) VALUES($1,$2,$3::jsonb) ON CONFLICT(snapshot_id) DO UPDATE SET graph=excluded.graph', [job.workspace_id, job.snapshot_id, JSON.stringify({ ...index, files: [] })]);
        // Completed source is canonical; discard duplicate temporary bytes in
        // the same transaction. Failed/cancelled jobs retain their checkpoints.
        await tx.query('DELETE FROM atlas.import_files WHERE snapshot_id=$1 AND workspace_id=$2', [job.snapshot_id,job.workspace_id]);
        await tx.query('DELETE FROM atlas.import_manifests WHERE snapshot_id=$1 AND workspace_id=$2', [job.snapshot_id,job.workspace_id]);
        await tx.query("UPDATE atlas.snapshots SET status='complete',indexed_at=now() WHERE id=$1 AND workspace_id=$2", [job.snapshot_id, job.workspace_id]);
        await tx.query("UPDATE atlas.jobs SET status='complete',phase='complete',claim_token=NULL,lease_until=NULL,error_code=NULL,error_retryable=false,finished_at=now(),updated_at=now() WHERE id=$1 AND claim_token=$2", [job.job_id, job.claim_token]);
      });
      return { status: 'complete', jobId: job.job_id };
    } catch (original) {
      await stopHeartbeat(); const error = heartbeatFailure ?? original; const code = errorCode(error);
      if (error instanceof AtlasDatabaseError && error.code === 'commit_unknown') return { status: 'unknown', jobId: job.job_id, code };
      if (code === 'job-lease-lost') return { status: 'superseded', jobId: job.job_id, code };
      const interrupted = options.signal?.aborted && !heartbeatFailure || code === 'worker-interrupted';
      const retryable = interrupted || error instanceof GitHubError && (error.code === 'rate-limit' || error.code === 'upstream' && (error.status === undefined || error.status >= 500))
        || error instanceof AtlasDatabaseError && ['connection','timeout'].includes(error.code) || code === 'worker-timeout' || code === 'parser-unavailable';
      const attempts = job.attempts + (interrupted ? 0 : 1); const retrying = interrupted || retryable && attempts < MAX_FAILURES;
      const backoff = interrupted ? 0 : Math.max(Math.min(300_000, 15_000 * 2 ** Math.min(attempts - 1, 5)), error instanceof GitHubError ? error.retryAfterMs ?? 0 : 0);
      try {
        const changed = await database.withAdminTransaction(async tx => {
          const repository = (await tx.query('SELECT id FROM atlas.repositories WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [job.id, job.workspace_id])).rows[0]; if (!repository) return false;
          const result = await tx.query<{ snapshot_id: string }>(`UPDATE atlas.jobs SET status=$1,attempts=$2,next_attempt_at=$3,lease_until=NULL,claim_token=NULL,error_code=$4,error_retryable=$5,
            updated_at=now(),finished_at=CASE WHEN $1='failed' THEN now() ELSE NULL END WHERE id=$6 AND workspace_id=$7 AND status='running' AND claim_token=$8 AND lease_until>now() RETURNING snapshot_id`,
          [retrying ? 'queued' : 'failed', attempts, new Date(Date.now() + backoff).toISOString(), interrupted ? null : code, retryable, job.job_id, job.workspace_id, job.claim_token]);
          if (result.rows[0]) await tx.query("UPDATE atlas.snapshots SET status=$1 WHERE id=$2 AND workspace_id=$3 AND status<>'complete'", [retrying ? 'queued' : 'failed', job.snapshot_id, job.workspace_id]);
          return !!result.rows[0];
        });
        return changed ? { status: retrying ? 'retrying' : 'failed', jobId: job.job_id, ...(interrupted ? {} : { code }) } : { status: 'superseded', jobId: job.job_id, code };
      } catch { return { status: 'unknown', jobId: job.job_id, code: 'failure-state-unavailable' }; }
    } finally { await stopHeartbeat(); }
  }
  return { queueImport, listRepositories, getJob, cancelImport, retryImport, getIndex, getGraph, getSource, processOne };
}
