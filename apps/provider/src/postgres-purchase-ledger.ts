import { createHash } from 'node:crypto';
import { Receipt } from 'mppx';
import type { PurchaseTerms } from '../../../packages/contracts/src/index.ts';
import { parseQuestion } from '../../../packages/contracts/src/local.ts';
import { isExactVersion } from '../../../packages/core/src/versions.ts';
import { validateTestnetTerms, validateTestnetTermsShape } from '../../../packages/sdk/src/payment-policy.ts';
import { AtlasDatabaseError } from '../../worker/src/database.ts';
import type { AtlasDatabase, AtlasTransaction } from '../../worker/src/database.ts';
import type { AuthorizedRetrieval, DurablePurchaseClaim, TempoProviderDependencies } from './tempo-adapter.ts';

export class ProviderLedgerError extends Error {
  constructor(public readonly code: 'configuration' | 'invalid' | 'denied' | 'mismatch' | 'expired' | 'not-claimed' | 'verification' | 'storage' | 'commit-unknown', message: string) {
    super(message); this.name = 'ProviderLedgerError';
  }
}
export type ProviderLedgerOperation = 'quote' | 'lookup' | 'claim' | 'verifySettlement' | 'saveSettlement' | 'markUnknown';
export type ProviderLedgerOptions = Readonly<{
  providerId: string;
  /** Independently verify identity, exact-version entitlement and current permission
   * revision on every call. Return the freshly verified binding, never echo untrusted
   * arguments as authorization. No buyer budget or credentials are needed here. */
  reauthorize(check: Readonly<{ operation: ProviderLedgerOperation; providerId: string; authorization: AuthorizedRetrieval; requestDigest: string }>,tx?:AtlasTransaction): Promise<AuthorizedRetrieval>;
  /** MUST reconcile authoritative network finality, transfer token/recipient/amount,
   * request attribution and this principal/provider's immutable exact-version terms.
   * An SDK success or a receipt header alone is not authoritative verification. */
  verifySettlement(authorization: AuthorizedRetrieval, terms: PurchaseTerms, receipt: Receipt.Receipt): Promise<boolean>;
  now(): number;
}>;
export type PostgresPurchaseLedger = Pick<TempoProviderDependencies, 'quote' | 'lookup' | 'claim' | 'verifySettlement' | 'saveSettlement' | 'markUnknown'>;
type SaleRow = { permission_revision: string; authorization_digest: string; request_digest: string; terms: unknown; terms_digest: string;
  state: 'quoted' | 'pending' | 'unknown' | 'settled' | 'rejected'; receipt: unknown; receipt_reference: string | null };
const termsFields = ['providerId', 'operation', 'requestDigest', 'packageName', 'version', 'network', 'token', 'recipient', 'atomicAmount', 'expiresAtMs'] as const;
const receiptFields = ['method', 'status', 'timestamp', 'reference', 'externalId', 'fundingCurrency'] as const;
function fail(code: ProviderLedgerError['code'], message: string): never { throw new ProviderLedgerError(code, message); }
function requireValue(value: unknown, code: ProviderLedgerError['code'], message: string): asserts value { if (!value) fail(code, message); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function text(value: unknown, maximum: number): value is string {
  // eslint-disable-next-line no-control-regex -- identifiers and receipt references cannot contain controls
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum && !/[\x00-\x1f\x7f]/.test(value);
}
/** Reject non-native JSON, accessors, hidden/symbol fields and excessive structure
 * before serialization. In particular, a toJSON hook is never executed. */
function nativeJson(value: unknown): void {
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    requireValue(++nodes <= 128 && depth <= 5, 'invalid', 'Ledger input exceeds JSON bounds');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { requireValue(Number.isFinite(item), 'invalid', 'Ledger input must be native JSON'); return; }
    if (typeof item === 'string') { requireValue(Buffer.byteLength(item) <= 8192, 'invalid', 'Ledger input exceeds JSON bounds'); return; }
    requireValue(typeof item === 'object' && item !== null, 'invalid', 'Ledger input must be native JSON');
    requireValue(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null || Array.isArray(item), 'invalid', 'Ledger input must be native JSON');
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      requireValue(typeof key === 'string' && key.length <= 100 && !['__proto__', 'constructor', 'prototype'].includes(key), 'invalid', 'Ledger input has unsupported fields');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      requireValue(descriptor && descriptor.enumerable && 'value' in descriptor, 'invalid', 'Ledger input must be native JSON');
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(item)) requireValue(Object.keys(item).length === item.length, 'invalid', 'Ledger input must be native JSON');
  }
  visit(value, 0);
  requireValue(Buffer.byteLength(JSON.stringify(value)) <= 16384, 'invalid', 'Ledger input exceeds JSON bounds');
}
function object(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  requireValue(typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)), 'invalid', 'Ledger input has unsupported fields');
}
function authorization(raw: AuthorizedRetrieval): AuthorizedRetrieval {
  nativeJson(raw); object(raw, ['principalId', 'permissionRevision', 'input']); object(raw.input, ['packageName', 'version', 'question', 'idempotencyKey']);
  requireValue(text(raw.principalId, 256) && raw.principalId.trim() === raw.principalId && text(raw.permissionRevision, 256)
    && raw.permissionRevision.trim() === raw.permissionRevision, 'invalid', 'A bounded verified principal and permission revision are required');
  requireValue(text(raw.input.packageName, 200) && text(raw.input.version, 100) && isExactVersion(raw.input.version)
    && typeof raw.input.idempotencyKey === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(raw.input.idempotencyKey), 'invalid', 'Invalid exact-version ledger request');
  let question: string; try { question = parseQuestion(raw.input.question); } catch { return fail('invalid', 'Invalid bounded retrieval question'); }
  requireValue(question === raw.input.question, 'invalid', 'Retrieval question must already be canonical');
  return Object.freeze({ principalId: raw.principalId, permissionRevision: raw.permissionRevision,
    input: Object.freeze({ packageName: raw.input.packageName, version: raw.input.version, question, idempotencyKey: raw.input.idempotencyKey }) });
}
function authorizationDigest(auth: AuthorizedRetrieval): string {
  return hash(JSON.stringify([auth.principalId, auth.permissionRevision, auth.input.packageName, auth.input.version, auth.input.question, auth.input.idempotencyKey]));
}
function parseTerms(raw: PurchaseTerms, auth: AuthorizedRetrieval, providerId: string): PurchaseTerms {
  nativeJson(raw); object(raw, termsFields);
  requireValue(termsFields.every(field => field === 'expiresAtMs' ? typeof raw[field] === 'number' : text(raw[field], 256)), 'invalid', 'Purchase terms require bounded native strings and an integer expiry');
  try { validateTestnetTermsShape(raw); } catch { return fail('invalid', 'Invalid bounded Tempo testnet purchase terms'); }
  requireValue(raw.providerId === providerId && raw.packageName === auth.input.packageName && raw.version === auth.input.version,
    'mismatch', 'Purchase terms differ from the authorized exact-version request');
  requireValue(BigInt(raw.atomicAmount) <= (1n << 256n) - 1n, 'invalid', 'Atomic amount exceeds the token integer range');
  return Object.freeze(Object.fromEntries(termsFields.map(field => [field, raw[field]])) as PurchaseTerms);
}
function termsDigest(terms: PurchaseTerms): string { return hash(JSON.stringify(termsFields.map(field => terms[field]))); }
function parseReceipt(raw: Receipt.Receipt, auth: AuthorizedRetrieval): Receipt.Receipt {
  nativeJson(raw); object(raw, receiptFields);
  let result: Receipt.Receipt;
  try { result = Receipt.Schema.parse(raw); } catch { return fail('invalid', 'Invalid bounded settlement receipt'); }
  requireValue(result.method === 'tempo' && text(result.reference, 512) && text(result.timestamp, 64)
    && (result.externalId === undefined || result.externalId === auth.input.idempotencyKey)
    && (result.fundingCurrency === undefined || text(result.fundingCurrency, 256)), 'invalid', 'Receipt is not bound to this Tempo purchase');
  // Current mppx 0.13.1 charge receipts use only these fields. Unsupported
  // method extensions/subscriptions must receive an explicit review first.
  return Object.freeze(result);
}
function referenceIdentity(receipt: Receipt.Receipt): string { return /^0x[a-fA-F0-9]{64}$/.test(receipt.reference) ? receipt.reference.toLowerCase() : receipt.reference; }
function receiptIdentity(receipt: Receipt.Receipt): string { return JSON.stringify(receiptFields.map(field => receipt[field as keyof Receipt.Receipt] ?? null)); }

/** Independent provider ledger. Apply migration 006 to the provider's own database.
 * No buyer budgets, keys, source bundles or delivery state are accessed. */
export function createPostgresPurchaseLedger(database: AtlasDatabase, supplied: ProviderLedgerOptions): PostgresPurchaseLedger {
  requireValue(supplied && typeof supplied.providerId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(supplied.providerId)
    && typeof supplied.reauthorize === 'function' && typeof supplied.verifySettlement === 'function' && typeof supplied.now === 'function', 'configuration', 'Provider ledger requires trusted authorization and settlement verification');
  const options = Object.freeze({ ...supplied });
  function now(): number { const value = options.now(); requireValue(Number.isSafeInteger(value) && value > 0, 'configuration', 'Provider ledger clock is invalid'); return value; }
  async function fresh(operation: ProviderLedgerOperation, auth: AuthorizedRetrieval, digest: string,tx?:AtlasTransaction): Promise<void> {
    requireValue(typeof digest === 'string' && /^sha-256=[A-Za-z0-9+/]{43}=$/.test(digest), 'invalid', 'Invalid request body digest');
    let verified: AuthorizedRetrieval;
    try { verified = authorization(await options.reauthorize(Object.freeze({ operation, providerId: options.providerId, authorization: auth, requestDigest: digest }),tx)); }
    catch { return fail('denied', 'Current provider authorization is unavailable'); }
    requireValue(authorizationDigest(verified) === authorizationDigest(auth), 'denied', 'Current authorization differs from this purchase binding');
  }
  async function transaction<T>(work: (tx: AtlasTransaction) => Promise<T>): Promise<T> {
    try { return await database.withAdminTransaction(work); }
    catch (error) {
      if (error instanceof ProviderLedgerError) throw error;
      if (error instanceof AtlasDatabaseError && error.code === 'commit_unknown') return fail('commit-unknown', 'Provider ledger commit outcome is unknown; reconcile without another charge');
      return fail('storage', 'Provider ledger storage is unavailable; no new processing claim is authorized');
    }
  }
  function key(auth: AuthorizedRetrieval): string[] { return [options.providerId, auth.principalId, auth.input.idempotencyKey]; }
  async function lock(tx: AtlasTransaction, auth: AuthorizedRetrieval): Promise<void> {
    const identity = createHash('sha256').update(JSON.stringify(['atlas-provider-sale', ...key(auth)])).digest().readBigInt64BE().toString();
    // Every writer uses the same transaction lock, including missing quote rows.
    await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [identity]);
  }
  async function read(tx: AtlasTransaction, auth: AuthorizedRetrieval, locked = false): Promise<SaleRow | undefined> {
    return (await tx.query<SaleRow>(`SELECT permission_revision,authorization_digest,request_digest,terms,terms_digest,state,receipt,receipt_reference
      FROM atlas_provider.sales WHERE provider_id=$1 AND principal_id=$2 AND idempotency_key=$3${locked ? ' FOR UPDATE' : ''}`, key(auth))).rows[0];
  }
  function bound(row: SaleRow, auth: AuthorizedRetrieval, digest: string): PurchaseTerms {
    requireValue(row.permission_revision === auth.permissionRevision && row.authorization_digest === authorizationDigest(auth) && row.request_digest === digest,
      'mismatch', 'Idempotency key is already bound to another request or permission revision');
    const terms = parseTerms(row.terms as PurchaseTerms, auth, options.providerId);
    requireValue(terms.requestDigest === digest && row.terms_digest === termsDigest(terms), 'mismatch', 'Stored purchase terms failed immutable binding');
    requireValue(['quoted', 'pending', 'unknown', 'settled', 'rejected'].includes(row.state), 'storage', 'Stored provider sale state is invalid');
    return terms;
  }
  function claimResult(row: SaleRow, auth: AuthorizedRetrieval): DurablePurchaseClaim {
    if (row.state === 'settled') {
      const receipt = parseReceipt(row.receipt as Receipt.Receipt, auth);
      requireValue(referenceIdentity(receipt) === row.receipt_reference, 'storage', 'Stored settlement reference is invalid');
      return Object.freeze({ state: 'settled', receipt });
    }
    requireValue(row.state !== 'quoted' && row.receipt === null && row.receipt_reference === null, 'storage', 'Stored provider sale state is invalid');
    return Object.freeze({ state: row.state });
  }
  async function matchingRow(tx: AtlasTransaction, auth: AuthorizedRetrieval, terms: PurchaseTerms): Promise<SaleRow> {
    const row = await read(tx, auth, true); requireValue(row, 'not-claimed', 'A durable quote and processing claim are required');
    const saved = bound(row, auth, terms.requestDigest);
    requireValue(termsDigest(saved) === termsDigest(terms), 'mismatch', 'Purchase differs from its frozen quote'); return row;
  }
  async function verify(auth: AuthorizedRetrieval, terms: PurchaseTerms, receipt: Receipt.Receipt): Promise<boolean> {
    // Required even when the HTTP adapter already verified the SDK result.
    try { return await options.verifySettlement(auth, terms, receipt) === true; } catch { return false; }
  }
  return Object.freeze({
    quote: async (rawAuth, rawTerms) => {
      const auth = authorization(rawAuth); const proposed = parseTerms(rawTerms, auth, options.providerId);
      await fresh('quote', auth, proposed.requestDigest);
      try { validateTestnetTerms(proposed, now()); } catch { return fail('expired', 'Quote has expired'); }
      requireValue(proposed.expiresAtMs - now() <= 300_000, 'invalid', 'Quote lifetime exceeds the supported testnet bound');
      return transaction(async tx => {
        await lock(tx, auth); await fresh('quote', auth, proposed.requestDigest,tx);
        const row = await read(tx, auth, true);
        if (row) {
          const saved = bound(row, auth, proposed.requestDigest);
          requireValue(termsFields.filter(field => field !== 'expiresAtMs').every(field => saved[field] === proposed[field]) && proposed.expiresAtMs >= saved.expiresAtMs,
            'mismatch', 'Idempotency key has different immutable quote terms');
          requireValue(saved.expiresAtMs > now(), 'expired', 'Frozen quote has expired; it cannot be renewed');
          // A retry has a rolling proposed deadline; return the original deadline
          // without extending or replacing it, as required by the HTTP adapter.
          return saved;
        }
        requireValue(proposed.expiresAtMs > now(), 'expired', 'Quote expired before it was saved');
        await tx.query(`INSERT INTO atlas_provider.sales(provider_id,principal_id,idempotency_key,permission_revision,authorization_digest,
          request_digest,package_name,version,network,terms,terms_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [...key(auth), auth.permissionRevision, authorizationDigest(auth), proposed.requestDigest, proposed.packageName, proposed.version, proposed.network, JSON.stringify(proposed), termsDigest(proposed)]);
        return proposed;
      });
    },
    lookup: async (rawAuth, digest) => {
      const auth = authorization(rawAuth); await fresh('lookup', auth, digest);
      return transaction(async tx => {
        const row = await read(tx, auth); if (!row) return null;
        const terms = bound(row, auth, digest); await fresh('lookup', auth, digest,tx);
        // Quote-only state must not be mistaken for a processing claim by the
        // adapter; otherwise its first credential could never be accepted.
        return row.state === 'quoted' ? null : Object.freeze({ ...claimResult(row, auth), terms });
      });
    },
    claim: async (rawAuth, rawTerms) => {
      const auth = authorization(rawAuth); const terms = parseTerms(rawTerms, auth, options.providerId); await fresh('claim', auth, terms.requestDigest);
      return transaction(async tx => {
        await lock(tx, auth); const row = await matchingRow(tx, auth, terms); await fresh('claim', auth, terms.requestDigest,tx);
        if (row.state !== 'quoted') return claimResult(row, auth);
        if (terms.expiresAtMs <= now()) {
          await tx.query("UPDATE atlas_provider.sales SET state='rejected',updated_at=now() WHERE provider_id=$1 AND principal_id=$2 AND idempotency_key=$3 AND state='quoted'", key(auth));
          return Object.freeze({ state: 'rejected' });
        }
        const result = await tx.query("UPDATE atlas_provider.sales SET state='pending',claimed_at=now(),updated_at=now() WHERE provider_id=$1 AND principal_id=$2 AND idempotency_key=$3 AND state='quoted' RETURNING state", key(auth));
        requireValue(result.rows.length === 1, 'storage', 'Atomic provider processing claim failed');
        return Object.freeze({ state: 'claimed' });
      });
    },
    verifySettlement: async (rawAuth, rawTerms, rawReceipt) => {
      const auth = authorization(rawAuth); const terms = parseTerms(rawTerms, auth, options.providerId); const receipt = parseReceipt(rawReceipt, auth);
      await fresh('verifySettlement', auth, terms.requestDigest);
      await transaction(async tx => { const row = await read(tx, auth); requireValue(row, 'not-claimed', 'A durable processing claim is required');
        const saved = bound(row, auth, terms.requestDigest);
        requireValue(termsDigest(saved) === termsDigest(terms), 'mismatch', 'Purchase differs from its frozen quote');
        requireValue(['pending', 'unknown', 'settled'].includes(row.state), 'not-claimed', 'This quote has no processing claim');
        if (row.state === 'settled') requireValue(receiptIdentity(parseReceipt(row.receipt as Receipt.Receipt, auth)) === receiptIdentity(receipt), 'mismatch', 'Sale already has a different immutable receipt'); });
      const verified = await verify(auth, terms, receipt); await fresh('verifySettlement', auth, terms.requestDigest); return verified;
    },
    saveSettlement: async (rawAuth, rawTerms, rawReceipt) => {
      const auth = authorization(rawAuth); const terms = parseTerms(rawTerms, auth, options.providerId); const receipt = parseReceipt(rawReceipt, auth);
      await fresh('saveSettlement', auth, terms.requestDigest);
      await transaction(async tx => { const row = await read(tx, auth); requireValue(row, 'not-claimed', 'A durable processing claim is required');
        const saved = bound(row, auth, terms.requestDigest);
        requireValue(termsDigest(saved) === termsDigest(terms), 'mismatch', 'Purchase differs from its frozen quote');
        requireValue(['pending', 'unknown', 'settled'].includes(row.state), 'not-claimed', 'This quote has no processing claim'); });
      requireValue(await verify(auth, terms, receipt), 'verification', 'Authoritative settlement verification failed; reconcile without another charge');
      await transaction(async tx => {
        await lock(tx, auth); const row = await matchingRow(tx, auth, terms); await fresh('saveSettlement', auth, terms.requestDigest,tx);
        if (row.state === 'settled') {
          const stored = parseReceipt(row.receipt as Receipt.Receipt, auth);
          requireValue(receiptIdentity(stored) === receiptIdentity(receipt), 'mismatch', 'Sale already has a different immutable receipt'); return;
        }
        requireValue(row.state === 'pending' || row.state === 'unknown', 'not-claimed', 'This quote has no processing claim');
        // The unique provider+network+reference index prevents another sale from
        // accepting this receipt, even when different sale locks are concurrent.
        await tx.query(`UPDATE atlas_provider.sales SET state='settled',receipt=$4::jsonb,receipt_reference=$5,settled_at=now(),updated_at=now()
          WHERE provider_id=$1 AND principal_id=$2 AND idempotency_key=$3 AND state IN ('pending','unknown')`, [...key(auth), JSON.stringify(receipt), referenceIdentity(receipt)]);
      });
    },
    markUnknown: async (rawAuth, rawTerms) => {
      const auth = authorization(rawAuth); const terms = parseTerms(rawTerms, auth, options.providerId); await fresh('markUnknown', auth, terms.requestDigest);
      await transaction(async tx => {
        await lock(tx, auth); const row = await matchingRow(tx, auth, terms); await fresh('markUnknown', auth, terms.requestDigest,tx);
        // A lost settlement COMMIT response may have stored settlement already;
        // never downgrade it. Pending uncertainty remains durable indefinitely.
        if (row.state === 'unknown' || row.state === 'settled') return;
        requireValue(row.state === 'pending', 'not-claimed', 'Unknown outcome requires an existing processing claim');
        await tx.query("UPDATE atlas_provider.sales SET state='unknown',updated_at=now() WHERE provider_id=$1 AND principal_id=$2 AND idempotency_key=$3 AND state='pending'", key(auth));
      });
    },
  });
}
