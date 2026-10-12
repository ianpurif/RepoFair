import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { Store } from 'mppx';
import type { PoolConfig } from 'pg';
import { AtlasDatabaseError, createAtlasDatabase, loadDatabasePoolConfiguration } from '../apps/worker/src/database.ts';
import type { AtlasDatabase, AtlasPool, AtlasTransaction } from '../apps/worker/src/database.ts';
import { createPostgresReplayStore } from '../apps/provider/src/postgres-replay-store.ts';
import { ProviderLedgerError, createPostgresPurchaseLedger } from '../apps/provider/src/postgres-purchase-ledger.ts';
import type { AuthorizedRetrieval } from '../apps/provider/src/tempo-adapter.ts';
import type { PurchaseTerms } from '../packages/contracts/src/index.ts';
import { MODERATO_NETWORK, MODERATO_PATHUSD } from '../packages/contracts/src/commerce.ts';

// Hosted metadata reads and owned synthetic provider-storage rows only. No
// hosted DDL, existing tenant/source reads, signing, RPC, receipt or settlement.
// Run only after the dedicated provider configuration/migrations are ready:
// node --experimental-transform-types scripts/verify-publishing-infrastructure.ts --provider-env ABSOLUTE_PATH
const reportPath = 'docs/evidence/publishing-infrastructure.json';
const centralMigrations = ['202610030001_atlas.sql', '202610070001_personal_workspaces.sql',
  '202610070002_github_jobs.sql', '202610070003_server_repository_grants.sql', '202610070004_publication_drafts.sql',
  '202610110001_resumable_imports.sql', '202610110002_publication_commerce.sql'];
const providerMigrations = ['202610070005_provider_replay.sql', '202610070006_provider_ledger.sql', '202610110003_provider_delivery.sql'];
type MetadataRow = Record<string, string | number | boolean | null>;
type Catalog = Record<string, MetadataRow[]>;
type Detail = Record<string, string | number | boolean | null>;
type Check = { id: string; status: 'passed' | 'failed'; details?: Detail; code?: string };
class AuditFailure extends Error { constructor(readonly code: string) { super(code); } }
function assert(condition: unknown, code: string): asserts condition { if (!condition) throw new AuditFailure(code); }
function safeCode(error: unknown): string {
  if (error instanceof AuditFailure) return error.code;
  if (error instanceof AtlasDatabaseError) return `database-${error.code}`;
  if (error instanceof ProviderLedgerError) return `ledger-${error.code}`;
  return 'audit-operation-failed';
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function canonical(rows: MetadataRow[]): MetadataRow[] {
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value])));
}

async function catalog(tx: AtlasTransaction, schema: string): Promise<Catalog> {
  await tx.query('SET LOCAL search_path=pg_catalog');
  const queries = {
    tables: `SELECT c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,
      has_table_privilege('authenticated',c.oid,'SELECT') AS authenticated_read,
      (has_table_privilege('authenticated',c.oid,'INSERT') OR has_table_privilege('authenticated',c.oid,'UPDATE') OR
       has_table_privilege('authenticated',c.oid,'DELETE') OR has_table_privilege('authenticated',c.oid,'TRUNCATE')) AS authenticated_write,
      has_table_privilege('anon',c.oid,'SELECT') AS anonymous_read,
      (has_table_privilege('anon',c.oid,'INSERT') OR has_table_privilege('anon',c.oid,'UPDATE') OR
       has_table_privilege('anon',c.oid,'DELETE') OR has_table_privilege('anon',c.oid,'TRUNCATE')) AS anonymous_write
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname`,
    columns: `SELECT c.relname||'.'||a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
      pg_get_expr(d.adbin,d.adrelid) AS default_expression FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attname`,
    // PostgreSQL18 duplicates NOT NULL into pg_constraint; PostgreSQL17 does
    // not. Column attnotnull above verifies the same bound on both versions.
    constraints: `SELECT c.relname||'.'||k.conname AS name,k.contype::text AS kind,k.convalidated AS validated,
      pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND k.contype<>'n' ORDER BY c.relname,k.conname`,
    indexes: `SELECT c.relname||'.'||i.relname AS name,x.indisvalid AS valid,x.indisready AS ready,
      pg_get_indexdef(i.oid) AS definition FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid
      JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 ORDER BY c.relname,i.relname`,
    functions: `SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS name,l.lanname AS language,
      p.prosrc AS source,p.prosecdef AS security_definer,pg_get_function_result(p.oid) AS result_type,
      coalesce(array_to_string(p.proconfig,','),'') AS configuration,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anonymous_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
      WHERE n.nspname=$1 ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`,
    triggers: `SELECT c.relname||'.'||t.tgname AS name,t.tgenabled::text AS enabled,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
    policies: `SELECT c.relname||'.'||p.polname AS name,p.polcmd::text AS command,p.polpermissive AS permissive,
      coalesce((SELECT string_agg(r.rolname,',' ORDER BY r.rolname) FROM pg_roles r WHERE r.oid=ANY(p.polroles)),'PUBLIC') AS roles,
      pg_get_expr(p.polqual,p.polrelid) AS using_expression,pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
      FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 ORDER BY c.relname,p.polname`,
  };
  const result: Catalog = {};
  for (const [name, query] of Object.entries(queries)) result[name] = canonical((await tx.query<MetadataRow>(query, [schema])).rows);
  return result;
}

/** Offline expected metadata only; this never reads credentials or connects remotely. */
export async function prepareExpectedCatalogs(): Promise<{ central: Catalog; provider: Catalog }> {
  async function build(migrations: string[], schema: string) {
    const local = new PGlite();
    try {
      await local.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
        CREATE SCHEMA auth; CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
        GRANT USAGE ON SCHEMA auth TO authenticated; GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;`);
      for (const name of migrations) await local.exec(await readFile(`supabase/migrations/${name}`, 'utf8'));
      await local.exec('BEGIN');
      const tx = { query: async (text: string, values?: unknown[]) => {
        const result = await local.query(text, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, command: '', oid: 0, fields: [] };
      } } as AtlasTransaction;
      const result = await catalog(tx, schema); await local.exec('ROLLBACK'); return result;
    } finally { await local.close(); }
  }
  return { central: await build(centralMigrations, 'atlas'), provider: await build(providerMigrations, 'atlas_provider') };
}

async function readEnvironment(path: string): Promise<Record<string, string | undefined>> {
  const file = await stat(path); assert(file.isFile() && file.size > 0 && file.size <= 65_536, 'configuration-file-invalid');
  return parseEnv(await readFile(path, 'utf8'));
}
function backendRole(config: PoolConfig): string {
  const user = config.user ?? ''; const host = config.host ?? '';
  // Supabase session-pooler usernames append a tenant routing suffix, while
  // current_user is the actual PostgreSQL role. The suffix remains private.
  return host.endsWith('.pooler.supabase.com') && user.includes('.') ? user.slice(0, user.lastIndexOf('.')) : user;
}
type NativeDatabase = { db: AtlasDatabase; tls: boolean[]; pids: Set<number> };
async function nativeDatabase(env: Readonly<Record<string, string | undefined>>): Promise<NativeDatabase> {
  const requirePg = createRequire(new URL('../apps/worker/src/database.ts', import.meta.url));
  const { Pool } = requirePg('pg') as { Pool: new (config: PoolConfig) => AtlasPool };
  const tls: boolean[] = []; const pids = new Set<number>();
  const db = await createAtlasDatabase(env, { poolFactory: config => {
    const pool = new Pool({ ...config, max: 1, min: 0 });
    pool.on('connect', (client: unknown) => {
      const stream = (client as { connection?: { stream?: { encrypted?: boolean; authorized?: boolean } } }).connection?.stream;
      tls.push(stream?.encrypted === true && stream.authorized === true);
    });
    return pool;
  } });
  return { db, tls, pids };
}
async function identity(connection: NativeDatabase, config: PoolConfig) {
  return connection.db.withAdminTransaction(async tx => {
    await tx.query('SET TRANSACTION READ ONLY');
    const row = (await tx.query<{ database: string; role: string; session_role: string; pid: number; backend_ssl: boolean | null }>(`
      SELECT current_database() AS database,current_user AS role,session_user AS session_role,pg_backend_pid() AS pid,
        (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS backend_ssl`)).rows[0];
    assert(row && row.database === config.database && row.role === backendRole(config) && row.session_role === row.role,
      'database-or-login-target-mismatch');
    assert(connection.tls.length > 0 && connection.tls.every(Boolean), 'client-tls-not-verified');
    connection.pids.add(row.pid);
    return { configuredDatabaseMatched: true, configuredLoginMatched: true, sessionRoleMatched: true,
      clientTlsEncryptedAndAuthorized: true, backendHopTls: row.backend_ssl };
  });
}
async function compareCatalog(db: AtlasDatabase, expected: Catalog, schema: string): Promise<Detail> {
  return db.withAdminTransaction(async tx => {
    await tx.query('SET TRANSACTION READ ONLY'); const actual = await catalog(tx, schema);
    for (const name of Object.keys(expected)) assert(JSON.stringify(actual[name]) === JSON.stringify(expected[name]), `schema-${name}-mismatch`);
    const roles = (await tx.query<{ superuser: boolean; bypass: boolean }>(
      "SELECT rolsuper AS superuser,rolbypassrls AS bypass FROM pg_roles WHERE rolname IN ('anon','authenticated')")).rows;
    assert(roles.length === 2 && roles.every(role => !role.superuser && !role.bypass), 'untrusted-role-can-bypass-rls');
    return { tableCount: actual.tables!.length, columnCount: actual.columns!.length, constraintCount: actual.constraints!.length,
      functionCount: actual.functions!.length, triggerCount: actual.triggers!.length,
      expectedSignatureSha256: hash(JSON.stringify(expected)), observedSignatureSha256: hash(JSON.stringify(actual)),
      readOnlyTransaction: true, migrationsReplayedOnHostedDatabase: false, notNullVerifiedViaColumnMetadata: true,
      untrustedRolesCannotBypassRls: true };
  });
}

/** Read-only diagnostics return object names/changed fields, never SQL bodies or tenant data. */
export async function diagnoseCentralCatalog(): Promise<Record<string, unknown>> {
  const expected = (await prepareExpectedCatalogs()).central;
  const connection = await nativeDatabase(await readEnvironment(resolve('.env.local')));
  try {
    return await connection.db.withAdminTransaction(async tx => {
      await tx.query('SET TRANSACTION READ ONLY'); const actual = await catalog(tx, 'atlas');
      const differences: Record<string, unknown> = {};
      for (const name of Object.keys(expected)) {
        const wanted = new Map(expected[name]!.map(row => [row.name, row]));
        const observed = new Map(actual[name]!.map(row => [row.name, row]));
        const missing = [...wanted.keys()].filter(key => !observed.has(key));
        const additional = [...observed.keys()].filter(key => !wanted.has(key));
        const changed = [...wanted].filter(([key, row]) => observed.has(key) && JSON.stringify(row) !== JSON.stringify(observed.get(key)))
          .map(([key, row]) => ({ object: key, fields: Object.keys(row).filter(field => row[field] !== observed.get(key)![field]) }));
        if (missing.length || additional.length || changed.length) differences[name] = { missing, additional, changed };
      }
      return { scope: 'read-only-schema-metadata-diagnostics', differences };
    });
  } finally { await connection.db.close(); }
}

async function denied(work: () => Promise<unknown>, expected: 'permission' | 'query' | 'mismatch' | 'denied') {
  try { await work(); } catch (error) {
    if (error instanceof AtlasDatabaseError && error.code === expected || error instanceof ProviderLedgerError && error.code === expected) return;
    throw error;
  }
  throw new AuditFailure('expected-denial-did-not-occur');
}

// Hold exactly the production advisory key, launch real competing operations,
// observe another backend waiting in pg_stat_activity, then release and await
// EVERY attempt before cleanup. No elapsed-time inference substitutes for a lock.
async function contended<T>(first: NativeDatabase, second: NativeDatabase, observer: NativeDatabase, lock: string, work: Array<() => Promise<T>>) {
  let release = () => {}; const released = new Promise<void>(complete => { release = complete; });
  let ready = () => {}; let rejectReady = (_error: unknown) => {};
  const acquired = new Promise<void>((complete, reject) => { ready = complete; rejectReady = reject; });
  const holder = first.db.withAdminTransaction(async tx => { await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [lock]); ready(); await released; });
  holder.catch(rejectReady);
  const attempts: Promise<T>[] = []; let observed = false; let operationFailure: unknown;
  let settled: PromiseSettledResult<unknown>[];
  try {
    await acquired;
    for (const start of work) { const attempt = start(); attempt.catch(() => {}); attempts.push(attempt); }
    for (let poll = 0; poll < 20; poll++) {
      const waiting = await observer.db.withAdminTransaction(async tx => (await tx.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user
          AND pid=ANY($1::int[]) AND wait_event_type='Lock' AND wait_event='advisory'`, [[...second.pids]])).rows[0]?.count ?? 0);
      if (waiting > 0) { observed = true; break; }
      await new Promise<void>(complete => setTimeout(complete, 25));
    }
  } catch (error) { operationFailure = error; }
  finally { release(); settled = await Promise.allSettled([holder, ...attempts]); }
  if (operationFailure !== undefined) throw operationFailure;
  const failed = settled.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  assert(observed, 'separate-backend-advisory-wait-not-observed');
  return Promise.all(attempts);
}

export async function main(): Promise<void> {
  const checks: Check[] = [];
  async function check(id: string, work: () => Promise<Detail>): Promise<void> {
    try { checks.push({ id, status: 'passed', details: await work() }); }
    catch (error) { checks.push({ id, status: 'failed', code: safeCode(error) }); throw error; }
  }
  const audit = randomUUID(); const providerId = `audit-${audit}`; const namespace = `publishing-audit-${audit}`;
  const isolatedNamespace = `${namespace}-isolated`;
  const authorization: AuthorizedRetrieval = { principalId: `audit-${audit}`, permissionRevision: 'synthetic-audit-1',
    input: { packageName: '@atlas/infrastructure-audit', version: '1.0.0', question: 'Verify independent provider storage concurrency.', idempotencyKey: audit } };
  const terms: PurchaseTerms = { providerId, operation: 'context.retrieve', requestDigest: `sha-256=${createHash('sha256').update(audit).digest('base64')}`,
    packageName: authorization.input.packageName, version: authorization.input.version, network: MODERATO_NETWORK,
    token: MODERATO_PATHUSD, recipient: '0x' + '2'.repeat(40), atomicAmount: '1', expiresAtMs: Date.now() + 240_000 };
  const connections: NativeDatabase[] = []; let first: NativeDatabase | undefined; let second: NativeDatabase | undefined;
  let mayHaveWritten = false; let cleanup: Detail = { status: 'not-needed', ownedRowsRemaining: 0 };
  let failure: string | null = null;
  try {
    const args = process.argv.slice(2);
    assert(args.length === 2 && args[0] === '--provider-env' && typeof args[1] === 'string' && isAbsolute(args[1]), 'provider-env-absolute-path-required');
    const centralEnv = await readEnvironment(resolve('.env.local')); const providerFile = await readEnvironment(args[1]);
    assert(providerFile.ATLAS_PROVIDER_DATABASE_URL, 'provider-database-configuration-missing');
    assert(!providerFile.DATABASE_URL && !providerFile.CLERK_SECRET_KEY && !providerFile.SUPABASE_SERVICE_ROLE_KEY,
      'provider-configuration-includes-buyer-credentials');
    const providerEnv = { DATABASE_URL: providerFile.ATLAS_PROVIDER_DATABASE_URL,
      DATABASE_SSL_CA_FILE: providerFile.ATLAS_PROVIDER_DATABASE_SSL_CA_FILE };
    const centralConfig = await loadDatabasePoolConfiguration(centralEnv); const providerConfig = await loadDatabasePoolConfiguration(providerEnv);
    assert(centralConfig.database !== providerConfig.database && backendRole(centralConfig) !== backendRole(providerConfig), 'provider-database-or-login-not-independent');
    const expected = await prepareExpectedCatalogs();
    const central = await nativeDatabase(centralEnv); connections.push(central);
    await check('central-target-and-verified-client-tls', () => identity(central, centralConfig));
    await check('central-current-001-002-signatures-and-readonly-role-permissions', () => compareCatalog(central.db, expected.central, 'atlas'));
    first = await nativeDatabase(providerEnv); connections.push(first);
    second = await nativeDatabase(providerEnv); connections.push(second);
    const observer = await nativeDatabase(providerEnv); connections.push(observer);
    const providerFirst = first; const providerSecond = second;
    await check('provider-separate-target-login-tls-and-backends', async () => {
      const identities = await Promise.all([first!, second!, observer].map(connection => identity(connection, providerConfig)));
      assert([...providerFirst.pids][0] !== [...providerSecond.pids][0], 'provider-backends-not-distinct');
      return { independentDatabase: true, independentLogin: true, distinctContenderBackends: 2, observerBackend: true,
        clientTlsEncryptedAndAuthorized: identities.every(result => result.clientTlsEncryptedAndAuthorized),
        configuredDatabaseMatched: identities.every(result => result.configuredDatabaseMatched),
        configuredLoginMatched: identities.every(result => result.configuredLoginMatched) };
    });
    await check('provider-current-005-006-003-schema-signatures-and-rls', () => compareCatalog(providerFirst.db, expected.provider, 'atlas_provider'));
    await check('provider-owner-privileges-and-restricted-login', () => providerFirst.db.withAdminTransaction(async tx => {
      await tx.query('SET TRANSACTION READ ONLY');
      const role = (await tx.query<MetadataRow>(`SELECT rolcanlogin AS login,rolsuper AS superuser,rolbypassrls AS bypass_rls,
        rolcreatedb AS create_database,rolcreaterole AS create_role,rolreplication AS replication,rolinherit AS inherit_roles,
        pg_has_role(current_user,'service_role','MEMBER') AS service_member,
        pg_has_role(current_user,'authenticated','MEMBER') AS authenticated_member FROM pg_roles WHERE rolname=current_user`)).rows[0];
      assert(role?.login === true && ['superuser','bypass_rls','create_database','create_role','replication','inherit_roles','service_member','authenticated_member'].every(name => role[name] === false), 'provider-login-overprivileged');
      const owners = (await tx.query<{ owned: boolean; can_read: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }>(`
        SELECT pg_get_userbyid(c.relowner)=current_user AS owned,has_table_privilege(current_user,c.oid,'SELECT') AS can_read,
          has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,has_table_privilege(current_user,c.oid,'UPDATE') AS can_update,
          has_table_privilege(current_user,c.oid,'DELETE') AS can_delete FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='atlas_provider' AND c.relkind='r'`)).rows;
      assert(owners.length === 5 && owners.every(row => Object.values(row).every(value => value === true)), 'provider-login-not-table-owner');
      assert((await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_namespace WHERE nspname='atlas'")).rows[0]?.count === 0, 'provider-database-contains-buyer-schema');
      return { loginEnabled: true, noSuperuserOrBypassRls: true, noCreateDatabaseOrRoleOrReplication: true,
        noInheritedRolePrivileges: true, noServiceRoleOrAuthenticatedMembership: true,
        providerTablesOwnedWithReadWritePrivileges: 5, buyerSchemaAbsent: true };
    }));
    await check('provider-credentials-denied-central-atlas-table-access', async () => {
      const retargeted = new URL(centralEnv.DATABASE_URL!); const providerUrl = new URL(providerFile.ATLAS_PROVIDER_DATABASE_URL!);
      retargeted.username = providerUrl.username; retargeted.password = providerUrl.password;
      const crossEnv = { DATABASE_URL: retargeted.toString(), DATABASE_SSL_CA_FILE: centralEnv.DATABASE_SSL_CA_FILE };
      const cross = await nativeDatabase(crossEnv); connections.push(cross);
      await identity(cross, await loadDatabasePoolConfiguration(crossEnv));
      await denied(() => cross.db.withAdminTransaction(async tx => {
        await tx.query('SET TRANSACTION READ ONLY'); await tx.query('SELECT 1 FROM atlas.workspaces LIMIT 0');
      }), 'permission');
      return { providerLoginAuthenticatedToCentralTarget: true, atlasTableReadDenied: true, existingTenantRowsRead: 0 };
    });
    const stores = [createPostgresReplayStore(providerFirst.db, namespace), createPostgresReplayStore(providerSecond.db, namespace)];
    const isolated = createPostgresReplayStore(observer.db, isolatedNamespace);
    let authorized = true;
    const options = { providerId, now: Date.now, reauthorize: async (input: { authorization: AuthorizedRetrieval }) => {
      assert(authorized, 'synthetic-authorization-revoked'); return input.authorization;
    }, verifySettlement: async () => false };
    const ledgers = [createPostgresPurchaseLedger(providerFirst.db, options), createPostgresPurchaseLedger(providerSecond.db, options)];
    const scopedCounts = (db: AtlasDatabase) => db.withAdminTransaction(async tx => (await tx.query<{ sales: number; replay: number }>(`
      SELECT (SELECT count(*)::int FROM atlas_provider.sales WHERE provider_id=$1) AS sales,
        (SELECT count(*)::int FROM atlas_provider.replay WHERE namespace=ANY($2::text[])) AS replay`,
      [providerId, [namespace, isolatedNamespace]])).rows[0]!);
    await check('synthetic-audit-identities-are-unused', async () => {
      const counts = await scopedCounts(providerFirst.db); assert(counts.sales === 0 && counts.replay === 0, 'owned-audit-identity-collision');
      return { ownedSaleRowsBefore: 0, ownedReplayRowsBefore: 0 };
    });
    mayHaveWritten = true;
    await check('real-backend-replay-contention-single-winner', async () => {
      const key = 'shared-synthetic-credential'; const digest = hash(key);
      const lock = createHash('sha256').update(JSON.stringify(['atlas-provider-replay', namespace, digest])).digest().readBigInt64BE().toString();
      const claims = await contended(providerFirst, providerSecond, observer, lock,
        Array.from({ length: 8 }, (_, index) => async () => Store.tryClaim(stores[index % 2]!, key, Date.now() + 60_000)));
      assert(claims.filter(Boolean).length === 1, 'replay-more-than-one-winner');
      return { attempts: 8, winners: 1, advisoryWaitObservedOnSeparateBackend: true };
    });
    await check('real-backend-atomic-replay-updates-isolation-and-rollback', async () => {
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => stores[index % 2]!.update('counter', value => ({ op: 'set', value: Number(value ?? 0) + 1, result: undefined }))));
      assert(results.every(result => result.status === 'fulfilled') && await stores[0]!.get('counter') === 8, 'replay-lost-update');
      assert(await isolated.get('counter') === null, 'replay-namespace-leak');
      let rejected = false; try { await stores[0]!.update('counter', () => { throw new AuditFailure('synthetic-callback-rejected'); }); }
      catch (error) { assert(error instanceof AuditFailure && error.code === 'synthetic-callback-rejected', 'unexpected-replay-callback-failure'); rejected = true; }
      assert(rejected && await stores[1]!.get('counter') === 8, 'replay-callback-not-rolled-back');
      return { concurrentUpdates: 8, savedCounter: 8, namespaceIsolated: true, rejectedCallbackRolledBack: true };
    });
    await check('real-backend-immutable-quotes-and-single-sale-claim', async () => {
      const quotes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => ledgers[index % 2]!.quote(authorization, terms)));
      assert(quotes.every(result => result.status === 'fulfilled' && JSON.stringify(result.value) === JSON.stringify(terms)), 'quotes-not-identical');
      const later = await ledgers[1]!.quote(authorization, { ...terms, expiresAtMs: terms.expiresAtMs + 1000 });
      assert(later.expiresAtMs === terms.expiresAtMs, 'frozen-quote-expiry-extended');
      const lock = createHash('sha256').update(JSON.stringify(['atlas-provider-sale', providerId, authorization.principalId, authorization.input.idempotencyKey])).digest().readBigInt64BE().toString();
      const claims = await contended(providerFirst, providerSecond, observer, lock,
        Array.from({ length: 8 }, (_, index) => () => ledgers[index % 2]!.claim(authorization, terms)));
      assert(claims.filter(result => result.state === 'claimed').length === 1 && claims.filter(result => result.state === 'pending').length === 7, 'sale-more-than-one-claim-winner');
      return { concurrentQuotes: 8, saleRows: 1, originalExpiryFrozen: true, claimAttempts: 8, winners: 1,
        pendingContenders: 7, advisoryWaitObservedOnSeparateBackend: true };
    });
    await check('unknown-sale-cannot-reclaim-reopen-or-substitute-terms', async () => {
      await ledgers[0]!.markUnknown(authorization, terms);
      const claims = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => ledgers[index % 2]!.claim(authorization, terms)));
      assert(claims.every(result => result.status === 'fulfilled' && result.value.state === 'unknown'), 'unknown-sale-reclaimed');
      await denied(() => ledgers[1]!.quote(authorization, { ...terms, atomicAmount: '2' }), 'mismatch');
      for (const state of ['quoted', 'pending']) await denied(() => providerFirst.db.withAdminTransaction(async tx => {
        await tx.query(`UPDATE atlas_provider.sales SET state=$4,claimed_at=CASE WHEN $4='quoted' THEN NULL ELSE claimed_at END
          WHERE provider_id=$1 AND principal_id=$2 AND idempotency_key=$3`, [providerId, authorization.principalId, authorization.input.idempotencyKey, state]);
      }), 'query');
      const saved = await ledgers[1]!.lookup(authorization, terms.requestDigest);
      const counts = await scopedCounts(providerFirst.db);
      assert(saved?.state === 'unknown' && !('receipt' in saved) && counts.sales === 1, 'unknown-sale-not-retained');
      authorized = false; await denied(() => ledgers[0]!.lookup(authorization, terms.requestDigest), 'denied');
      return { repeatedClaimAttempts: 8, allRemainUnknown: true, sqlReopenAttemptsDenied: 2,
        alteredIdempotentTermsDenied: true, immutableSaleRows: 1, receiptPresent: false, injectedRevocationDeniedRead: true };
    });
  } catch (error) { failure = safeCode(error); }
  finally {
    if (mayHaveWritten && first) {
      cleanup = { status: 'failed', ownedRowsRemaining: null };
      // All concurrent groups have settled before reaching here. Retry cleanup
      // once through the second native connection if the first connection fails.
      for (const connection of [first, second].filter((item): item is NativeDatabase => !!item)) {
        try {
          cleanup = await connection.db.withAdminTransaction(async tx => {
            await tx.query('DELETE FROM atlas_provider.replay WHERE namespace=ANY($1::text[])', [[namespace, isolatedNamespace]]);
            await tx.query('DELETE FROM atlas_provider.sales WHERE provider_id=$1', [providerId]);
            const row = (await tx.query<{ count: number }>(`SELECT
              (SELECT count(*)::int FROM atlas_provider.sales WHERE provider_id=$1)+
              (SELECT count(*)::int FROM atlas_provider.replay WHERE namespace=ANY($2::text[])) AS count`,
            [providerId, [namespace, isolatedNamespace]])).rows[0];
            assert(row?.count === 0, 'owned-record-cleanup-incomplete'); return { status: 'verified', ownedRowsRemaining: 0 };
          });
          break;
        } catch { /* A second bounded cleanup attempt is mandatory. */ }
      }
      if (cleanup.status !== 'verified') failure ??= 'owned-record-cleanup-failed';
    }
    const closures = await Promise.allSettled(connections.map(connection => connection.db.close()));
    if (closures.some(result => result.status === 'rejected')) failure ??= 'database-close-failed';
  }
  const report = {
    schemaVersion: 1, checkedAt: new Date().toISOString(), status: failure ? 'failed' : 'verified',
    scope: 'Native hosted PostgreSQL infrastructure and real backend storage contention using synthetic authorization and audit rows; no real publication or payment.',
    requestedModel: 'gpt-6.1-sol', requestedReasoningEffort: 'max', observedModel: null, observedReasoningEffort: null,
    checks, failure, cleanup, hostedSchemaMutations: false, existingRecordMutations: false, existingTenantSourceReads: 0,
    syntheticAuthorization: true, signingPerformed: false, fundingPerformed: false, paymentSubmitted: false,
    receiptCreated: false, settlementVerified: false, privateSourceExported: false, liveEntitlementVerified: false,
    clientToServerTlsScope: 'Encrypted and certificate/hostname-authorized native pg client connection. Pooler internal TLS is a separate observation, not inferred.',
    reproduction: 'node --experimental-transform-types scripts/verify-publishing-infrastructure.ts --provider-env ABSOLUTE_PATH',
    notRun: ['Real Clerk/GitHub entitlement or owner activation.', 'Signed artifact installation, external deployment and provider reachability.',
      'Wallet authorization, chain funding, MPP payment, receipt, settlement or paid source delivery.'],
    references: ['https://node-postgres.com/features/ssl', 'https://www.postgresql.org/docs/current/explicit-locking.html',
      'https://www.postgresql.org/docs/current/ddl-rowsecurity.html', 'https://www.postgresql.org/docs/current/functions-info.html',
      'https://www.postgresql.org/docs/18/catalog-pg-constraint.html', 'https://www.postgresql.org/docs/17/catalog-pg-constraint.html'],
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
  if (failure) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
