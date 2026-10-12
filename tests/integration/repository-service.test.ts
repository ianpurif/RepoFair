import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubForPrincipal } from '../../apps/worker/src/clerk-github.ts';
import { GitHubError } from '../../apps/worker/src/github.ts';
import type { GitHubAppClient, GitHubDiscoveryCheckpoint, GitHubTreeFile, VerifiedGitHubUser } from '../../apps/worker/src/github.ts';
import type { AtlasDatabase, AtlasTransaction } from '../../apps/worker/src/database.ts';
import { AtlasDatabaseError } from '../../apps/worker/src/database.ts';
import { createRepositoryService, parseGitHubRepositoryUrl, parseRepositoryIsolated } from '../../apps/worker/src/repository-service.ts';
import type { ParseRepositoryInput } from '../../packages/core/src/local/index.ts';
import { validateSourceIndex } from '../../packages/core/src/local/index.ts';
import { GIT_LIMITS, LOCAL_LIMITS } from '../../packages/core/src/local/limits.ts';
import { parseImportJob } from '../../packages/contracts/src/import.ts';

vi.mock('../../apps/worker/src/clerk-github.ts', () => ({ githubForPrincipal: vi.fn() }));
// Real migration SQL and parser processes, mocked Clerk/GitHub HTTP. This does
// not establish hosted login or concurrent PostgreSQL backend acceptance.
const sql = new PGlite(); let directory = ''; let script = ''; const workspaceId = randomUUID();
const principalA = 'user_auditA'; const principalB = 'user_auditB'; const commitSha = 'a'.repeat(40); const treeSha = 'b'.repeat(40);
const source = [{ path: 'package.json', text: '{"name":"@example/repository","version":"1.0.0"}' },
  { path: 'src/retry.ts', text: 'export function retry(attempt: number) {\n  return attempt < 3;\n}' }];
const repo = { id: 100, owner: 'owner', name: 'repository', fullName: 'owner/repository', private: true, defaultBranch: 'main', principalId: principalA, installationId: 99 };
const client = { authorizeRepository: vi.fn(), resolveCommit: vi.fn(), discoverSnapshot: vi.fn(), downloadFiles: vi.fn() };
const queries: string[] = []; const transactions: string[][] = []; let configuredFiles = source;
let queryFault: ((query: string) => void) | undefined;
function hashed(file: { path: string; text: string }): GitHubTreeFile { const bytes = Buffer.from(file.text); return { path: file.path, size: bytes.length, blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }; }
function discovery(sha = commitSha, files = configuredFiles): GitHubDiscoveryCheckpoint { return { schemaVersion: 1, commitSha: sha, treeSha, pending: [], files: files.map(hashed).sort((a,b) => a.path.localeCompare(b.path)), limitations: [], discovered: files.length, skipped: 0, treesVisited: 1, entriesVisited: files.length, complete: true }; }
async function transaction<T>(principalId: string | null, work: (transaction: AtlasTransaction) => Promise<T>): Promise<T> {
  await sql.exec('BEGIN'); const trace: string[] = []; transactions.push(trace);
  try {
    await sql.exec(principalId ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE NONE');
    await sql.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify(principalId ? { sub: principalId, role: 'authenticated' } : {})]);
    await sql.query("SELECT set_config('atlas.authorized_repository_ids','[]',true)");
    const result = await work({ query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => {
      queries.push(text); trace.push(text); queryFault?.(text);
      try { const result = await sql.query<Row>(text, values); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, command: '', oid: 0, fields: [] }; }
      catch (error) { if (error instanceof AtlasDatabaseError) throw error; throw new AtlasDatabaseError('query', 'Database operation failed'); }
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
  for (const path of ['202610030001_atlas.sql','202610070001_personal_workspaces.sql','202610070002_github_jobs.sql','202610070003_server_repository_grants.sql','202610110001_resumable_imports.sql']) await sql.exec(await readFile(`supabase/migrations/${path}`, 'utf8'));
  directory = await mkdtemp(join(tmpdir(), 'atlas-repository-parser-')); script = join(directory, 'parser.mjs');
  const build = spawnSync('bun', ['build', resolve('apps/worker/src/repository-parser-child.ts'), '--target=node', `--outfile=${script}`], { encoding: 'utf8', windowsHide: true });
  if (build.status !== 0) throw new Error('Trusted parser bundle failed');
}, 30000);
beforeEach(async () => {
  queryFault = undefined; await sql.exec('TRUNCATE atlas.workspaces CASCADE');
  await sql.query('INSERT INTO atlas.workspaces(id,name) VALUES($1,$2)', [workspaceId, 'Test workspace']);
  await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role,revision) VALUES($1,$2,'owner',7)", [workspaceId, principalA]);
  queries.length = 0; transactions.length = 0; vi.resetAllMocks(); configuredFiles = source;
  client.authorizeRepository.mockResolvedValue(repo); client.resolveCommit.mockResolvedValue({ sha: commitSha, treeSha });
  client.discoverSnapshot.mockImplementation(async (_repo, sha) => discovery(sha));
  client.downloadFiles.mockImplementation(async (_repo, files: GitHubTreeFile[]) => files.map(file => ({ path: file.path, text: configuredFiles.find(item => item.path === file.path)!.text, blobSha: file.blobSha, lineCount: 1 })));
  vi.mocked(githubForPrincipal).mockImplementation(async principalId => ({ client: client as unknown as GitHubAppClient, user: { principalId, githubUserId: 10, login: 'alice' } as VerifiedGitHubUser }));
});
afterAll(async () => { await sql.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
function service() { return createRepositoryService(database, { ATLAS_PARSER_SCRIPT: script }); }
async function queue() { return service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository'); }
async function drain(max = 200) {
  for (let slice = 0; slice < max; slice++) { const result = await service().processOne(); if (result.status !== 'progress') return result; }
  throw new Error('Import did not complete within bounded test slices');
}
describe('resumable GitHub repository import service', () => {
  it('validates URL, ref and membership before any provider access', async () => {
    for (const url of ['http://github.com/owner/repository','https://attacker.example/owner/repository','https://user:secret@github.com/owner/repository','https://github.com/owner/repository?token=x','https://github.com/owner/repository/tree/main','https://github.com/owner/%2frepository']) expect(() => parseGitHubRepositoryUrl(url)).toThrow();
    expect(parseGitHubRepositoryUrl('https://github.com/owner/repository.git')).toEqual({ owner: 'owner', name: 'repository' });
    await expect(service().queueImport(principalA, workspaceId, 'https://github.com/owner/repository','-option')).rejects.toMatchObject({ code: 'invalid-ref' });
    await expect(service().queueImport(principalB, workspaceId, 'https://github.com/owner/repository')).rejects.toMatchObject({ code: 'denied' });
    expect(githubForPrincipal).not.toHaveBeenCalled();
  });
  it('queues one job for an exact snapshot regardless of requesting actor, with failure attempts initially zero', async () => {
    const first = await queue(); await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role,revision) VALUES($1,$2,'admin',3)", [workspaceId, principalB]);
    expect(await service().queueImport(principalB, workspaceId, 'https://github.com/owner/repository')).toEqual(first);
    const jobs = (await sql.query('SELECT principal_id,status,attempts FROM atlas.jobs')).rows;
    expect(jobs).toEqual([{ principal_id: principalA, status: 'queued', attempts: 0 }]);
    expect(parseImportJob(await service().getJob(principalB, first.repositoryId)).id).toBe(first.jobId);
    expect(JSON.stringify((await sql.query('SELECT * FROM atlas.repositories')).rows)).not.toMatch(/token|Bearer|private_key/);
  });
  it('checks membership revision again before queue writes', async () => {
    client.resolveCommit.mockImplementationOnce(async () => { await sql.query('UPDATE atlas.memberships SET revision=8 WHERE workspace_id=$1',[workspaceId]); return { sha: commitSha, treeSha }; });
    await expect(queue()).rejects.toMatchObject({ code: 'authorization-changed' });
    expect((await sql.query('SELECT * FROM atlas.repositories')).rows).toHaveLength(0);
  });
  it('exposes shared progress to a verified reader while withholding import controls', async () => {
    const queued = await queue(); await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role) VALUES($1,$2,'reader')",[workspaceId,principalB]);
    expect(await service().getJob(principalB,queued.repositoryId)).toMatchObject({id:queued.jobId,status:'queued',canCancel:false,canRetry:false});
    expect((await service().listRepositories(principalB,workspaceId))[0]?.job?.canCancel).toBe(false);
    await expect(service().cancelImport(principalB,queued.repositoryId)).rejects.toMatchObject({code:'denied'});
  });
  it('persists discovery and source separately, then atomically publishes using a real isolated parser', async () => {
    const queued = await queue(); expect((await service().getJob(principalA, queued.repositoryId))?.progress.eligible).toBeNull();
    expect(await service().processOne()).toEqual({ status: 'progress',jobId: queued.jobId,phase: 'downloading' });
    const discovered = await service().getJob(principalA, queued.repositoryId); expect(discovered?.progress).toMatchObject({ discovered: 2,eligible: 2,downloaded: 0 });
    expect((await sql.query('SELECT * FROM atlas.source_files')).rows).toHaveLength(0);
    expect(await service().processOne()).toEqual({ status: 'progress',jobId: queued.jobId,phase: 'parsing' });
    expect((await sql.query('SELECT * FROM atlas.import_files')).rows).toHaveLength(2); expect((await sql.query('SELECT * FROM atlas.source_files')).rows).toHaveLength(0);
    expect(await service().processOne()).toEqual({ status: 'complete',jobId: queued.jobId });
    const progress = parseImportJob(await service().getJob(principalA, queued.repositoryId));
    expect(progress).toMatchObject({ status: 'complete',phase: 'complete',attempts: 0,canCancel: false,canRetry: false });
    expect(progress.progress).toMatchObject({ downloaded: 2,reused: 0,parsed: 2 }); expect(progress.progress.bytesProcessed).toBe(progress.progress.bytesTotal);
    const index = await service().getIndex(principalA, queued.repositoryId); validateSourceIndex(index);
    expect(index.files.map(({ path,text }) => ({ path,text }))).toEqual(source);
    expect(queries.some(query => /INSERT INTO atlas\.source_files[\s\S]*SELECT workspace_id,snapshot_id,path,content,blob_sha FROM atlas\.import_files/.test(query))).toBe(true);
    expect(await service().processOne()).toEqual({ status: 'idle' }); expect((await queue()).status).toBe('complete');
  });
  it('resumes discovery from the exact stored subtree checkpoint', async () => {
    const queued = await queue(); const partial = { ...discovery(),files: [hashed(source[0]!)],complete: false,pending: [{ prefix: 'src',sha: 'c'.repeat(40),recursive: false }] };
    client.discoverSnapshot.mockResolvedValueOnce(partial).mockImplementationOnce(async (_repo,sha,checkpoint) => { expect(checkpoint).toEqual(partial); return discovery(sha); });
    expect((await service().processOne()).phase).toBe('discovering'); expect((await service().getJob(principalA, queued.repositoryId))?.progress.eligible).toBeNull();
    expect((await service().processOne()).phase).toBe('downloading'); expect((await drain()).status).toBe('complete');
  });
  it('uses slices of at most 32 files and retains all 144 distinct source files across a simulated restart', async () => {
    configuredFiles = [source[0]!,...Array.from({ length: 143 }, (_,position) => ({ path: `src/module-${position}.ts`,text: `export const value${position}=${position};\n` }))];
    const queued = await queue(); await service().processOne(); await service().processOne();
    expect((await service().getJob(principalA, queued.repositoryId))?.progress.downloaded).toBe(32);
    expect((await sql.query('SELECT * FROM atlas.source_files')).rows).toHaveLength(0);
    expect((await drain()).status).toBe('complete'); const index = await service().getIndex(principalA, queued.repositoryId);
    expect(index.files).toHaveLength(144); expect(new Map(index.files.map(file => [file.path,file.text]))).toEqual(new Map(configuredFiles.map(file => [file.path,file.text])));
    expect(client.downloadFiles.mock.calls.every(call => call[1].length <= 32)).toBe(true);
    expect((await service().getJob(principalA, queued.repositoryId))?.attempts).toBe(0);
  });
  it('imports Python and non-package repositories without synthesizing a package identity', async () => {
    configuredFiles = [{ path: 'main.py',text: 'def retry(attempt):\n    return attempt < 3\n' },{ path: 'src/main.go',text: 'package main\nfunc main() {}\n' }];
    const queued = await queue(); expect((await drain()).status).toBe('complete');
    const index = await service().getIndex(principalA, queued.repositoryId);
    expect(index.packageName).toBeNull(); expect(index.version).toBeNull(); expect(index.files).toHaveLength(2);
    expect(index.nodes.some(node => node.kind === 'symbol' && node.label === 'retry')).toBe(true);
    expect(index.nodes.some(node => node.label === 'main.go' && node.kind === 'symbol')).toBe(false);
  });
  it('keeps the last completed map readable while a subsequent import runs or fails, and honors explicit snapshot selection', async () => {
    const first = await queue(); await drain(); client.resolveCommit.mockResolvedValueOnce({ sha: 'c'.repeat(40),treeSha }); const newer = await queue();
    expect((await service().getIndex(principalA, first.repositoryId)).snapshot.snapshotId).toBe(first.snapshotId);
    await expect(service().getIndex(principalA, first.repositoryId,newer.snapshotId)).rejects.toMatchObject({ code: 'index-not-ready' });
    await expect(service().getIndex(principalA, first.repositoryId,randomUUID())).rejects.toMatchObject({ code: 'snapshot-unavailable' });
    client.discoverSnapshot.mockRejectedValueOnce(new GitHubError('invalid','Invalid tree'));
    expect((await service().processOne()).status).toBe('failed');
    expect((await service().getIndex(principalA, first.repositoryId,first.snapshotId)).snapshot.revision).toBe(commitSha);
    const summary = (await service().listRepositories(principalA, workspaceId))[0]!;
    expect(summary).toMatchObject({ status: 'failed',snapshotId: first.snapshotId,commitSha,latestSnapshotId: newer.snapshotId,latestCommitSha: 'c'.repeat(40),errorCode: 'github-invalid' });
  });
  it('reuses unchanged blobs including renamed files only from the same authorized repository', async () => {
    const first = await queue(); await drain(); client.downloadFiles.mockClear();
    configuredFiles = [source[0]!,{ path: 'src/retry.ts',text: 'export const newVersion=2;\n' },{ path: 'src/moved.ts',text: source[1]!.text }];
    client.resolveCommit.mockResolvedValueOnce({ sha: 'c'.repeat(40),treeSha }); const next = await queue();
    expect((await drain()).status).toBe('complete');
    expect(client.downloadFiles.mock.calls.flatMap(call => call[1]).map(file => file.path)).toEqual(['src/retry.ts']);
    const progress = await service().getJob(principalA, first.repositoryId); expect(progress?.progress).toMatchObject({ eligible: 3,downloaded: 1,reused: 2,parsed: 3 });
    expect((await service().getIndex(principalA, first.repositoryId,first.snapshotId)).files).toHaveLength(2);
    expect((await service().getIndex(principalA, first.repositoryId,next.snapshotId)).files).toHaveLength(3);
  });
  it('keeps repository summaries and default graph pins consistent when imports finish out of creation order', async () => {
    const first=await queue();await drain();client.resolveCommit.mockResolvedValueOnce({sha:'c'.repeat(40),treeSha});const second=await queue();await drain();
    // Simulate the first-created import publishing after its newer sibling.
    await sql.query("UPDATE atlas.snapshots SET indexed_at=now()+interval '1 second' WHERE id=$1",[first.snapshotId]);
    const summary=(await service().listRepositories(principalA,workspaceId))[0]!;
    expect(summary).toMatchObject({snapshotId:first.snapshotId,commitSha,latestSnapshotId:second.snapshotId,latestCommitSha:'c'.repeat(40)});
    expect((await service().getGraph(principalA,first.repositoryId)).snapshot.snapshotId).toBe(summary.snapshotId);
    expect((await service().getIndex(principalA,first.repositoryId)).snapshot.snapshotId).toBe(summary.snapshotId);
    expect(queries.filter(query=>query.startsWith('SELECT id,revision') && query.includes('FROM atlas.snapshots')).every(query=>query.includes('LIMIT 1'))).toBe(true);
  });
  it('does not reuse matching private blobs from another repository', async () => {
    const otherRepo = randomUUID(); const otherSnapshot = randomUUID(); const queued = await queue();
    await sql.query("INSERT INTO atlas.repositories(id,workspace_id,name,visibility) VALUES($1,$2,'Other private source','private')",[otherRepo,workspaceId]);
    await sql.query("INSERT INTO atlas.snapshots(id,workspace_id,repository_id,revision,status) VALUES($1,$2,$3,$4,'complete')",[otherSnapshot,workspaceId,otherRepo,'f'.repeat(40)]);
    for (const file of source) await sql.query('INSERT INTO atlas.source_files(workspace_id,snapshot_id,path,content,blob_sha) VALUES($1,$2,$3,$4,$5)',[workspaceId,otherSnapshot,file.path,file.text,hashed(file).blobSha]);
    expect((await drain()).status).toBe('complete');
    expect(client.downloadFiles.mock.calls.flatMap(call => call[1]).map(file => file.path)).toEqual(source.map(file => file.path));
    expect((await service().getJob(principalA,queued.repositoryId))?.progress.reused).toBe(0);
  });
  it('creates a new snapshot for an index-version change and preserves the older completed map', async () => {
    const first=await queue();await drain();await sql.query("UPDATE atlas.snapshots SET index_version='atlas-source-v1' WHERE id=$1",[first.snapshotId]);
    client.downloadFiles.mockClear();const updated=await queue();expect(updated.snapshotId).not.toBe(first.snapshotId);expect(updated.commitSha).toBe(first.commitSha);
    expect((await drain()).status).toBe('complete');expect(client.downloadFiles.mock.calls.flatMap(call=>call[1])).toHaveLength(source.length);
    expect((await service().getIndex(principalA,first.repositoryId,first.snapshotId)).snapshot.snapshotId).toBe(first.snapshotId);
  });
  it('respects Retry-After in durable scheduling without sleeping or counting successful slices as attempts', async () => {
    const queued = await queue(); await service().processOne(); const start = Date.now();
    client.downloadFiles.mockRejectedValueOnce(new GitHubError('rate-limit','Rate limited',429,120000));
    expect(await service().processOne()).toEqual({ status: 'retrying',jobId: queued.jobId,code: 'github-rate-limit' });
    const state = parseImportJob(await service().getJob(principalA,queued.repositoryId)); expect(state).toMatchObject({ status: 'queued',attempts: 1,phase: 'downloading',error: { code: 'github-rate-limit',retryable: true,action: 'retry' } });
    expect(Date.parse(state.nextAttemptAt!) - start).toBeGreaterThanOrEqual(120000); expect(await service().processOne()).toEqual({ status: 'idle' });
    await sql.query("UPDATE atlas.jobs SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[queued.jobId]);
    expect((await drain()).status).toBe('complete'); expect((await service().getJob(principalA,queued.repositoryId))?.attempts).toBe(1);
  });
  it('bounds automatic retries and lets a manually retried same-SHA job retain its failure history', async () => {
    const queued = await queue(); client.discoverSnapshot.mockRejectedValue(new GitHubError('upstream','Network unavailable'));
    for (let failure = 1; failure <= 5; failure++) {
      await sql.query("UPDATE atlas.jobs SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[queued.jobId]);
      expect((await service().processOne()).status).toBe(failure < 5 ? 'retrying' : 'failed');
    }
    const failed = await service().getJob(principalA,queued.repositoryId); expect(failed).toMatchObject({ attempts: 5,status: 'failed',canRetry: true });
    expect(await service().processOne()).toEqual({ status: 'idle' });
    const retry = await service().retryImport(principalA,queued.repositoryId,queued.jobId!); expect(retry).toMatchObject({ id: queued.jobId,snapshotId: queued.snapshotId,commitSha,attempts: 5,status: 'queued' });
    client.discoverSnapshot.mockImplementation(async (_repo,sha) => discovery(sha));
    expect((await drain()).status).toBe('complete'); expect((await service().getJob(principalA,queued.repositoryId))?.attempts).toBe(5);
  });
  it('fences a replaced claim token before any checkpoint or failure-state mutation', async () => {
    const queued = await queue(); const replacement = randomUUID();
    client.discoverSnapshot.mockImplementationOnce(async (_repo,sha) => { await sql.query("UPDATE atlas.jobs SET claim_token=$1,lease_until=now()+interval '2 minutes' WHERE id=$2",[replacement,queued.jobId]); return discovery(sha); });
    expect(await service().processOne()).toEqual({ status: 'superseded',jobId: queued.jobId,code: 'job-lease-lost' });
    expect((await sql.query('SELECT claim_token,status,attempts,error_code FROM atlas.jobs')).rows).toEqual([{ claim_token: replacement,status: 'running',attempts: 0,error_code: null }]);
    expect((await sql.query('SELECT * FROM atlas.import_manifests')).rows).toHaveLength(0);
    await sql.query("UPDATE atlas.jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",[queued.jobId]);
    expect((await drain()).status).toBe('complete'); expect((await service().getJob(principalA,queued.repositoryId))?.attempts).toBe(0);
  });
  it('cancels an in-flight slice, prevents its late writes, then resumes the retained checkpoint under an authorized admin', async () => {
    configuredFiles = [source[0]!,...Array.from({ length: 64 },(_,position) => ({ path: `src/${position}.ts`,text: `export const item${position}=${position};\n` }))];
    const queued = await queue(); await service().processOne(); await service().processOne();
    await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role,revision) VALUES($1,$2,'admin',3)",[workspaceId,principalB]);
    client.downloadFiles.mockImplementationOnce(async (_repo,files: GitHubTreeFile[]) => {
      const cancelled = await service().cancelImport(principalB,queued.repositoryId,queued.jobId!); expect(cancelled.status).toBe('cancelled');
      return files.map(file => ({ path: file.path,text: configuredFiles.find(item => item.path===file.path)!.text,blobSha: file.blobSha }));
    });
    expect((await service().processOne()).status).toBe('superseded');
    const cancelled = await service().getJob(principalA,queued.repositoryId); expect(cancelled).toMatchObject({ status: 'cancelled',attempts: 0,canRetry: true,progress: { downloaded: 32 } });
    expect((await sql.query('SELECT * FROM atlas.source_files')).rows).toHaveLength(0);
    const resumed = await service().retryImport(principalB,queued.repositoryId,queued.jobId!); expect(resumed).toMatchObject({ id: queued.jobId,snapshotId: queued.snapshotId,commitSha,status: 'queued' });
    expect((await drain()).status).toBe('complete'); expect((await sql.query('SELECT * FROM atlas.jobs')).rows).toHaveLength(1);
    const index = await service().getIndex(principalB,queued.repositoryId); expect(index.scope.permissionRevision).toBe('3:1'); expect(index.files).toHaveLength(65);
  });
  it('recovers a worker shutdown without charging a failure attempt or discarding downloaded files', async () => {
    const queued = await queue(); await service().processOne(); const controller = new AbortController();
    client.downloadFiles.mockImplementationOnce(async () => { controller.abort(); throw new GitHubError('aborted','Stopped'); });
    expect(await service().processOne({ signal: controller.signal })).toEqual({ status: 'retrying',jobId: queued.jobId });
    expect((await service().getJob(principalA,queued.repositoryId))?.attempts).toBe(0); expect((await drain()).status).toBe('complete');
  });
  it('checks workspace and live GitHub access before reads and rechecks revocation before caching', async () => {
    const queued = await queue(); await service().processOne();
    vi.mocked(githubForPrincipal).mockClear(); queries.length=0;
    await expect(service().getJob(principalB,queued.repositoryId)).rejects.toMatchObject({ code:'repository-unavailable' });
    await expect(service().getGraph(principalB,queued.repositoryId)).rejects.toMatchObject({ code:'repository-unavailable' });
    expect(githubForPrincipal).not.toHaveBeenCalled(); expect(queries.some(query => /FROM atlas\.(?:source_files|graphs|jobs|import_files)/.test(query))).toBe(false);
    client.downloadFiles.mockImplementationOnce(async (_repo,files: GitHubTreeFile[]) => { await sql.query('UPDATE atlas.memberships SET revision=8 WHERE workspace_id=$1',[workspaceId]); return files.map(file => ({ path:file.path,text:source.find(item=>item.path===file.path)!.text,blobSha:file.blobSha })); });
    expect((await service().processOne())).toEqual({ status:'failed',jobId:queued.jobId,code:'authorization-changed' });
    expect((await sql.query('SELECT * FROM atlas.import_files')).rows).toHaveLength(0); expect((await sql.query('SELECT * FROM atlas.graphs')).rows).toHaveLength(0);
  });
  it('fails a job whose owner lost membership before reading any staged source or GitHub content', async () => {
    const queued = await queue(); await sql.query('DELETE FROM atlas.memberships WHERE workspace_id=$1',[workspaceId]);
    expect(await service().processOne()).toEqual({ status:'failed',jobId:queued.jobId,code:'denied' }); expect(client.discoverSnapshot).not.toHaveBeenCalled();
  });
  it('rejects forged source bytes and corrupt reused blobs without publishing source or graph', async () => {
    const queued=await queue(); await service().processOne();
    client.downloadFiles.mockResolvedValueOnce(discovery().files.map(file=>({ ...file,text:'forged text' })));
    expect(await service().processOne()).toEqual({ status:'failed',jobId:queued.jobId,code:'source-integrity' });
    expect((await sql.query('SELECT * FROM atlas.import_files')).rows).toHaveLength(0); expect((await sql.query('SELECT * FROM atlas.source_files')).rows).toHaveLength(0);
    await queue(); expect((await drain()).status).toBe('complete');
    await sql.query("UPDATE atlas.source_files SET content=replace(content,'attempt < 3','attempt < 9') WHERE path='src/retry.ts'");
    client.resolveCommit.mockResolvedValueOnce({ sha:'c'.repeat(40),treeSha }); await queue(); await service().processOne();
    expect((await service().processOne()).code).toBe('source-integrity');
    expect((await sql.query('SELECT * FROM atlas.source_files')).rows).toHaveLength(2);
  });
  it('rolls back source publication when graph storage fails and preserves the staged checkpoint', async () => {
    const queued=await queue(); await service().processOne(); await service().processOne();
    queryFault=query=>{if(query.startsWith('INSERT INTO atlas.graphs'))throw new AtlasDatabaseError('query','Injected graph write failure');};
    expect(await service().processOne()).toEqual({ status:'failed',jobId:queued.jobId,code:'database-query' }); queryFault=undefined;
    expect((await sql.query('SELECT * FROM atlas.source_files')).rows).toHaveLength(0); expect((await sql.query('SELECT * FROM atlas.graphs')).rows).toHaveLength(0);
    expect((await sql.query('SELECT * FROM atlas.import_files')).rows).toHaveLength(2);
  });
  it('returns uncertainty after a lost COMMIT response without overwriting a completed job', async () => {
    const queued=await queue(); await service().processOne(); await service().processOne();
    const uncertain={ ...database,withAdminTransaction: async <T>(work:(tx:AtlasTransaction)=>Promise<T>)=>{let publishing=false;const result=await database.withAdminTransaction(tx=>work({query:async (text,values)=>{if(text.startsWith('INSERT INTO atlas.source_files'))publishing=true;return tx.query(text,values);}}));if(publishing)throw new AtlasDatabaseError('commit_unknown','Lost response');return result;} } as AtlasDatabase;
    expect(await createRepositoryService(uncertain,{ATLAS_PARSER_SCRIPT:script}).processOne()).toEqual({ status:'unknown',jobId:queued.jobId,code:'database-commit_unknown' });
    expect((await service().getJob(principalA,queued.repositoryId))?.status).toBe('complete'); expect(await service().processOne()).toEqual({status:'idle'});
  });
  it('pages graph metadata without reading full source and returns exact commit-pinned source lines', async () => {
    const queued=await queue(); await drain(); queries.length=0;
    const graph=await service().getGraph(principalA,queued.repositoryId,{ snapshotId:queued.snapshotId,folder:'src',limit:1 });
    expect(graph.nodes).toHaveLength(1); expect(graph.page.nextCursor).toBe(1); expect(graph.edges.length).toBeLessThanOrEqual(400);
    expect(graph.files.every(file=>!('text' in file))).toBe(true); expect(queries.some(query=>query.includes('content AS text'))).toBe(false);
    const passage=await service().getSource(principalA,queued.repositoryId,queued.snapshotId,'src/retry.ts',2,2);
    expect(passage.original).toBe('  return attempt < 3;'); expect(passage.source).toMatchObject({ revision:commitSha,snapshotId:queued.snapshotId,startLine:2,endLine:2 });
    await expect(service().getSource(principalA,queued.repositoryId,queued.snapshotId,'src/retry.ts',1,121)).rejects.toMatchObject({ code:'invalid-source-range' });
    await expect(service().getSource(principalA,queued.repositoryId,queued.snapshotId,'../escape.ts')).rejects.toMatchObject({ code:'invalid-source-range' });
    await expect(service().getGraph(principalA,queued.repositoryId,{limit:161})).rejects.toMatchObject({code:'invalid-graph-query'});
  });
  it('denies ungranted source, graph and job reads and prevents browser access to staging tables', async () => {
    const queued=await queue(); await drain();
    await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role) VALUES($1,$2,'reader')",[workspaceId,principalB]);
    const visible=async (grant:boolean)=>database.withPrincipalTransaction(principalB,async tx=>{ if(grant)await tx.query("SELECT set_config('atlas.authorized_repository_ids',$1,true)",[JSON.stringify([queued.repositoryId])]);const result=[];for(const table of ['source_files','graphs','jobs'])result.push((await tx.query(`SELECT * FROM atlas.${table}`)).rows.length);return result; });
    expect(await visible(false)).toEqual([0,0,0]); expect(await visible(true)).toEqual([2,1,1]); expect(await visible(false)).toEqual([0,0,0]);
    for(const table of ['import_files','import_manifests'])await expect(database.withPrincipalTransaction(principalB,tx=>tx.query(`SELECT * FROM atlas.${table}`))).rejects.toBeInstanceOf(AtlasDatabaseError);
    await expect(service().cancelImport(principalB,queued.repositoryId)).rejects.toMatchObject({code:'denied'});
    const index=await service().getIndex(principalB,queued.repositoryId); expect(index.evidence.every(item=>item.scope.principalId===principalB)).toBe(true);
    client.authorizeRepository.mockRejectedValue(new GitHubError('unauthorized','Revoked'));queries.length=0;
    await expect(service().getSource(principalB,queued.repositoryId,queued.snapshotId,'src/retry.ts')).rejects.toBeInstanceOf(GitHubError);
    expect(queries.some(query=>query.includes('FROM atlas.source_files'))).toBe(false);
  });
  it('bounds graph evidence bytes and keeps every returned edge bound to retained canonical evidence', async () => {
    configuredFiles=[source[0]!,...Array.from({length:10},(_,position)=>({path:`src/module-${position}.ts`,text:`export const value${position} = "${'a'.repeat(60000)}";\n`}))];
    const queued=await queue(); expect((await drain()).status).toBe('complete');
    const page=await service().getGraph(principalA,queued.repositoryId,{folder:'src',limit:160});
    expect(Buffer.byteLength(JSON.stringify(page.evidence))).toBeLessThanOrEqual(262144); expect(page.evidence.length).toBeGreaterThan(0); expect(page.evidence.length).toBeLessThan(10);
    const retained=new Set(page.evidence.map(item=>item.id));expect(page.edges.length).toBeGreaterThan(0);expect(page.edges.every(edge=>retained.has(edge.evidenceId))).toBe(true);
    for(const evidence of page.evidence)expect(configuredFiles.find(file=>file.path===evidence.source.path)!.text.includes(evidence.original)).toBe(true);
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
    const overflow = Array.from({ length: GIT_LIMITS.files + 1 }, (_, position) => ({ path: `src/${position}.ts`, text: 'export const a=1;' }));
    await expect(parseRepositoryIsolated({ ...input(), files: overflow }, { ATLAS_PARSER_SCRIPT: script })).rejects.toMatchObject({ code: 'source-limit' });
  }, 15000);
  it('returns only fixed safe parser diagnostics without reflecting syntax, source paths or exception text', async () => {
    await expect(parseRepositoryIsolated({ ...input(), files: [{ path: 'package.json', text: 'private-source-sentinel-is-not-json' }] }, { ATLAS_PARSER_SCRIPT: script })).rejects.toMatchObject({ code: 'parser-manifest-invalid' });
    await expect(parseRepositoryIsolated({ ...input(), files: [...source, { path: 'src/bounded.ts', text: '\n'.repeat(GIT_LIMITS.linesPerFile) }] }, { ATLAS_PARSER_SCRIPT: script })).rejects.toMatchObject({ code: 'parser-line-limit' });
    const untrusted = join(directory, 'diagnostic-reflection.mjs');
    await writeFile(untrusted, 'process.stdin.resume(); process.stdout.write(JSON.stringify({error:"private-source-sentinel"})); process.exitCode=1;');
    try { await parseRepositoryIsolated(input(), { ATLAS_PARSER_SCRIPT: untrusted }); throw new Error('Expected parser diagnostic rejection'); }
    catch (error) { expect(error).toMatchObject({ code: 'parser-failed' }); expect(String(error)).not.toContain('private-source-sentinel'); }
  });
  it('parses dense source above the old fixture AST bound under the separate bounded Git policy', async () => {
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
    const larger = dense(45000); expect(larger.count).toBeGreaterThan(LOCAL_LIMITS.astNodes); expect(larger.count).toBeLessThan(GIT_LIMITS.astNodes);
    expect(larger.file.text.length).toBeLessThan(GIT_LIMITS.fileCharacters);
    expect((await parseRepositoryIsolated({ ...input(), files: [...source, larger.file] }, { ATLAS_PARSER_SCRIPT: script })).files).toHaveLength(3);
  }, 15000);
  it('kills a stalled trusted parser at the hard deadline', async () => {
    const stalled = join(directory, 'stalled.mjs'); await writeFile(stalled, 'process.stdin.resume(); setInterval(() => {},1000);');
    await expect(parseRepositoryIsolated(input(), { ATLAS_PARSER_SCRIPT: stalled },{timeoutMs:500})).rejects.toMatchObject({ code: 'parser-timeout' });
  }, 20000);
});
