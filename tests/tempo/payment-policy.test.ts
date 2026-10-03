import { describe, expect, it, vi } from 'vitest';
import { BodyDigest, Challenge, PaymentRequest } from 'mppx';
import { assertApprovedChallenge, atomicToDecimal, decimalToAtomic, createApprovedCredential, TEMPO_TESTNET_NETWORK,
  TEMPO_TESTNET_CHAIN_ID } from '../../packages/sdk/src/payment-policy.ts';
import type { ApprovedTestnetPurchase } from '../../packages/sdk/src/payment-policy.ts';

function scenario() {
  const now = Date.now(); const requestDigest = BodyDigest.compute('{"question":"test only"}');
  const approval: ApprovedTestnetPurchase = { origin: 'https://provider.example', realm: 'provider.example', challengeId: 'test-challenge-only',
    idempotencyKey: 'test_purchase_12345678', tokenDecimals: 6,
    terms: { providerId: 'test-provider', operation: 'context.retrieve', packageName: '@test/lib', version: '1.0.0',
      requestDigest, network: TEMPO_TESTNET_NETWORK, token: `0x${'1'.repeat(40)}`, recipient: `0x${'2'.repeat(40)}`,
      atomicAmount: '1000', expiresAtMs: now + 60_000 } };
  const challenge = Challenge.from({ id: approval.challengeId, realm: approval.realm, method: 'tempo', intent: 'charge',
    expires: new Date(approval.terms.expiresAtMs), meta: { providerId: 'test-provider', operation: 'context.retrieve',
      requestDigest, packageName: '@test/lib', version: '1.0.0', idempotencyKey: approval.idempotencyKey },
    request: { amount: '1000', currency: approval.terms.token, recipient: approval.terms.recipient, externalId: approval.idempotencyKey,
      methodDetails: { chainId: TEMPO_TESTNET_CHAIN_ID, supportedModes: ['pull'] } } });
  return { now, approval, requestDigest, challenge };
}
describe('integer quote/signing policy', () => {
  it('converts atomic values to SDK decimal strings without floats or rounding', () => {
    for (const [atomic, decimal] of [['1', '0.000001'], ['1000', '0.001000'], ['9007199254740993001', '9007199254740.993001']]) {
      expect(atomicToDecimal(atomic!, 6)).toBe(decimal); expect(decimalToAtomic(decimal!, 6)).toBe(atomic);
    }
    expect(() => decimalToAtomic('0.0000001', 6)).toThrow('rounding');
    for (const value of ['1e6', '-1', 'NaN', '01', '1.']) expect(() => decimalToAtomic(value, 6)).toThrow();
    expect(() => atomicToDecimal('0', 6)).toThrow(); expect(() => atomicToDecimal('1', 100)).toThrow('decimals');
  });
  it('validates the approved package, network, token, recipient, amount, expiry and request digest', () => {
    const { challenge, approval, now, requestDigest } = scenario();
    expect(() => assertApprovedChallenge(challenge, approval, requestDigest, now, 'https://provider.example/context/retrieve')).not.toThrow();
    const variants = [
      { ...challenge, request: { ...challenge.request, recipient: `0x${'3'.repeat(40)}` } },
      { ...challenge, request: { ...challenge.request, currency: `0x${'3'.repeat(40)}` } },
      { ...challenge, request: { ...challenge.request, amount: '1001' } },
      { ...challenge, request: { ...challenge.request, methodDetails: { chainId: 4217, supportedModes: ['pull'] } } },
      { ...challenge, expires: new Date(approval.terms.expiresAtMs + 1).toISOString() },
      { ...challenge, opaque: PaymentRequest.serialize({ ...challenge.meta!, version: '2.0.0' }) },
      { ...challenge, opaque: PaymentRequest.serialize({ ...challenge.meta!, requestDigest: BodyDigest.compute('altered') }) },
      { ...challenge, request: { ...challenge.request, methodDetails: { chainId: TEMPO_TESTNET_CHAIN_ID, supportedModes: ['push'] } } },
      { ...challenge, request: { ...challenge.request, methodDetails: { chainId: TEMPO_TESTNET_CHAIN_ID, supportedModes: ['pull'], splits: [] } } },
    ];
    for (const variant of variants) expect(() => assertApprovedChallenge(variant, approval, requestDigest, now, 'https://provider.example/context/retrieve')).toThrow();
    expect(() => assertApprovedChallenge(challenge, approval, BodyDigest.compute('different request'), now, 'https://provider.example/context/retrieve')).toThrow('digest');
    expect(() => assertApprovedChallenge(challenge, approval, requestDigest, approval.terms.expiresAtMs, 'https://provider.example/context/retrieve')).toThrow('Expired');
    expect(() => assertApprovedChallenge(challenge, approval, requestDigest, now, 'https://altered.example/context/retrieve')).toThrow('provider route');
  });
  it('rejects pending, unknown or settled purchases before touching the caller signer', async () => {
    const { challenge, approval, now, requestDigest } = scenario(); const signer = vi.fn();
    for (const state of ['pending', 'unknown', 'settled', 'failed'] as const) {
      await expect(createApprovedCredential({ challenge, providerUrl: 'https://provider.example/context/retrieve', createCredential: signer }, approval, requestDigest,
        { claimSigning: async () => state, markUnknown: vi.fn(), now: () => now })).rejects.toThrow('cannot be retried');
    }
    expect(signer).not.toHaveBeenCalled();
  });
  it('keeps a failed caller-owned signing attempt unknown and never retries it', async () => {
    const { challenge, approval, now, requestDigest } = scenario(); const signer = vi.fn(async () => { throw new Error('test signer unavailable'); });
    let state: 'claimed' | 'unknown' = 'claimed'; const markUnknown = vi.fn(async () => { state = 'unknown'; });
    const dependencies = { claimSigning: async () => state, markUnknown, now: () => now };
    await expect(createApprovedCredential({ challenge, providerUrl: 'https://provider.example/context/retrieve', createCredential: signer }, approval, requestDigest, dependencies)).rejects.toThrow('unknown');
    await expect(createApprovedCredential({ challenge, providerUrl: 'https://provider.example/context/retrieve', createCredential: signer }, approval, requestDigest, dependencies)).rejects.toThrow('cannot be retried');
    expect(signer).toHaveBeenCalledTimes(1); expect(markUnknown).toHaveBeenCalledTimes(1);
  });
  it('rechecks mutable challenge data after the durable reservation before signing', async () => {
    const { challenge, approval, now, requestDigest } = scenario(); const signer = vi.fn(); const markUnknown = vi.fn();
    await expect(createApprovedCredential({ challenge, providerUrl: 'https://provider.example/context/retrieve', createCredential: signer }, approval, requestDigest,
      { claimSigning: async () => { challenge.request.amount = '9999'; return 'claimed'; }, markUnknown, now: () => now })).rejects.toThrow('unknown');
    expect(signer).not.toHaveBeenCalled(); expect(markUnknown).toHaveBeenCalledTimes(1);
  });
});
