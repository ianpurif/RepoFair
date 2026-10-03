import type { PaymentState, DeliveryState, PurchaseTerms } from '../../contracts/src/index.ts';
import { assertPositiveAtomic } from './amounts.ts';
import { requireCondition } from './errors.ts';
import { isExactVersion } from './versions.ts';
const paymentTransitions: Record<PaymentState, readonly PaymentState[]> = {
  draft: ['approved', 'expired'], approved: ['reserved', 'expired'], reserved: ['pending', 'failed', 'expired'],
  pending: ['settled', 'unknown', 'failed'], unknown: ['settled', 'failed'], settled: [], failed: [], expired: [],
};
/** State validation is not receipt verification. The trusted MPP adapter must verify outcomes first. */
export function nextPayment(current: PaymentState, next: PaymentState): PaymentState {
  requireCondition(current === next || paymentTransitions[current].includes(next), 'INVALID_TRANSITION', 'Payment transition not allowed.');
  return next;
}
const deliveryTransitions: Record<DeliveryState, readonly DeliveryState[]> = {
  'not-started': ['awaiting-payment'], 'awaiting-payment': ['running', 'revoked'],
  running: ['ready', 'failed', 'revoked'], failed: ['running', 'revoked'], ready: ['revoked'], revoked: [],
};
export function nextDelivery(current: DeliveryState, next: DeliveryState, payment: PaymentState): DeliveryState {
  requireCondition(current === next || deliveryTransitions[current].includes(next), 'INVALID_TRANSITION', 'Delivery transition not allowed.');
  if (next === 'running' || next === 'ready') requireCondition(payment === 'settled', 'PAYMENT_REQUIRED', 'Verified settlement is required.');
  return next;
}
/** Immutable comparable tuple; use a cryptographic digest in the final payment adapter. */
export function termsIdentity(t: PurchaseTerms, nowMs: number): string {
  requireCondition(Number.isFinite(nowMs) && Number.isSafeInteger(t.expiresAtMs) && t.expiresAtMs > nowMs,
    'EXPIRED_TERMS', 'Offer is expired or invalid.');
  assertPositiveAtomic(t.atomicAmount);
  requireCondition(isExactVersion(t.version), 'EXACT_VERSION_REQUIRED', 'Version must be exact.');
  requireCondition([t.providerId,t.requestDigest,t.packageName,t.network,t.token,t.recipient].every(v => v.length > 0),
    'INVALID_TERMS', 'Payment terms are incomplete.');
  return JSON.stringify([t.providerId,t.operation,t.requestDigest,t.packageName,t.version,t.network,t.token,t.recipient,t.atomicAmount,t.expiresAtMs]);
}
