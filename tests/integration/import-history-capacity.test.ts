import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasDatabase } from '../../apps/worker/src/database.ts';
import type { AtlasPool } from '../../apps/worker/src/database.ts';
import type { githubForPrincipal } from '../../apps/worker/src/clerk-github.ts';
import type { GitHubAppClient, VerifiedGitHubUser } from '../../apps/worker/src/github.ts';
import { assertImportHistoryCapacity, createRepositoryService } from '../../apps/worker/src/repository-service.ts';
import { IMPORT_INDEX_VERSION, parseImportJob } from '../../packages/contracts/src/import.ts';
import { parseRepositoryIndex } from '../../packages/core/src/local/parser.ts';

// Actual retention triggers, RLS and AtlasDatabase transactions execute against
// an isolated, generated PGlite database. Only Clerk/GitHub proof is injected.
// Its one serialized PostgreSQL backend cannot prove cross-connection races.
const sql = new PGlite();
const workspaceId = randomUUID(); const otherWorkspaceId = randomUUID();
const repositoryId = randomUUID(); const snapshotId = randomUUID();
const principal = 'user_capacityOwner'; const otherPrincipal = 'user_capacityOther';
const commitSha = 'a'.repeat(40); const treeSha = 'b'.repeat(40);
const observedAt = '2026-10-11T00:00:00Z';
const files = [
  { path: 'package.json', text: '{"name":"@verifier/capacity","version":"1.0.0","exports":{".":"./src/index.ts"}}' },
  { path: 'src/index.ts', text: 'export function retained(value: number) {\n  return value + 1;\n}\n' },
];
const index = parseRepositoryIndex({ scope: { tenantId: workspaceId, principalId: principal, permissionRevision: '1:1' },
  snapshot: { kind: 'git', repositoryId, snapshotId, revision: commitSha },
  packageName: '@verifier/capacity', version: '1.0.0', files, observedAt });
const githubRepository = { id: 701, owner: 'verifier', name: 'capacity', fullName: 'verifier/capacity', private: true,
  defaultBranch: 'main', installationId: 99, principalId: principal };
const client = { authorizeRepository: vi.fn(), resolveCommit: vi.fn() };
const linkGitHub: typeof githubForPrincipal = async actor => ({
  client: client as unknown as GitHubAppClient,
  user: { principalId: actor, githubUserId: actor === principal ? 10 : 11, login: 'capacity-fixture' } as VerifiedGitHubUser,
});

type Statement = { text: string; values: unknown[] };
const statements: Statement[] = [];
let tail: Promise<void> = Promise.resolve();
const pool = Object.assign(new EventEmitter(), {
  connect: async () => {
    const previous = tail; let releaseQueue = () => {};
    tail = new Promise<void>(complete => { releaseQueue = complete; }); await previous;
    return Object.assign(new EventEmitter(), {
      query: async (text: string, values?: unknown[]) => {
        statements.push({ text, values: [...(values ?? [])] });
        const result = await sql.query(text, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, command: '', oid: 0, fields: [] };
      },
      release: () => { releaseQueue(); },
    });
  },
  end: async () => {},
}) as unknown as AtlasPool;
const database = new AtlasDatabase(pool);
const service = createRepositoryService(database, {}, { githubForPrincipal: linkGitHub });

beforeAll(async () => {
  await sql.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;`);
  for (const path of ['202610030001_atlas.sql', '202610070001_personal_workspaces.sql',
    '202610070002_github_jobs.sql', '202610070003_server_repository_grants.sql', '202610110001_resumable_imports.sql']) {
    await sql.exec(await readFile(`supabase/migrations/${path}`, 'utf8'));
  }
}, 30_000);

beforeEach(async () => {
  await sql.exec('TRUNCATE atlas.workspaces CASCADE');
  await sql.query('INSERT INTO atlas.workspaces(id,name) VALUES($1,$3),($2,$4)',
    [workspaceId, otherWorkspaceId, 'Generated retention workspace', 'Separate generated workspace']);
  await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role) VALUES($1,$3,'owner'),($2,$4,'owner')",
    [workspaceId, otherWorkspaceId, principal, otherPrincipal]);
  await sql.query(`INSERT INTO atlas.repositories(id,workspace_id,name,visibility,github_repository_id,github_installation_id,github_owner,github_name)
    VALUES($1,$2,'verifier/capacity','private',701,99,'verifier','capacity')`, [repositoryId, workspaceId]);
  await sql.query(`INSERT INTO atlas.snapshots(id,workspace_id,repository_id,revision,status,tree_sha,index_version,indexed_at)
    VALUES($1,$2,$3,$4,'complete',$5,$6,$7)`, [snapshotId, workspaceId, repositoryId, commitSha, treeSha, IMPORT_INDEX_VERSION, observedAt]);
  for (const file of files) {
    const bytes = Buffer.from(file.text);
    const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    await sql.query('INSERT INTO atlas.source_files(workspace_id,snapshot_id,path,content,blob_sha) VALUES($1,$2,$3,$4,$5)',
      [workspaceId, snapshotId, file.path, file.text, blobSha]);
  }
  await sql.query('INSERT INTO atlas.graphs(workspace_id,snapshot_id,graph) VALUES($1,$2,$3::jsonb)',
    [workspaceId, snapshotId, JSON.stringify({ ...index, files: [] })]);
  statements.length = 0; vi.resetAllMocks();
  client.authorizeRepository.mockImplementation(async (user: VerifiedGitHubUser) => ({ ...githubRepository, principalId: user.principalId }));
  client.resolveCommit.mockResolvedValue({ sha: commitSha, treeSha });
});

afterAll(async () => { await database.close(); await sql.close(); });

async function counts(workspace = workspaceId) {
  const row = (await sql.query<{ snapshots: number; jobs: number; sources: number; graphs: number }>(`
    SELECT (SELECT count(*)::int FROM atlas.snapshots WHERE workspace_id=$1) AS snapshots,
      (SELECT count(*)::int FROM atlas.jobs WHERE workspace_id=$1) AS jobs,
      (SELECT count(*)::int FROM atlas.source_files WHERE workspace_id=$1) AS sources,
      (SELECT count(*)::int FROM atlas.graphs WHERE workspace_id=$1) AS graphs`, [workspace])).rows[0];
  if (!row) throw new Error('Missing generated history counters');
  return row;
}

async function fillSnapshots(target: number) {
  if (!Number.isInteger(target) || target < 1 || target > 100) throw new Error('Unbounded snapshot fixture');
  const remaining = target - (await counts()).snapshots;
  if (remaining < 0) throw new Error('Snapshot fixture already exceeds its target');
  if (!remaining) return;
  // Failed and cancelled versions also consume retained history; no source is
  // invented for those snapshots. The one complete snapshot retains real parser evidence.
  await sql.query(`INSERT INTO atlas.snapshots(workspace_id,repository_id,revision,status,tree_sha,index_version)
    SELECT $1,$2,lpad(to_hex(1000+n),40,'0'),CASE WHEN n%2=0 THEN 'cancelled' ELSE 'failed' END,$3,$4
    FROM generate_series(1,$5::int) n`, [workspaceId, repositoryId, treeSha, IMPORT_INDEX_VERSION, remaining]);
}

async function fillJobs(target: number) {
  if (!Number.isInteger(target) || target < 0 || target > 1000) throw new Error('Unbounded job fixture');
  const remaining = target - (await counts()).jobs;
  if (remaining < 0) throw new Error('Job fixture already exceeds its target');
  if (!remaining) return;
  await sql.query(`INSERT INTO atlas.jobs(workspace_id,snapshot_id,principal_id,permission_revision,repository_permission_revision,status,phase,finished_at)
    SELECT $1,$2,$3,1,1,CASE WHEN n%3=0 THEN 'cancelled' WHEN n%3=1 THEN 'failed' ELSE 'complete' END,
      CASE WHEN n%3=2 THEN 'complete' ELSE 'discovering' END,now() FROM generate_series(1,$4::int) n`,
  [workspaceId, snapshotId, principal, remaining]);
}

async function insertSnapshot(revision: string, status = 'failed') {
  return (await sql.query<{ id: string }>(`INSERT INTO atlas.snapshots(workspace_id,repository_id,revision,status,tree_sha,index_version)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [workspaceId, repositoryId, revision, status, treeSha, IMPORT_INDEX_VERSION])).rows[0]!.id;
}

async function sourceRows() {
  return (await sql.query<{ workspace_id: string; snapshot_id: string; path: string; content: string; blob_sha: string | null }>(
    'SELECT workspace_id,snapshot_id,path,content,blob_sha FROM atlas.source_files ORDER BY path')).rows;
}

const capacityError = {
  name: 'RepositoryServiceError', code: 'import-history-limit', status: 422,
  message: 'Workspace history is limited to 100 snapshots and 1000 import jobs. Ask an administrator to review retention before importing another version.',
};
function queue(actor = principal, workspace = workspaceId) {
  return service.queueImport(actor, workspace, 'https://github.com/verifier/capacity');
}

describe('retained import history capacity using actual PostgreSQL SQL', () => {
  it('allows the 100th snapshot and rejects the 101st while retaining failed and cancelled history', async () => {
    await fillSnapshots(99);
    await insertSnapshot('c'.repeat(40));
    const retained = await sourceRows();
    expect(await counts()).toEqual({ snapshots: 100, jobs: 0, sources: 2, graphs: 1 });
    await expect(insertSnapshot('d'.repeat(40))).rejects.toMatchObject({
      code: 'P0001', message: 'Workspace retained snapshot capacity reached',
    });
    expect(await counts()).toEqual({ snapshots: 100, jobs: 0, sources: 2, graphs: 1 });
    expect(await sourceRows()).toEqual(retained);
  });

  it('allows the 1000th import job and rejects the 1001st regardless of completed/failed/cancelled state', async () => {
    await fillJobs(999);
    await sql.query(`INSERT INTO atlas.jobs(workspace_id,snapshot_id,principal_id,permission_revision,status,phase)
      VALUES($1,$2,$3,1,'complete','complete')`, [workspaceId, snapshotId, principal]);
    await expect(sql.query(`INSERT INTO atlas.jobs(workspace_id,snapshot_id,principal_id,permission_revision,status,phase)
      VALUES($1,$2,$3,1,'failed','discovering')`, [workspaceId, snapshotId, principal])).rejects.toMatchObject({
      code: 'P0001', message: 'Workspace retained import job capacity reached',
    });
    expect(await counts()).toEqual({ snapshots: 1, jobs: 1000, sources: 2, graphs: 1 });
    const statuses = (await sql.query<{ status: string }>('SELECT DISTINCT status FROM atlas.jobs ORDER BY status')).rows.map(row => row.status);
    expect(statuses).toEqual(['cancelled', 'complete', 'failed']);
    expect((await sourceRows()).map(row => row.content)).toEqual(files.map(file => file.text));
  });

  it('takes the workspace advisory lock and gives an actionable snapshot-cap error while an existing snapshot still has one job slot', async () => {
    await fillSnapshots(100); await fillJobs(999);
    await expect(database.withAdminTransaction(tx => assertImportHistoryCapacity(tx, workspaceId, false))).resolves.toBeUndefined();
    await expect(database.withAdminTransaction(tx => assertImportHistoryCapacity(tx, workspaceId, true))).rejects.toMatchObject(capacityError);
    const locks = statements.filter(statement => statement.text.includes('pg_advisory_xact_lock'));
    expect(locks).toHaveLength(2);
    expect(locks.map(statement => statement.values)).toEqual([[`atlas-import-capacity:${workspaceId}`], [`atlas-import-capacity:${workspaceId}`]]);
    expect(await counts()).toEqual({ snapshots: 100, jobs: 999, sources: 2, graphs: 1 });
  });

  it('gives the same actionable job-cap error for another attempt or a new version even below the snapshot cap', async () => {
    await fillSnapshots(99); await fillJobs(1000);
    for (const needsSnapshot of [false, true]) {
      await expect(database.withAdminTransaction(tx => assertImportHistoryCapacity(tx, workspaceId, needsSnapshot))).rejects.toMatchObject(capacityError);
    }
    expect(await counts()).toEqual({ snapshots: 99, jobs: 1000, sources: 2, graphs: 1 });
  });

  it('accepts a new import in another workspace while the first has 100 snapshots and 1000 jobs', async () => {
    await fillSnapshots(100); await fillJobs(1000);
    const retained = await sourceRows();
    expect(await counts(otherWorkspaceId)).toEqual({ snapshots: 0, jobs: 0, sources: 0, graphs: 0 });
    expect(await queue(otherPrincipal, otherWorkspaceId)).toMatchObject({ status: 'queued', commitSha });
    expect(await counts(otherWorkspaceId)).toEqual({ snapshots: 1, jobs: 1, sources: 0, graphs: 0 });
    expect(await counts()).toEqual({ snapshots: 100, jobs: 1000, sources: 2, graphs: 1 });
    expect(await sourceRows()).toEqual(retained);
    await expect(service.getIndex(otherPrincipal, repositoryId, snapshotId)).rejects.toMatchObject({ code: 'repository-unavailable', status: 404 });
  });

  it('reuses a completed exact-version import twice at both caps and preserves its readable source and graph', async () => {
    await fillSnapshots(100); await fillJobs(1000);
    const retained = await sourceRows();
    const graph = (await sql.query('SELECT graph FROM atlas.graphs WHERE snapshot_id=$1', [snapshotId])).rows;
    const expected = { repositoryId, snapshotId, jobId: null, status: 'complete', commitSha };
    expect(await queue()).toEqual(expected);
    expect(await queue()).toEqual(expected);
    expect(statements.some(statement => statement.text.includes('pg_advisory_xact_lock'))).toBe(false);
    const loaded = await service.getIndex(principal, repositoryId, snapshotId);
    expect(loaded.snapshot).toEqual(index.snapshot);
    expect(loaded.files.map(file => ({ path: file.path, text: file.text }))).toEqual(files);
    expect(loaded.nodes).toEqual(index.nodes);
    expect(loaded.evidence).toEqual(index.evidence);
    const symbol = index.nodes.find(node => node.label === 'retained');
    expect(symbol).toBeDefined();
    expect((await service.getGraph(principal, repositoryId, { snapshotId, query: 'retained' })).nodes).toEqual([symbol]);
    expect(await service.getSource(principal, repositoryId, snapshotId, 'src/index.ts', 1, 3)).toMatchObject({
      original: 'export function retained(value: number) {\n  return value + 1;\n}',
      source: { repositoryId, snapshotId, revision: commitSha, path: 'src/index.ts', startLine: 1, endLine: 3 },
    });
    expect(await counts()).toEqual({ snapshots: 100, jobs: 1000, sources: 2, graphs: 1 });
    expect(await sourceRows()).toEqual(retained);
    expect((await sql.query('SELECT graph FROM atlas.graphs WHERE snapshot_id=$1', [snapshotId])).rows).toEqual(graph);
  });

  it.each(['queued', 'running'] as const)('reuses the same %s job at both caps without deleting the prior complete source', async status => {
    const activeRevision = 'c'.repeat(40); const activeSnapshot = await insertSnapshot(activeRevision, status);
    await fillSnapshots(100); await fillJobs(999);
    const activeJob = (await sql.query<{ id: string }>(`INSERT INTO atlas.jobs(workspace_id,snapshot_id,principal_id,permission_revision,repository_permission_revision,status,phase)
      VALUES($1,$2,$3,1,1,$4,'discovering') RETURNING id`, [workspaceId, activeSnapshot, principal, status])).rows[0]!.id;
    client.resolveCommit.mockResolvedValue({ sha: activeRevision, treeSha });
    const retained = await sourceRows();
    const expected = { repositoryId, snapshotId: activeSnapshot, jobId: activeJob, status, commitSha: activeRevision };
    expect(await queue()).toEqual(expected); expect(await queue()).toEqual(expected);
    expect(parseImportJob(await service.getJob(principal, repositoryId))).toMatchObject({ id: activeJob, snapshotId: activeSnapshot, status });
    expect((await service.getIndex(principal, repositoryId, snapshotId)).files.map(file => file.text)).toEqual(files.map(file => file.text));
    expect(await counts()).toEqual({ snapshots: 100, jobs: 1000, sources: 2, graphs: 1 });
    expect(await sourceRows()).toEqual(retained);
    expect(statements.some(statement => statement.text.includes('pg_advisory_xact_lock'))).toBe(false);
  });

  it.each([{ snapshots: 100, jobs: 999 }, { snapshots: 99, jobs: 1000 }])(
    'rolls back a new import and metadata writes with $snapshots retained snapshots / $jobs jobs', async capacity => {
      await fillSnapshots(capacity.snapshots); await fillJobs(capacity.jobs);
      const retained = await sourceRows();
      const repositories = (await sql.query('SELECT * FROM atlas.repositories')).rows;
      client.resolveCommit.mockResolvedValue({ sha: 'd'.repeat(40), treeSha });
      client.authorizeRepository.mockResolvedValue({ ...githubRepository, private: false, installationId: 100 });
      await expect(queue()).rejects.toMatchObject(capacityError);
      expect(await counts()).toEqual({ ...capacity, sources: 2, graphs: 1 });
      expect((await sql.query('SELECT * FROM atlas.repositories')).rows).toEqual(repositories);
      expect(await sourceRows()).toEqual(retained);
      expect((await sql.query("SELECT count(*)::int AS count FROM atlas.snapshots WHERE revision=$1", ['d'.repeat(40)])).rows).toEqual([{ count: 0 }]);
    });
});
