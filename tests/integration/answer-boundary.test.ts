import { it, expect, vi } from 'vitest';
import { indexFixture } from '../../apps/worker/src/fixture-service.ts';
import { answerLocal, lookupSource, validateLocalAnswer } from '../../packages/core/src/local/index.ts';
import { AtlasFixtureClient } from '../../packages/sdk/src/fixture.ts';
import { federateFixture } from '../../apps/worker/src/federation.ts';
it('rejects forged citation scope, provenance and answer graph identities', async () => {
  const index = await indexFixture('retry-kit@2.0.0'); const answer = answerLocal(index, 'permanent errors');
  for (const patch of [{ scope: { ...index.scope, principalId: 'forged' } }, { provenance: 'model-inferred' }, { observedAt: 'not-a-date' }]) {
    const changed = { ...answer, citations: [{ ...answer.citations[0], ...patch }] };
    expect(() => validateLocalAnswer(changed, index)).toThrow();
  }
  expect(() => validateLocalAnswer({ ...answer, nodeIds: ['invented'] }, index)).toThrow();
});
it('binds SDK source responses to the exact requested path and range', async () => {
  const index = await indexFixture('retry-kit@2.0.0');
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => Response.json(String(input).includes('/api/fixtures') ? index : lookupSource(index, 'package.json', 1, 1), { headers: { 'X-Atlas-Mode': 'fixture' } }));
  try { await expect(new AtlasFixtureClient().source('retry-kit@2.0.0', 'src/index.ts', 1, 1)).rejects.toThrow('requested location'); }
  finally { mock.mockRestore(); }
});
it('rejects forged provider answer metadata at the federation boundary', async () => {
  const index = await indexFixture('retry-kit@1.0.0'); const answer = answerLocal(index, 'retry');
  const response = { schemaVersion: 1, mode: 'fixture', providerId: 'fixture-retry', payment: 'not-attempted', index,
    answer: { ...answer, citations: [{ ...answer.citations[0], scope: { ...index.scope, principalId: 'forged' } }] } };
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(response));
  try { await expect(federateFixture('jobboard-app@1.0.0', ['fixture-retry'], 'retry')).rejects.toThrow('Noncanonical'); }
  finally { mock.mockRestore(); }
});
