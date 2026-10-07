import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { RepositoryIndex } from '../../../packages/contracts/src/index.ts';
import { LOCAL_LIMITS } from '../../../packages/core/src/local/limits.ts';
import { validateSourceIndex } from '../../../packages/core/src/local/validation.ts';
import type { ParseRepositoryInput } from '../../../packages/core/src/local/index.ts';
import { isExactVersion } from '../../../packages/core/src/versions.ts';
import { AtlasDatabaseError } from './database.ts';
import type { AtlasDatabase, AtlasTransaction } from './database.ts';
import { GitHubError } from './github.ts';
import { githubForPrincipal } from './clerk-github.ts';

export class RepositoryServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 503) { super(message); this.name = 'RepositoryServiceError'; }
}
function fail(code: string, message: string, status = 503): never { throw new RepositoryServiceError(code, message, status); }
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
type ClaimedJob = RepositoryRow & { job_id: string; snapshot_id: string; principal_id: string; member_revision: string; commit_sha: string; attempts: number };
export type RepositorySummary = Readonly<{ id: string; workspaceId: string; name: string; githubUrl: string; visibility: 'private' | 'public'; status: string; snapshotId: string | null; commitSha: string | null; errorCode: string | null }>;
export type QueuedRepositoryImport = Readonly<{ repositoryId: string; snapshotId: string; jobId: string | null; status: 'queued' | 'running' | 'complete'; commitSha: string }>;
export type WorkerResult = Readonly<{ status: 'idle' | 'complete' | 'failed' | 'unknown'; jobId?: string; code?: string }>;
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
export async function parseRepositoryIsolated(input: ParseRepositoryInput, env: Readonly<Record<string, string | undefined>>): Promise<RepositoryIndex> {
  if ('bun' in process.versions) return fail('parser-runtime', 'The isolated repository parser requires the Node runtime');
  const cwd = process.cwd(); const root = basename(cwd) === 'web' && basename(dirname(cwd)) === 'apps' ? resolve(cwd, '../..') : cwd;
  const script = env.ATLAS_PARSER_SCRIPT ?? resolve(root, '.atlas/repository-parser-child.mjs');
  if (!isAbsolute(script)) return fail('parser-unavailable', 'Configure an absolute trusted parser script path');
  try { const info = await lstat(script); if (!info.isFile() || info.isSymbolicLink() || info.size > 32_000_000) throw new Error(); }
  catch { return fail('parser-unavailable', 'The bundled repository parser is unavailable'); }
  if (input.files.length > LOCAL_LIMITS.files || input.files.some(file => file.text.length > LOCAL_LIMITS.fileCharacters)
    || input.files.reduce((total, file) => total + file.text.length, 0) > LOCAL_LIMITS.totalCharacters) return fail('source-limit', 'Repository exceeds the supported source limits', 422);
  return new Promise<RepositoryIndex>((resolveIndex, reject) => {
    let settled = false; let size = 0; const output: Buffer[] = [];
    const child = spawn(process.execPath, ['--max-old-space-size=256', script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { NODE_ENV: 'production', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}) } });
    const timer = setTimeout(() => finish(new RepositoryServiceError('parser-timeout', 'Repository parsing exceeded its hard time limit', 422)), 15_000);
    function finish(error?: RepositoryServiceError, index?: RepositoryIndex): void {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else if (index) resolveIndex(index);
    }
    child.once('error', () => finish(new RepositoryServiceError('parser-unavailable', 'Repository parser could not start')));
    child.stdin.on('error', () => finish(new RepositoryServiceError('parser-failed', 'Repository parser rejected its input', 422)));
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 16_000_000) return finish(new RepositoryServiceError('source-limit', 'Parsed repository exceeds the response limit', 422)); output.push(chunk); });
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
        if (value.mode !== 'git' || JSON.stringify(value.snapshot) !== JSON.stringify(input.snapshot) || JSON.stringify(value.scope) !== JSON.stringify(input.scope)) throw new Error();
        finish(undefined, value);
      } catch { finish(new RepositoryServiceError('parser-failed', 'Repository parser returned invalid source evidence', 422)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export function createRepositoryService(database: AtlasDatabase, env: Readonly<Record<string, string | undefined>>) {
  async function member(principalId: string, workspaceId: string, write: boolean) {
    principal(principalId); uuid(workspaceId);
    return database.withPrincipalTransaction(principalId, transaction => membership(transaction, principalId, workspaceId, write));
  }
  async function freshRepository(principalId: string, row: RepositoryAccessRow) {
    const linked = await githubForPrincipal(principalId, env);
    const authorized = await linked.client.authorizeRepository(linked.user, selectedRepository(row));
    return { ...linked, authorized };
  }
  async function queueImport(principalId: string, workspaceId: string, url: string, ref?: string): Promise<QueuedRepositoryImport> {
    const selected = parseGitHubRepositoryUrl(url); if (ref !== undefined) refValue(ref);
    const initial = await member(principalId, workspaceId, true);
    const linked = await githubForPrincipal(principalId, env);
    const authorized = await linked.client.authorizeRepository(linked.user, selected);
    const requestedRef = refValue(ref ?? authorized.defaultBranch);
    const commit = await linked.client.resolveCommit(authorized, requestedRef);
    return database.withAdminTransaction(async transaction => {
      const current = await membership(transaction, principalId, workspaceId, true, true); ensureRevision(current.revision, initial.revision);
      const row = (await transaction.query<RepositoryRow>(`INSERT INTO atlas.repositories(id,workspace_id,name,visibility,github_repository_id,github_installation_id,github_owner,github_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,github_repository_id) DO UPDATE SET
        name=excluded.name, visibility=excluded.visibility, github_installation_id=excluded.github_installation_id,
        github_owner=excluded.github_owner, github_name=excluded.github_name,
        permission_revision=CASE WHEN atlas.repositories.access_revoked THEN atlas.repositories.permission_revision+1 ELSE atlas.repositories.permission_revision END,
        access_revoked=false RETURNING *, permission_revision::text AS permission_revision`, [randomUUID(), workspaceId, authorized.fullName, authorized.private ? 'private' : 'public', authorized.id, authorized.installationId, authorized.owner, authorized.name])).rows[0];
      if (!row) return fail('database-failed', 'Repository could not be queued');
      // The repository write lock serializes imports, workers and revocation.
      // Existing rows always lock in repository -> job -> snapshot order.
      let snapshot = (await transaction.query<{ id: string; status: string }>('SELECT id,status FROM atlas.snapshots WHERE repository_id=$1 AND workspace_id=$2 AND revision=$3', [row.id, workspaceId, commit.sha])).rows[0];
      if (!snapshot) snapshot = (await transaction.query<{ id: string; status: string }>("INSERT INTO atlas.snapshots(id,workspace_id,repository_id,revision,status,requested_ref) VALUES($1,$2,$3,$4,'queued',$5) RETURNING id,status", [randomUUID(), workspaceId, row.id, commit.sha, requestedRef])).rows[0];
      if (!snapshot) return fail('database-failed', 'Snapshot could not be queued');
      if (snapshot.status === 'complete') return { repositoryId: row.id, snapshotId: snapshot.id, jobId: null, status: 'complete', commitSha: commit.sha };
      const existing = (await transaction.query<{ id: string; status: 'queued' | 'running' }>("SELECT id,status FROM atlas.jobs WHERE snapshot_id=$1 AND principal_id=$2 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [snapshot.id, principalId])).rows[0];
      if (existing) {
        await transaction.query('UPDATE atlas.snapshots SET requested_ref=$1 WHERE id=$2 AND workspace_id=$3', [requestedRef, snapshot.id, workspaceId]);
        return { repositoryId: row.id, snapshotId: snapshot.id, jobId: existing.id, status: existing.status, commitSha: commit.sha };
      }
      const job = (await transaction.query<{ id: string }>("INSERT INTO atlas.jobs(workspace_id,snapshot_id,principal_id,permission_revision,status) VALUES($1,$2,$3,$4,'queued') RETURNING id", [workspaceId, snapshot.id, principalId, current.revision])).rows[0];
      if (!job) return fail('database-failed', 'Import job could not be queued');
      await transaction.query("UPDATE atlas.snapshots SET status='queued',requested_ref=$1 WHERE id=$2 AND workspace_id=$3", [requestedRef, snapshot.id, workspaceId]);
      return { repositoryId: row.id, snapshotId: snapshot.id, jobId: job.id, status: 'queued', commitSha: commit.sha };
    });
  }
  async function listRepositories(principalId: string, workspaceId: string): Promise<readonly RepositorySummary[]> {
    const initial = await member(principalId, workspaceId, false);
    // Minimal server-only authorization candidates: never source, graph, names,
    // visibility or status. RLS data reads happen only after live GitHub proof.
    const rows = await database.withAdminTransaction(async transaction => (await transaction.query<RepositoryAccessRow>(`SELECT r.id,r.workspace_id,r.permission_revision::text AS permission_revision,
      r.github_repository_id,r.github_installation_id,r.github_owner,r.github_name,r.access_revoked
      FROM atlas.repositories r JOIN atlas.memberships m ON m.workspace_id=r.workspace_id
      WHERE r.workspace_id=$1 AND m.principal_id=$2 AND NOT r.access_revoked AND r.github_repository_id IS NOT NULL ORDER BY r.id LIMIT 20`, [workspaceId, principalId])).rows);
    if (!rows.length) return [];
    const linked = await githubForPrincipal(principalId, env); const allowed: RepositoryAccessRow[] = [];
    for (const row of rows) {
      try { await linked.client.authorizeRepository(linked.user, selectedRepository(row)); allowed.push(row); }
      catch (error) { if (error instanceof GitHubError && error.code === 'unauthorized') continue; throw error; }
    }
    return database.withPrincipalTransaction(principalId, async transaction => {
      await transaction.query("SELECT set_config('atlas.authorized_repository_ids',$1,true)", [JSON.stringify(allowed.map(row => row.id))]);
      const current = await membership(transaction, principalId, workspaceId, false); ensureRevision(current.revision, initial.revision);
      const summaries: RepositorySummary[] = [];
      for (const row of allowed) {
        const visible = (await transaction.query<{ permission_revision: string; name: string; visibility: 'private' | 'public' }>('SELECT name,visibility,permission_revision::text FROM atlas.repositories WHERE id=$1 AND workspace_id=$2 AND NOT access_revoked', [row.id, workspaceId])).rows[0];
        if (!visible || visible.permission_revision !== row.permission_revision) continue;
        const latest = (await transaction.query<{ id: string; revision: string; status: string; error_code: string | null }>(`SELECT s.id,s.revision,s.status,j.error_code FROM atlas.snapshots s LEFT JOIN LATERAL
          (SELECT error_code FROM atlas.jobs WHERE snapshot_id=s.id AND principal_id=$2 ORDER BY created_at DESC LIMIT 1) j ON true
          WHERE s.repository_id=$1 AND s.workspace_id=$3 ORDER BY s.created_at DESC LIMIT 1`, [row.id, principalId, workspaceId])).rows[0];
        summaries.push({ id: row.id, workspaceId, name: visible.name, githubUrl: `https://github.com/${row.github_owner}/${row.github_name}`, visibility: visible.visibility,
          status: latest?.status ?? 'unindexed', snapshotId: latest?.id ?? null, commitSha: latest?.revision ?? null, errorCode: latest?.error_code ?? null });
      }
      return summaries;
    });
  }
  async function getIndex(principalId: string, repositoryId: string): Promise<RepositoryIndex> {
    principal(principalId); uuid(repositoryId);
    const metadata = await database.withAdminTransaction(async transaction => {
      const row = (await transaction.query<RepositoryAccessRow & { role: string; member_revision: string }>(`SELECT r.id,r.workspace_id,r.permission_revision::text AS permission_revision,
        r.github_repository_id,r.github_installation_id,r.github_owner,r.github_name,r.access_revoked,m.role,m.revision::text AS member_revision
        FROM atlas.repositories r JOIN atlas.memberships m ON m.workspace_id=r.workspace_id
        WHERE r.id=$1 AND m.principal_id=$2 AND NOT r.access_revoked`, [repositoryId, principalId])).rows[0];
      if (!row) return fail('repository-unavailable', 'Repository is unavailable', 404);
      return { row, grant: { role: row.role, revision: row.member_revision } };
    });
    await freshRepository(principalId, metadata.row);
    return database.withPrincipalTransaction(principalId, async transaction => {
      await transaction.query("SELECT set_config('atlas.authorized_repository_ids',$1,true)", [JSON.stringify([repositoryId])]);
      const current = await membership(transaction, principalId, metadata.row.workspace_id, false); ensureRevision(current.revision, metadata.grant.revision);
      const repository = (await transaction.query<RepositoryRow>('SELECT *,permission_revision::text AS permission_revision FROM atlas.repositories WHERE id=$1 AND workspace_id=$2 AND NOT access_revoked', [repositoryId, metadata.row.workspace_id])).rows[0];
      if (!repository) return fail('repository-unavailable', 'Repository is unavailable', 404); ensureRevision(repository.permission_revision, metadata.row.permission_revision);
      const snapshot = (await transaction.query<{ id: string; revision: string; status: string }>('SELECT id,revision,status FROM atlas.snapshots WHERE repository_id=$1 AND workspace_id=$2 ORDER BY created_at DESC LIMIT 1', [repositoryId, repository.workspace_id])).rows[0];
      if (!snapshot) return fail('index-not-ready', 'Repository indexing has not completed', 202);
      if (snapshot.status === 'failed') return fail('index-failed', 'The latest repository import failed; inspect its job status', 422);
      if (snapshot.status !== 'complete') return fail('index-not-ready', 'The latest repository import has not completed', 202);
      const graph = (await transaction.query<{ graph: unknown }>('SELECT graph FROM atlas.graphs WHERE snapshot_id=$1 AND workspace_id=$2', [snapshot.id, repository.workspace_id])).rows[0]?.graph;
      const source = (await transaction.query<{ path: string; text: string; lineCount: number }>(`SELECT path,content AS text,(length(content)-length(replace(content,E'\n',''))+1)::int AS "lineCount" FROM atlas.source_files WHERE snapshot_id=$1 AND workspace_id=$2 ORDER BY path`, [snapshot.id, repository.workspace_id])).rows;
      if (!graph || typeof graph !== 'object') return fail('index-unavailable', 'Indexed source evidence is unavailable');
      const scope = { tenantId: repository.workspace_id, principalId, permissionRevision: `${current.revision}:${repository.permission_revision}` };
      const stored = graph as RepositoryIndex;
      const index = { ...stored, scope, files: source, evidence: Array.isArray(stored.evidence) ? stored.evidence.map(item => ({ ...item, scope })) : [] };
      validateSourceIndex(index);
      if (index.mode !== 'git' || index.snapshot.repositoryId !== repositoryId || index.snapshot.snapshotId !== snapshot.id || index.snapshot.revision !== snapshot.revision) return fail('index-unavailable', 'Index identity differs from its authorized snapshot');
      return index;
    });
  }
  async function processOne(): Promise<WorkerResult> {
    const job = await database.withAdminTransaction(async transaction => {
      // Acquire one repository first. SKIP LOCKED keeps concurrent workers from
      // waiting on an importer/revocation while holding a job or snapshot lock.
      const repository = (await transaction.query<RepositoryRow>(`SELECT r.*,r.permission_revision::text AS permission_revision FROM atlas.repositories r
        WHERE EXISTS (SELECT 1 FROM atlas.jobs j JOIN atlas.snapshots s ON s.id=j.snapshot_id AND s.workspace_id=j.workspace_id
          WHERE s.repository_id=r.id AND j.workspace_id=r.workspace_id AND (j.status='queued' OR (j.status='running' AND j.lease_until<now())))
        ORDER BY r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`)).rows[0];
      if (!repository) return null;
      const selected = (await transaction.query<{ job_id: string; snapshot_id: string; principal_id: string; member_revision: string; commit_sha: string; attempts: number }>(`SELECT j.id AS job_id,j.snapshot_id,j.principal_id,j.permission_revision::text AS member_revision,s.revision AS commit_sha,j.attempts
        FROM atlas.jobs j JOIN atlas.snapshots s ON s.id=j.snapshot_id AND s.workspace_id=j.workspace_id
        WHERE s.repository_id=$1 AND j.workspace_id=$2 AND (j.status='queued' OR (j.status='running' AND j.lease_until<now()))
        ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`, [repository.id, repository.workspace_id])).rows[0];
      const found: ClaimedJob | undefined = selected ? { ...repository, ...selected } : undefined;
      if (!found) return null;
      if (found.attempts >= 3) {
        await transaction.query("UPDATE atlas.jobs SET status='failed',error_code='attempt-limit',lease_until=NULL WHERE id=$1", [found.job_id]);
        await transaction.query("UPDATE atlas.snapshots SET status='failed' WHERE id=$1 AND workspace_id=$2 AND status<>'complete'", [found.snapshot_id, found.workspace_id]);
        return null;
      }
      await transaction.query("UPDATE atlas.jobs SET status='running',attempts=attempts+1,lease_until=now()+interval '5 minutes',error_code=NULL WHERE id=$1", [found.job_id]);
      await transaction.query("UPDATE atlas.snapshots SET status='running' WHERE id=$1 AND status<>'complete'", [found.snapshot_id]);
      return { ...found, attempts: found.attempts + 1 };
    });
    if (!job) return { status: 'idle' };
    try {
      const grant = await member(job.principal_id, job.workspace_id, true); ensureRevision(grant.revision, job.member_revision);
      const linked = await freshRepository(job.principal_id, job);
      const downloaded = await linked.client.downloadSnapshot(linked.authorized, job.commit_sha, { maxFiles: LOCAL_LIMITS.files, maxFileBytes: 262_144, maxTotalBytes: 5_000_000 });
      if (downloaded.files.length > LOCAL_LIMITS.files) return fail('source-limit', `Repository exceeds the supported ${LOCAL_LIMITS.files}-file source limit`, 422);
      if (downloaded.files.some(file => Buffer.byteLength(file.text, 'utf8') > 262_144)) return fail('source-limit', 'A repository source file exceeds the database storage limit', 422);
      const manifestText = downloaded.files.find(file => file.path === 'package.json')?.text;
      let manifest: { name?: unknown; version?: unknown };
      try { manifest = JSON.parse(manifestText ?? '') as typeof manifest; } catch { return fail('manifest-invalid', 'A root package.json with an exact package version is required', 422); }
      if (!manifest || typeof manifest.name !== 'string' || !manifest.name || typeof manifest.version !== 'string' || !isExactVersion(manifest.version)) return fail('manifest-invalid', 'A supported exact package name and version are required', 422);
      const input: ParseRepositoryInput = { scope: { tenantId: job.workspace_id, principalId: job.principal_id, permissionRevision: `${grant.revision}:${job.permission_revision}` },
        snapshot: { repositoryId: job.id, snapshotId: job.snapshot_id, kind: 'git', revision: job.commit_sha }, packageName: manifest.name, version: manifest.version,
        observedAt: new Date().toISOString(), files: downloaded.files.map(({ path, text }) => ({ path, text })) };
      const parsed = await parseRepositoryIsolated(input, env);
      const index: RepositoryIndex = { ...parsed, limitations: [...parsed.limitations, ...downloaded.limitations.slice(0, 20),
        ...(downloaded.limitations.length > 20 ? [`${downloaded.limitations.length - 20} additional unsupported links or submodules were omitted from this bounded limitation list.`] : [])] };
      validateSourceIndex(index);
      await freshRepository(job.principal_id, job);
      await database.withAdminTransaction(async transaction => {
        const current = await membership(transaction, job.principal_id, job.workspace_id, true, true); ensureRevision(current.revision, job.member_revision);
        const repository = (await transaction.query<{ permission_revision: string; access_revoked: boolean }>('SELECT permission_revision::text,access_revoked FROM atlas.repositories WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [job.id, job.workspace_id])).rows[0];
        if (!repository || repository.access_revoked) return fail('denied', 'Repository access was revoked', 403); ensureRevision(repository.permission_revision, job.permission_revision);
        const lease = (await transaction.query<{ status: string; attempts: number; live: boolean }>("SELECT status,attempts,lease_until>now() AS live FROM atlas.jobs WHERE id=$1 FOR UPDATE", [job.job_id])).rows[0];
        if (!lease || lease.status !== 'running' || lease.attempts !== job.attempts || !lease.live) return fail('job-lease-lost', 'Import job lease is no longer owned by this worker');
        await transaction.query('SELECT id FROM atlas.snapshots WHERE id=$1 AND repository_id=$2 AND workspace_id=$3 FOR UPDATE', [job.snapshot_id, job.id, job.workspace_id]);
        await transaction.query('DELETE FROM atlas.source_files WHERE snapshot_id=$1 AND workspace_id=$2', [job.snapshot_id, job.workspace_id]);
        // One bounded parameterized write avoids a network round trip per file
        // while preserving every source row in this same atomic transaction.
        const values: unknown[] = [];
        const rows = index.files.map(file => {
          const offset = values.length; values.push(job.workspace_id, job.snapshot_id, file.path, file.text);
          return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4})`;
        });
        await transaction.query(`INSERT INTO atlas.source_files(workspace_id,snapshot_id,path,content) VALUES${rows.join(',')}`, values);
        await transaction.query('INSERT INTO atlas.graphs(workspace_id,snapshot_id,graph) VALUES($1,$2,$3::jsonb) ON CONFLICT(snapshot_id) DO UPDATE SET graph=excluded.graph', [job.workspace_id, job.snapshot_id, JSON.stringify({ ...index, files: [] })]);
        await transaction.query("UPDATE atlas.snapshots SET status='complete' WHERE id=$1 AND workspace_id=$2", [job.snapshot_id, job.workspace_id]);
        await transaction.query("UPDATE atlas.jobs SET status='complete',lease_until=NULL,error_code=NULL WHERE id=$1 AND attempts=$2", [job.job_id, job.attempts]);
      });
      return { status: 'complete', jobId: job.job_id };
    } catch (error) {
      const code = errorCode(error);
      if (error instanceof AtlasDatabaseError && error.code === 'commit_unknown') return { status: 'unknown', jobId: job.job_id, code };
      try {
        await database.withAdminTransaction(async transaction => {
          const repository = await transaction.query('SELECT id FROM atlas.repositories WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [job.id, job.workspace_id]);
          if (!repository.rows[0]) return;
          const changed = await transaction.query<{ snapshot_id: string }>("UPDATE atlas.jobs SET status='failed',lease_until=NULL,error_code=$1 WHERE id=$2 AND attempts=$3 AND status='running' RETURNING snapshot_id", [code, job.job_id, job.attempts]);
          if (changed.rows[0]) await transaction.query("UPDATE atlas.snapshots SET status='failed' WHERE id=$1 AND workspace_id=$2 AND status<>'complete'", [job.snapshot_id, job.workspace_id]);
        });
      } catch { return { status: 'unknown', jobId: job.job_id, code: 'failure-state-unavailable' }; }
      return { status: 'failed', jobId: job.job_id, code };
    }
  }
  return { queueImport, listRepositories, getIndex, processOne };
}
