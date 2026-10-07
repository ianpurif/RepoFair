import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_PROVIDER_LIMITS, AiProviderError, createAiProviders, parseAiProviderConfig } from '../../packages/core/src/ai/providers.ts';

// Offline HTTP mocks only: these tests do not use credentials, spend money, or certify live APIs.
const config = parseAiProviderConfig({ VOYAGE_API_KEY: 'offline-voyage-key', DEEPSEEK_API_KEY: 'offline-deepseek-key' });
const vector = (value = 0.25) => Array.from({ length: 1024 }, () => value);
const generation = (content = '{"answer":"source-grounded"}') => ({
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, reasoning_content: 'discard this' } }],
});
function mocked(payload: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(payload));
  return { fetch, providers: createAiProviders(config, { fetch }) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('native provider configuration', () => {
  it('selects explicit supported defaults and allows documented models', () => {
    expect(config).toMatchObject({ voyageEmbeddingModel: 'voyage-code-3', voyageRerankModel: 'rerank-2.5',
      deepseekModel: 'deepseek-flash', deepseekThinking: 'disabled' });
    expect(parseAiProviderConfig({ VOYAGE_API_KEY: 'offline', DEEPSEEK_API_KEY: 'offline',
      VOYAGE_EMBEDDING_MODEL: 'voyage-4-large', VOYAGE_RERANK_MODEL: 'rerank-2.5-lite',
      DEEPSEEK_MODEL: 'deepseek-v4-pro', DEEPSEEK_THINKING: 'enabled' })).toMatchObject({
      deepseekModel: 'deepseek-v4-pro', deepseekThinking: 'enabled', voyageEmbeddingModel: 'voyage-4-large',
    });
  });
  it.each([
    { VOYAGE_API_KEY: undefined }, { DEEPSEEK_API_KEY: '' }, { VOYAGE_API_KEY: 'key\nunsafe' },
    { VOYAGE_EMBEDDING_MODEL: 'unknown-embedding' }, { VOYAGE_RERANK_MODEL: 'unknown-rerank' },
    { DEEPSEEK_MODEL: 'deepseek-chat' }, { DEEPSEEK_MODEL: 'deepseek-reasoner' },
    { DEEPSEEK_MODEL: 'deepseek-v4-flash' }, { DEEPSEEK_THINKING: 'maybe' },
  ])('rejects missing keys and unsupported configuration without substitutions (%j)', override => {
    expect(() => parseAiProviderConfig({ VOYAGE_API_KEY: 'offline', DEEPSEEK_API_KEY: 'offline', ...override })).toThrow(AiProviderError);
  });
  it('rejects browser execution before accepting credentials', () => {
    vi.stubGlobal('document', {});
    expect(() => parseAiProviderConfig({ VOYAGE_API_KEY: 'offline', DEEPSEEK_API_KEY: 'offline' })).toThrow(AiProviderError);
    expect(() => createAiProviders(config)).toThrow(AiProviderError);
  });
  it('revalidates direct configuration and bounded timeout options', () => {
    expect(() => createAiProviders({ ...config, voyageApiKey: '' })).toThrow(AiProviderError);
    for (const timeoutMs of [0, -1, Infinity, 1.5, 120001]) {
      expect(() => createAiProviders(config, { timeoutMs })).toThrow(AiProviderError);
    }
  });
});

describe('Voyage native embeddings', () => {
  it('uses the official fixed endpoint and binds every vector to its input index', async () => {
    const { fetch, providers } = mocked({ data: [{ index: 1, embedding: vector(2) }, { index: 0, embedding: vector(1) }] });
    const embeddings = await providers.embed(['first', 'second'], 'document');
    expect(embeddings[0]?.[0]).toBe(1); expect(embeddings[1]?.[0]).toBe(2);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.voyageai.com/v1/embeddings');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
      headers: { Authorization: 'Bearer offline-voyage-key' } });
    expect(JSON.parse(String(init?.body))).toEqual({ input: ['first', 'second'], model: 'voyage-code-3',
      input_type: 'document', output_dimension: 1024, output_dtype: 'float', truncation: false });
  });
  it.each([
    { data: [] }, { data: [{ index: 0, embedding: [1] }] },
    { data: [{ index: -1, embedding: vector() }] }, { data: [{ index: 1, embedding: vector() }] },
    { data: [{ index: 0.5, embedding: vector() }] }, { data: [{ index: 0, embedding: vector(NaN) }] },
    { data: [{ index: 0, embedding: [...vector().slice(1), 'text'] }] },
  ])('rejects malformed counts, indexes, dimensions and nonnumeric vectors (%#)', async payload => {
    const { providers } = mocked(payload);
    await expect(providers.embed(['source'], 'query')).rejects.toMatchObject({ code: 'response' });
  });
  it('rejects duplicate indexes even when the response count is correct', async () => {
    const { providers } = mocked({ data: [{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }] });
    await expect(providers.embed(['source one', 'source two'], 'document')).rejects.toMatchObject({ code: 'response' });
  });
  it('bounds input count, UTF-8 bytes and total request content before HTTP', async () => {
    const { fetch, providers } = mocked({});
    for (const inputs of [[], [''], ['😀'.repeat(4001)], Array.from({ length: 129 }, () => 'x'),
      Array.from({ length: 128 }, () => 'x'.repeat(2100))]) {
      await expect(providers.embed(inputs, 'document')).rejects.toMatchObject({ code: 'input' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Voyage native reranking', () => {
  it('returns document indexes with finite relevance scores from the official rerank endpoint', async () => {
    const { fetch, providers } = mocked({ data: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] });
    await expect(providers.rerank('query', ['first', 'second'])).resolves.toEqual([
      { index: 1, relevanceScore: 0.9 }, { index: 0, relevanceScore: 0.2 },
    ]);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.voyageai.com/v1/rerank');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ query: 'query', documents: ['first', 'second'],
      model: 'rerank-2.5', top_k: 2, return_documents: false, truncation: false });
  });
  it.each([
    { data: [] }, { data: [{ index: 1, relevance_score: 0.5 }] },
    { data: [{ index: 0, relevance_score: null }] }, { data: [{ index: 0, relevance_score: 1.01 }] },
  ])('rejects invalid result counts, indexes and scores (%#)', async payload => {
    await expect(mocked(payload).providers.rerank('query', ['source'])).rejects.toMatchObject({ code: 'response' });
  });
  it('rejects duplicate rerank indexes', async () => {
    const payload = { data: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0.5 }] };
    await expect(mocked(payload).providers.rerank('query', ['first', 'second'])).rejects.toMatchObject({ code: 'response' });
  });
});

describe('DeepSeek native generation', () => {
  it('uses the official endpoint, JSON format and explicit thinking mode without exposing reasoning', async () => {
    const { fetch, providers } = mocked(generation());
    await expect(providers.generate('Ground answers in supplied sources.', 'question')).resolves.toBe('{"answer":"source-grounded"}');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer offline-deepseek-key' });
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'deepseek-flash', thinking: { type: 'disabled' },
      messages: [{ role: 'system', content: 'Ground answers in supplied sources.\nReturn a single valid JSON object.' },
        { role: 'user', content: 'question' }], response_format: { type: 'json_object' }, max_tokens: 4096, stream: false });
  });
  it('supports enabled thinking only for the configured DeepSeek model', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(generation()));
    await createAiProviders({ ...config, deepseekModel: 'deepseek-v4-pro', deepseekThinking: 'enabled' }, { fetch }).generate('system', 'question');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ model: 'deepseek-v4-pro', thinking: { type: 'enabled' } });
  });
  it.each(['', 'plain text', '[]', 'null', '{"answer":'])('rejects empty, invalid and non-object final JSON (%j)', async content => {
    await expect(mocked(generation(content)).providers.generate('system', 'question')).rejects.toMatchObject({ code: 'response' });
  });
  it.each(['length', 'content_filter', 'tool_calls', 'aborted', 'insufficient_system_resource'])('rejects nonfinal completions (%s)', async finishReason => {
    const payload = generation(); payload.choices[0]!.finish_reason = finishReason;
    await expect(mocked(payload).providers.generate('system', 'question')).rejects.toMatchObject({ code: 'response' });
  });
  it('rejects unexpected tool calls and oversized final answers', async () => {
    const payload = generation(); Object.assign(payload.choices[0]!.message, { tool_calls: [{ id: 'unexpected' }] });
    await expect(mocked(payload).providers.generate('system', 'question')).rejects.toMatchObject({ code: 'response' });
    await expect(mocked(generation(JSON.stringify({ answer: 'x'.repeat(65536) }))).providers.generate('system', 'question'))
      .rejects.toMatchObject({ code: 'response' });
  });
  it('rejects a provider response reporting a substituted model', async () => {
    await expect(mocked({ ...generation(), model: 'deepseek-v4-pro' }).providers.generate('system', 'question'))
      .rejects.toMatchObject({ code: 'response' });
  });
});

describe('bounded native HTTP behavior', () => {
  it('makes one request and redacts HTTP errors without reading the error body', async () => {
    const response = new Response('private source and key', { status: 429 });
    const read = vi.spyOn(response, 'text');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const providers = createAiProviders(config, { fetch });
    await expect(providers.generate('private prompt', 'question')).rejects.toMatchObject({
      code: 'http', status: 429, message: 'AI provider http error (429).',
    });
    expect(fetch).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled();
  });
  it('sanitizes thrown transport errors and never retries', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('secret token in transport exception'));
    await expect(createAiProviders(config, { fetch }).generate('system', 'question'))
      .rejects.toMatchObject({ code: 'network', message: 'AI provider network error.' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects an aborted request before sending content', async () => {
    const { fetch, providers } = mocked(generation()); const controller = new AbortController(); controller.abort();
    await expect(providers.generate('system', 'question', controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds request time even when an injected transport ignores cancellation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise<Response>(() => undefined));
    await expect(createAiProviders(config, { fetch, timeoutMs: 5 }).generate('system', 'question')).rejects.toMatchObject({ code: 'aborted' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds streamed response bodies even without Content-Length', async () => {
    const response = new Response(new globalThis.ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(AI_PROVIDER_LIMITS.responseBytes + 1)); controller.close();
    } }), { headers: { 'Content-Type': 'application/json' } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    await expect(createAiProviders(config, { fetch }).generate('system', 'question')).rejects.toMatchObject({ code: 'response' });
  });
  it('bounds a stalled streamed body and propagates caller cancellation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new globalThis.ReadableStream<Uint8Array>(),
      { headers: { 'Content-Type': 'application/json' } }));
    const controller = new AbortController();
    const pending = createAiProviders(config, { fetch }).generate('system', 'question', controller.signal);
    controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });
  it('times out after headers when the response body stalls', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new globalThis.ReadableStream<Uint8Array>(),
      { headers: { 'Content-Type': 'application/json' } }));
    await expect(createAiProviders(config, { fetch, timeoutMs: 5 }).generate('system', 'question'))
      .rejects.toMatchObject({ code: 'aborted' });
  });
  it.each([
    new Response('not JSON', { headers: { 'Content-Type': 'text/plain' } }),
    new Response('{broken', { headers: { 'Content-Type': 'application/json' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '5000000' } }),
  ])('rejects unexpected MIME, malformed JSON and excessive declared size (%#)', async response => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    await expect(createAiProviders(config, { fetch }).generate('system', 'question')).rejects.toMatchObject({ code: 'response' });
  });
});
