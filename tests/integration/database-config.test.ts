import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { describe, expect, it, vi } from 'vitest';
import { AtlasDatabaseError, createAtlasDatabase, loadDatabasePoolConfiguration } from '../../apps/worker/src/database.ts';
import type { AtlasPool, AtlasTransaction } from '../../apps/worker/src/database.ts';

// Resolve the exact driver declared by the worker instead of a phantom root dependency.
const { Pool } = createRequire(new URL('../../apps/worker/src/database.ts', import.meta.url))('pg') as typeof import('pg');

const env = { DATABASE_URL: 'postgresql://test-user:test-only-password@db.example.com:6543/postgres?sslmode=require' };
function poolHarness(fail?: (sql: string) => unknown) {
  const clients: (EventEmitter & { queries: { text: string; values: unknown[] | undefined }[]; query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> })[] = [];
  const events = new EventEmitter();
  const connect = vi.fn(async () => {
    const client = Object.assign(new EventEmitter(), { queries: [] as { text: string; values: unknown[] | undefined }[], query: vi.fn(), release: vi.fn() });
    client.query.mockImplementation(async (text: string, values?: unknown[]) => {
      client.queries.push({ text, values }); const error = fail?.(text); if (error) throw error;
      return { rows: [{ value: 1 }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
    });
    clients.push(client); return client;
  });
  const pool = Object.assign(events, { connect, end: vi.fn(async () => {}) });
  return { pool: pool as unknown as AtlasPool, clients, connect, end: pool.end, events };
}
describe('verified database connection configuration', () => {
  it('uses explicit verified TLS and bounded pool/operation timeouts without a connection string', async () => {
    const config = await loadDatabasePoolConfiguration(env);
    expect(config).toMatchObject({ host: 'db.example.com', port: 6543, user: 'test-user', password: 'test-only-password', database: 'postgres', ssl: { rejectUnauthorized: true }, max: 5,
      connectionTimeoutMillis: 10000, query_timeout: 15000, idleTimeoutMillis: 10000, enableChannelBinding: true });
    expect(config.connectionString).toBeUndefined();
    for (const mode of ['require', 'verify-ca', 'verify-full']) expect((await loadDatabasePoolConfiguration({ DATABASE_URL: env.DATABASE_URL.replace('require', mode) })).ssl).toEqual({ rejectUnauthorized: true });
  });
  it('rejects TLS weakening, driver SSL overrides, and unknown URL settings', async () => {
    for (const query of ['sslmode=disable', 'sslmode=no-verify', 'sslmode=allow', 'sslmode=prefer', 'ssl=false', 'sslrootcert=attacker.pem', 'sslmode=require&sslmode=disable', 'rejectUnauthorized=false', 'options=-c%20role%3Dservice_role']) {
      await expect(loadDatabasePoolConfiguration({ DATABASE_URL: `postgresql://user:password@host/postgres?${query}` })).rejects.toThrow('certificate verification');
    }
  });
  it('validates missing/malformed URLs and decodes actual credential components safely', async () => {
    for (const value of ['', 'not-a-url', 'https://user:password@host/postgres', 'postgres://host/postgres', 'postgres://user:password@host/', 'postgres://user:password@host/postgres#secret', 'postgres://user:password@host/one/two']) {
      await expect(loadDatabasePoolConfiguration({ DATABASE_URL: value })).rejects.toBeInstanceOf(AtlasDatabaseError);
    }
    const configured = await loadDatabasePoolConfiguration({ DATABASE_URL: 'postgresql://tenant%2Euser:pw%40%3A%2Fword@[::1]/postgres' });
    expect(configured).toMatchObject({ host: '::1', user: 'tenant.user', password: 'pw@:/word', database: 'postgres' });
  });
  it('loads a real certificate PEM file and rejects invalid or missing CA files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-database-ca-'));
    try {
      const file = join(directory, 'root.pem'); await writeFile(file, rootCertificates[0] ?? '');
      expect((await loadDatabasePoolConfiguration({ ...env, DATABASE_SSL_CA_FILE: file })).ssl).toEqual({ rejectUnauthorized: true, ca: rootCertificates[0] });
      const invalid = join(directory, 'invalid.pem'); await writeFile(invalid, '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----');
      for (const path of [invalid, join(directory, 'absent.pem'), directory]) await expect(loadDatabasePoolConfiguration({ ...env, DATABASE_SSL_CA_FILE: path })).rejects.toThrow('certificate PEM');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each(['multiline', 'escaped-newlines', 'escaped-crlf', 'crlf'])('validates inline native X509 certificates from %s configuration', async representation => {
    const certificate = rootCertificates[0]!;
    const inline = representation === 'escaped-newlines' ? certificate.replace(/\n/g, '\\n')
      : representation === 'escaped-crlf' ? certificate.replace(/\n/g, '\\r\\n') : representation === 'crlf' ? certificate.replace(/\n/g, '\r\n') : certificate;
    const config = await loadDatabasePoolConfiguration({ ...env, DATABASE_SSL_CA: inline });
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: certificate });
    expect(new X509Certificate((config.ssl as { ca: string }).ca).fingerprint256).toBe(new X509Certificate(certificate).fingerprint256);
  });
  it('accepts a bounded complete CA bundle and passes verified TLS unchanged into the native pg driver', async () => {
    const bundle = rootCertificates.slice(0, 2).join('\n\n');
    const config = await loadDatabasePoolConfiguration({ ...env, DATABASE_SSL_CA: bundle });
    const pool = new Pool(config);
    try {
      expect(pool.options.ssl).toEqual({ rejectUnauthorized: true, ca: bundle });
      expect(pool.options.connectionString).toBeUndefined(); expect(pool.totalCount).toBe(0);
    } finally { await pool.end(); }
  });
  it('rejects competing CA sources before reading a file and treats blank templates as unset', async () => {
    await expect(loadDatabasePoolConfiguration({ ...env, DATABASE_SSL_CA: rootCertificates[0], DATABASE_SSL_CA_FILE: 'PRIVATE_CONFIGURATION_SENTINEL.pem' })).rejects.toThrow('exactly one');
    expect((await loadDatabasePoolConfiguration({ ...env, DATABASE_SSL_CA: ' ', DATABASE_SSL_CA_FILE: ' ' })).ssl).toEqual({ rejectUnauthorized: true });
  });
  it('rejects invalid, oversized, noncertificate, appended DER and mixed malformed PEM content without disclosure', async () => {
    const certificate = rootCertificates[0]!; const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const appended = Buffer.concat([new X509Certificate(certificate).raw, Buffer.from('PRIVATE_CONFIGURATION_SENTINEL')]);
    const extraDer = `-----BEGIN CERTIFICATE-----\n${appended.toString('base64')}\n-----END CERTIFICATE-----`;
    const invalid = ['', 'PRIVATE_CONFIGURATION_SENTINEL', `PRIVATE_CONFIGURATION_SENTINEL\n${certificate}`, `${certificate}\nPRIVATE_CONFIGURATION_SENTINEL`,
      `${certificate}\n${privateKey}`, `${certificate}\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----`,
      `${certificate}\n\0`, extraDer, 'x'.repeat(1_000_001), Array.from({ length: 65 }, () => certificate).join('\n')];
    // Empty configuration explicitly keeps the native verified system trust store.
    invalid.shift();
    for (const value of invalid) {
      const error = await loadDatabasePoolConfiguration({ ...env, DATABASE_SSL_CA: value }).then(() => null, error => error as AtlasDatabaseError);
      expect(error).toMatchObject({ code: 'configuration' }); expect(String(error)).toContain('certificate PEM');
      expect(String(error)).not.toContain('PRIVATE_CONFIGURATION_SENTINEL'); expect(String(error)).not.toContain(privateKey);
    }
  });
  it('rejects malformed extras in CA files as well as inline values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-database-ca-extras-'));
    try {
      const file = join(directory, 'root.pem'); await writeFile(file, `${rootCertificates[0]}\nPRIVATE_CONFIGURATION_SENTINEL`);
      const error = await loadDatabasePoolConfiguration({ ...env, DATABASE_SSL_CA_FILE: file }).then(() => null, error => error as AtlasDatabaseError);
      expect(error).toMatchObject({ code: 'configuration' }); expect(String(error)).not.toContain(directory); expect(String(error)).not.toContain('PRIVATE_CONFIGURATION_SENTINEL');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('rejects nonstring CA configuration without leaking values or driver details', async () => {
    for (const name of ['DATABASE_SSL_CA', 'DATABASE_SSL_CA_FILE']) {
      const configured = { ...env, [name]: { secret: 'PRIVATE_CONFIGURATION_SENTINEL' } } as unknown as Record<string, string>;
      const error = await loadDatabasePoolConfiguration(configured).then(() => null, error => error as AtlasDatabaseError);
      expect(error).toMatchObject({ code: 'configuration' }); expect(String(error)).not.toContain('PRIVATE_CONFIGURATION_SENTINEL');
    }
  });
});
describe('principal and trusted admin transactions', () => {
  it('sets authenticated role and parameterized local principal claims before querying, then commits on the same connection', async () => {
    const harness = poolHarness(); const database = await createAtlasDatabase(env, { poolFactory: () => harness.pool });
    const principal = "user'; RESET ROLE; --";
    const value = await database.withPrincipalTransaction(principal, async transaction => (await transaction.query<{ value: number }>('SELECT 1 AS value')).rows[0]?.value);
    expect(value).toBe(1); const client = harness.clients[0];
    expect(client?.queries.map(query => query.text)).toEqual(['BEGIN', "SET LOCAL statement_timeout = '10000ms'", "SET LOCAL lock_timeout = '3000ms'", "SET LOCAL idle_in_transaction_session_timeout = '15000ms'", "SELECT set_config('atlas.authorized_repository_ids', '[]', true)", 'SET LOCAL ROLE authenticated', "SELECT set_config('request.jwt.claims', $1, true)", 'SELECT 1 AS value', 'COMMIT']);
    expect(client?.queries[6]?.values).toEqual([JSON.stringify({ sub: principal, role: 'authenticated' })]);
    expect(client?.release).toHaveBeenCalledWith(false); await database.close();
  });
  it('rejects empty/unverified principals before acquiring a connection', async () => {
    const harness = poolHarness(); const database = await createAtlasDatabase(env, { poolFactory: () => harness.pool });
    for (const principal of ['', ' ', '\0bad', 'x'.repeat(257)]) await expect(database.withPrincipalTransaction(principal, async () => 1)).rejects.toThrow('verified principal');
    expect(harness.connect).not.toHaveBeenCalled(); await database.close();
  });
  it('keeps admin execution separate and clears local user claims', async () => {
    const harness = poolHarness(); const database = await createAtlasDatabase(env, { poolFactory: () => harness.pool });
    await database.withAdminTransaction(async transaction => { await transaction.query('SELECT current_user'); });
    const queries = harness.clients[0]?.queries.map(query => query.text);
    expect(queries).toContain('SET LOCAL ROLE NONE'); expect(queries).toContain("SELECT set_config('request.jwt.claims', '{}', true)"); expect(queries).not.toContain('SET LOCAL ROLE authenticated');
    await database.close();
  });
  it('rolls back callback failures and prevents queries through a retained transaction handle', async () => {
    const harness = poolHarness(); const database = await createAtlasDatabase(env, { poolFactory: () => harness.pool }); let retained: AtlasTransaction | undefined;
    const marker = new Error('Domain validation failed');
    await expect(database.withPrincipalTransaction('user-a', async transaction => { retained = transaction; throw marker; })).rejects.toBe(marker);
    expect(harness.clients[0]?.queries.at(-1)?.text).toBe('ROLLBACK'); expect(harness.clients[0]?.release).toHaveBeenCalledWith(false);
    await expect(retained?.query('SELECT 1')).rejects.toThrow('no longer active'); await database.close();
  });
  it('sanitizes SQL errors and destroys a connection when rollback fails', async () => {
    const harness = poolHarness(sql => ['SELECT secret', 'ROLLBACK'].includes(sql) ? Object.assign(new Error('postgres://user:secret-password@host private SQL'), { code: '42501' }) : null);
    const database = await createAtlasDatabase(env, { poolFactory: () => harness.pool });
    await expect(database.withPrincipalTransaction('user-a', async transaction => transaction.query('SELECT secret'))).rejects.toMatchObject({ code: 'permission', message: 'Database authorization failed' });
    expect(harness.clients[0]?.release).toHaveBeenCalledWith(true); await database.close();
  });
  it('reports failed COMMIT as unknown and never retries the transaction', async () => {
    const harness = poolHarness(sql => sql === 'COMMIT' ? Object.assign(new Error('lost connection with secret DSN'), { code: 'ECONNRESET' }) : null);
    const database = await createAtlasDatabase(env, { poolFactory: () => harness.pool }); const callback = vi.fn(async transaction => transaction.query('SELECT 1'));
    await expect(database.withPrincipalTransaction('user-a', callback)).rejects.toMatchObject({ code: 'commit_unknown' });
    expect(callback).toHaveBeenCalledTimes(1); expect(harness.connect).toHaveBeenCalledTimes(1); expect(harness.clients[0]?.release).toHaveBeenCalledWith(true); await database.close();
  });
  it('sanitizes connection errors and idle-pool errors without emitting secret driver details', async () => {
    const harness = poolHarness(); harness.connect.mockRejectedValue(Object.assign(new Error('password=private-secret'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }));
    const database = await createAtlasDatabase(env, { poolFactory: () => harness.pool });
    await expect(database.withPrincipalTransaction('user-a', async () => 1)).rejects.toMatchObject({ code: 'connection', message: 'Database connection or certificate verification failed' });
    harness.events.emit('error', new Error('postgres://private-secret'));
    expect(String(database.lastIdleError)).not.toContain('private-secret'); expect(database.lastIdleError?.code).toBe('connection'); await database.close();
  });
  it('keeps concurrent principal callbacks on separate acquired connections', async () => {
    const harness = poolHarness(); const database = await createAtlasDatabase(env, { poolFactory: () => harness.pool });
    await Promise.all(['user-a', 'user-b'].map(principal => database.withPrincipalTransaction(principal, async transaction => transaction.query('SELECT 1'))));
    expect(harness.clients).toHaveLength(2);
    expect(harness.clients.map(client => JSON.parse(String(client.queries.find(query => query.text.includes('request.jwt.claims'))?.values?.[0])).sub)).toEqual(['user-a', 'user-b']);
    await database.close();
  });
  it('handles checked-out connection failure and destroys the broken client', async () => {
    const harness = poolHarness(); const database = await createAtlasDatabase(env, { poolFactory: () => harness.pool });
    await expect(database.withPrincipalTransaction('user-a', async () => {
      harness.clients[0]?.emit('error', Object.assign(new Error('secret connection'), { code: 'ECONNRESET' }));
      await new Promise(() => {});
    })).rejects.toMatchObject({ code: 'connection' });
    expect(harness.clients[0]?.release).toHaveBeenCalledWith(true); await database.close();
  });
  it('bounds the whole transaction and closes the query handle after its deadline', async () => {
    vi.useFakeTimers(); const harness = poolHarness(); let retained: AtlasTransaction | undefined;
    const database = await createAtlasDatabase(env, { poolFactory: () => harness.pool });
    try {
      const pending = database.withPrincipalTransaction('user-a', async transaction => { retained = transaction; await new Promise(() => {}); });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(30_001); await assertion;
      await expect(retained?.query('SELECT 1')).rejects.toThrow('no longer active'); expect(harness.clients[0]?.queries.at(-1)?.text).toBe('ROLLBACK');
    } finally { vi.useRealTimers(); await database.close(); }
  });
  it('ends the pool exactly once and rejects use after close', async () => {
    const harness = poolHarness(); const database = await createAtlasDatabase(env, { poolFactory: () => harness.pool }); await database.close(); await database.close();
    expect(harness.end).toHaveBeenCalledTimes(1); await expect(database.withAdminTransaction(async () => 1)).rejects.toMatchObject({ code: 'closed' });
  });
});
