import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubForPrincipal } from '../../apps/worker/src/clerk-github.ts';
import { GitHubError } from '../../apps/worker/src/github.ts';
import type { GitHubAppClient, VerifiedGitHubUser } from '../../apps/worker/src/github.ts';
import type { AtlasDatabase, AtlasTransaction } from '../../apps/worker/src/database.ts';
import { AtlasDatabaseError } from '../../apps/worker/src/database.ts';
import { createRepositoryService, parseGitHubRepositoryUrl, parseRepositoryIsolated } from '../../apps/worker/src/repository-service.ts';
import type { ParseRepositoryInput } from '../../packages/core/src/local/index.ts';
import { validateSourceIndex } from '../../packages/core/src/local/index.ts';
import { LOCAL_LIMITS } from '../../packages/core/src/local/limits.ts';

vi.mock('../../apps/worker/src/clerk-github.ts', () => ({ githubForPrincipal: vi.fn() }));
// SQL and parsing are real here; identity/provider HTTP is mocked. This does not
// establish hosted PostgreSQL concurrency or actual Clerk/GitHub acceptance.
const sql = new PGlite(); let directory = ''; let script = ''; const workspaceId = randomUUID();
const principalA = 'user_auditA'; const principalB = 'user_auditB'; const commitSha = 'a'.repeat(40);
const source = [
  { path: 'package.json', text: '{"name":"@example/repository","version":"1.0.0"}' },
  { path: 'src/retry.ts', text: 'export function retry(attempt: number) {\n  return attempt < 3;\n}' },
];
const repo = { id: 100, owner: 'owner', name: 'repository', fullName: 'owner/repository', private: true, defaultBranch: 'main', principalId: principalA, installationId: 99 };
const client = { authorizeRepository: vi.fn(), resolveCommit: vi.fn(), downloadSnapshot: vi.fn() };
const queries: string[] = [];
const transactions: string[][] = [];
async function transaction<T>(principalId: string | null, work: (transaction: AtlasTransaction) => Promise<T>): Promise<T> {
  await sql.exec('BEGIN');
  const trace: string[] = []; transactions.push(trace);
  try {
    await sql.exec(principalId ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE NONE');
    await sql.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify(principalId ? { sub: principalId, role: 'authenticated' } : {})]);
    await sql.query("SELECT set_config('atlas.authorized_repository_ids','[]',true)");
    const result = await work({ query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => {
      queries.push(text); trace.push(text);
      try { const result = await sql.query<Row>(text, values); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, command: '', oid: 0, fields: [] }; }
      catch { throw new AtlasDatabaseError('query', 'Database operation failed'); }
    } });
    await sql.exec('COMMIT'); return result;
  } catch (error) { await sql.exec('ROLLBACK'); throw error; }
}
const database = { withPrincipalTransaction: <T>(principalId: string, work: (transaction: AtlasTransaction) => Promise<T>) => transaction(principalId, work),
  withAdminTransaction: <T>(work: (transaction: AtlasTransaction) => Promise<T>) => transaction(null, work) } as unknown as AtlasDatabase;
beforeAll(async () => {
  await sql.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    GRANT USAGE ON SCHEMA auth TO authenticated; GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;`);
  for (const path of ['supabase/migrations/202610030001_atlas.sql', 'supabase/migrations/202610070001_personal_workspaces.sql', 'supabase/migrations/202610070002_github_jobs.sql', 'supabase/migrations/202610070003_server_repository_grants.sql']) await sql.exec(await readFile(path, 'utf8'));
  directory = await mkdtemp(join(tmpdir(), 'atlas-repository-parser-')); script = join(directory, 'parser.mjs');
  const build = spawnSync('bun', ['build', resolve('apps/worker/src/repository-parser-child.ts'), '--target=node', `--outfile=${script}`], { encoding: 'utf8', windowsHide: true });
  if (build.status !== 0) throw new Error('Trusted parser bundle failed');
}, 30000);
beforeEach(async () => {
  await sql.exec('TRUNCATE atlas.workspaces CASCADE');
  await sql.query('INSERT INTO atlas.workspaces(id,name) VALUES($1,$2)', [workspaceId, 'Test workspace']);
  await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role,revision) VALUES($1,$2,'owner',7)", [workspaceId, principalA]);
  queries.length = 0; transactions.length = 0; vi.clearAllMocks();
  client.authorizeRepository.mockResolvedValue(repo); client.resolveCommit.mockResolvedValue({ sha: commitSha, treeSha: 'b'.repeat(40) });
  client.downloadSnapshot.mockResolvedValue({ repository: repo, commitSha, treeSha: 'b'.repeat(40), files: source, limitations: [] });
  vi.mocked(githubForPrincipal).mockImplementation(async principalId => ({ client: client as unknown as GitHubAppClient, user: { principalId, githubUserId: 10, login: 'alice' } as VerifiedGitHubUser }));
});
afterAll(async () => { await sql.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
function service() { return createRepositoryService(database, { ATLAS_PARSER_SCRIPT: script }); }
describe('durable GitHub repository import service', () => {
  it('rejects arbitrary egress URLs and invalid refs before GitHub access', async () => {
    for (const url of ['http://github.com/owner/repository', 'https://attacker.example/owner/repository', 'https://api.github.com/owner/repository', 'https://user:secret@github.com/owner/repository', 'https://github.com/owner/repository?token=x', 'https://github.com/owner/repository/tree/main', 'https://github.com/owner/%2frepository']) {
      expect(() => parseGitHubRepositoryUrl(url)).toThrow();
    }
    expect(parseGitHubRepositoryUrl('https://github.com/owner/repository.git')).toEqual({ owner: 'owner', name: 'repository' });
    await expect(service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository', '-option')).rejects.toMatchObject({ code: 'invalid-ref' });
    expect(githubForPrincipal).not.toHaveBeenCalled();
  });
  it('authorizes membership before GitHub and rechecks its revision before durable queue writes', async () => {
    await expect(service().queueImport(principalB, workspaceId, 'https://github.com/owner/repository')).rejects.toMatchObject({ code: 'denied' });
    expect(githubForPrincipal).not.toHaveBeenCalled();
    client.resolveCommit.mockImplementationOnce(async () => { await sql.query('UPDATE atlas.memberships SET revision=8 WHERE workspace_id=$1', [workspaceId]); return { sha: commitSha, treeSha: 'b'.repeat(40) }; });
    await expect(service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository')).rejects.toMatchObject({ code: 'authorization-changed' });
    expect((await sql.query('SELECT id FROM atlas.repositories')).rows).toHaveLength(0);
  });
  it('queues exact immutable commit once without storing access tokens', async () => {
    const first = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository', 'release/1');
    const repeated = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository', 'release/1');
    expect(repeated).toEqual(first); expect(first.status).toBe('queued'); expect(first.commitSha).toBe(commitSha);
    expect(client.resolveCommit).toHaveBeenCalledWith(repo, 'release/1');
    const jobs = (await sql.query<{ principal_id: string; permission_revision: number; status: string; attempts: number }>('SELECT principal_id,permission_revision,status,attempts FROM atlas.jobs')).rows;
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ principal_id: principalA, status: 'queued', attempts: 0 });
    expect(JSON.stringify((await sql.query('SELECT * FROM atlas.repositories')).rows)).not.toMatch(/token|Bearer|private.key/i);
  });
  it('claims a durable job, uses a real isolated parser, atomically saves source/graph, and rebinds evidence for a verified reader', async () => {
    const queued = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    expect(await service().processOne()).toEqual({ status: 'complete', jobId: queued.jobId });
    const saved = (await sql.query<{ status: string; attempts: number; lease_until: unknown }>('SELECT status,attempts,lease_until FROM atlas.jobs')).rows[0];
    expect(saved).toEqual({ status: 'complete', attempts: 1, lease_until: null });
    expect((await sql.query('SELECT path FROM atlas.source_files')).rows).toHaveLength(source.length);
    await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role,revision) VALUES($1,$2,'reader',3)", [workspaceId, principalB]);
    const index = await service().getIndex(principalB, queued.repositoryId); validateSourceIndex(index);
    expect(index.mode).toBe('git'); expect(index.snapshot.revision).toBe(commitSha); expect(index.scope.principalId).toBe(principalB);
    expect(index.scope.permissionRevision).toBe('3:1'); expect(index.evidence.every(item => item.scope.principalId === principalB)).toBe(true);
    expect(index.files.map(file => ({ path: file.path, text: file.text }))).toEqual(source);
    expect((await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository')).status).toBe('complete');
    expect(await service().processOne()).toEqual({ status: 'idle' });
  });
  it('durably preserves all 144 distinct source files in the scoped atomic publication', async () => {
    const files = [source[0]!, ...Array.from({ length: 143 }, (_, position) => ({ path: `src/module-${position}.ts`, text: `export const value${position} = ${position};\n` }))];
    client.downloadSnapshot.mockResolvedValueOnce({ repository: repo, commitSha, treeSha: 'b'.repeat(40), files, limitations: [] });
    const queued = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    expect(await service().processOne()).toEqual({ status: 'complete', jobId: queued.jobId });
    const index = await service().getIndex(principalA, queued.repositoryId);
    expect(index.files).toHaveLength(files.length);
    expect(new Map(index.files.map(file => [file.path, file.text]))).toEqual(new Map(files.map(file => [file.path, file.text])));
    expect((await sql.query<{ complete: boolean }>('SELECT status=\'complete\' AS complete FROM atlas.snapshots WHERE id=$1', [queued.snapshotId])).rows[0]?.complete).toBe(true);
    expect((await sql.query<{ complete: boolean }>('SELECT status=\'complete\' AS complete FROM atlas.jobs WHERE id=$1', [queued.jobId])).rows[0]?.complete).toBe(true);
  });
  it('denies repository, source, graph and job reads without a server grant, scopes grants exactly and resets them after each transaction', async () => {
    const queued = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    expect((await service().processOne()).status).toBe('complete');
    async function visible(principalId: string, grant?: readonly string[], injectClaims = false) {
      return database.withPrincipalTransaction(principalId, async tx => {
        if (injectClaims) await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principalId, role: 'authenticated', authorized_repository_ids: [queued.repositoryId] })]);
        if (grant) await tx.query("SELECT set_config('atlas.authorized_repository_ids',$1,true)", [JSON.stringify(grant)]);
        const counts: number[] = [];
        for (const table of ['repositories', 'snapshots', 'source_files', 'graphs', 'jobs']) counts.push((await tx.query(`SELECT * FROM atlas.${table} WHERE workspace_id=$1`, [workspaceId])).rows.length);
        return counts;
      });
    }
    expect(await visible(principalA)).toEqual([0, 0, 0, 0, 0]);
    expect(await visible(principalA, undefined, true)).toEqual([0, 0, 0, 0, 0]);
    expect(await visible(principalA, [randomUUID()])).toEqual([0, 0, 0, 0, 0]);
    // This direct grant represents trusted-server GitHub proof only; a database
    // role with arbitrary SQL could set it. Browser/client JWTs cannot set it.
    expect(await visible(principalA, [queued.repositoryId])).toEqual([1, 1, source.length, 1, 1]);
    expect(await visible(principalA)).toEqual([0, 0, 0, 0, 0]);
    expect(await visible(principalB, [queued.repositoryId])).toEqual([0, 0, 0, 0, 0]);
  });
  it('keeps candidate metadata server-only and requires explicit membership before fresh GitHub authorization', async () => {
    const queued = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    vi.mocked(githubForPrincipal).mockClear(); queries.length = 0;
    await expect(service().getIndex(principalB, queued.repositoryId)).rejects.toMatchObject({ code: 'repository-unavailable' });
    await expect(service().listRepositories(principalB, workspaceId)).rejects.toMatchObject({ code: 'denied' });
    expect(githubForPrincipal).not.toHaveBeenCalled();
    expect(queries.some(query => /FROM atlas\.(?:source_files|graphs|snapshots|jobs)/.test(query))).toBe(false);
    client.authorizeRepository.mockImplementationOnce(async () => {
      // Even the trusted scope is unset while the provider check is pending.
      expect(queries.some(query => query.includes("set_config('atlas.authorized_repository_ids'"))).toBe(false);
      return repo;
    });
    queries.length = 0;
    expect(await service().listRepositories(principalA, workspaceId)).toHaveLength(1);
    const candidates = queries.find(query => query.includes('JOIN atlas.memberships m'));
    expect(candidates).toContain('m.principal_id=$2'); expect(candidates).toContain('r.workspace_id=$1');
    expect(candidates).not.toMatch(/r\.name|r\.visibility|SELECT \*/);
  });
  it('locks repository before existing jobs and snapshots in queue, claim, publication, failure and exhausted cleanup', async () => {
    await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    expect((await service().processOne()).status).toBe('complete');
    client.resolveCommit.mockResolvedValueOnce({ sha: 'c'.repeat(40), treeSha: 'd'.repeat(40) });
    const failed = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    client.downloadSnapshot.mockResolvedValueOnce({ repository: repo, commitSha: 'c'.repeat(40), files: [] });
    expect((await service().processOne()).status).toBe('failed');
    await sql.query("UPDATE atlas.jobs SET status='queued',attempts=3 WHERE id=$1", [failed.jobId]);
    expect((await service().processOne()).status).toBe('idle');
    let checked = 0;
    for (const trace of transactions) {
      const job = trace.findIndex(query => /(?:UPDATE|INSERT INTO) atlas\.jobs|FROM atlas\.jobs(?: WHERE[\s\S]*FOR UPDATE| j[\s\S]*FOR UPDATE OF j)/.test(query));
      if (job < 0) continue;
      const repository = trace.findIndex(query => /INSERT INTO atlas\.repositories|FROM atlas\.repositories[\s\S]*FOR UPDATE/.test(query));
      const snapshot = trace.findIndex(query => /UPDATE atlas\.snapshots|FROM atlas\.snapshots[\s\S]*FOR UPDATE/.test(query));
      expect(repository).toBeGreaterThanOrEqual(0); expect(repository).toBeLessThan(job);
      if (snapshot >= 0) expect(job).toBeLessThan(snapshot);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });
  it('fails a revoked job before GitHub download and never reports completion', async () => {
    const queued = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    await sql.query('DELETE FROM atlas.memberships WHERE workspace_id=$1', [workspaceId]);
    expect(await service().processOne()).toEqual({ status: 'failed', jobId: queued.jobId, code: 'denied' });
    expect(client.downloadSnapshot).not.toHaveBeenCalled(); expect((await sql.query('SELECT * FROM atlas.source_files')).rows).toHaveLength(0);
  });
  it('rechecks permission revision before persistence after source has been downloaded', async () => {
    const queued = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    client.downloadSnapshot.mockImplementationOnce(async () => {
      await sql.query('UPDATE atlas.memberships SET revision=8 WHERE workspace_id=$1', [workspaceId]);
      return { repository: repo, commitSha, treeSha: 'b'.repeat(40), files: source, limitations: [] };
    });
    expect(await service().processOne()).toEqual({ status: 'failed', jobId: queued.jobId, code: 'authorization-changed' });
    expect((await sql.query('SELECT * FROM atlas.source_files')).rows).toHaveLength(0); expect((await sql.query('SELECT * FROM atlas.graphs')).rows).toHaveLength(0);
  });
  it('rechecks live GitHub access before storage and does not expose metadata when GitHub access is denied', async () => {
    const queued = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    client.authorizeRepository.mockResolvedValueOnce(repo).mockRejectedValueOnce(new GitHubError('unauthorized', 'Access revoked'));
    expect(await service().processOne()).toEqual({ status: 'failed', jobId: queued.jobId, code: 'github-unauthorized' });
    expect((await sql.query('SELECT * FROM atlas.source_files')).rows).toHaveLength(0);
    client.authorizeRepository.mockRejectedValue(new GitHubError('unauthorized', 'Access revoked'));
    expect(await service().listRepositories(principalA, workspaceId)).toEqual([]); queries.length = 0;
    await expect(service().getIndex(principalA, queued.repositoryId)).rejects.toBeInstanceOf(GitHubError);
    expect(queries.some(query => /SELECT[\s\S]*FROM atlas\.(?:source_files|graphs)/.test(query))).toBe(false);
  });
  it('rejects missing manifest, too many files and parser failures explicitly without saving placeholders', async () => {
    const queued = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    client.downloadSnapshot.mockResolvedValueOnce({ repository: repo, commitSha, files: source.filter(file => file.path !== 'package.json') });
    expect(await service().processOne()).toEqual({ status: 'failed', jobId: queued.jobId, code: 'manifest-invalid' });
    const another = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    client.downloadSnapshot.mockResolvedValueOnce({ repository: repo, commitSha, files: Array.from({ length: LOCAL_LIMITS.files + 1 }, (_, index) => ({ path: `src/${index}.ts`, text: 'export const a=1;' })) });
    expect(await service().processOne()).toEqual({ status: 'failed', jobId: another.jobId, code: 'source-limit' });
    expect((await sql.query('SELECT * FROM atlas.graphs')).rows).toHaveLength(0);
  });
  it('reclaims expired leases, increments attempts, and fails exhausted jobs without re-running imports', async () => {
    const queued = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    await sql.query("UPDATE atlas.jobs SET status='running',attempts=1,lease_until=now()-interval '1 minute' WHERE id=$1", [queued.jobId]);
    expect((await service().processOne()).status).toBe('complete');
    expect((await sql.query<{ attempts: number }>('SELECT attempts FROM atlas.jobs')).rows[0]?.attempts).toBe(2);
    await sql.query("UPDATE atlas.jobs SET status='running',attempts=3,lease_until=now()-interval '1 minute' WHERE id=$1", [queued.jobId]);
    client.downloadSnapshot.mockClear(); expect(await service().processOne()).toEqual({ status: 'idle' });
    expect(client.downloadSnapshot).not.toHaveBeenCalled(); expect((await sql.query<{ error_code: string }>('SELECT error_code FROM atlas.jobs')).rows[0]?.error_code).toBe('attempt-limit');
  });
  it('reports an index as not ready and filters webhook-revoked repositories through actual RLS', async () => {
    const queued = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    await expect(service().getIndex(principalA, queued.repositoryId)).rejects.toMatchObject({ code: 'index-not-ready', status: 202 });
    await sql.query('UPDATE atlas.repositories SET access_revoked=true WHERE id=$1', [queued.repositoryId]);
    expect(await service().listRepositories(principalA, workspaceId)).toEqual([]);
    await expect(service().getIndex(principalA, queued.repositoryId)).rejects.toMatchObject({ code: 'repository-unavailable' });
  });
  it('reports the latest failed or running commit instead of silently serving an older completed snapshot', async () => {
    const first = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    expect((await service().processOne()).status).toBe('complete');
    client.resolveCommit.mockResolvedValueOnce({ sha: 'c'.repeat(40), treeSha: 'd'.repeat(40) });
    const newer = await service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository');
    expect(newer.snapshotId).not.toBe(first.snapshotId);
    await expect(service().getIndex(principalA, first.repositoryId)).rejects.toMatchObject({ code: 'index-not-ready', status: 202 });
    client.downloadSnapshot.mockResolvedValueOnce({ repository: repo, commitSha: 'c'.repeat(40), files: [] });
    expect((await service().processOne()).status).toBe('failed'); queries.length = 0;
    await expect(service().getIndex(principalA, first.repositoryId)).rejects.toMatchObject({ code: 'index-failed', status: 422 });
    expect(queries.some(query => /SELECT[\s\S]*FROM atlas\.(?:source_files|graphs)/.test(query))).toBe(false);
  });
});
describe('hard parser subprocess isolation', () => {
  function input(): ParseRepositoryInput { return { scope: { tenantId: workspaceId, principalId: principalA, permissionRevision: '7:1' },
    snapshot: { repositoryId: randomUUID(), snapshotId: randomUUID(), kind: 'git', revision: commitSha }, packageName: '@example/repository', version: '1.0.0', observedAt: new Date().toISOString(), files: source }; }
  it('parses through a real child and keeps environment secrets out of imported code', async () => {
    const index = await parseRepositoryIsolated({ ...input(), files: [...source, { path: 'src/evil.ts', text: "throw new Error(process.env.CLERK_SECRET_KEY);\nexport const sourceOnly = 1;" }] }, { ATLAS_PARSER_SCRIPT: script });
    expect(index.mode).toBe('git'); expect(index.nodes.some(node => node.label === 'sourceOnly')).toBe(true);
    await expect(parseRepositoryIsolated(input(), { ATLAS_PARSER_SCRIPT: join(directory, 'missing.mjs') })).rejects.toMatchObject({ code: 'parser-unavailable' });
  });
  it('parses all 144 and 192 supported files through the real isolated child without truncation or limit bypass', async () => {
    for (const count of [144, LOCAL_LIMITS.files]) {
      const files = [source[0]!, ...Array.from({ length: count - 1 }, (_, position) => ({ path: `src/module-${position}.ts`,
        text: `export function value${position}(input: number): number {\n  return input + ${position};\n}\n` }))];
      const original = { ...input(), files };
      const index = await parseRepositoryIsolated(original, { ATLAS_PARSER_SCRIPT: script });
      validateSourceIndex(index); expect(index.files).toHaveLength(count);
      expect(index.files.map(file => ({ path: file.path, text: file.text }))).toEqual(files);
      expect(index.nodes.filter(node => node.kind === 'symbol')).toHaveLength(count - 1);
      expect(index.nodes.length).toBeLessThanOrEqual(LOCAL_LIMITS.nodes);
      expect(index.snapshot).toEqual(original.snapshot);
    }
    const overflow = Array.from({ length: LOCAL_LIMITS.files + 1 }, (_, position) => ({ path: `src/${position}.ts`, text: 'export const a=1;' }));
    await expect(parseRepositoryIsolated({ ...input(), files: overflow }, { ATLAS_PARSER_SCRIPT: script })).rejects.toMatchObject({ code: 'source-limit' });
  }, 15000);
  it('returns only fixed safe parser diagnostics without reflecting syntax, source paths or exception text', async () => {
    await expect(parseRepositoryIsolated({ ...input(), files: [{ path: 'package.json', text: 'private-source-sentinel-is-not-json' }] }, { ATLAS_PARSER_SCRIPT: script })).rejects.toMatchObject({ code: 'parser-manifest-invalid' });
    await expect(parseRepositoryIsolated({ ...input(), files: [...source, { path: 'src/bounded.ts', text: '\n'.repeat(LOCAL_LIMITS.linesPerFile) }] }, { ATLAS_PARSER_SCRIPT: script })).rejects.toMatchObject({ code: 'parser-line-limit' });
    const untrusted = join(directory, 'diagnostic-reflection.mjs');
    await writeFile(untrusted, 'process.stdin.resume(); process.stdout.write(JSON.stringify({error:"private-source-sentinel"})); process.exitCode=1;');
    try { await parseRepositoryIsolated(input(), { ATLAS_PARSER_SCRIPT: untrusted }); throw new Error('Expected parser diagnostic rejection'); }
    catch (error) { expect(error).toMatchObject({ code: 'parser-failed' }); expect(String(error)).not.toContain('private-source-sentinel'); }
  });
  it('parses a generated AST above 100,000 nodes and rejects one above the bounded 200,000 cap', async () => {
    const native = createRequire(new URL('../../packages/core/src/local/parser.ts', import.meta.url))('ts-morph') as {
      Project: new (options: { useInMemoryFileSystem: boolean; skipAddingFilesFromTsConfig: boolean; skipFileDependencyResolution: boolean }) => {
        createSourceFile(path: string, text: string): { getDescendants(): unknown[] };
      };
    };
    function dense(elements: number) {
      const text = `export const values = [${Array(elements).fill('1+2').join(',')}];`;
      const project = new native.Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
      return { file: { path: 'src/dense.ts', text }, count: project.createSourceFile('/atlas/dense.ts', text).getDescendants().length };
    }
    const supported = dense(25000); expect(supported.count).toBeGreaterThan(100000); expect(supported.count).toBeLessThan(LOCAL_LIMITS.astNodes);
    const index = await parseRepositoryIsolated({ ...input(), files: [...source, supported.file] }, { ATLAS_PARSER_SCRIPT: script });
    expect(index.files).toHaveLength(3); expect(index.nodes.some(node => node.label === 'values')).toBe(true);
    const oversized = dense(45000); expect(oversized.count).toBeGreaterThan(LOCAL_LIMITS.astNodes);
    expect(oversized.file.text.length).toBeLessThan(LOCAL_LIMITS.fileCharacters);
    await expect(parseRepositoryIsolated({ ...input(), files: [...source, oversized.file] }, { ATLAS_PARSER_SCRIPT: script })).rejects.toMatchObject({ code: 'parser-ast-limit' });
  }, 15000);
  it('kills a stalled trusted parser at the hard deadline', async () => {
    const stalled = join(directory, 'stalled.mjs'); await writeFile(stalled, 'process.stdin.resume(); setInterval(() => {},1000);');
    await expect(parseRepositoryIsolated(input(), { ATLAS_PARSER_SCRIPT: stalled })).rejects.toMatchObject({ code: 'parser-timeout' });
  }, 20000);
});
