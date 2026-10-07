/** Server-side native REST clients. The caller authorizes disclosure and spending before invocation. */
export const AI_PROVIDER_LIMITS = Object.freeze({
  inputs: 128, inputBytes: 16_000, totalInputBytes: 256_000,
  queryBytes: 8_000, promptBytes: 256_000, responseBytes: 4_194_304,
  outputBytes: 65_536, embeddingDimensions: 1024, outputTokens: 4096,
  timeoutMs: 30_000, maximumTimeoutMs: 120_000,
});

const EMBEDDING_MODELS = ['voyage-code-3', 'voyage-4-large', 'voyage-4', 'voyage-4-lite',
  'voyage-3-large', 'voyage-3.5', 'voyage-3.5-lite'] as const;
const RERANK_MODELS = ['rerank-2.5', 'rerank-2.5-lite'] as const;
const GENERATION_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;
export type VoyageEmbeddingModel = typeof EMBEDDING_MODELS[number];
export type VoyageRerankModel = typeof RERANK_MODELS[number];
export type DeepSeekModel = typeof GENERATION_MODELS[number];
export type DeepSeekThinking = 'enabled' | 'disabled';
export type AiProviderErrorCode = 'configuration' | 'input' | 'http' | 'network' | 'aborted' | 'response';

export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;
  readonly status: number | undefined;
  constructor(code: AiProviderErrorCode, status?: number) {
    super(`AI provider ${code} error${status === undefined ? '' : ` (${status})`}.`);
    this.name = 'AiProviderError'; this.code = code; this.status = status;
  }
}

export interface AiProviderConfig {
  readonly voyageApiKey: string;
  readonly voyageEmbeddingModel: VoyageEmbeddingModel;
  readonly voyageRerankModel: VoyageRerankModel;
  readonly deepseekApiKey: string;
  readonly deepseekModel: DeepSeekModel;
  readonly deepseekThinking: DeepSeekThinking;
}
export interface AiProviders {
  embed(inputs: readonly string[], inputType: 'document' | 'query', signal?: AbortSignal): Promise<number[][]>;
  rerank(query: string, documents: readonly string[], signal?: AbortSignal): Promise<Array<{ index: number; relevanceScore: number }>>;
  /** Returns final JSON text only. The caller validates the application's answer/citation schema. */
  generate(system: string, user: string, signal?: AbortSignal): Promise<string>;
}
export interface AiProviderOptions {
  /** Test injection. Production callers omit this to use native fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

function serverOnly(): void {
  if ('document' in globalThis) throw new AiProviderError('configuration');
}
function apiKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || !/^[!-~]+$/.test(value)) {
    throw new AiProviderError('configuration');
  }
  return value;
}
function model<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new AiProviderError('configuration');
  return value as T;
}
export function parseAiProviderConfig(env: Readonly<Record<string, string | undefined>>): AiProviderConfig {
  serverOnly();
  return Object.freeze({
    voyageApiKey: apiKey(env.VOYAGE_API_KEY),
    voyageEmbeddingModel: model(env.VOYAGE_EMBEDDING_MODEL ?? 'voyage-code-3', EMBEDDING_MODELS),
    voyageRerankModel: model(env.VOYAGE_RERANK_MODEL ?? 'rerank-2.5', RERANK_MODELS),
    deepseekApiKey: apiKey(env.DEEPSEEK_API_KEY),
    deepseekModel: model(env.DEEPSEEK_MODEL ?? 'deepseek-flash', GENERATION_MODELS),
    deepseekThinking: model(env.DEEPSEEK_THINKING ?? 'disabled', ['enabled', 'disabled'] as const),
  });
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function bytes(text: string): number { return new globalThis.TextEncoder().encode(text).byteLength; }
function inputText(text: unknown, maximumBytes: number): asserts text is string {
  if (typeof text !== 'string' || text.trim().length === 0 || bytes(text) > maximumBytes) {
    throw new AiProviderError('input');
  }
}
function inputList(inputs: readonly string[]): void {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > AI_PROVIDER_LIMITS.inputs) {
    throw new AiProviderError('input');
  }
  let total = 0;
  for (const input of inputs) {
    inputText(input, AI_PROVIDER_LIMITS.inputBytes); total += bytes(input);
  }
  if (total > AI_PROVIDER_LIMITS.totalInputBytes) throw new AiProviderError('input');
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AiProviderError('aborted'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AiProviderError('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > AI_PROVIDER_LIMITS.responseBytes)) {
    void response.body?.cancel().catch(() => undefined);
    throw new AiProviderError('response');
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || response.body === null) {
    void response.body?.cancel().catch(() => undefined);
    throw new AiProviderError('response');
  }
  const reader = response.body.getReader();
  const decoder = new globalThis.TextDecoder('utf-8', { fatal: true });
  let total = 0; let text = '';
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > AI_PROVIDER_LIMITS.responseBytes) throw new AiProviderError('response');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError('response');
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createAiProviders(config: AiProviderConfig, options: AiProviderOptions = {}): AiProviders {
  serverOnly();
  // Revalidate even when a caller bypasses the environment parser or TypeScript.
  const checked = Object.freeze({
    voyageApiKey: apiKey(config.voyageApiKey),
    voyageEmbeddingModel: model(config.voyageEmbeddingModel, EMBEDDING_MODELS),
    voyageRerankModel: model(config.voyageRerankModel, RERANK_MODELS),
    deepseekApiKey: apiKey(config.deepseekApiKey),
    deepseekModel: model(config.deepseekModel, GENERATION_MODELS),
    deepseekThinking: model(config.deepseekThinking, ['enabled', 'disabled'] as const),
  });
  const timeoutMs = options.timeoutMs ?? AI_PROVIDER_LIMITS.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > AI_PROVIDER_LIMITS.maximumTimeoutMs) {
    throw new AiProviderError('configuration');
  }
  const nativeFetch = options.fetch ?? globalThis.fetch;
  async function post(url: string, key: string, body: unknown, callerSignal?: AbortSignal): Promise<unknown> {
    serverOnly();
    if (callerSignal?.aborted) throw new AiProviderError('aborted');
    const controller = new AbortController();
    const abort = () => controller.abort();
    callerSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await abortable(nativeFetch(url, {
        method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
      }), controller.signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new AiProviderError('http', response.status);
      }
      return await readJson(response, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new AiProviderError('aborted');
      if (error instanceof AiProviderError) throw error;
      throw new AiProviderError('network');
    } finally {
      clearTimeout(timer); callerSignal?.removeEventListener('abort', abort);
    }
  }
  return Object.freeze({
    async embed(inputs: readonly string[], inputType: 'document' | 'query', signal?: AbortSignal): Promise<number[][]> {
      inputList(inputs);
      if (inputType !== 'query' && inputType !== 'document') throw new AiProviderError('input');
      const response = await post('https://api.voyageai.com/v1/embeddings', checked.voyageApiKey, {
        input: inputs, model: checked.voyageEmbeddingModel, input_type: inputType,
        output_dimension: AI_PROVIDER_LIMITS.embeddingDimensions, output_dtype: 'float', truncation: false,
      }, signal);
      if (!record(response) || !Array.isArray(response.data) || response.data.length !== inputs.length) {
        throw new AiProviderError('response');
      }
      const vectors: number[][] = []; const seen = new Set<number>();
      for (const entry of response.data) {
        if (!record(entry) || !Number.isInteger(entry.index) || typeof entry.index !== 'number'
          || entry.index < 0 || entry.index >= inputs.length || seen.has(entry.index)
          || !Array.isArray(entry.embedding) || entry.embedding.length !== AI_PROVIDER_LIMITS.embeddingDimensions
          || !entry.embedding.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) {
          throw new AiProviderError('response');
        }
        seen.add(entry.index); vectors[entry.index] = entry.embedding as number[];
      }
      return vectors;
    },
    async rerank(query: string, documents: readonly string[], signal?: AbortSignal) {
      inputText(query, AI_PROVIDER_LIMITS.queryBytes); inputList(documents);
      const response = await post('https://api.voyageai.com/v1/rerank', checked.voyageApiKey, {
        query, documents, model: checked.voyageRerankModel,
        top_k: documents.length, return_documents: false, truncation: false,
      }, signal);
      if (!record(response) || !Array.isArray(response.data) || response.data.length !== documents.length) {
        throw new AiProviderError('response');
      }
      const seen = new Set<number>();
      return response.data.map((entry: unknown) => {
        if (!record(entry) || typeof entry.index !== 'number' || !Number.isInteger(entry.index)
          || entry.index < 0 || entry.index >= documents.length || seen.has(entry.index)
          || typeof entry.relevance_score !== 'number' || !Number.isFinite(entry.relevance_score)
          || entry.relevance_score < 0 || entry.relevance_score > 1) throw new AiProviderError('response');
        seen.add(entry.index);
        return { index: entry.index, relevanceScore: entry.relevance_score };
      });
    },
    async generate(system: string, user: string, signal?: AbortSignal): Promise<string> {
      inputText(system, AI_PROVIDER_LIMITS.promptBytes); inputText(user, AI_PROVIDER_LIMITS.promptBytes);
      const instruction = `${system}\nReturn a single valid JSON object.`;
      if (bytes(instruction) + bytes(user) > AI_PROVIDER_LIMITS.promptBytes) throw new AiProviderError('input');
      const response = await post('https://api.deepseek.com/chat/completions', checked.deepseekApiKey, {
        model: checked.deepseekModel, thinking: { type: checked.deepseekThinking },
        messages: [{ role: 'system', content: instruction }, { role: 'user', content: user }],
        response_format: { type: 'json_object' }, max_tokens: AI_PROVIDER_LIMITS.outputTokens, stream: false,
      }, signal);
      if (!record(response) || !Array.isArray(response.choices) || response.choices.length !== 1
        || (response.model !== undefined && response.model !== checked.deepseekModel)) {
        throw new AiProviderError('response');
      }
      const choice: unknown = response.choices[0];
      if (!record(choice) || choice.index !== 0 || choice.finish_reason !== 'stop' || !record(choice.message)
        || choice.message.role !== 'assistant' || typeof choice.message.content !== 'string'
        || choice.message.content.trim().length === 0 || bytes(choice.message.content) > AI_PROVIDER_LIMITS.outputBytes
        || (choice.message.tool_calls !== undefined && choice.message.tool_calls !== null
          && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length > 0))) {
        throw new AiProviderError('response');
      }
      try {
        if (!record(JSON.parse(choice.message.content) as unknown)) throw new AiProviderError('response');
      } catch { throw new AiProviderError('response'); }
      return choice.message.content;
    },
  });
}
