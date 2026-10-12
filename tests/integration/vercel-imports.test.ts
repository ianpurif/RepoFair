import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AtlasDatabase, AtlasTransaction } from '../../apps/worker/src/database.ts';
import { AtlasDatabaseError } from '../../apps/worker/src/database.ts';
import { createRepositoryService } from '../../apps/worker/src/repository-service.ts';
import type { GitHubAppClient, GitHubDiscoveryCheckpoint, VerifiedGitHubUser } from '../../apps/worker/src/github.ts';
import type { githubForPrincipal } from '../../apps/worker/src/clerk-github.ts';

// Genuine migration SQL, claims, leases and RLS, with explicitly simulated
// GitHub HTTP. The serialized WASM backend does not prove hosted contention.
const sql = new PGlite();
const workspaceId = randomUUID(); const principalId = 'user_vercelImporter'; const otherPrincipal = 'user_vercelOther';
const commitSha = 'a'.repeat(40); const treeSha = 'b'.repeat(40);
const source = 'export const indexed = true;\n'; const bytes = Buffer.from(source);
const file = { path: 'src/index.ts', size: bytes.length, blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
const queries: { text: string; values?: unknown[] }[] = [];
let previousTransaction: Promise<void> = Promise.resolve();
function transaction<T>(actor: string | null, work: (tx: AtlasTransaction) => Promise<T>): Promise<T> {
  const result = previousTransaction.then(async () => {
    await sql.exec('BEGIN');
    try {
      await sql.exec(actor ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE NONE');
      await sql.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify(actor ? { sub: actor, role: 'authenticated' } : {})]);
      await sql.query("SELECT set_config('atlas.authorized_repository_ids','[]',true)");
      const value = await work({ query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => {
        queries.push({ text, values });
        try {
          const result = await sql.query<Row>(text, values);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, command: '', oid: 0, fields: [] };
        } catch { throw new AtlasDatabaseError('query', 'Database operation failed'); }
      } });
      await sql.exec('COMMIT'); return value;
    } catch (error) { await sql.exec('ROLLBACK'); throw error; }
  });
  previousTransaction = result.then(() => {}, () => {});
  return result;
}
const database = { withAdminTransaction: <T>(work: (tx: AtlasTransaction) => Promise<T>) => transaction(null, work),
  withPrincipalTransaction: <T>(actor: string, work: (tx: AtlasTransaction) => Promise<T>) => transaction(actor, work) } as unknown as AtlasDatabase;
function discovery(): GitHubDiscoveryCheckpoint {
  return { schemaVersion: 1, commitSha, treeSha, pending: [], files: [file], limitations: [], discovered: 1, skipped: 0, treesVisited: 1, entriesVisited: 1, complete: true };
}
const client = { authorizeRepository: vi.fn(), resolveCommit: vi.fn(), discoverSnapshot: vi.fn(), downloadFiles: vi.fn() };
const linked = vi.fn() as unknown as typeof githubForPrincipal;
function service() { return createRepositoryService(database, {}, { githubForPrincipal: linked }); }
async function queue(name = 'one') { return service().queueImport(principalId, workspaceId, `https://github.com/owner/${name}`); }
function jobQueries() { return queries.filter(query => /FROM atlas.jobs|UPDATE atlas.jobs/.test(query.text)); }

const boundary = vi.hoisted(() => ({ context: vi.fn(), processOne: vi.fn(), getJob: vi.fn(), cancel: vi.fn(), retry: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('../../apps/web/src/lib/repositories.ts', async original => {
  const actual = await original<typeof import('../../apps/web/src/lib/repositories.ts')>();
  return { ...actual, repositoryContext: boundary.context };
});
import { POST, maxDuration } from '../../apps/web/src/app/api/repositories/[id]/jobs/route.ts';

beforeAll(async () => {
  await sql.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    GRANT USAGE ON SCHEMA auth TO authenticated; GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;`);
  for (const path of ['202610030001_atlas.sql','202610070001_personal_workspaces.sql','202610070002_github_jobs.sql','202610070003_server_repository_grants.sql','202610110001_resumable_imports.sql']) await sql.exec(await readFile(`supabase/migrations/${path}`, 'utf8'));
}, 30000);
beforeEach(async () => {
  await sql.exec('TRUNCATE atlas.workspaces CASCADE');
  await sql.query('INSERT INTO atlas.workspaces(id,name) VALUES($1,$2)', [workspaceId, 'Import advancement test']);
  await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role,revision) VALUES($1,$2,'owner',7)", [workspaceId, principalId]);
  queries.length = 0; vi.resetAllMocks();
  client.authorizeRepository.mockImplementation(async (user: VerifiedGitHubUser, selected: { name: string }) => ({ id: selected.name === 'one' ? 100 : 101, owner: 'owner', name: selected.name,
    fullName: `owner/${selected.name}`, private: true, defaultBranch: 'main', principalId: user.principalId, installationId: 99 }));
  client.resolveCommit.mockResolvedValue({ sha: commitSha, treeSha });
  client.discoverSnapshot.mockImplementation(async () => discovery());
  client.downloadFiles.mockImplementation(async () => [{ ...file, text: source }]);
  vi.mocked(linked).mockImplementation(async actor => ({ client: client as unknown as GitHubAppClient, user: { principalId: actor, githubUserId: 10, login: 'test-importer' } as VerifiedGitHubUser }));
  boundary.context.mockResolvedValue({ principalId, service: { processOne: boundary.processOne, getJob: boundary.getJob, cancelImport: boundary.cancel, retryImport: boundary.retry } });
  boundary.processOne.mockResolvedValue({ status: 'progress' }); boundary.getJob.mockResolvedValue({ id: 'durable-job', status: 'queued', phase: 'downloading' });
  vi.stubEnv('APP_ORIGIN', 'https://repofair.vercel.app');
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await previousTransaction; await sql.close(); });

describe('authenticated repository-specific import slices', () => {
  it('rejects incomplete or invalid target scope before any SQL or GitHub calls', async () => {
    for (const target of [{ principalId }, { repositoryId: randomUUID() }, { principalId: 'attacker', repositoryId: randomUUID() }, { principalId, repositoryId: 'not-a-repository' }]) {
      await expect(service().processOne(target)).rejects.toBeInstanceOf(Error);
    }
    expect(queries).toHaveLength(0); expect(linked).not.toHaveBeenCalled();
  });
  it('denies a nonmember before reading or claiming any job', async () => {
    const queued = await queue(); queries.length = 0; vi.mocked(linked).mockClear();
    await expect(service().processOne({ principalId: otherPrincipal, repositoryId: queued.repositoryId })).rejects.toMatchObject({ code: 'repository-unavailable' });
    expect(jobQueries()).toHaveLength(0); expect(linked).not.toHaveBeenCalled();
    expect((await sql.query('SELECT status,claim_token FROM atlas.jobs')).rows).toEqual([{ status: 'queued', claim_token: null }]);
  });
  it('denies read-only and revoked callers before touching job state', async () => {
    const queued = await queue();
    await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role,revision) VALUES($1,$2,'reader',1)", [workspaceId, otherPrincipal]);
    queries.length = 0; vi.mocked(linked).mockClear();
    await expect(service().processOne({ principalId: otherPrincipal, repositoryId: queued.repositoryId })).rejects.toMatchObject({ code: 'denied' });
    await sql.query('DELETE FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2', [workspaceId, principalId]);
    await expect(service().processOne({ principalId, repositoryId: queued.repositoryId })).rejects.toMatchObject({ code: 'repository-unavailable' });
    expect(jobQueries()).toHaveLength(0); expect(linked).not.toHaveBeenCalled();
  });
  it('advances only the verified repository while leaving older work untouched', async () => {
    const first = await queue('one'); const target = await queue('two'); queries.length = 0;
    expect(await service().processOne({ principalId, repositoryId: target.repositoryId })).toEqual({ status: 'progress', jobId: target.jobId, phase: 'downloading' });
    const selected = queries.filter(query => query.text.startsWith('SELECT r.*') || query.text.startsWith('SELECT j.id AS job_id'));
    expect(selected).toHaveLength(2); expect(selected.every(query => query.values?.[0] === target.repositoryId)).toBe(true);
    expect((await sql.query('SELECT status,phase,claim_token FROM atlas.jobs WHERE id=$1', [first.jobId])).rows).toEqual([{ status: 'queued', phase: 'discovering', claim_token: null }]);
    expect((await service().getJob(principalId, target.repositoryId))?.progress.discovered).toBe(1);
    expect((await service().processOne({ principalId, repositoryId: target.repositoryId })).phase).toBe('parsing');
    expect((await service().getJob(principalId, target.repositoryId))?.progress.downloaded).toBe(1);
  });
  it('rechecks a changed membership after GitHub proof and before job selection', async () => {
    const queued = await queue(); queries.length = 0;
    client.authorizeRepository.mockImplementationOnce(async () => {
      await sql.query('UPDATE atlas.memberships SET revision=8 WHERE workspace_id=$1 AND principal_id=$2', [workspaceId, principalId]);
      return { id: 100, owner: 'owner', name: 'one', fullName: 'owner/one', private: true, defaultBranch: 'main', principalId, installationId: 99 };
    });
    await expect(service().processOne({ principalId, repositoryId: queued.repositoryId })).rejects.toMatchObject({ code: 'authorization-changed' });
    expect(jobQueries()).toHaveLength(0); expect(client.discoverSnapshot).not.toHaveBeenCalled();
    expect((await sql.query('SELECT status,claim_token FROM atlas.jobs')).rows).toEqual([{ status: 'queued', claim_token: null }]);
  });
  it('keeps one live claim when two authenticated advancement requests overlap', async () => {
    const queued = await queue(); let entered!: () => void; let finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const release = new Promise<void>(resolve => { finish = resolve; });
    client.discoverSnapshot.mockImplementationOnce(async () => { entered(); await release; return discovery(); });
    const first = service().processOne({ principalId, repositoryId: queued.repositoryId }); await started;
    const second = await service().processOne({ principalId, repositoryId: queued.repositoryId }); expect(second).toEqual({ status: 'idle' });
    finish(); expect(await first).toMatchObject({ status: 'progress', jobId: queued.jobId });
    expect(client.discoverSnapshot).toHaveBeenCalledOnce();
    expect((await sql.query('SELECT attempts,status,claim_token FROM atlas.jobs')).rows).toEqual([{ attempts: 0, status: 'queued', claim_token: null }]);
  });
  it('fences a superseded targeted claim without saving a late checkpoint', async () => {
    const queued = await queue(); const replacement = randomUUID();
    client.discoverSnapshot.mockImplementationOnce(async () => { await sql.query('UPDATE atlas.jobs SET claim_token=$1 WHERE id=$2', [replacement, queued.jobId]); return discovery(); });
    expect(await service().processOne({ principalId, repositoryId: queued.repositoryId })).toEqual({ status: 'superseded', jobId: queued.jobId, code: 'job-lease-lost' });
    expect((await sql.query('SELECT * FROM atlas.import_manifests')).rows).toHaveLength(0);
    expect((await sql.query('SELECT claim_token,status,attempts FROM atlas.jobs')).rows).toEqual([{ claim_token: replacement, status: 'running', attempts: 0 }]);
  });
  it('rechecks the requesting admin throughout a slice even when another authorized owner queued it', async () => {
    const queued = await queue();
    await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role,revision) VALUES($1,$2,'admin',1)", [workspaceId, otherPrincipal]);
    client.discoverSnapshot.mockImplementationOnce(async () => { await sql.query('DELETE FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2', [workspaceId, otherPrincipal]); return discovery(); });
    expect(await service().processOne({ principalId: otherPrincipal, repositoryId: queued.repositoryId })).toMatchObject({ status: 'failed', code: 'denied' });
    expect((await sql.query('SELECT * FROM atlas.import_manifests')).rows).toHaveLength(0);
    expect((await sql.query('SELECT * FROM atlas.source_files')).rows).toHaveLength(0);
  });
});

function request(body: unknown, origin = 'https://repofair.vercel.app') {
  return new Request('https://repofair.vercel.app/api/repositories/11000000-0000-4000-8000-000000000001/jobs', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const repositoryId = '11000000-0000-4000-8000-000000000001'; const route = { params: Promise.resolve({ id: repositoryId }) };
describe('same-origin awaited Vercel job advancement route', () => {
  it('awaits one bounded targeted slice and returns the durable authenticated job', async () => {
    let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
    boundary.processOne.mockImplementationOnce(async () => { await pending; return { status: 'unknown', code: 'internal-only' }; });
    const advance = request({ action: 'advance' }); const response = POST(advance, route);
    await vi.waitFor(() => expect(boundary.processOne).toHaveBeenCalledOnce()); expect(boundary.getJob).not.toHaveBeenCalled();
    finish(); const result = await response;
    expect(boundary.processOne).toHaveBeenCalledWith({ principalId, repositoryId, signal: advance.signal });
    expect(boundary.getJob).toHaveBeenCalledWith(principalId, repositoryId);
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ job: { id: 'durable-job', status: 'queued', phase: 'downloading' } });
    expect(result.headers.get('cache-control')).toBe('no-store'); expect(maxDuration).toBe(300);
  });
  it('rejects a foreign origin before identity or worker access', async () => {
    const response = await POST(request({ action: 'advance' }, 'https://attacker.test'), route);
    expect(response.status).toBe(403); expect(boundary.context).not.toHaveBeenCalled(); expect(boundary.processOne).not.toHaveBeenCalled();
  });
  it('requires a verified session without advancing work', async () => {
    boundary.context.mockRejectedValueOnce(new Error('AUTHENTICATION_REQUIRED'));
    expect((await POST(request({ action: 'advance' }), route)).status).toBe(401); expect(boundary.processOne).not.toHaveBeenCalled();
  });
  it.each([{ action: ['advance'] }, { action: 'advance', principalId: otherPrincipal }, { action: 'advance', repositoryId: randomUUID() }, { action: 'advance', jobId: randomUUID() }, { action: 'processAll' }])('rejects untrusted or unsupported advancement controls %j', async body => {
    expect((await POST(request(body), route)).status).toBe(400); expect(boundary.processOne).not.toHaveBeenCalled();
  });
  it('preserves explicit cancel and retry behavior with expected job identifiers', async () => {
    const jobId = randomUUID(); boundary.cancel.mockResolvedValue({ status: 'cancelled' }); boundary.retry.mockResolvedValue({ status: 'queued' });
    expect((await POST(request({ action: 'cancel', jobId }), route)).status).toBe(200);
    expect((await POST(request({ action: 'retry', jobId }), route)).status).toBe(200);
    expect(boundary.cancel).toHaveBeenCalledWith(principalId, repositoryId, jobId); expect(boundary.retry).toHaveBeenCalledWith(principalId, repositoryId, jobId);
    expect(boundary.processOne).not.toHaveBeenCalled();
  });
});
