import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Real loopback HTTP executes. The strict provider factory is an explicit
// rejection sentinel: no database, key, source artifact, RPC or payment occurs.
const factory = vi.hoisted(() => ({ loaded: vi.fn(), createIndependentProvider: vi.fn(async () => { throw new Error('Synthetic normal configuration refused'); }) }));
vi.mock('../../apps/provider/src/runtime.ts', () => { factory.loaded(); return { createIndependentProvider: factory.createIndependentProvider }; });
import { createProviderServer } from '../../apps/provider/src/main.ts';
import { createProviderPreparationServer } from '../../apps/provider/src/preparation.ts';
const servers: Server[] = [];
async function preparation() {
  const server = createProviderPreparationServer();
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Loopback preparation test unavailable');
  return { origin: `http://127.0.0.1:${address.port}` };
}
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  vi.clearAllMocks();
});
describe('real inactive provider preparation listener', () => {
  it('health reports 503 and explicit owner approval/payment inactivity without initializing a provider', async () => {
    const { origin } = await preparation();
    const response = await fetch(origin + '/health'); expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ mode: 'tempo-testnet', ready: false, publication: 'awaiting-owner-approval', payments: 'inactive' });
    expect(factory.createIndependentProvider).not.toHaveBeenCalled(); expect(factory.loaded).not.toHaveBeenCalled();
  });
  it.each(['/context/retrieve', '/context/recovery', '/context/resume', '/.well-known/atlas-provider.json', '/control', '/api/purchases', '/unexpected'])('keeps %s unavailable without credentials, source, quote or metadata handlers', async path => {
    const { origin } = await preparation();
    const response = await fetch(origin + path + '?nonce=SYNTHETIC_NONCE', { method: 'POST', headers: { Authorization: 'Bearer SYNTHETIC_SESSION_CREDENTIAL', 'Payment-Authorization': 'SYNTHETIC_PAYMENT_CREDENTIAL', 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'SYNTHETIC_PRIVATE_SOURCE', providerId: 'SYNTHETIC_ID_MUST_NOT_BE_EXPOSED' }) });
    expect(response.status).toBe(503);
    for (const header of ['www-authenticate', 'payment-receipt', 'payment-authorization']) expect(response.headers.get(header)).toBeNull();
    const text = await response.text(); expect(text).not.toContain('SYNTHETIC_');
    expect(JSON.parse(text)).toEqual({ mode: 'tempo-testnet', ready: false, publication: 'awaiting-owner-approval', payments: 'inactive' });
    expect(factory.createIndependentProvider).not.toHaveBeenCalled(); expect(factory.loaded).not.toHaveBeenCalled();
  });
  it('HEAD health is unavailable and has no successful-payment headers or body', async () => {
    const { origin } = await preparation(); const response = await fetch(origin + '/health', { method: 'HEAD' });
    expect(response.status).toBe(503); expect(await response.text()).toBe(''); expect(response.headers.get('payment-receipt')).toBeNull();
    expect(factory.createIndependentProvider).not.toHaveBeenCalled(); expect(factory.loaded).not.toHaveBeenCalled();
  });
  it('normal runtime remains strict and does not fall back to preparation on missing configuration', async () => {
    await expect(createProviderServer([], {})).rejects.toThrow('Synthetic normal configuration refused');
    expect(factory.createIndependentProvider).toHaveBeenCalledExactlyOnceWith({});
  });
  it.each([['--prepare'], ['--prepare', '--prepare'], ['--prepare', '--install'], ['--unknown'], ['--prepare', '--source', 'SYNTHETIC_PRIVATE_SOURCE']])('rejects unsupported direct runtime arguments before initializing handlers: %j', async (...args) => {
    await expect(createProviderServer(args, {})).rejects.toThrow('dedicated preparation launcher'); expect(factory.createIndependentProvider).not.toHaveBeenCalled();
  });
});
