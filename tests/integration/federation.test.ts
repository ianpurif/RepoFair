import { beforeAll, afterAll, it, expect } from 'vitest';
import { once } from 'node:events';
import { createFixtureProvider } from '../../apps/provider/src/fixture-server.ts';
import { federateFixture, discoverFixtureProviders } from '../../apps/worker/src/federation.ts';
const servers = [createFixtureProvider('fixture-retry', true), createFixtureProvider('fixture-events', true)];
beforeAll(async () => {
  for (let i = 0; i < servers.length; i++) { const server = servers[i]!; server.listen(4311 + i, '127.0.0.1'); await once(server, 'listening'); }
});
afterAll(async () => { await Promise.all(servers.map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
it('uses two independently configured HTTP endpoints and real version/export joins', async () => {
  const discovery = await discoverFixtureProviders(); expect(discovery.map(p => p.published)).toEqual([true,true]);
  const result = await federateFixture('jobboard-app@1.0.0', ['fixture-retry','fixture-events'], 'How are retries recorded and delayed?');
  expect(result.providers.map(p => p.providerId)).toEqual(['fixture-retry','fixture-events']);
  expect(result.edges.filter(e => e.id.includes('fixture-join'))).toHaveLength(2);
  expect(result.providers.every(p => p.payment === 'not-attempted')).toBe(true);
  expect(result.citations.length).toBeGreaterThan(0);
});
it('new buyer snapshot resolves retry-kit2 and makes old source inapplicable', async () => {
  const result = await federateFixture('jobboard-app@2.0.0', ['fixture-retry'], 'What happens for permanent errors?');
  expect(result.providers[0]?.index.version).toBe('2.0.0');
  expect(result.providers[0]?.index.files.some(f => f.text.includes('if (error.permanent === true) return false'))).toBe(true);
  expect(result.nodes.some(n => n.snapshotId === 'retry-kit@1.0.0')).toBe(false);
});
it('rejects unknown endpoints, excess approvals and unsupported exact versions before payment', async () => {
  await expect(federateFixture('jobboard-app@1.0.0', ['http://169.254.169.254'], 'retry')).rejects.toThrow('Approve');
  await expect(federateFixture('jobboard-app@1.0.0', ['fixture-retry','fixture-retry'], 'retry')).rejects.toThrow('Approve');
  const response = await fetch('http://127.0.0.1:4311/context/retrieve', { method: 'POST', body: JSON.stringify({ packageName: '@atlas-fixture/retry-kit', version: '9.0.0', question: 'retry' }) });
  expect(response.status).toBe(422); expect(response.headers.get('payment-receipt')).toBeNull(); expect((await response.json()).charged).toBe(false);
});
it('denies browser-origin provider calls', async () => {
  const response = await fetch('http://127.0.0.1:4311/health', { headers: { origin: 'https://untrusted.example' } });
  expect(response.status).toBe(403);
});
