import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Challenge, Store, BodyDigest } from 'mppx';
import { createTempoTestnetAdapter } from '../../apps/provider/src/tempo-adapter.ts';
import type { TempoProviderConfig, TempoProviderDependencies } from '../../apps/provider/src/tempo-adapter.ts';
import { assertApprovedChallenge } from '../../packages/sdk/src/payment-policy.ts';

function configured() {
  const config: TempoProviderConfig = { providerId: 'unit-test-provider', origin: 'https://provider.example', realm: 'provider.example',
    token: `0x${'1'.repeat(40)}`, recipient: `0x${'2'.repeat(40)}`, decimals: 6, atomicPrice: '1000',
    secretKey: randomBytes(32).toString('base64'), quoteLifetimeMs: 60_000 };
  const now = Date.now(); let state: 'claimed' | 'unknown' | 'pending' = 'claimed';
  const dependencies: TempoProviderDependencies = { now: () => now,
    authorize: vi.fn(async (_request, input) => ({ input, principalId: 'test-principal', permissionRevision: 'test-revision' })),
    quote: vi.fn(async (_authorization, terms) => terms), claim: vi.fn(async () => ({ state })),
    lookup: vi.fn(async () => null),
    verifySettlement: vi.fn(async () => false), saveSettlement: vi.fn(), deliver: vi.fn(),
    markUnknown: vi.fn(async () => { state = 'unknown'; }), replayStore: Store.memory(),
    // Test-only descriptor: no RPC methods, signer or network. Durable stores are not established by these unit tests.
    getClient: vi.fn(() => ({ chain: { id: 42431 } }) as never),
  };
  const body = JSON.stringify({ packageName: '@test/lib', version: '1.0.0', question: 'How does run work?', idempotencyKey: 'test_purchase_12345678' });
  const request = (paid = false) => new Request(`${config.origin}/context/retrieve`, { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', ...(paid ? { 'Payment-Authorization': 'invalid-test-credential' } : {}) } });
  return { config, dependencies, now, body, request, setState: (value: typeof state) => { state = value; } };
}
describe('unwired Tempo testnet adapter', () => {
  it('remains unavailable without every required durable integration', async () => {
    const adapter = createTempoTestnetAdapter(null, null);
    expect(adapter.status).toBe('unavailable'); expect((await adapter.handle(new Request('https://provider.example'))).status).toBe(503);
    const { config, dependencies } = configured();
    expect(() => createTempoTestnetAdapter(config, { ...dependencies, replayStore: undefined } as never)).toThrow('atomic replay');
  });
  it('issues a genuine SDK challenge offline only after exact-version authorization', async () => {
    const { config, dependencies, request, body, now } = configured();
    const adapter = createTempoTestnetAdapter(config, dependencies); const response = await adapter.handle(request());
    expect(response.status).toBe(402); expect(dependencies.authorize).toHaveBeenCalledTimes(1);
    const challenge = Challenge.deserialize(response.headers.get('WWW-Authenticate')!);
    expect(challenge.method).toBe('tempo'); expect(challenge.intent).toBe('charge');
    expect(challenge.request.amount).toBe('1000'); expect(challenge.request.currency).toBe(config.token);
    expect(challenge.request.methodDetails).toMatchObject({ chainId: 42431, supportedModes: ['pull'] });
    expect(() => assertApprovedChallenge(challenge, { origin: config.origin, realm: config.realm, challengeId: challenge.id,
      idempotencyKey: 'test_purchase_12345678', tokenDecimals: config.decimals,
      terms: { providerId: config.providerId, operation: 'context.retrieve', requestDigest: BodyDigest.compute(body), packageName: '@test/lib', version: '1.0.0',
        network: 'eip155:42431', token: config.token, recipient: config.recipient, atomicAmount: config.atomicPrice, expiresAtMs: now + config.quoteLifetimeMs } }, BodyDigest.compute(body), now, `${config.origin}/context/retrieve`)).not.toThrow();
    expect(dependencies.claim).not.toHaveBeenCalled(); expect(dependencies.deliver).not.toHaveBeenCalled(); expect(dependencies.saveSettlement).not.toHaveBeenCalled();
  });
  it('does not generate a charge for unauthorized or unavailable versions', async () => {
    const { config, dependencies, request } = configured();
    dependencies.authorize = vi.fn(async () => { throw new Error('No exact release'); });
    const response = await createTempoTestnetAdapter(config, dependencies).handle(request());
    expect(response.status).toBe(403); expect(response.headers.has('WWW-Authenticate')).toBe(false);
    expect(dependencies.quote).not.toHaveBeenCalled(); expect(dependencies.claim).not.toHaveBeenCalled();
  });
  it('rejects durable quote changes and wrong networks before invoking settlement', async () => {
    const { config, dependencies, request } = configured();
    dependencies.quote = vi.fn(async (_auth, terms) => ({ ...terms, recipient: `0x${'3'.repeat(40)}` }));
    expect((await createTempoTestnetAdapter(config, dependencies).handle(request(true))).status).toBe(409);
    expect(dependencies.claim).not.toHaveBeenCalled();
  });
  it('stops pending/unknown state without SDK resubmission or delivery', async () => {
    const { config, dependencies, request, setState } = configured(); setState('unknown');
    const response = await createTempoTestnetAdapter(config, dependencies).handle(request(true));
    expect(response.status).toBe(409); expect((await response.json()).payment).toBe('unknown');
    expect(dependencies.getClient).not.toHaveBeenCalled(); expect(dependencies.deliver).not.toHaveBeenCalled();
  });
  it('persists uncertainty on an unaccepted credential and stops a second attempt', async () => {
    const { config, dependencies, request } = configured(); const adapter = createTempoTestnetAdapter(config, dependencies);
    const first = await adapter.handle(request(true)); expect(first.status).toBe(503); expect((await first.json()).payment).toBe('unknown');
    expect(dependencies.markUnknown).toHaveBeenCalledTimes(1); expect(dependencies.saveSettlement).not.toHaveBeenCalled();
    expect((await adapter.handle(request(true))).status).toBe(409); expect(dependencies.markUnknown).toHaveBeenCalledTimes(1);
    expect(dependencies.deliver).not.toHaveBeenCalled();
  });
  it('does not issue another charge when a settled durable record cannot yet provide delivery evidence', async () => {
    const { config, dependencies, request, body, now } = configured();
    dependencies.lookup = vi.fn(async () => ({ state: 'settled', terms: {
      providerId: config.providerId, operation: 'context.retrieve', requestDigest: BodyDigest.compute(body),
      packageName: '@test/lib', version: '1.0.0', network: 'eip155:42431', token: config.token,
      recipient: config.recipient, atomicAmount: config.atomicPrice, expiresAtMs: now - 1,
    } }));
    const response = await createTempoTestnetAdapter(config, dependencies).handle(request());
    expect(response.status).toBe(503); expect(response.headers.has('WWW-Authenticate')).toBe(false);
    expect((await response.json()).payment).toBe('unknown');
    expect(dependencies.quote).not.toHaveBeenCalled(); expect(dependencies.claim).not.toHaveBeenCalled();
    expect(dependencies.getClient).not.toHaveBeenCalled(); expect(dependencies.deliver).not.toHaveBeenCalled();
  });
});
