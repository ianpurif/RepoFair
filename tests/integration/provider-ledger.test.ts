import { readFile } from 'node:fs/promises';
import { BodyDigest, Receipt } from 'mppx';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostgresPurchaseLedger } from '../../apps/provider/src/postgres-purchase-ledger.ts';
import type { ProviderLedgerOptions } from '../../apps/provider/src/postgres-purchase-ledger.ts';
import type { AuthorizedRetrieval } from '../../apps/provider/src/tempo-adapter.ts';
import { AtlasDatabaseError } from '../../apps/worker/src/database.ts';
import type { AtlasDatabase, AtlasTransaction } from '../../apps/worker/src/database.ts';
import type { PurchaseTerms } from '../../packages/contracts/src/index.ts';

// Real PGlite SQL, constraints, triggers and transactions. Authorization and
// settlement verification are explicitly mocked. These sequential tests do not
// establish hosted multi-connection concurrency or any real network settlement.
const sql = new PGlite(); const providerId = 'synthetic-provider-a'; const start = 1_791_331_200_000;
let clock = start; let loseCommit = false; let trace: string[] = [];
const reauthorize = vi.fn<ProviderLedgerOptions['reauthorize']>();
const verifier = vi.fn<ProviderLedgerOptions['verifySettlement']>();
async function transaction<T>(work: (tx: AtlasTransaction) => Promise<T>): Promise<T> {
  await sql.exec('BEGIN');
  try {
    const result = await work({ query: async <Row extends Record<string, unknown>>(query: string, values?: unknown[]) => {
      trace.push(query);
      try { const result = await sql.query<Row>(query, values); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, command: '', oid: 0, fields: [] }; }
      catch { throw new AtlasDatabaseError('query', 'Database operation failed'); }
    } });
    await sql.exec('COMMIT');
    if (loseCommit) { loseCommit = false; throw new AtlasDatabaseError('commit_unknown', 'Synthetic lost commit acknowledgement'); }
    return result;
  } catch (error) { await sql.exec('ROLLBACK'); throw error; }
}
const database = { withAdminTransaction: transaction } as unknown as AtlasDatabase;
function auth(changes: Partial<AuthorizedRetrieval> = {}): AuthorizedRetrieval {
  return { principalId: 'synthetic-buyer-a', permissionRevision: '1:1', input: { packageName: '@synthetic/package', version: '1.2.3', question: 'How does retry work?', idempotencyKey: 'synthetic_request_0001' }, ...changes };
}
function terms(authorization = auth(), changes: Partial<PurchaseTerms> = {}): PurchaseTerms {
  return { providerId, operation: 'context.retrieve', requestDigest: BodyDigest.compute(JSON.stringify(authorization.input)), packageName: authorization.input.packageName,
    version: authorization.input.version, network: 'eip155:42431', token: `0x${'1'.repeat(40)}`, recipient: `0x${'2'.repeat(40)}`,
    atomicAmount: '1000000000000000001', expiresAtMs: start + 60_000, ...changes };
}
function ledger(id = providerId) { return createPostgresPurchaseLedger(database, { providerId: id, reauthorize, verifySettlement: verifier, now: () => clock }); }
function syntheticReceipt(reference = 'synthetic-mocked-verification-reference-a'): Receipt.Receipt {
  // This opaque test reference is deliberately not presented as a transaction hash.
  return { method: 'tempo', status: 'success', timestamp: '2026-10-07T00:00:00.000Z', reference };
}
async function claimed(authorization = auth(), price = terms(authorization)) {
  await ledger(price.providerId).quote(authorization, price);
  expect(await ledger(price.providerId).claim(authorization, price)).toEqual({ state: 'claimed' }); return price;
}
async function sale() { return (await sql.query<Record<string, unknown>>('SELECT * FROM atlas_provider.sales ORDER BY created_at')).rows; }
beforeAll(async () => {
  await sql.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
  await sql.exec(await readFile('supabase/migrations/202610070006_provider_ledger.sql', 'utf8'));
});
beforeEach(async () => {
  await sql.exec('TRUNCATE atlas_provider.sales'); clock = start; loseCommit = false; trace = []; vi.clearAllMocks();
  reauthorize.mockImplementation(async check => check.authorization); verifier.mockResolvedValue(true);
});
afterAll(async () => { await sql.close(); });
describe('independent provider durable ledger with mocked authoritative verification', () => {
  it('freezes one quote including expiry, stores only hashes of the question, and hides quote-only state from adapter lookup', async () => {
    const price = terms(); expect(await ledger().quote(auth(), price)).toEqual(price);
    clock += 1000;
    expect(await ledger().quote(auth(), { ...price, expiresAtMs: price.expiresAtMs + 1000 })).toEqual(price);
    expect(await ledger().lookup(auth(), price.requestDigest)).toBeNull();
    const rows = await sale(); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ state: 'quoted', delivery: 'unavailable', claimed_at: null, receipt: null });
    expect(JSON.stringify(rows)).not.toContain(auth().input.question);
    expect(trace.every(query => !/atlas\.(?:budgets|purchases)|credential|source_file/i.test(query))).toBe(true);
  });
  it('returns exactly one claimed result and persists pending across fresh factory instances', async () => {
    const price = await claimed();
    for (let count = 0; count < 5; count++) expect(await ledger().claim(auth(), price)).toEqual({ state: 'pending' });
    expect(await ledger().lookup(auth(), price.requestDigest)).toEqual({ state: 'pending', terms: price });
    expect((await sale())[0]).toMatchObject({ state: 'pending', delivery: 'unavailable' });
  });
  it('never renews an expired quote and rejects the first claim after expiry without claiming processing', async () => {
    const price = terms(); await ledger().quote(auth(), price); clock = price.expiresAtMs;
    await expect(ledger().quote(auth(), { ...price, expiresAtMs: clock + 60_000 })).rejects.toMatchObject({ code: 'expired' });
    expect(await ledger().claim(auth(), price)).toEqual({ state: 'rejected' });
    expect(await ledger().claim(auth(), price)).toEqual({ state: 'rejected' });
    expect(await ledger().lookup(auth(), price.requestDigest)).toEqual({ state: 'rejected', terms: price });
    expect((await sale())[0]).toMatchObject({ claimed_at: null, receipt: null });
  });
  it('fails closed for altered token, recipient, amount, digest, expiry and exact version with the same idempotency key', async () => {
    const price = terms(); await ledger().quote(auth(), price);
    for (const changes of [{ token: `0x${'3'.repeat(40)}` }, { recipient: `0x${'4'.repeat(40)}` }, { atomicAmount: '1000000000000000002' },
      { requestDigest: BodyDigest.compute('other input') }, { expiresAtMs: price.expiresAtMs - 1 }]) {
      await expect(ledger().quote(auth(), { ...price, ...changes })).rejects.toMatchObject({ code: 'mismatch' });
      await expect(ledger().claim(auth(), { ...price, ...changes })).rejects.toMatchObject({ code: 'mismatch' });
    }
    const changed = auth({ input: { ...auth().input, version: '1.2.4' } });
    await expect(ledger().quote(changed, terms(changed))).rejects.toMatchObject({ code: 'mismatch' });
    expect((await sale())[0]).toMatchObject({ state: 'quoted', terms: price });
  });
  it('binds the canonical authorized question and permission revision independently of a supplied body digest', async () => {
    const price = terms(); await ledger().quote(auth(), price);
    const otherQuestion = auth({ input: { ...auth().input, question: 'Other exact request' } });
    await expect(ledger().lookup(otherQuestion, price.requestDigest)).rejects.toMatchObject({ code: 'mismatch' });
    const changed = auth({ permissionRevision: '1:2' });
    await expect(ledger().claim(changed, price)).rejects.toMatchObject({ code: 'mismatch' });
    reauthorize.mockResolvedValue(changed);
    await expect(ledger().claim(auth(), price)).rejects.toMatchObject({ code: 'denied' });
  });
  it('isolates provider and principal keys without sharing sales, budgets or credentials', async () => {
    await claimed(); const other = auth({ principalId: 'synthetic-buyer-b' });
    expect(await ledger().lookup(other, terms(other).requestDigest)).toBeNull();
    const otherPrice = terms(auth(), { providerId: 'synthetic-provider-b' });
    expect(await ledger('synthetic-provider-b').lookup(auth(), otherPrice.requestDigest)).toBeNull();
    await claimed(other); await claimed(auth(), otherPrice);
    expect(await sale()).toHaveLength(3);
    await expect(ledger().claim(auth(), otherPrice)).rejects.toMatchObject({ code: 'mismatch' });
  });
  it('checks fresh trusted authorization on every callback and never reads storage when authorization is revoked', async () => {
    const price = await claimed(); const receipt = syntheticReceipt(); reauthorize.mockRejectedValue(new Error('synthetic private credential sentinel'));
    const operations = [() => ledger().quote(auth(), price), () => ledger().lookup(auth(), price.requestDigest), () => ledger().claim(auth(), price),
      () => ledger().verifySettlement(auth(), price, receipt), () => ledger().saveSettlement(auth(), price, receipt), () => ledger().markUnknown(auth(), price)];
    const before = trace.length;
    for (const operation of operations) await expect(operation()).rejects.toMatchObject({ code: 'denied', message: 'Current provider authorization is unavailable' });
    expect(trace).toHaveLength(before); expect(verifier).not.toHaveBeenCalled();
  });
  it('rechecks authorization after acquiring the claim lock and leaves the quote unclaimed on revocation', async () => {
    const price = terms(); await ledger().quote(auth(), price);
    reauthorize.mockResolvedValueOnce(auth()).mockRejectedValueOnce(new Error('revoked'));
    await expect(ledger().claim(auth(), price)).rejects.toMatchObject({ code: 'denied' });
    expect((await sale())[0]).toMatchObject({ state: 'quoted', claimed_at: null });
  });
  it('keeps unknown claims durable after expiry and never authorizes another processing attempt', async () => {
    const price = await claimed(); await ledger().markUnknown(auth(), price); clock += 600_000;
    await ledger().markUnknown(auth(), price);
    expect(await ledger().claim(auth(), price)).toEqual({ state: 'unknown' });
    expect(await ledger().lookup(auth(), price.requestDigest)).toEqual({ state: 'unknown', terms: price });
    expect((await sale())[0]).toMatchObject({ state: 'unknown', receipt: null, delivery: 'unavailable' });
  });
  it('requires an existing processing claim for unknown state and settlement; a quote or receipt does not grant one', async () => {
    const price = terms(); await ledger().quote(auth(), price);
    await expect(ledger().markUnknown(auth(), price)).rejects.toMatchObject({ code: 'not-claimed' });
    await expect(ledger().saveSettlement(auth(), price, syntheticReceipt())).rejects.toMatchObject({ code: 'not-claimed' });
    await expect(ledger().verifySettlement(auth(), price, syntheticReceipt())).rejects.toMatchObject({ code: 'not-claimed' });
    expect(verifier).not.toHaveBeenCalled();
  });
  it('saveSettlement independently invokes the mocked authoritative verifier and refuses false or unavailable verification', async () => {
    const price = await claimed(); const receipt = syntheticReceipt();
    expect(await ledger().verifySettlement(auth(), price, receipt)).toBe(true);
    verifier.mockResolvedValue(false);
    await expect(ledger().saveSettlement(auth(), price, receipt)).rejects.toMatchObject({ code: 'verification' });
    verifier.mockRejectedValue(new Error('private RPC credential sentinel'));
    await expect(ledger().saveSettlement(auth(), price, receipt)).rejects.toMatchObject({ code: 'verification' });
    expect(verifier).toHaveBeenCalledTimes(3); expect((await sale())[0]).toMatchObject({ state: 'pending', receipt: null });
  });
  it('can reconcile an unknown expired claim to verified settlement while delivery remains unavailable', async () => {
    const price = await claimed(); const receipt = syntheticReceipt(); await ledger().markUnknown(auth(), price); clock += 600_000;
    await ledger().saveSettlement(auth(), price, receipt);
    expect(await ledger().lookup(auth(), price.requestDigest)).toEqual({ state: 'settled', terms: price, receipt });
    expect(await ledger().claim(auth(), price)).toEqual({ state: 'settled', receipt });
    await ledger().markUnknown(auth(), price); await ledger().saveSettlement(auth(), price, receipt);
    expect(verifier).toHaveBeenCalledTimes(2); expect((await sale())[0]).toMatchObject({ state: 'settled', delivery: 'unavailable', receipt });
  });
  it('rechecks authorization after settlement verification and rolls back persistence if access changes', async () => {
    const price = await claimed(); verifier.mockImplementation(async () => { reauthorize.mockRejectedValue(new Error('revoked')); return true; });
    await expect(ledger().saveSettlement(auth(), price, syntheticReceipt())).rejects.toMatchObject({ code: 'denied' });
    expect((await sale())[0]).toMatchObject({ state: 'pending', receipt: null });
  });
  it('prevents replacing a saved receipt and prevents its reuse across other sales on the same provider/network', async () => {
    const price = await claimed(); const receipt = syntheticReceipt(); await ledger().saveSettlement(auth(), price, receipt);
    await expect(ledger().saveSettlement(auth(), price, syntheticReceipt('synthetic-different-reference'))).rejects.toMatchObject({ code: 'mismatch' });
    const other = auth({ input: { ...auth().input, idempotencyKey: 'synthetic_request_0002' } }); const otherPrice = await claimed(other);
    await expect(ledger().saveSettlement(other, otherPrice, receipt)).rejects.toMatchObject({ code: 'storage' });
    await ledger().markUnknown(other, otherPrice);
    expect((await sale()).map(row => row.state).sort()).toEqual(['settled', 'unknown']);
  });
  it('retains a committed pending claim when a synthetic lost COMMIT acknowledgement occurs, so a retry cannot claim again', async () => {
    const price = terms(); await ledger().quote(auth(), price); loseCommit = true;
    await expect(ledger().claim(auth(), price)).rejects.toMatchObject({ code: 'commit-unknown' });
    expect(await ledger().claim(auth(), price)).toEqual({ state: 'pending' });
    expect((await sale())[0]).toMatchObject({ state: 'pending', receipt: null });
  });
  it('does not downgrade settlement after a synthetic lost settlement COMMIT acknowledgement', async () => {
    const price = await claimed(); const receipt = syntheticReceipt();
    verifier.mockImplementation(async () => { loseCommit = true; return true; });
    await expect(ledger().saveSettlement(auth(), price, receipt)).rejects.toMatchObject({ code: 'commit-unknown' });
    await ledger().markUnknown(auth(), price);
    expect(await ledger().lookup(auth(), price.requestDigest)).toEqual({ state: 'settled', terms: price, receipt });
  });
  it('rejects extra fields, unsafe integers, floating or non-string amounts, and non-native JSON without executing hooks', async () => {
    const toJSON = vi.fn(() => terms()); const getter = vi.fn(() => 'synthetic-buyer-a');
    const hookedAuth = Object.defineProperty({ ...auth() }, 'principalId', { get: getter, enumerable: true });
    for (const invalid of [{ ...terms(), source: 'private source' }, { ...terms(), atomicAmount: 1 }, { ...terms(), atomicAmount: '1.2' },
      { ...terms(), atomicAmount: (1n << 256n).toString() }, { ...terms(), expiresAtMs: Number.MAX_SAFE_INTEGER + 1 }, { ...terms(), toJSON },
      { ...terms(), token: null }, { ...terms(), network: 'eip155:4217' }, new Date()]) {
      await expect(ledger().quote(auth(), invalid as unknown as PurchaseTerms)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(ledger().quote(hookedAuth, terms())).rejects.toMatchObject({ code: 'invalid' });
    expect(toJSON).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled(); expect(await sale()).toHaveLength(0);
  });
  it('rejects unsupported receipt extensions and mismatched external IDs before calling verification', async () => {
    const price = await claimed();
    for (const receipt of [{ ...syntheticReceipt(), source: 'private code' }, { ...syntheticReceipt(), reference: '' },
      { ...syntheticReceipt(), externalId: 'another_request_key' }, { ...syntheticReceipt(), method: 'other' }, { ...syntheticReceipt(), timestamp: 'yesterday' }]) {
      await expect(ledger().saveSettlement(auth(), price, receipt as Receipt.Receipt)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(verifier).not.toHaveBeenCalled(); expect((await sale())[0]).toMatchObject({ state: 'pending', receipt: null });
  });
  it('migration rejects NULL/non-string terms, mutation of frozen terms, reopening claims and enabling delivery', async () => {
    const price = await claimed();
    await expect(sql.exec("UPDATE atlas_provider.sales SET state='quoted',claimed_at=null")).rejects.toThrow();
    await expect(sql.exec("UPDATE atlas_provider.sales SET terms=jsonb_set(terms,'{atomicAmount}','\"2\"')")).rejects.toThrow();
    await expect(sql.exec("UPDATE atlas_provider.sales SET delivery='ready'")).rejects.toThrow();
    const row = (await sale())[0]!;
    for (const changes of [{ operation: null }, { atomicAmount: 1 }, { expiresAtMs: null }]) {
      await expect(sql.query(`INSERT INTO atlas_provider.sales(provider_id,principal_id,idempotency_key,permission_revision,authorization_digest,request_digest,package_name,version,network,terms,terms_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`, [providerId, 'synthetic-invalid-buyer', 'synthetic_invalid_0001', row.permission_revision,
        row.authorization_digest, price.requestDigest, price.packageName, price.version, price.network, JSON.stringify({ ...price, ...changes }), row.terms_digest])).rejects.toThrow();
    }
    expect((await sale())[0]).toMatchObject({ state: 'pending', terms: price, delivery: 'unavailable' });
  });
  it('migration rejects malformed JSON-null receipt metadata and arbitrary receipt extensions directly in SQL', async () => {
    const price = await claimed(); const receipt = syntheticReceipt();
    for (const changes of [{ method: null }, { status: null }, { timestamp: null }, { reference: null }, { externalId: null },
      { fundingCurrency: null }, { method: 1 }, { sourceBundle: 'private source must not be stored' }]) {
      await expect(sql.query(`UPDATE atlas_provider.sales SET state='settled',receipt=$1::jsonb,receipt_reference=$2,settled_at=now()
        WHERE provider_id=$3 AND principal_id=$4 AND idempotency_key=$5`, [JSON.stringify({ ...receipt, ...changes }), receipt.reference,
        providerId, auth().principalId, auth().input.idempotencyKey])).rejects.toThrow();
    }
    expect((await sale())[0]).toMatchObject({ state: 'pending', terms: price, receipt: null, delivery: 'unavailable' });
  });
  it('blocks anonymous/authenticated direct access and grants only the trusted service role', async () => {
    await claimed();
    const flags = await sql.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE oid='atlas_provider.sales'::regclass");
    expect(flags.rows[0]?.relrowsecurity).toBe(true);
    for (const role of ['anon', 'authenticated']) {
      await sql.exec('BEGIN'); await sql.exec(`SET LOCAL ROLE ${role}`);
      try { await expect(sql.exec('SELECT * FROM atlas_provider.sales')).rejects.toThrow(); } finally { await sql.exec('ROLLBACK'); }
    }
    await sql.exec('BEGIN'); await sql.exec('SET LOCAL ROLE service_role');
    try { expect((await sql.query('SELECT provider_id FROM atlas_provider.sales')).rows).toHaveLength(1); } finally { await sql.exec('ROLLBACK'); }
  });
});
