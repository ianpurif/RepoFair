import type { Capabilities, CapabilityState } from '../../contracts/src/index.ts';
export * from './authenticated.ts';
const states = new Set<CapabilityState>(['available', 'not-implemented', 'unverified', 'disabled']);
function isCapabilities(value: unknown): value is Capabilities {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.product === 'Chronos Atlas' && (v.stage === 'starter' || v.stage === 'local-fixture') && v.mode === 'fixture'
    && v.livePayments === false && typeof v.capabilities === 'object' && v.capabilities !== null
    && !Array.isArray(v.capabilities)
    && Object.values(v.capabilities).every(s => typeof s === 'string' && states.has(s as CapabilityState))
    && Array.isArray(v.limitations) && v.limitations.every(s => typeof s === 'string');
}
async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Empty capability response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        throw new Error('Capability response exceeds the permitted size.');
      }
      text += decoder.decode(next.value, {stream: true});
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally { reader.releaseLock(); }
}
/** Starter-only capability client. Paid requests and MCP are not implemented. */
export class ChronosAtlasClient {
  readonly #base: URL;
  constructor(baseUrl: string, options: { allowLocalDevelopment?: boolean } = {}) {
    const url = new URL(baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a credential-free service origin.');
    if (url.protocol !== 'https:' && !(options.allowLocalDevelopment === true && local && url.protocol === 'http:')) {
      throw new Error('HTTPS is required outside explicitly enabled local development.');
    }
    this.#base = url;
  }
  async capabilities(signal?: AbortSignal): Promise<Capabilities> {
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetch(new URL('/api/capabilities', this.#base), {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error',
    });
    if (!response.ok) throw new Error(`Capability endpoint failed: ${response.status}`);
    const value = await readBoundedJson(response);
    if (!isCapabilities(value)) throw new Error('Unsupported capability response.');
    return value;
  }
}
