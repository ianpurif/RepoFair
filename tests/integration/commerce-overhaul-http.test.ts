import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boundedProviderResponse, isPublicProviderAddress, ProviderHttpError, providerHttp, publicProviderUrl } from '../../apps/worker/src/provider-http.ts';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
// Only the system DNS/TLS transport is replaced. Real destination filtering,
// pinning, byte bounds, Fetch response construction, and promise error handling
// execute. No network requests, credential reads, or paid calls occur.
let status = 200; let body = Buffer.from('{"ok":true}');
let responseHeaders: Record<string, string | string[]> = { 'content-type': 'application/json' };
let captured: RequestOptions | null = null; let pin: unknown[] = [];
beforeEach(() => {
  vi.useRealTimers();
  status = 200; body = Buffer.from('{"ok":true}'); responseHeaders = { 'content-type': 'application/json' }; captured = null; pin = [];
  vi.mocked(lookup).mockReset(); vi.mocked(request).mockReset();
  vi.mocked(lookup).mockResolvedValue([{ address: '1.1.1.1', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }] as never);
  vi.mocked(request).mockImplementation((...arguments_: unknown[]) => {
    captured = arguments_[1] as RequestOptions; const callback = arguments_[2] as (response: IncomingMessage) => void;
    let destroyed = false; let responseDestroyed = false;
    const outgoing = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      destroy: (error?: Error) => { destroyed = true; if (error) outgoing.emit('error', error); outgoing.emit('close'); },
      end: () => {
        queueMicrotask(() => {
          if (destroyed) return;
          const incoming = Object.assign(new EventEmitter(), {
            statusCode: status, headers: responseHeaders, destroy: () => { responseDestroyed = true; },
          });
          callback(incoming as unknown as IncomingMessage);
          if (!responseDestroyed) incoming.emit('data', body);
          if (!responseDestroyed) incoming.emit('end');
          outgoing.emit('close');
        });
      },
    });
    return outgoing as never;
  });
});
afterEach(() => { vi.useRealTimers(); });
describe('native provider destination and transport boundaries', () => {
  it('requires a public HTTPS hostname and refuses credentials, literal IPs, local namespaces, and alternate ports', () => {
    expect(publicProviderUrl('https://provider.verifier.dev/context/retrieve').hostname).toBe('provider.verifier.dev');
    for (const url of ['http://provider.verifier.dev', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://a.internal',
      'https://a.local', 'https://a.test', 'https://a.example', 'https://a.invalid', 'https://a.onion', 'https://user:secret@provider.verifier.dev',
      'https://provider.verifier.dev:8443', 'https://provider.verifier.dev/#secret']) expect(() => publicProviderUrl(url)).toThrow();
    expect(lookup).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  it('rejects private, reserved, multicast, documentation, and transition addresses', () => {
    for (const address of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '100.64.0.1', '169.254.1.1', '172.31.255.255', '192.168.0.1',
      '192.0.0.1', '192.88.99.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
      '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1', '2001::1', '2002:7f00:1::', '3fff::1']) expect(isPublicProviderAddress(address)).toBe(false);
    expect(isPublicProviderAddress('1.1.1.1')).toBe(true); expect(isPublicProviderAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('rejects any mixed public/private DNS result and bounds total address records before connecting', async () => {
    for (const addresses of [[], [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }],
      Array.from({ length: 17 }, () => ({ address: '1.1.1.1', family: 4 }))]) {
      vi.mocked(lookup).mockResolvedValueOnce(addresses as never);
      await expect(providerHttp('https://provider.verifier.dev/context/retrieve')).rejects.toThrow('DNS');
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('pins both Node lookup forms to the validated public address without a second DNS lookup', async () => {
    const response = await providerHttp('https://provider.verifier.dev/context/retrieve'); expect(response.status).toBe(200);
    const callback = (...values: unknown[]) => { pin.push(values); };
    const connection = captured as RequestOptions & { lookup: (hostname: string, options: { all?: boolean }, callback: (...values: unknown[]) => void) => void };
    connection.lookup('provider.verifier.dev', {}, callback); connection.lookup('provider.verifier.dev', { all: true }, callback);
    expect(pin).toEqual([[null, '1.1.1.1', 4], [null, [{ address: '1.1.1.1', family: 4 }]]]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('rejects redirects instead of forwarding scoped authorization to another destination', async () => {
    status = 302; responseHeaders = { location: 'https://other.verifier.dev/context/retrieve' };
    await expect(providerHttp('https://provider.verifier.dev/context/retrieve', { headers: { Authorization: 'Bearer synthetic-scoped-grant' } })).rejects.toThrow('redirects');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('bounds response bytes and request bytes independently', async () => {
    body = Buffer.alloc(11);
    await expect(providerHttp('https://provider.verifier.dev/context/retrieve', { maximumBytes: 10 })).rejects.toThrow('response exceeds');
    await expect(providerHttp('https://provider.verifier.dev/context/retrieve', { body: 'x'.repeat(8193) })).rejects.toThrow('request exceeds');
    for (const maximumBytes of [0, 4_000_001, 1.5]) await expect(providerHttp('https://provider.verifier.dev/context/retrieve', { maximumBytes })).rejects.toThrow('request exceeds');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('preserves only supported protocol headers and never returns cookies or arbitrary response secrets', async () => {
    responseHeaders = { 'content-type': 'application/json', 'www-authenticate': 'synthetic-challenge', 'payment-receipt': 'synthetic-test-receipt',
      'x-atlas-mode': 'tempo-testnet', 'set-cookie': 'must-not-escape', authorization: 'must-not-escape', 'x-private-secret': 'must-not-escape' };
    const response = await providerHttp('https://provider.verifier.dev/context/retrieve');
    const headers: Record<string, string> = {}; response.headers.forEach((value, name) => { headers[name] = value; });
    expect(headers).toEqual({ 'content-type': 'application/json', 'payment-receipt': 'synthetic-test-receipt',
      'www-authenticate': 'synthetic-challenge', 'x-atlas-mode': 'tempo-testnet' });
    expect(await response.json()).toEqual({ ok: true });
  });
  it('constructs no-content HTTP responses without an illegal Fetch body or uncaught stream callback exception', async () => {
    for (const noContent of [204, 205]) {
      status = noContent; body = Buffer.alloc(0); const response = await providerHttp('https://provider.verifier.dev/health');
      expect(response.status).toBe(noContent); expect(response.body).toBeNull(); expect(await response.text()).toBe('');
    }
    expect(boundedProviderResponse(304, new Headers(), Buffer.from('ignored body')).body).toBeNull();
  });
  it('converts invalid provider status into a rejected promise without an uncaught callback exception', async () => {
    for (const invalid of [101, 199, 600, 999]) {
      status = invalid; await expect(providerHttp('https://provider.verifier.dev/context/retrieve')).rejects.toThrow('Invalid provider HTTP response');
      expect(() => boundedProviderResponse(invalid, new Headers(), Buffer.alloc(0))).toThrow('Invalid provider HTTP status');
    }
  });
});

describe('bounded provider deadlines with synthetic DNS/TLS and a fake clock', () => {
  const endpoint = 'https://provider.verifier.dev/context/retrieve';
  const sentinel = 'SYNTHETIC_SECRET_MUST_NOT_LEAK';

  function stalledConnection() {
    const outgoing = Object.assign(new EventEmitter(), {
      write: vi.fn(), end: vi.fn(), destroy: vi.fn((error?: Error) => {
        if (error) outgoing.emit('error', error);
        outgoing.emit('close');
      }),
    });
    vi.mocked(request).mockImplementation((...arguments_: unknown[]) => {
      captured = arguments_[1] as RequestOptions;
      return outgoing as never;
    });
    return outgoing;
  }

  function fakeClock() { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); }

  it.each([1, 12_000, 30_000, 180_000])('accepts a bounded %i ms override and aligns socket/hard deadline settings', async timeoutMs => {
    fakeClock();
    const response = await providerHttp(endpoint, { timeoutMs });
    expect(response.status).toBe(200); expect(captured?.timeout).toBe(timeoutMs);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 180_001, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, Number.NaN, 1.5, '12000', null])(
    'rejects unsupported timeout %s before DNS or TLS starts', async timeoutMs => {
      await expect(providerHttp(endpoint, { timeoutMs: timeoutMs as number })).rejects.toThrow('request exceeds bounds');
      expect(lookup).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    });

  it('retains the ten-second default and rejects a stalled request at the actual hard deadline', async () => {
    fakeClock(); const outgoing = stalledConnection(); let settled = false;
    const failure = providerHttp(endpoint).then(() => null, error => { settled = true; return error as Error; });
    await vi.advanceTimersByTimeAsync(0);
    expect(captured?.timeout).toBe(10_000);
    await vi.advanceTimersByTimeAsync(9_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await failure).toBeInstanceOf(ProviderHttpError);
    expect(await failure).toMatchObject({ code: 'provider-timeout', message: 'Provider request timed out' });
    expect(outgoing.destroy).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a longer bounded override without the old ten-second timer truncating it', async () => {
    fakeClock(); const outgoing = stalledConnection(); let settled = false;
    const failure = providerHttp(endpoint, { timeoutMs: 180_000 }).then(() => null, error => { settled = true; return error as Error; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false); expect(captured?.timeout).toBe(180_000);
    await vi.advanceTimersByTimeAsync(169_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await failure).toMatchObject({ code: 'provider-timeout' });
    expect(outgoing.destroy).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce();
  });

  it('counts DNS time against the same hard budget and aligns the remaining socket allowance', async () => {
    fakeClock(); stalledConnection(); let settled = false;
    vi.mocked(lookup).mockImplementation(() => new Promise(resolveDns => {
      setTimeout(() => resolveDns([{ address: '1.1.1.1', family: 4 }] as never), 2_000);
    }));
    const failure = providerHttp(endpoint, { timeoutMs: 30_000 }).then(() => null, error => { settled = true; return error as Error; });
    await vi.advanceTimersByTimeAsync(2_000); expect(captured?.timeout).toBe(28_000);
    await vi.advanceTimersByTimeAsync(27_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await failure).toMatchObject({ code: 'provider-timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([500, 180_000])('bounds DNS independently within a %i ms total allowance', async timeoutMs => {
    fakeClock(); vi.mocked(lookup).mockImplementation(() => new Promise(() => {}));
    const failure = providerHttp(endpoint, { timeoutMs }).then(() => null, error => error as Error);
    await vi.advanceTimersByTimeAsync(Math.min(5_000, timeoutMs));
    expect(await failure).toMatchObject({ code: 'provider-timeout', message: 'Provider request timed out' });
    expect(request).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a socket timeout distinctly and discards untrusted event/error details', async () => {
    fakeClock(); const outgoing = stalledConnection();
    const failure = providerHttp(endpoint, { timeoutMs: 12_000 }).then(() => null, error => error as Error);
    await vi.advanceTimersByTimeAsync(0); outgoing.emit('timeout', new Error(sentinel));
    const error = await failure;
    expect(error).toMatchObject({ code: 'provider-timeout', message: 'Provider request timed out' });
    expect(String(error)).not.toContain(sentinel); expect(error).not.toHaveProperty('cause');
    expect(outgoing.destroy).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('sanitizes asynchronous TLS failures without leaking raw messages or codes', async () => {
    fakeClock(); const outgoing = stalledConnection();
    const failure = providerHttp(endpoint).then(() => null, error => error as Error);
    await vi.advanceTimersByTimeAsync(0);
    outgoing.emit('error', Object.assign(new Error(sentinel), { code: sentinel })); outgoing.emit('close');
    const error = await failure;
    expect(error).toMatchObject({ code: 'provider-connection', message: 'Provider connection failed' });
    expect(String(error)).not.toContain(sentinel); expect(error).not.toHaveProperty('cause');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sanitizes DNS rejection and synchronous TLS creation failures without retrying', async () => {
    vi.mocked(lookup).mockRejectedValueOnce(new Error(sentinel));
    const dnsError = await providerHttp(endpoint).then(() => null, error => error as Error);
    expect(dnsError).toMatchObject({ code: 'provider-connection', message: 'Provider connection failed' });
    expect(String(dnsError)).not.toContain(sentinel); expect(request).not.toHaveBeenCalled();
    vi.mocked(request).mockImplementationOnce(() => { throw new Error(sentinel); });
    const tlsError = await providerHttp(endpoint).then(() => null, error => error as Error);
    expect(tlsError).toMatchObject({ code: 'provider-connection', message: 'Provider connection failed' });
    expect(String(tlsError)).not.toContain(sentinel); expect(request).toHaveBeenCalledOnce();
  });
});
