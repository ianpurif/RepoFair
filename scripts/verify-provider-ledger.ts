import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createAtlasDatabase, AtlasDatabaseError } from '../apps/worker/src/database.ts';
import { createPostgresPurchaseLedger } from '../apps/provider/src/postgres-purchase-ledger.ts';
import type { AuthorizedRetrieval } from '../apps/provider/src/tempo-adapter.ts';
import type { PurchaseTerms } from '../packages/contracts/src/index.ts';

// Hosted storage concurrency using synthetic authorized subjects only. This is
// not a real entitlement, publication, payment, receipt or settlement test.
const audit = randomUUID(); const providerId = `audit-${audit}`;
const env = parseEnv(await readFile('.env.local', 'utf8'));
const first = await createAtlasDatabase(env); const second = await createAtlasDatabase(env);
const authorization: AuthorizedRetrieval = { principalId: `audit-${audit}`, permissionRevision: '1', input: { packageName: '@atlas/audit', version: '1.0.0', question: 'Audit storage concurrency only', idempotencyKey: audit } };
const terms: PurchaseTerms = { providerId, operation: 'context.retrieve', requestDigest: `sha-256=${createHash('sha256').update(audit).digest('base64')}`, packageName: '@atlas/audit', version: '1.0.0', network: 'eip155:42431', token: `0x${'1'.repeat(40)}`, recipient: `0x${'2'.repeat(40)}`, atomicAmount: '1', expiresAtMs: Date.now() + 240_000 };
let authorized = true;
const options = { providerId, now: Date.now, reauthorize: async (check: { authorization: AuthorizedRetrieval }) => { if (!authorized) throw new Error('audit-revoked'); return check.authorization; }, verifySettlement: async () => false };
const ledgers = [createPostgresPurchaseLedger(first, options), createPostgresPurchaseLedger(second, options)];
const checks: string[] = []; let failure: string | null = null; let cleaned = false;
function assert(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
try {
  const pids = await Promise.all([first, second].map(db => db.withAdminTransaction(async tx => (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)));
  assert(pids[0] !== pids[1], 'audit-distinct-backends'); checks.push('separate-postgres-backends');
  const quotes = await Promise.all(Array.from({ length: 8 }, (_, index) => ledgers[index % 2]!.quote(authorization, terms)));
  assert(quotes.every(quote => JSON.stringify(quote) === JSON.stringify(quotes[0])), 'audit-quote-terms-differ'); checks.push('eight-concurrent-quotes-one-immutable-row');
  const later = await ledgers[0]!.quote(authorization, { ...terms, expiresAtMs: terms.expiresAtMs + 5000 });
  assert(later.expiresAtMs === terms.expiresAtMs, 'audit-quote-expiry-extended'); checks.push('quote-expiry-remains-frozen');
  const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => ledgers[index % 2]!.claim(authorization, terms)));
  assert(claims.filter(claim => claim.state === 'claimed').length === 1 && claims.filter(claim => claim.state === 'pending').length === 7, 'audit-multiple-claim-winners'); checks.push('eight-concurrent-claims-one-winner-seven-pending');
  await ledgers[0]!.markUnknown(authorization, terms);
  assert((await ledgers[1]!.claim(authorization, terms)).state === 'unknown', 'audit-unknown-reclaimed');
  const saved = await ledgers[1]!.lookup(authorization, terms.requestDigest);
  assert(saved?.state === 'unknown' && !saved.receipt, 'audit-unknown-not-retained'); checks.push('unknown-retained-without-receipt-or-reclaim');
  let conflict = false;
  try { await ledgers[0]!.quote(authorization, { ...terms, atomicAmount: '2' }); } catch { conflict = true; }
  assert(conflict, 'audit-idempotency-terms-changed'); checks.push('altered-idempotent-terms-rejected');
  authorized = false; let denied = false;
  try { await ledgers[1]!.lookup(authorization, terms.requestDigest); } catch { denied = true; }
  assert(denied, 'audit-revocation-ignored'); checks.push('injected-authorization-revocation-denies-read');
  const counts = await first.withAdminTransaction(async tx => (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM atlas_provider.sales WHERE provider_id=$1', [providerId])).rows[0]!.count);
  assert(counts === 1, 'audit-duplicate-sale-rows');
  const roleDenials = await Promise.all(['authenticated', 'anon'].map(async role => {
    try { await first.withAdminTransaction(async tx => { await tx.query(`SET LOCAL ROLE ${role}`); await tx.query('SELECT * FROM atlas_provider.sales LIMIT 1'); }); return false; }
    catch (error) { return error instanceof AtlasDatabaseError && error.code === 'permission'; }
  }));
  assert(roleDenials.every(Boolean), 'audit-untrusted-ledger-read'); checks.push('anonymous-and-authenticated-role-denied');
} catch (error) { failure = error instanceof Error && /^audit-[a-z-]+$/.test(error.message) ? error.message : error instanceof AtlasDatabaseError ? `database-${error.code}` : 'audit-operation-failed'; }
finally {
  try { await first.withAdminTransaction(async tx => {
    await tx.query('DELETE FROM atlas_provider.sales WHERE provider_id=$1', [providerId]);
    cleaned = (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM atlas_provider.sales WHERE provider_id=$1', [providerId])).rows[0]!.count === 0;
  }); } catch { cleaned = false; }
  await Promise.all([first.close(), second.close()]);
}
const evidence = { checkedAt: new Date().toISOString(), status: !failure && cleaned ? 'verified' : 'failed', scope: 'Real hosted quote/claim/unknown persistence with synthetic authorization; no real sale', checks, failure, generatedRecordsCleaned: cleaned, paymentSubmitted: false, settlementVerified: false, liveEntitlementVerified: false };
await writeFile('docs/evidence/provider-ledger.json', JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify(evidence));
if (evidence.status !== 'verified') process.exitCode = 1;
