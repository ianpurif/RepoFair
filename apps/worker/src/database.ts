import { X509Certificate } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { Pool } from 'pg';
import type { PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';

/** Server-only PostgreSQL boundary. Never return or log driver errors, DSNs or credentials. */
export class AtlasDatabaseError extends Error {
  constructor(public readonly code: 'configuration' | 'connection' | 'permission' | 'timeout' | 'query' | 'commit_unknown' | 'closed', message: string) {
    super(message); this.name = 'AtlasDatabaseError';
  }
}
function configuration(message: string): never { throw new AtlasDatabaseError('configuration', message); }
/** Accept only complete certificate PEMs; OpenSSL alone ignores surrounding/trailing bytes. */
function certificateAuthorityPem(source: string): string {
  if (Buffer.byteLength(source) > 1_000_000) throw new Error();
  const pem = source.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  const certificates = [...pem.matchAll(/-----BEGIN CERTIFICATE-----\n([A-Za-z0-9+/= \t\n]+)\n-----END CERTIFICATE-----/g)];
  if (!certificates.length || certificates.length > 64) throw new Error();
  let position = 0;
  for (const certificate of certificates) {
    if (pem.slice(position, certificate.index).trim()) throw new Error();
    const encoded = certificate[1]!.replace(/[ \t\n]/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new Error();
    const der = Buffer.from(encoded, 'base64');
    if (der.toString('base64') !== encoded || !new X509Certificate(der).raw.equals(der)) throw new Error();
    position = certificate.index + certificate[0].length;
  }
  if (pem.slice(position).trim()) throw new Error();
  return pem;
}
function sanitize(error: unknown, phase: 'connection' | 'query' = 'query'): AtlasDatabaseError {
  if (error instanceof AtlasDatabaseError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['42501', '28P01', '28000'].includes(code)) return new AtlasDatabaseError('permission', 'Database authorization failed');
  if (['57014', '55P03', 'ETIMEDOUT'].includes(code)) return new AtlasDatabaseError('timeout', 'Database operation timed out');
  if (phase === 'connection' || /^(?:08|57P0)/.test(code) || ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED'].includes(code)) {
    return new AtlasDatabaseError('connection', 'Database connection or certificate verification failed');
  }
  return new AtlasDatabaseError('query', 'Database operation failed');
}

/** Structured connection fields prevent pg URL SSL options from replacing verified TLS. */
export async function loadDatabasePoolConfiguration(env: Readonly<Record<string, string | undefined>>): Promise<PoolConfig> {
  const source = env.DATABASE_URL?.trim();
  if (!source || source.length > 8192) return configuration('DATABASE_URL is unavailable or invalid');
  let url: URL;
  try { url = new URL(source); } catch { return configuration('DATABASE_URL must be a PostgreSQL connection URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash || !url.username || !url.password || url.pathname === '/' || !url.pathname) {
    return configuration('DATABASE_URL must include a PostgreSQL host, database, user and password');
  }
  for (const [key, value] of url.searchParams) {
    if (key !== 'sslmode' || !['require', 'verify-ca', 'verify-full'].includes(value) || url.searchParams.getAll(key).length !== 1) {
      return configuration('DATABASE_URL contains unsupported options; TLS certificate verification cannot be disabled');
    }
  }
  let user: string; let password: string; let database: string;
  try { user = decodeURIComponent(url.username); password = decodeURIComponent(url.password); database = decodeURIComponent(url.pathname.slice(1)); }
  catch { return configuration('DATABASE_URL has invalid percent encoding'); }
  if (!user || !password || !database || database.includes('/') || database.length > 128 || user.length > 256 || password.length > 4096 || [user, password, database].some(value => value.includes('\0'))) {
    return configuration('DATABASE_URL contains invalid connection fields');
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return configuration('DATABASE_URL has an invalid port');
  const ssl: { rejectUnauthorized: true; ca?: string } = { rejectUnauthorized: true };
  const fileValue = env.DATABASE_SSL_CA_FILE; const inlineValue = env.DATABASE_SSL_CA;
  if ((fileValue !== undefined && typeof fileValue !== 'string') || (inlineValue !== undefined && typeof inlineValue !== 'string')) {
    return configuration('Database CA configuration must use a certificate PEM string or file path');
  }
  const caFile = fileValue?.trim(); const inlineCa = inlineValue?.trim();
  if (caFile && inlineCa) return configuration('Configure exactly one of DATABASE_SSL_CA or DATABASE_SSL_CA_FILE');
  if (caFile || inlineCa) {
    let ca: string;
    try {
      if (caFile) {
        if (caFile.length > 8192) throw new Error();
        const file = await stat(caFile);
        if (!file.isFile() || file.size < 1 || file.size > 1_000_000) throw new Error();
        ca = certificateAuthorityPem(await readFile(caFile, 'utf8'));
      } else ca = certificateAuthorityPem(inlineValue!);
    } catch { return configuration('Database CA must be a valid certificate PEM string or accessible certificate PEM file'); }
    ssl.ca = ca;
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''), port, user, password, database,
    ssl, enableChannelBinding: true, application_name: 'repofair',
    max: 5, min: 0, maxLifetimeSeconds: 300, maxUses: 100,
    connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000, query_timeout: 15_000,
    allowExitOnIdle: true,
  };
}

export type AtlasTransaction = Readonly<{
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}>;
export type AtlasPool = Pick<Pool, 'connect' | 'end' | 'on'>;
export type AtlasPoolFactory = (configuration: PoolConfig) => AtlasPool;

export class AtlasDatabase {
  private closed = false;
  /** Sanitized idle-pool health only; callers never receive the driver error. */
  private idleFailure: AtlasDatabaseError | null = null;
  constructor(private readonly pool: AtlasPool) {
    this.pool.on('error', (error: unknown) => { this.idleFailure = sanitize(error, 'connection'); });
  }
  get lastIdleError(): AtlasDatabaseError | null { return this.idleFailure; }
  private async transaction<T>(principalId: string | null, callback: (transaction: AtlasTransaction) => Promise<T>): Promise<T> {
    if (this.closed) throw new AtlasDatabaseError('closed', 'Database pool is closed');
    let client: PoolClient;
    try { client = await this.pool.connect(); } catch (error) { throw sanitize(error, 'connection'); }
    let began = false; let active = true; let discard = false; let committing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectConnection: (error: AtlasDatabaseError) => void = () => {};
    const connectionFailure = new Promise<never>((_resolve, reject) => { rejectConnection = reject; });
    const onConnectionError = (error: unknown): void => { discard = true; rejectConnection(sanitize(error, 'connection')); };
    client.on('error', onConnectionError);
    const execute = async <Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>> => {
      if (!active) throw new AtlasDatabaseError('closed', 'Database transaction is no longer active');
      if (typeof text !== 'string' || !text.trim() || text.length > 200_000 || (values !== undefined && (!Array.isArray(values) || values.length > 10_000))) {
        throw new AtlasDatabaseError('query', 'Invalid database query');
      }
      try { return await client.query<Row>(text, values); } catch (error) { throw sanitize(error); }
    };
    const run = async (): Promise<T> => {
      await execute('BEGIN'); began = true;
      await execute("SET LOCAL statement_timeout = '10000ms'");
      await execute("SET LOCAL lock_timeout = '3000ms'");
      await execute("SET LOCAL idle_in_transaction_session_timeout = '15000ms'");
      await execute("SELECT set_config('atlas.authorized_repository_ids', '[]', true)");
      if (principalId !== null) {
        await execute('SET LOCAL ROLE authenticated');
        await execute("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: principalId, role: 'authenticated' })]);
      } else {
        await execute('SET LOCAL ROLE NONE');
        await execute("SELECT set_config('request.jwt.claims', '{}', true)");
      }
      const result = await callback(Object.freeze({ query: execute }));
      committing = true;
      await execute('COMMIT'); began = false; active = false; this.idleFailure = null;
      return result;
    };
    try {
      const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new AtlasDatabaseError('timeout', 'Database transaction exceeded its time limit')), 30_000); });
      return await Promise.race([run(), deadline, connectionFailure]);
    } catch (error) {
      active = false;
      if (began) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
      } else { discard = true; }
      // A lost COMMIT response cannot safely be interpreted as an uncommitted purchase.
      if (committing) { discard = true; throw new AtlasDatabaseError('commit_unknown', 'Database commit outcome is unknown; reconcile before retrying'); }
      throw error;
    } finally {
      active = false; if (timer !== undefined) clearTimeout(timer);
      client.removeListener('error', onConnectionError); client.release(discard);
    }
  }
  /** principalId must originate from a verified server session, never request JSON. */
  withPrincipalTransaction<T>(principalId: string, callback: (transaction: AtlasTransaction) => Promise<T>): Promise<T> {
    // eslint-disable-next-line no-control-regex -- principal claims must not contain control characters
    if (typeof principalId !== 'string' || !principalId.trim() || principalId.length > 256 || /[\x00-\x1f\x7f]/.test(principalId)) {
      return Promise.reject(new AtlasDatabaseError('permission', 'A verified principal is required for this database operation'));
    }
    return this.transaction(principalId, callback);
  }
  /** Trusted server provisioning/migration only. Never expose this method to untrusted callers. */
  withAdminTransaction<T>(callback: (transaction: AtlasTransaction) => Promise<T>): Promise<T> { return this.transaction(null, callback); }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    try { await this.pool.end(); } catch (error) { throw sanitize(error, 'connection'); }
  }
}

export async function createAtlasDatabase(env: Readonly<Record<string, string | undefined>>, options: Readonly<{ poolFactory?: AtlasPoolFactory }> = {}): Promise<AtlasDatabase> {
  const config = await loadDatabasePoolConfiguration(env);
  try { return new AtlasDatabase(options.poolFactory ? options.poolFactory(config) : new Pool(config)); }
  catch (error) { throw sanitize(error, 'connection'); }
}
