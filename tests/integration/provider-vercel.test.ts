import { describe, expect, it, vi } from 'vitest';
import { createVercelProviderHandler, vercelProviderEnvironment } from '../../apps/provider/src/vercel.ts';

// Real Request/Response/streams execute. Injected provider handlers and configuration
// are synthetic adapter sentinels: no database, RPC, source export or payment executes.
const origin = 'https://repofair-provider.vercel.app';
const environment = { ATLAS_PROVIDER_ORIGIN: origin, TEMPO_CHAIN_ID: '42431' };

describe('Vercel independent provider adapter with synthetic runtime', () => {
  it('passes only exact provider settings and drops central, buyer, preload and proxy credentials', async () => {
    const inherited = {
      ...environment, ATLAS_PROVIDER_DATABASE_URL: 'synthetic-provider-database', ATLAS_PROVIDER_MPP_SECRET: 'synthetic-provider-mpp',
      ATLAS_PROVIDER_ISSUER_PUBLIC_KEY: 'synthetic-public-key', ATLAS_PROVIDER_ID: 'synthetic-publication-id',
      ATLAS_PROVIDER_RECIPIENT: 'synthetic-recipient', ATLAS_PROVIDER_PRICE_UNITS: '1000', TEMPO_RPC_URL: 'https://rpc.moderato.tempo.xyz',
      DATABASE_URL: 'central-secret', DATABASE_SSL_CA: 'central-ca', CLERK_SECRET_KEY: 'clerk-secret', GITHUB_APP_PRIVATE_KEY: 'github-secret',
      ATLAS_PUBLICATION_SIGNING_KEY: 'issuer-private-key', ATLAS_BUYER_PRIVATE_KEY: 'buyer-private-key', ATLAS_PROVIDER_PRIVATE_KEY: 'future-secret',
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'central-public-setting', NODE_OPTIONS: '--require=synthetic-preload', HTTPS_PROXY: 'synthetic-proxy',
      NODE_TLS_REJECT_UNAUTHORIZED: '0', ATLAS_FIXTURES_ENABLED: 'true', ATLAS_PROVIDER_PORT: '4311',
    };
    const factory = vi.fn(async (passed: Readonly<Record<string, string | undefined>>) => {
      expect(Object.keys(passed).sort()).toEqual([
        'ATLAS_PROVIDER_DATABASE_URL', 'ATLAS_PROVIDER_ID', 'ATLAS_PROVIDER_ISSUER_PUBLIC_KEY', 'ATLAS_PROVIDER_MPP_SECRET',
        'ATLAS_PROVIDER_ORIGIN', 'ATLAS_PROVIDER_PRICE_UNITS', 'ATLAS_PROVIDER_RECIPIENT', 'TEMPO_CHAIN_ID', 'TEMPO_RPC_URL',
      ].sort());
      expect(passed.ATLAS_PROVIDER_DATABASE_URL).toBe(inherited.ATLAS_PROVIDER_DATABASE_URL);
      expect(Object.isFrozen(passed)).toBe(true);
      return { handle: async () => new Response(null, { status: 204 }) };
    });
    expect((await createVercelProviderHandler(inherited, factory)(new Request(origin + '/health'))).status).toBe(204);
    expect(factory).toHaveBeenCalledOnce();
    expect(vercelProviderEnvironment({ ...inherited, ATLAS_PROVIDER_ID: 1 as unknown as string }).ATLAS_PROVIDER_ID).toBeUndefined();
  });

  it('shares one initialization across concurrent requests and keeps the successful runtime', async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const runtime = { handle: vi.fn(async () => new Response('synthetic-adapter-response')) };
    const factory = vi.fn(async () => { await ready; return runtime; });
    const handle = createVercelProviderHandler(environment, factory);
    const pending = Array.from({ length: 8 }, () => handle(new Request(origin + '/health')));
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    release();
    expect((await Promise.all(pending)).map(response => response.status)).toEqual(Array(8).fill(200));
    expect((await handle(new Request(origin + '/unexpected'))).status).toBe(200);
    expect(factory).toHaveBeenCalledOnce();
    expect(runtime.handle).toHaveBeenCalledTimes(9);
  });

  it('clears rejected initialization so a later request can initialize without repeating a purchase', async () => {
    const runtime = { handle: vi.fn(async () => new Response(null, { status: 204 })) };
    const factory = vi.fn().mockRejectedValueOnce(new Error('SYNTHETIC_SECRET_CONFIGURATION')).mockResolvedValue(runtime);
    const handle = createVercelProviderHandler(environment, factory);
    const rejected = await handle(new Request(origin + '/context/retrieve', { method: 'POST', body: '{}' }));
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('cache-control')).toBe('no-store');
    expect(await rejected.text()).not.toContain('SYNTHETIC_SECRET_CONFIGURATION');
    expect(runtime.handle).not.toHaveBeenCalled();
    expect((await handle(new Request(origin + '/health'))).status).toBe(204);
    expect((await handle(new Request(origin + '/health'))).status).toBe(204);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(runtime.handle).toHaveBeenCalledTimes(2);
  });

  it('pins origin and preserves exact pathname, query, method, headers and noncanonical raw body bytes', async () => {
    const body = '{\n  "version" : "1.0.0", "question":"café 🧭", "unknown": 1.00\n}\r\n';
    const headers = new Headers({ 'Content-Type': 'application/json', Authorization: 'Bearer SYNTHETIC_DELEGATION',
      'Payment-Authorization': 'SYNTHETIC_PAYMENT', Origin: 'https://repofair.vercel.app', Host: 'attacker.invalid',
      'X-Forwarded-Host': 'attacker.invalid', 'X-Forwarded-Proto': 'http', 'X-Atlas-Publication-Control': 'SYNTHETIC_CONTROL' });
    const request = new Request('https://deployment-alias.vercel.app//context/%72etrieve?nonce=abc%2F123&nonce=second', { method: 'POST', headers, body });
    let received!: Request;
    const runtime = { handle: vi.fn(async (actual: Request) => { received = actual; return new Response('synthetic'); }) };
    await createVercelProviderHandler(environment, async () => runtime)(request);
    expect(received.url).toBe(origin + '//context/%72etrieve?nonce=abc%2F123&nonce=second');
    expect(received.method).toBe('POST');
    expect([...received.headers.entries()]).toEqual([...headers.entries()]);
    expect(new Uint8Array(await received.arrayBuffer())).toEqual(new TextEncoder().encode(body));
  });

  it('does not eagerly read or reserialize the incoming body and propagates its abort signal', async () => {
    const abort = new AbortController();
    const bytes = new Uint8Array([0, 255, 13, 10, 123, 125]);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const request = new Request(origin + '/context/retrieve', { method: 'POST', body, signal: abort.signal, duplex: 'half' } as RequestInit);
    const runtime = { handle: vi.fn(async (actual: Request) => {
      expect(actual.bodyUsed).toBe(false); expect(actual.signal.aborted).toBe(false);
      abort.abort(); expect(actual.signal.aborted).toBe(true);
      expect(new Uint8Array(await actual.arrayBuffer())).toEqual(bytes);
      return new Response(null, { status: 204 });
    }) };
    expect((await createVercelProviderHandler(environment, async () => runtime)(request)).status).toBe(204);
  });

  it('returns the runtime response unchanged, including payment and CORS headers', async () => {
    const response = new Response('SYNTHETIC_ADAPTER_RESPONSE_ONLY', { status: 402, headers: {
      'WWW-Authenticate': 'SYNTHETIC_CHALLENGE_ONLY', 'Payment-Receipt': 'SYNTHETIC_HEADER_ONLY',
      'Access-Control-Allow-Origin': 'https://repofair.vercel.app', 'Cache-Control': 'no-store', 'X-Atlas-Mode': 'tempo-testnet',
    } });
    const handle = createVercelProviderHandler(environment, async () => ({ handle: async () => response }));
    expect(await handle(new Request(origin + '/context/retrieve', { method: 'POST', body: '{}' }))).toBe(response);
  });

  it('does not retry or rebuild the runtime after a failed handling attempt', async () => {
    const runtime = { handle: vi.fn().mockRejectedValueOnce(new Error('SYNTHETIC_SECRET_SOURCE')).mockResolvedValue(new Response(null, { status: 204 })) };
    const factory = vi.fn(async () => runtime);
    const handle = createVercelProviderHandler(environment, factory);
    const unavailable = await handle(new Request(origin + '/context/retrieve', { method: 'POST', body: '{}' }));
    expect(unavailable.status).toBe(503); expect(await unavailable.text()).not.toContain('SYNTHETIC_SECRET_SOURCE');
    expect(runtime.handle).toHaveBeenCalledOnce(); expect(factory).toHaveBeenCalledOnce();
    expect((await handle(new Request(origin + '/health'))).status).toBe(204);
    expect(factory).toHaveBeenCalledOnce(); expect(runtime.handle).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 'http://repofair-provider.vercel.app', origin + '/', origin + '/path', origin + '?query=1',
    origin + '#fragment', 'https://127.0.0.1', 'https://localhost', 'https://user:password@repofair-provider.vercel.app'])(
    'refuses invalid or inexact provider origin %s before runtime initialization', async configured => {
      const factory = vi.fn(async () => ({ handle: async () => new Response(null, { status: 204 }) }));
      const response = await createVercelProviderHandler({ ATLAS_PROVIDER_ORIGIN: configured }, factory)(new Request(origin + '/health'));
      expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(factory).not.toHaveBeenCalled();
      expect(await response.json()).toEqual({ error: 'Independent provider unavailable', mode: 'tempo-testnet' });
    });

  it('keeps every route unavailable with the real strict factory when publication configuration is missing', async () => {
    const handle = createVercelProviderHandler(environment);
    for (const path of ['/health', '/context/retrieve', '/.well-known/atlas-provider.json']) {
      const response = await handle(new Request(origin + path));
      expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('www-authenticate')).toBeNull(); expect(response.headers.get('payment-receipt')).toBeNull();
      expect(await response.json()).toEqual({ error: 'Independent provider unavailable', mode: 'tempo-testnet' });
    }
    const head = await handle(new Request(origin + '/health', { method: 'HEAD' }));
    expect(head.status).toBe(503); expect(await head.text()).toBe('');
  });
});
