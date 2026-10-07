import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { AtlasDatabaseError, createAtlasDatabase } from '../apps/worker/src/database.ts';
import type { AtlasDatabase, AtlasPool, AtlasTransaction } from '../apps/worker/src/database.ts';
import type { PoolConfig } from 'pg';

// Actual hosted native-PG contention on generated database fixtures only.
// Complete-status jobs are never eligible for the concurrently running worker.
// No GitHub, Clerk, source/provider calls, imports, purchases or schema changes.
const auditId = randomUUID(); const workspaceId = randomUUID(); const repositoryId = randomUUID();
const snapshotId = randomUUID(); const jobId = randomUUID(); const principalId = `atlas-lock-audit-${auditId}`;
const tables = ['jobs', 'source_files', 'graphs', 'snapshots', 'repositories', 'memberships', 'workspaces'] as const;
const checks: Record<string, unknown>[] = []; let database: AtlasDatabase | undefined; let created = false;
let cleanup: Record<string, unknown> = { status: 'not-needed' }; const verifiedSockets: boolean[] = [];
function assert(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
function safeCode(error: unknown): string {
  if (error instanceof AtlasDatabaseError) return `database-${error.code}`;
  return error instanceof Error && /^audit-[a-z0-9-]+$/.test(error.message) ? error.message : 'audit-operation-failed';
}
async function check(id: string, work: () => Promise<Record<string, unknown>>): Promise<void> {
  try { checks.push({ id, status: 'passed', ...await work() }); }
  catch (error) { checks.push({ id, status: 'failed', code: safeCode(error) }); throw error; }
}
function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function handshake<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('audit-lock-handshake-timeout')), 6000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function pid(tx: AtlasTransaction): Promise<number> {
  const value = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  assert(typeof value === 'number', 'audit-backend-pid-unavailable'); return value;
}
async function repositoryLock(tx: AtlasTransaction): Promise<void> {
  const result = await tx.query('SELECT id FROM atlas.repositories WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [repositoryId, workspaceId]);
  assert(result.rows.length === 1, 'audit-created-repository-missing');
}
async function jobLock(tx: AtlasTransaction, nowait = false): Promise<void> {
  const result = await tx.query(`SELECT id FROM atlas.jobs WHERE id=$1 AND workspace_id=$2 FOR UPDATE${nowait ? ' NOWAIT' : ''}`, [jobId, workspaceId]);
  assert(result.rows.length === 1, 'audit-created-job-missing');
}
async function snapshotLock(tx: AtlasTransaction, nowait = false): Promise<void> {
  const result = await tx.query(`SELECT id FROM atlas.snapshots WHERE id=$1 AND workspace_id=$2 FOR UPDATE${nowait ? ' NOWAIT' : ''}`, [snapshotId, workspaceId]);
  assert(result.rows.length === 1, 'audit-created-snapshot-missing');
}
async function waitForBlocked(tx: AtlasTransaction, contender: number, holder: number): Promise<void> {
  const deadline = Date.now() + 3500;
  do {
    const state = (await tx.query<{ blocked: boolean }>('SELECT wait_event_type=\'Lock\' AND $2=ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid=$1', [contender, holder])).rows[0];
    if (state?.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  throw new Error('audit-repository-contention-not-observed');
}
async function counts(db: AtlasDatabase): Promise<Record<string, number>> {
  return db.withAdminTransaction(async tx => {
    const result: Record<string, number> = {};
    for (const table of tables) result[table] = (await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM atlas.${table} WHERE ${table === 'workspaces' ? 'id' : 'workspace_id'}=$1`, [workspaceId])).rows[0]?.count ?? -1;
    return result;
  });
}
async function orderedContention(db: AtlasDatabase, reverse: boolean): Promise<Record<string, unknown>> {
  const held = signal<number>(); const ready = signal<number>();
  let observedBlocking = false; let acquiredSnapshot = false; const backendPids: number[] = [];
  const holder = db.withAdminTransaction(async tx => {
    const backend = await pid(tx); backendPids.push(backend); await repositoryLock(tx); held.resolve(backend);
    const contender = await handshake(ready.promise); assert(contender !== backend, 'audit-transactions-share-backend');
    await waitForBlocked(tx, contender, backend); observedBlocking = true;
    // With correct order the waiter holds no job while waiting for repository.
    // NOWAIT makes the reverse-order control detectable without a deadlock.
    await jobLock(tx, true); await snapshotLock(tx, true);
  });
  const contender = (async () => {
    await handshake(held.promise);
    return db.withAdminTransaction(async tx => {
      await tx.query("SET LOCAL lock_timeout = '5000ms'");
      const backend = await pid(tx); backendPids.push(backend);
      if (reverse) await jobLock(tx);
      ready.resolve(backend); await repositoryLock(tx);
      if (!reverse) await jobLock(tx);
      await snapshotLock(tx); acquiredSnapshot = true;
    });
  })();
  // Attach handlers immediately; expected negative-control rejection must not
  // become an unhandled promise rejection while another backend is waiting.
  const results = await Promise.allSettled([holder, contender]);
  assert(observedBlocking && acquiredSnapshot && new Set(backendPids).size === 2, 'audit-lock-race-incomplete');
  assert(results[1]?.status === 'fulfilled', 'audit-contender-did-not-complete');
  if (reverse) {
    const failed = results[0];
    assert(failed?.status === 'rejected' && failed.reason instanceof AtlasDatabaseError && failed.reason.code === 'timeout', 'audit-reverse-order-control-not-detected');
  } else assert(results.every(result => result.status === 'fulfilled'), 'audit-ordered-locks-failed');
  return { separateBackendPids: backendPids, realRepositoryWaitObserved: true, waiterCompleted: true,
    jobLockAvailableToRepositoryHolder: !reverse, reverseOrderDetectedByNowait: reverse, noDeadlockWaitRequired: true };
}

try {
  const env = { ...process.env, ...parseEnv(await readFile('.env.local', 'utf8')) };
  const native = createRequire(new URL('../apps/worker/src/database.ts', import.meta.url))('pg') as { Pool: new (configuration: PoolConfig) => AtlasPool };
  database = await createAtlasDatabase(env, { poolFactory: configuration => {
    const pool = new native.Pool(configuration);
    pool.on('connect', client => {
      const stream = (client as unknown as { connection: { stream: { encrypted?: boolean; authorized?: boolean } } }).connection.stream;
      verifiedSockets.push(stream.encrypted === true && stream.authorized === true);
    }); return pool;
  } });
  const db = database;
  await check('hosted-preflight', () => db.withAdminTransaction(async tx => {
    const rows = (await tx.query<{ name: string; rls: boolean }>("SELECT c.relname AS name,c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='atlas' AND c.relname=ANY($1::text[]) AND c.relkind='r'", [tables])).rows;
    assert(rows.length === tables.length && rows.every(row => row.rls), 'audit-hosted-table-layout-differs');
    const fn = (await tx.query<{ source: string }>("SELECT p.prosrc AS source FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='atlas' AND p.proname='has_repository_access'")).rows[0];
    assert(fn?.source.includes("current_setting('atlas.authorized_repository_ids'"), 'audit-trusted-repository-policy-missing');
    assert(verifiedSockets.length > 0 && verifiedSockets.every(Boolean), 'audit-native-tls-not-verified');
    return { verifiedNativeTls: true, scopedTablesRlsEnabled: true, trustedRepositoryPolicyPresent: true };
  }));
  await check('isolated-complete-status-fixtures', () => db.withAdminTransaction(async tx => {
    await tx.query('INSERT INTO atlas.workspaces(id,name) VALUES($1,$2)', [workspaceId, `Atlas isolated lock audit ${auditId}`]);
    // Cleanup still reconciles these exact IDs if the COMMIT response is lost.
    created = true;
    await tx.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role) VALUES($1,$2,'owner')", [workspaceId, principalId]);
    await tx.query("INSERT INTO atlas.repositories(id,workspace_id,name,visibility) VALUES($1,$2,'synthetic-lock-audit-only','private')", [repositoryId, workspaceId]);
    await tx.query("INSERT INTO atlas.snapshots(id,workspace_id,repository_id,revision,status) VALUES($1,$2,$3,$4,'complete')", [snapshotId, workspaceId, repositoryId, createHash('sha1').update(`synthetic lock row ${auditId}`).digest('hex')]);
    await tx.query("INSERT INTO atlas.jobs(id,workspace_id,snapshot_id,principal_id,permission_revision,status) VALUES($1,$2,$3,$4,1,'complete')", [jobId, workspaceId, snapshotId, principalId]);
    return { jobsAlwaysComplete: true, eligibleForWorkerClaim: false, sourceRowsCreated: 0, graphRowsCreated: 0 };
  }));
  await check('repository-job-snapshot-concurrent-order', () => orderedContention(db, false));
  await check('reverse-order-negative-control', () => orderedContention(db, true));
  await check('repository-first-skip-locked', async () => {
    const held = signal<void>(); const finished = signal<void>(); const backendPids: number[] = [];
    const holder = db.withAdminTransaction(async tx => { backendPids.push(await pid(tx)); await repositoryLock(tx); held.resolve(); await handshake(finished.promise); });
    const contender = (async () => {
      await handshake(held.promise);
      return db.withAdminTransaction(async tx => {
        try { backendPids.push(await pid(tx)); const row = await tx.query('SELECT r.id FROM atlas.repositories r WHERE r.id=$1 AND r.workspace_id=$2 FOR UPDATE OF r SKIP LOCKED', [repositoryId, workspaceId]);
          assert(row.rows.length === 0, 'audit-skip-locked-selected-held-repository'); }
        finally { finished.resolve(); }
      });
    })();
    const results = await Promise.allSettled([holder, contender]);
    assert(results.every(result => result.status === 'fulfilled') && new Set(backendPids).size === 2, 'audit-skip-locked-race-failed');
    return { separateBackendPids: backendPids, lockedRepositorySkipped: true, noJobLockAcquired: true };
  });
  await check('fixture-status-and-scope-retained', async () => {
    const actual = await counts(db); const row = await db.withAdminTransaction(async tx => (await tx.query<{ job_status: string; snapshot_status: string }>('SELECT j.status AS job_status,s.status AS snapshot_status FROM atlas.jobs j JOIN atlas.snapshots s ON s.id=j.snapshot_id AND s.workspace_id=j.workspace_id WHERE j.id=$1 AND j.workspace_id=$2', [jobId, workspaceId])).rows[0]);
    assert(row?.job_status === 'complete' && row.snapshot_status === 'complete' && actual.jobs === 1 && actual.repositories === 1 && actual.snapshots === 1 && actual.source_files === 0 && actual.graphs === 0, 'audit-created-fixtures-changed');
    assert(verifiedSockets.every(Boolean), 'audit-later-native-tls-not-verified');
    return { jobStatus: 'complete', snapshotStatus: 'complete', allNativeSocketsVerified: true, scopedCounts: actual };
  });
} catch (error) {
  if (!checks.some(item => item.status === 'failed')) checks.push({ id: 'audit-execution', status: 'failed', code: safeCode(error) });
} finally {
  if (database && created) {
    try {
      await database.withAdminTransaction(async tx => { for (const table of tables) await tx.query(`DELETE FROM atlas.${table} WHERE ${table === 'workspaces' ? 'id' : 'workspace_id'}=$1`, [workspaceId]); });
      const remaining = await counts(database); assert(Object.values(remaining).every(value => value === 0), 'audit-cleanup-left-created-rows');
      cleanup = { status: 'passed', onlyGeneratedWorkspace: workspaceId, remainingRows: remaining };
    } catch (error) { cleanup = { status: 'failed', code: safeCode(error), workspaceId }; }
  }
  if (database) try { await database.close(); } catch (error) { checks.push({ id: 'pool-close', status: 'failed', code: safeCode(error) }); }
}
const report = { schemaVersion: 1, auditId, verifiedAt: new Date().toISOString(),
  status: checks.length > 0 && checks.every(item => item.status === 'passed') && cleanup.status === 'passed' ? 'passed' : 'failed',
  scope: 'Hosted native PostgreSQL row-lock contention on isolated complete-status database fixtures; no existing tenant or source reads', checks, cleanup,
  limitations: ['Synthetic database fixtures are not GitHub imports, actual Git commits, verified Clerk identities or source evidence.',
    'The contention probes exercise repository/job/snapshot SQL locking, not the full HTTP import workflow or every possible concurrent workload.',
    'The production service lock acquisition order is separately covered by its focused integration test SQL traces.',
    'No source, provider inference, purchase, payment broadcast, transaction ID or receipt was created.'] };
await writeFile('docs/evidence/hosted-import-locks.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2)); if (report.status !== 'passed') process.exitCode = 1;
