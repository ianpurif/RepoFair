import { Challenge, PaymentRequest } from 'mppx';
import { tempoModerato } from 'viem/tempo/chains';
import type { PurchaseTerms } from '../../contracts/src/index.ts';
import { assertPositiveAtomic } from '../../core/src/amounts.ts';
import { isExactVersion } from '../../core/src/versions.ts';

export const TEMPO_TESTNET_CHAIN_ID = tempoModerato.id;
export const TEMPO_TESTNET_NETWORK = `eip155:${TEMPO_TESTNET_CHAIN_ID}`;
export type ApprovedTestnetPurchase = Readonly<{
  terms: PurchaseTerms; origin: string; realm: string; challengeId: string;
  idempotencyKey: string; tokenDecimals: number;
}>;
function requirePolicy(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function address(value: unknown): value is `0x${string}` { return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) && !/^0x0{40}$/i.test(value); }
function decimals(value: number): void { requirePolicy(Number.isSafeInteger(value) && value >= 0 && value <= 18, 'Invalid token decimals'); }

/** SDK amount inputs are decimal strings; wire challenge amounts are atomic integers. Never round. */
export function atomicToDecimal(value: string, tokenDecimals: number): string {
  decimals(tokenDecimals); assertPositiveAtomic(value);
  if (!tokenDecimals) return value;
  const padded = value.padStart(tokenDecimals + 1, '0');
  return `${padded.slice(0, -tokenDecimals)}.${padded.slice(-tokenDecimals)}`;
}
export function decimalToAtomic(value: string, tokenDecimals: number): string {
  decimals(tokenDecimals);
  requirePolicy(typeof value === 'string' && value.length <= 100 && /^(0|[1-9]\d*)(?:\.\d+)?$/.test(value), 'Invalid decimal amount');
  const [whole, fraction = ''] = value.split('.');
  requirePolicy(fraction.length <= tokenDecimals, 'Decimal amount would require rounding');
  const units = BigInt(`${whole}${fraction.padEnd(tokenDecimals, '0')}`).toString(); assertPositiveAtomic(units); return units;
}
export function validateTestnetTermsShape(terms: PurchaseTerms): void {
  requirePolicy(object(terms) && terms.operation === 'context.retrieve' && typeof terms.providerId === 'string' && terms.providerId.length > 0
    && typeof terms.packageName === 'string' && terms.packageName.length > 0 && typeof terms.version === 'string' && isExactVersion(terms.version), 'Invalid purchase identity');
  requirePolicy(terms.network === TEMPO_TESTNET_NETWORK && address(terms.token) && address(terms.recipient), 'Only configured Tempo testnet addresses are supported');
  requirePolicy(typeof terms.requestDigest === 'string' && /^sha-256=[A-Za-z0-9+/]{43}=$/.test(terms.requestDigest), 'Invalid request body digest');
  requirePolicy(Number.isSafeInteger(terms.expiresAtMs) && terms.expiresAtMs > 0, 'Invalid payment expiry');
  assertPositiveAtomic(terms.atomicAmount);
}
export function validateTestnetTerms(terms: PurchaseTerms, nowMs: number): void {
  validateTestnetTermsShape(terms);
  requirePolicy(Number.isSafeInteger(nowMs) && terms.expiresAtMs > nowMs, 'Expired payment terms');
}
/** Accept an already parsed official SDK challenge. This never authenticates a provider or approves spending. */
export function assertApprovedChallenge(rawChallenge: unknown, approval: ApprovedTestnetPurchase,
  actualRequestDigest: string, nowMs: number, actualProviderUrl: string): void {
  validateTestnetTerms(approval.terms, nowMs); decimals(approval.tokenDecimals);
  const origin = new URL(approval.origin);
  requirePolicy(origin.protocol === 'https:' && origin.origin === approval.origin && !origin.username && !origin.password, 'Approved provider origin must be exact HTTPS');
  const provider = new URL(actualProviderUrl);
  requirePolicy(provider.origin === approval.origin && !provider.username && !provider.password && provider.pathname === '/context/retrieve'
    && !provider.search && !provider.hash, 'Response URL differs from the approved provider route');
  requirePolicy(typeof approval.idempotencyKey === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(approval.idempotencyKey), 'Invalid purchase idempotency key');
  const challenge = Challenge.Schema.parse(rawChallenge);
  requirePolicy(challenge.method === 'tempo' && challenge.intent === 'charge' && challenge.id === approval.challengeId
    && challenge.realm === approval.realm && typeof challenge.expires === 'string'
    && Date.parse(challenge.expires) === approval.terms.expiresAtMs, 'Challenge identity or expiry differs from approval');
  requirePolicy(actualRequestDigest === approval.terms.requestDigest
    && (challenge.digest === undefined || challenge.digest === actualRequestDigest), 'Request body digest differs from approval');
  requirePolicy(typeof challenge.opaque === 'string', 'Bound challenge metadata is missing');
  const meta = PaymentRequest.deserialize(challenge.opaque);
  const expected = { providerId: approval.terms.providerId, operation: approval.terms.operation,
    requestDigest: actualRequestDigest, packageName: approval.terms.packageName, version: approval.terms.version, idempotencyKey: approval.idempotencyKey };
  for (const [field, value] of Object.entries(expected)) requirePolicy(meta[field] === value, `Challenge ${field} differs from approval`);
  const request = challenge.request;
  requirePolicy(request.amount === approval.terms.atomicAmount && typeof request.currency === 'string'
    && request.currency.toLowerCase() === approval.terms.token.toLowerCase() && typeof request.recipient === 'string'
    && request.recipient.toLowerCase() === approval.terms.recipient.toLowerCase()
    && request.externalId === approval.idempotencyKey, 'Challenge amount, token or recipient differs from approval');
  const details = request.methodDetails;
  requirePolicy(object(details) && details.chainId === TEMPO_TESTNET_CHAIN_ID && details.feePayer !== true
    && details.machineTokenEnabled !== true && details.splits === undefined && Array.isArray(details.supportedModes)
    && details.supportedModes.length === 1 && details.supportedModes[0] === 'pull', 'Unsupported network, sponsorship, split or broadcast mode');
}

export type SigningPolicyDependencies = Readonly<{
  /** Atomically reserve the approved allowance and persist signing-pending; only the first claimant returns claimed. */
  claimSigning(approval: ApprovedTestnetPurchase): Promise<'claimed' | 'pending' | 'unknown' | 'settled' | 'failed'>;
  /** Persist uncertainty without releasing the allowance. Failure must leave the durable pending claim intact. */
  markUnknown(approval: ApprovedTestnetPurchase): Promise<void>;
  now(): number;
}>;
/** Caller supplies the official prepared payment and owns its signer. No fetch interception, key loading or retry. */
export async function createApprovedCredential(prepared: Readonly<{ challenge: unknown; providerUrl: string; createCredential(): Promise<string> }>,
  approved: ApprovedTestnetPurchase, actualRequestDigest: string, dependencies: SigningPolicyDependencies): Promise<string> {
  const approval: ApprovedTestnetPurchase = Object.freeze({ ...approved, terms: Object.freeze({ ...approved.terms }) });
  assertApprovedChallenge(prepared.challenge, approval, actualRequestDigest, dependencies.now(), prepared.providerUrl);
  const state = await dependencies.claimSigning(approval);
  requirePolicy(state === 'claimed', `Purchase is ${state}; signing cannot be retried`);
  try {
    assertApprovedChallenge(prepared.challenge, approval, actualRequestDigest, dependencies.now(), prepared.providerUrl);
    const credential = await prepared.createCredential();
    requirePolicy(typeof credential === 'string' && credential.length > 0 && credential.length <= 32_768, 'Official signer did not return a bounded credential');
    return credential;
  } catch {
    try { await dependencies.markUnknown(approval); } catch { /* The durable pending claim must remain reserved. */ }
    throw new Error('Signing outcome is unknown; reconcile this purchase before any new attempt');
  }
}
