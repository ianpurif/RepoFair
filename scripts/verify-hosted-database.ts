import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { AtlasDatabaseError, createAtlasDatabase } from '../apps/worker/src/database.ts';
import type { AtlasDatabase, AtlasPool, AtlasTransaction } from '../apps/worker/src/database.ts';
import type { PoolConfig } from 'pg';

// Explicitly scoped hosted audit. No schema changes, existing tenant reads, chain
// calls, settlement receipts, or actual Clerk identities are used by this script.
const tables = ['workspaces', 'memberships', 'repositories', 'snapshots', 'source_files', 'graphs', 'jobs', 'budgets', 'purchases'] as const;
const auditId = randomUUID();
const workspaceIds = [randomUUID(), randomUUID()];
const repositoryIds = [randomUUID(), randomUUID()];
const snapshotIds = [randomUUID(), randomUUID()];
const principals = [`atlas-database-audit-${auditId}-a`, `atlas-database-audit-${auditId}-b`];
const expiry = new Date(Date.now() + 600_000).toISOString();
const network = 'audit-no-chain'; const asset = 'audit-integer-units';
const requestDigest = `sha-256=${createHash('sha256').update(`synthetic database audit ${auditId}`).digest('base64')}`;
type Check = Record<string, unknown> & { id: string; status: 'passed' | 'failed' };
const checks: Check[] = [];
function assert(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
function safeCode(error: unknown): string {
  if (error instanceof AtlasDatabaseError) return `database-${error.code}`;
  if (error instanceof Error && /^audit-[a-z0-9-]+$/.test(error.message)) return error.message;
  return 'audit-operation-failed';
}
async function check(id: string, work: () => Promise<Record<string, unknown>>): Promise<void> {
  try { checks.push({ id, status: 'passed', ...await work() }); }
  catch (error) { checks.push({ id, status: 'failed', code: safeCode(error) }); throw error; }
}
function whereColumn(table: typeof tables[number]): string { return table === 'workspaces' ? 'id' : 'workspace_id'; }
async function scopedCounts(transaction: AtlasTransaction): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of tables) result[table] = (await transaction.query<{ count: number }>(`SELECT count(*)::int AS count FROM atlas.${table} WHERE ${whereColumn(table)} = ANY($1::uuid[])`, [workspaceIds])).rows[0]?.count ?? -1;
  return result;
}
function bodyFromMigration(migration: string, name: string): string {
  const begin = migration.indexOf(`create or replace function atlas.${name}(`);
  const body = migration.indexOf('as $$', begin) + 5;
  const end = migration.indexOf('$$;', body);
  assert(begin >= 0 && body >= 5 && end > body, 'audit-migration-definition-missing');
  return migration.slice(body, end).replace(/\s+/g, ' ').trim();
}
async function expectDatabaseDenial(work: () => Promise<unknown>, expected: 'permission' | 'query'): Promise<void> {
  try { await work(); } catch (error) { if (error instanceof AtlasDatabaseError && error.code === expected) return; throw error; }
  throw new Error('audit-operation-was-not-denied');
}
async function reserve(database: AtlasDatabase, actor: 0 | 1, key: string, units: string, extra: Readonly<{ payee?: string; digest?: string | null }> = {}) {
  return database.withAdminTransaction(async transaction => {
    const backend = (await transaction.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    const result = await transaction.query<{ id: string }>(`SELECT atlas.reserve_purchase($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS id`, [
      workspaceIds[actor], principals[actor], key, extra.digest === undefined ? createHash('sha256').update(`terms ${auditId} ${key}`).digest('hex') : extra.digest,
      'audit-no-provider', network, asset, extra.payee ?? 'audit-no-recipient', requestDigest, 'audit-database-only', '1.0.0', expiry, units,
    ]);
    assert(result.rows[0]?.id, 'audit-reservation-result-missing');
    // Keep successful transactions open briefly so a separate backend must
    // contend for the same database row rather than a JavaScript helper lock.
    await transaction.query('SELECT pg_sleep(0.1)');
    return { id: result.rows[0].id, backend };
  });
}
async function budget(database: AtlasDatabase, actor: 0 | 1) {
  return database.withAdminTransaction(async transaction => {
    const row = (await transaction.query<{ allowance: string; reserved: string; spent: string; purchase_count: number; purchase_amount: string }>(`
      SELECT b.allowance::text, b.reserved::text, b.spent::text,
        (SELECT count(*)::int FROM atlas.purchases p WHERE p.workspace_id=b.workspace_id AND p.principal_id=b.principal_id) AS purchase_count,
        (SELECT coalesce(sum(amount),0)::text FROM atlas.purchases p WHERE p.workspace_id=b.workspace_id AND p.principal_id=b.principal_id) AS purchase_amount
      FROM atlas.budgets b WHERE b.workspace_id=$1 AND b.principal_id=$2 AND b.network=$3 AND b.token=$4`, [workspaceIds[actor], principals[actor], network, asset])).rows[0];
    assert(row, 'audit-budget-missing'); return row;
  });
}

let database: AtlasDatabase | undefined;
let preflightPassed = false; let cleanup: Record<string, unknown> = { status: 'not-needed', reason: 'Audit rows were not created' };
try {
  const env = { ...parseEnv(await readFile('.env.local', 'utf8')), ...process.env };
  const requireWorkerDependency = createRequire(new URL('../apps/worker/src/database.ts', import.meta.url));
  const { Pool } = requireWorkerDependency('pg') as { Pool: new (configuration: PoolConfig) => AtlasPool };
  const clientTls: boolean[] = [];
  database = await createAtlasDatabase(env, { poolFactory: configuration => {
    const pool = new Pool(configuration);
    pool.on('connect', (client: unknown) => {
      const stream = (client as { connection?: { stream?: { encrypted?: boolean; authorized?: boolean } } }).connection?.stream;
      clientTls.push(stream?.encrypted === true && stream.authorized === true);
    });
    return pool;
  } }); const db = database;
  const migration = await readFile('supabase/migrations/202610030001_atlas.sql', 'utf8');
  await check('schema-and-security-preflight', () => db.withAdminTransaction(async transaction => {
    const ssl = (await transaction.query<{ ssl: boolean }>('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]?.ssl;
    assert(clientTls.length > 0 && clientTls.every(verified => verified), 'audit-client-tls-not-verified');
    const rows = (await transaction.query<{ name: string; rls: boolean; authenticated_read: boolean; authenticated_write: boolean; anonymous_read: boolean; anonymous_write: boolean }>(`
      SELECT c.relname AS name, c.relrowsecurity AS rls,
        has_table_privilege('authenticated',c.oid,'SELECT') AS authenticated_read,
        (has_table_privilege('authenticated',c.oid,'INSERT') OR has_table_privilege('authenticated',c.oid,'UPDATE') OR has_table_privilege('authenticated',c.oid,'DELETE') OR has_table_privilege('authenticated',c.oid,'TRUNCATE')) AS authenticated_write,
        has_table_privilege('anon',c.oid,'SELECT') AS anonymous_read,
        (has_table_privilege('anon',c.oid,'INSERT') OR has_table_privilege('anon',c.oid,'UPDATE') OR has_table_privilege('anon',c.oid,'DELETE') OR has_table_privilege('anon',c.oid,'TRUNCATE')) AS anonymous_write
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='atlas' AND c.relkind='r' ORDER BY c.relname`)).rows;
    assert(rows.length === tables.length + 2 && ['personal_workspaces','webhook_deliveries'].every(name => rows.some(row => row.name === name)) && tables.every(table => rows.some(row => row.name === table)), 'audit-hosted-table-layout-differs');
    assert(rows.every(row => row.rls && (row.name === 'webhook_deliveries' ? !row.authenticated_read : row.authenticated_read) && !row.authenticated_write && !row.anonymous_read && !row.anonymous_write), 'audit-hosted-table-permissions-differ');
    const roles = (await transaction.query<{ name: string; bypass: boolean; superuser: boolean }>("SELECT rolname AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname IN ('authenticated','anon')")).rows;
    assert(roles.length === 2 && roles.every(role => !role.bypass && !role.superuser), 'audit-untrusted-role-bypasses-rls');
    const functions = (await transaction.query<{ name: string; source: string; security_definer: boolean; authenticated_execute: boolean; anonymous_execute: boolean; service_execute: boolean }>(`
      SELECT p.proname AS name, p.prosrc AS source, p.prosecdef AS security_definer,
        has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
        has_function_privilege('anon',p.oid,'EXECUTE') AS anonymous_execute,
        has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='atlas' AND p.proname IN ('has_access','reserve_purchase','reconcile_purchase')`)).rows;
    assert(functions.length === 3, 'audit-hosted-function-layout-differs');
    for (const fn of functions) {
      assert(fn.security_definer && fn.source.replace(/\s+/g, ' ').trim() === bodyFromMigration(migration, fn.name), 'audit-hosted-function-source-differs');
      assert(!fn.anonymous_execute, 'audit-anonymous-function-execution-allowed');
      if (fn.name === 'has_access') assert(fn.authenticated_execute, 'audit-access-function-privilege-missing');
      else assert(!fn.authenticated_execute && fn.service_execute, 'audit-payment-function-privileges-differ');
    }
    const units = (await transaction.query<{ table_name: string; column_name: string; precision: number; scale: number }>(`SELECT table_name,column_name,numeric_precision::int AS precision,numeric_scale::int AS scale FROM information_schema.columns WHERE table_schema='atlas' AND ((table_name='budgets' AND column_name IN ('allowance','reserved','spent')) OR (table_name='purchases' AND column_name='amount'))`)).rows;
    assert(units.length === 4 && units.every(column => column.precision === 78 && column.scale === 0), 'audit-token-units-not-integer');
    preflightPassed = true;
    return { tlsVerified: true, tlsEvidence: 'Native pg client socket encrypted=true and authorized=true; certificate verification remains enabled', poolerToDatabaseTlsReported: ssl ?? null, tables: rows.map(({ name, rls, authenticated_read, authenticated_write, anonymous_read, anonymous_write }) => ({ name, rls, authenticatedRead: authenticated_read, authenticatedWrite: authenticated_write, anonymousRead: anonymous_read, anonymousWrite: anonymous_write })), installedFunctionBodiesMatchMigration: true, integerUnits: true };
  }));
  await check('isolated-audit-setup', () => db.withAdminTransaction(async transaction => {
    for (const actor of [0, 1] as const) {
      await transaction.query('INSERT INTO atlas.workspaces(id,name) VALUES($1,$2)', [workspaceIds[actor], `Atlas isolated audit ${auditId} ${actor}`]);
      await transaction.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role) VALUES($1,$2,'owner')", [workspaceIds[actor], principals[actor]]);
      await transaction.query("INSERT INTO atlas.repositories(id,workspace_id,name,visibility) VALUES($1,$2,$3,'private')", [repositoryIds[actor], workspaceIds[actor], 'synthetic-database-audit-only']);
      await transaction.query("INSERT INTO atlas.snapshots(id,workspace_id,repository_id,revision,status) VALUES($1,$2,$3,$4,'complete')", [snapshotIds[actor], workspaceIds[actor], repositoryIds[actor], createHash('sha1').update(`synthetic database row ${auditId} ${actor}`).digest('hex')]);
      await transaction.query('INSERT INTO atlas.source_files(workspace_id,snapshot_id,path,content) VALUES($1,$2,$3,$4)', [workspaceIds[actor], snapshotIds[actor], 'audit.ts', '// Synthetic database policy audit. Never executed.\nexport const audit = 1;\n']);
      await transaction.query('INSERT INTO atlas.graphs(workspace_id,snapshot_id,graph) VALUES($1,$2,$3::jsonb)', [workspaceIds[actor], snapshotIds[actor], JSON.stringify({ mode: 'synthetic-database-audit', nodes: [], edges: [] })]);
      await transaction.query("INSERT INTO atlas.jobs(workspace_id,snapshot_id,principal_id,permission_revision,status) VALUES($1,$2,$3,1,'complete')", [workspaceIds[actor], snapshotIds[actor], principals[actor]]);
      await transaction.query('INSERT INTO atlas.budgets(workspace_id,principal_id,network,token,allowance) VALUES($1,$2,$3,$4,100)', [workspaceIds[actor], principals[actor], network, asset]);
    }
    return { workspacesCreated: 2, claims: 'Synthetic audit subjects; no actual Clerk JWT verification', sourceRows: 'Synthetic policy fixtures, not imported Git commits' };
  }));
  await check('direct-jwt-without-server-repository-proof-denied', async () => {
    const counts = await db.withPrincipalTransaction(principals[0]!, scopedCounts);
    assert(['repositories','snapshots','source_files','graphs','jobs'].every(table => counts[table] === 0), 'audit-direct-source-access-without-github-proof');
    return { sourceAndGraphDeniedWithoutServerProof: true };
  });
  await check('real-separate-connection-tenant-isolation', async () => {
    let arrived = 0; let release = () => {}; const barrier = new Promise<void>(resolve => { release = resolve; });
    const results = await Promise.all(([0, 1] as const).map(actor => db.withPrincipalTransaction(principals[actor]!, async transaction => {
      const pid = (await transaction.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (++arrived === 2) release(); await barrier;
      await transaction.query("SELECT set_config('atlas.authorized_repository_ids',$1,true)",[JSON.stringify(repositoryIds)]);
      const counts = await scopedCounts(transaction);
      assert(tables.every(table => counts[table] === (table === 'purchases' ? 0 : 1)), 'audit-tenant-row-isolation-failed');
      const source = await transaction.query<{ workspace_id: string }>('SELECT workspace_id FROM atlas.source_files WHERE workspace_id=ANY($1::uuid[])', [workspaceIds]);
      assert(source.rows.every(row => row.workspace_id === workspaceIds[actor]), 'audit-cross-tenant-source-visible');
      return { pid, counts };
    })));
    assert(results[0]?.pid !== undefined && results[1]?.pid !== undefined && results[0].pid !== results[1].pid, 'audit-distinct-backends-not-observed');
    return { simultaneouslyHeldDistinctBackends: 2, tenantA: results[0]?.counts, tenantB: results[1]?.counts, privateSourceAndGraphIsolation: true };
  });
  await check('anonymous-and-direct-mutation-denial', async () => {
    await expectDatabaseDenial(() => db.withAdminTransaction(async transaction => {
      await transaction.query('SET LOCAL ROLE anon');
      return transaction.query('SELECT id FROM atlas.workspaces WHERE id=ANY($1::uuid[])', [workspaceIds]);
    }), 'permission');
    await expectDatabaseDenial(() => db.withPrincipalTransaction(principals[0]!, transaction => transaction.query('UPDATE atlas.source_files SET content=$1 WHERE workspace_id=$2', ['forbidden audit change', workspaceIds[0]])), 'permission');
    await expectDatabaseDenial(() => db.withPrincipalTransaction(principals[0]!, transaction => transaction.query('SELECT atlas.reserve_purchase($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [workspaceIds[0], principals[0], 'untrusted', 'a'.repeat(64), 'audit', network, asset, 'audit', requestDigest, 'audit', '1.0.0', expiry, '1'])), 'permission');
    const emptyClaims = await db.withAdminTransaction(async transaction => {
      await transaction.query('SET LOCAL ROLE authenticated');
      return scopedCounts(transaction);
    });
    assert(Object.values(emptyClaims).every(count => count === 0), 'audit-empty-claims-see-private-data');
    return { anonymousReadDenied: true, authenticatedMutationDenied: true, clientBudgetReservationDenied: true, emptyClaimsSeeNoRows: true };
  });
  await check('concurrent-integer-budget-reservations', async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => reserve(db, 0, `parallel-${index}`, '25')));
    const successful = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof reserve>>> => result.status === 'fulfilled');
    const denied = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert(successful.length === 4 && denied.length === 8 && denied.every(result => result.reason instanceof AtlasDatabaseError && result.reason.code === 'query'), 'audit-concurrent-reservation-outcomes-differ');
    const backends = new Set(successful.map(result => result.value.backend)); assert(backends.size > 1, 'audit-budget-race-did-not-use-separate-backends');
    const current = await budget(db, 0);
    assert(current.allowance === '100' && current.reserved === '100' && current.spent === '0' && current.purchase_count === 4 && current.purchase_amount === '100', 'audit-budget-accounting-differs');
    assert(BigInt(current.reserved) + BigInt(current.spent) <= BigInt(current.allowance), 'audit-budget-overcommitted');
    return { attempts: 12, accepted: 4, rejected: 8, simultaneousUnitsPerRequest: '25', observedBackendCount: backends.size, ...current, realDatabaseRowLockRace: true };
  });
  await check('concurrent-idempotency-and-frozen-terms', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => reserve(db, 1, 'same-approved-terms', '40')));
    assert(new Set(results.map(result => result.id)).size === 1, 'audit-idempotent-purchase-duplicated');
    assert(new Set(results.map(result => result.backend)).size > 1, 'audit-idempotency-did-not-use-separate-backends');
    await expectDatabaseDenial(() => reserve(db, 1, 'same-approved-terms', '40', { payee: 'changed-audit-recipient' }), 'query');
    await expectDatabaseDenial(() => reserve(db, 1, 'same-approved-terms', '40', { digest: null }), 'query');
    await expectDatabaseDenial(() => reserve(db, 1, 'fractional-units', '1.5'), 'query');
    const current = await budget(db, 1);
    assert(current.reserved === '40' && current.spent === '0' && current.purchase_count === 1 && current.purchase_amount === '40', 'audit-idempotent-budget-charged-twice');
    return { concurrentCalls: 8, uniquePurchaseRows: 1, changedTermsRejected: true, nullReplayRejected: true, fractionalUnitsRejected: true, ...current };
  });
  await check('unknown-settlement-preserves-reservation', async () => {
    const purchase = await reserve(db, 0, 'parallel-0', '25').catch(async () => {
      // Scheduling can accept another key first; locate only this audit's own rows.
      return db.withAdminTransaction(async transaction => {
        const row = (await transaction.query<{ id: string; idempotency_key: string }>('SELECT id,idempotency_key FROM atlas.purchases WHERE workspace_id=$1 AND principal_id=$2 ORDER BY id LIMIT 1', [workspaceIds[0], principals[0]])).rows[0];
        assert(row, 'audit-purchase-missing'); return { id: row.id, key: row.idempotency_key };
      });
    });
    await db.withAdminTransaction(async transaction => { await transaction.query("SELECT atlas.reconcile_purchase($1,'pending')", [purchase.id]); await transaction.query("SELECT atlas.reconcile_purchase($1,'unknown')", [purchase.id]); });
    await expectDatabaseDenial(() => db.withAdminTransaction(transaction => transaction.query("SELECT atlas.reconcile_purchase($1,'pending')", [purchase.id])), 'query');
    const current = await budget(db, 0); assert(current.reserved === '100' && current.spent === '0', 'audit-unknown-payment-freed-reservation');
    const state = await db.withPrincipalTransaction(principals[0]!, transaction => transaction.query<{ payment_state: string; delivery_state: string; receipt: unknown }>('SELECT payment_state,delivery_state,receipt FROM atlas.purchases WHERE id=$1 AND workspace_id=$2', [purchase.id, workspaceIds[0]]));
    assert(state.rows[0]?.payment_state === 'unknown' && state.rows[0].delivery_state === 'awaiting-payment' && state.rows[0].receipt === null, 'audit-payment-delivery-state-not-separated');
    return { reservationRetained: true, invalidUnknownTransitionDenied: true, deliveryRemainsAwaitingPayment: true, receiptIsNull: true, chainBroadcasts: 0, ...current };
  });
  await check('membership-revocation-removes-all-private-visibility', async () => {
    await db.withAdminTransaction(transaction => transaction.query('DELETE FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2', [workspaceIds[0], principals[0]]));
    const counts = await db.withPrincipalTransaction(principals[0]!, async transaction => { await transaction.query("SELECT set_config('atlas.authorized_repository_ids',$1,true)",[JSON.stringify(repositoryIds)]); return scopedCounts(transaction); });
    assert(Object.values(counts).every(count => count === 0), 'audit-revoked-principal-keeps-private-access');
    await expectDatabaseDenial(() => reserve(db, 0, 'revoked-request', '1'), 'query');
    return { newRequestVisibilityRemoved: true, sourceAndGraphHidden: true, budgetAndPurchasesHidden: true, reservationAfterRevocationDenied: true, counts };
  });
} catch (error) {
  if (!checks.some(check => check.status === 'failed')) checks.push({ id: 'audit-execution', status: 'failed', code: safeCode(error) });
} finally {
  if (database && preflightPassed) {
    try {
      await database.withAdminTransaction(async transaction => {
        for (const table of ['purchases', 'budgets', 'jobs', 'source_files', 'graphs', 'snapshots', 'repositories', 'memberships', 'workspaces'] as const) {
          await transaction.query(`DELETE FROM atlas.${table} WHERE ${whereColumn(table)}=ANY($1::uuid[])`, [workspaceIds]);
        }
      });
      const remaining = await database.withAdminTransaction(scopedCounts);
      assert(Object.values(remaining).every(count => count === 0), 'audit-cleanup-left-created-rows');
      cleanup = { status: 'passed', target: 'Only the two UUID workspaces generated by this run', remainingRows: remaining };
    } catch (error) { cleanup = { status: 'failed', code: safeCode(error), workspaceIds }; }
  }
  if (database) try { await database.close(); } catch (error) { checks.push({ id: 'pool-close', status: 'failed', code: safeCode(error) }); }
}
const report = {
  schemaVersion: 1, verifiedAt: new Date().toISOString(), auditId,
  status: checks.every(check => check.status === 'passed') && cleanup.status === 'passed' ? 'passed' : 'failed',
  scope: 'Real hosted PostgreSQL TLS, isolated synthetic tenant RLS, native separate-backend concurrent reservations, idempotency, revocation and cleanup',
  checks, cleanup,
  limitations: [
    'Claims are synthetic subjects injected by the trusted native adapter; Clerk JWT signature verification, browser sign-in and Supabase third-party identity configuration are not established.',
    'Audit source/snapshot rows are synthetic database policy fixtures, not GitHub imports or real Git commits.',
    'No real provider purchase, Tempo broadcast, transaction ID, settlement receipt or AI inference was created.',
    'Current policy checks and row-lock races do not prove all future migrations or arbitrary workload behavior.',
  ],
};
await writeFile('docs/evidence/hosted-database.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
