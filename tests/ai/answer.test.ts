import { afterEach, expect, it, vi } from 'vitest';
import { indexFixture } from '../../apps/worker/src/fixture-service.ts';
import { answerWithAi } from '../../packages/core/src/ai/answer.ts';
import { parseAiProviderConfig } from '../../packages/core/src/ai/providers.ts';
import type { AiProviders } from '../../packages/core/src/ai/providers.ts';
import { answerFixtureWithAi } from '../../apps/worker/src/ai-service.ts';
import { POST } from '../../apps/web/src/app/api/ai/questions/route.ts';
const config = parseAiProviderConfig({ VOYAGE_API_KEY: 'test-voyage', DEEPSEEK_API_KEY: 'test-deepseek' });
function providers(): AiProviders {
  return { embed: vi.fn(async inputs => inputs.map(() => [1, 0])),
    rerank: vi.fn(async (_query, documents) => documents.map((_, index) => ({ index, relevanceScore: 1 / (index + 1) }))),
    generate: vi.fn(async () => JSON.stringify({ abstained: false, claims: [{ text: 'Source describes retry behavior.', sourceIds: ['S1'] }], limitations: [] })) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('uses Voyage embedding/reranking then DeepSeek, with canonical immutable source citations', async () => {
  const index = await indexFixture('retry-kit@2.0.0'); const api = providers();
  const answer = await answerWithAi(index, 'How are retries handled?', api, config);
  expect(answer.mode).toBe('voyage-deepseek'); expect(answer.models.generation).toBe('deepseek-flash');
  expect(answer.citations).toHaveLength(1); expect(index.evidence).toContainEqual(answer.citations[0]);
  expect(answer.citations[0]?.source.snapshotId).toBe('retry-kit@2.0.0');
  expect(api.embed).toHaveBeenCalledTimes(2); expect(api.rerank).toHaveBeenCalledOnce(); expect(api.generate).toHaveBeenCalledOnce();
  const context = JSON.parse(vi.mocked(api.generate).mock.calls[0]![1]);
  expect(context.snapshot.revision).toBe(index.snapshot.revision); expect(context.evidence[0].source).toBe(answer.citations[0]?.original);
  expect(answer.activities.map(a => a.operation)).toEqual(['voyage.embed.documents', 'voyage.embed.query', 'voyage.rerank', 'deepseek.generate']);
});
it.each(['retry-kit 9.0.0 behavior', 'Prove no production job ever fails'])('abstains before any external call for %s', async question => {
  const api = providers(); const result = await answerWithAi(await indexFixture('retry-kit@2.0.0'), question, api, config);
  expect(result.status).toBe('abstained'); expect(api.embed).not.toHaveBeenCalled(); expect(api.generate).not.toHaveBeenCalled();
});
it.each([
  { abstained: false, claims: [{ text: 'fabricated', sourceIds: ['S999'] }], limitations: [] },
  { abstained: false, claims: [{ text: 'uncited', sourceIds: [] }], limitations: [] },
  { abstained: true, claims: [{ text: 'claim despite abstention', sourceIds: ['S1'] }], limitations: [] },
])('rejects invalid generated evidence without any fallback', async output => {
  const api = providers(); vi.mocked(api.generate).mockResolvedValue(JSON.stringify(output));
  await expect(answerWithAi(await indexFixture('retry-kit@1.0.0'), 'retry', api, config)).rejects.toThrow('grounded evidence');
  expect(api.generate).toHaveBeenCalledOnce();
});
it('does not generate after an embedding failure', async () => {
  const api = providers(); vi.mocked(api.embed).mockRejectedValue(new Error('unavailable'));
  await expect(answerWithAi(await indexFixture('retry-kit@1.0.0'), 'retry', api, config)).rejects.toThrow('unavailable');
  expect(api.embed).toHaveBeenCalledOnce(); expect(api.rerank).not.toHaveBeenCalled(); expect(api.generate).not.toHaveBeenCalled();
});
it('does not send source for disabled/missing configuration, absent consent, or unsupported snapshots', async () => {
  const outbound = vi.spyOn(globalThis, 'fetch');
  const env = { ATLAS_MODE: 'fixture', ATLAS_AI_ENABLED: 'true', VOYAGE_API_KEY: 'test', DEEPSEEK_API_KEY: 'test' };
  await expect(answerFixtureWithAi('retry-kit@1.0.0', 'retry', true, {})).rejects.toThrow('unavailable');
  await expect(answerFixtureWithAi('retry-kit@1.0.0', 'retry', false, env)).rejects.toThrow('approval');
  await expect(answerFixtureWithAi('retry-kit@1.0.0', 'retry', true, { ...env, DEEPSEEK_API_KEY: '' })).rejects.toThrow();
  await expect(answerFixtureWithAi('../../private', 'retry', true, env)).rejects.toThrow('Unsupported');
  expect(outbound).not.toHaveBeenCalled();
});
it('HTTP boundary rejects remote/forged origin, missing launcher marker and missing disclosure before egress', async () => {
  const outbound = vi.spyOn(globalThis, 'fetch');
  vi.stubEnv('ATLAS_LOOPBACK_SERVER', 'true');
  const request = (url: string, origin: string, approved = true) => new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ fixtureId: 'retry-kit@1.0.0', question: 'retry', approveAiDisclosure: approved }) });
  expect((await POST(request('https://example.com/api/ai/questions', 'https://example.com'))).status).toBe(403);
  expect((await POST(request('http://localhost:3000/api/ai/questions', 'https://untrusted.example'))).status).toBe(403);
  expect((await POST(request('http://localhost:3000/api/ai/questions', 'http://localhost:3000', false))).status).toBe(403);
  vi.stubEnv('ATLAS_LOOPBACK_SERVER', 'false');
  expect((await POST(request('http://localhost:3000/api/ai/questions', 'http://localhost:3000'))).status).toBe(403);
  expect(outbound).not.toHaveBeenCalled();
});
it('runs the whole approved HTTP answer flow through native Voyage and DeepSeek clients with mocked transport', async () => {
  for (const [key, value] of Object.entries({ ATLAS_LOOPBACK_SERVER: 'true', ATLAS_MODE: 'fixture', ATLAS_AI_ENABLED: 'true', VOYAGE_API_KEY: 'test-voyage', DEEPSEEK_API_KEY: 'test-deepseek', VOYAGE_EMBEDDING_MODEL: 'voyage-code-3', VOYAGE_RERANK_MODEL: 'rerank-2.5', DEEPSEEK_MODEL: 'deepseek-flash', DEEPSEEK_THINKING: 'disabled' })) vi.stubEnv(key, value);
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    urls.push(String(url)); const body = JSON.parse(init!.body as string);
    if (String(url).endsWith('/embeddings')) return Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: [1, ...Array(1023).fill(0)] })) });
    if (String(url).endsWith('/rerank')) return Response.json({ data: body.documents.map((_: string, index: number) => ({ index, relevance_score: 1 / (index + 1) })) });
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions');
    expect(init?.redirect).toBe('error'); expect(body.model).toBe('deepseek-flash');
    return Response.json({ model: 'deepseek-flash', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ abstained: false, claims: [{ text: 'A mocked grounded claim.', sourceIds: ['S1'] }], limitations: [] }) } }] });
  });
  const response = await POST(new Request('http://localhost:3000/api/ai/questions', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' }, body: JSON.stringify({ fixtureId: 'retry-kit@2.0.0', question: 'retry', approveAiDisclosure: true }) }));
  expect(response.status).toBe(200); const answer = await response.json();
  expect(answer.mode).toBe('voyage-deepseek'); expect(answer.citations[0].source.snapshotId).toBe('retry-kit@2.0.0');
  expect(urls).toEqual(['https://api.voyageai.com/v1/embeddings', 'https://api.voyageai.com/v1/embeddings', 'https://api.voyageai.com/v1/rerank', 'https://api.deepseek.com/chat/completions']);
});
