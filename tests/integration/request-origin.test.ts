import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAllowedRequestOrigin } from '../../apps/web/src/lib/request-origin.ts';

// Native Request/Response, the actual origin guard, JSON reader and API routes
// execute. Clerk/database identities are explicit synthetic callbacks; no real
// session, database write, source import, publication or purchase is performed.
const boundary = vi.hoisted(() => ({
  auth: vi.fn(async () => ({ userId: 'synthetic-origin-principal', sessionId: 'synthetic-origin-session' })),
  database: vi.fn(async () => ({})),
  repositoryService: vi.fn(() => ({ queueImport: vi.fn(async () => { throw new Error('Synthetic origin test forbids source import'); }) })),
  accountWorkspaces: vi.fn(async () => []),
  personalWorkspace: vi.fn(async () => '11000000-0000-4000-8000-000000000001'),
}));
vi.mock('server-only', () => ({}));
vi.mock('@clerk/nextjs/server', () => ({ auth: boundary.auth }));
// Bun isolates this dependency in the web workspace; bind both native entry conditions.
vi.mock('../../apps/web/node_modules/@clerk/nextjs/dist/esm/server/index.js', () => ({ auth: boundary.auth }));
vi.mock('../../apps/web/node_modules/@clerk/nextjs/dist/cjs/server/index.js', () => ({ auth: boundary.auth }));
vi.mock('../../apps/web/src/lib/database.ts', () => ({ workspaceDatabase: boundary.database }));
vi.mock('../../apps/web/src/lib/account.ts', () => ({ accountWorkspaces: boundary.accountWorkspaces, ensurePersonalWorkspace: boundary.personalWorkspace }));
vi.mock('@atlas/worker/repositories', async original => {
  const actual = await original<typeof import('../../apps/worker/src/repository-service.ts')>();
  return { ...actual, createRepositoryService: boundary.repositoryService };
});
import { POST as repositoryPost } from '../../apps/web/src/app/api/repositories/route.ts';
import { POST as accountPost } from '../../apps/web/src/app/api/account/route.ts';
import { requireSameOrigin } from '../../apps/web/src/lib/repositories.ts';

const approved = 'https://atlas.approved-origin.test';
const internal = 'http://atlas.approved-origin.test/api/repositories';
function request(url: string, origin: string | undefined, additionalHeaders: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin === undefined ? {} : { Origin: origin }), ...additionalHeaders }, body: '{"incomplete":' });
}
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('APP_ORIGIN', approved); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('exact configured browser origin behind HTTPS proxies', () => {
  it('accepts configured HTTPS despite the internal HTTP URL without using forwarded headers', () => {
    expect(isAllowedRequestOrigin(request(internal, approved), approved)).toBe(true);
    expect(() => requireSameOrigin(request(internal, approved))).not.toThrow();
  });
  it('reaches actual malformed-JSON validation after the approved proxy origin is accepted', async () => {
    const response = await repositoryPost(request(internal, approved));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'invalid-body' });
    expect(boundary.auth).toHaveBeenCalledOnce(); expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each([
    'https://foreign.test', 'http://atlas.approved-origin.test', 'https://atlas.approved-origin.test.evil.test',
    'https://evil-atlas.approved-origin.test', 'https://atlas.approved-origin.test:8443', 'https://atlas.approved-origin.test:443',
    'https://user@atlas.approved-origin.test', 'https://atlas.approved-origin.test/', 'https://atlas.approved-origin.test?x=1',
    'https://atlas.approved-origin.test#fragment', `${approved},https://foreign.test`, `${approved} https://foreign.test`,
  ])('rejects foreign or lookalike Origin %s even with forged proxy/Host headers', async origin => {
    const value = request(internal, origin, { Host: 'atlas.approved-origin.test', 'X-Forwarded-Host': 'atlas.approved-origin.test', 'X-Forwarded-Proto': 'https', Forwarded: 'host=atlas.approved-origin.test;proto=https' });
    expect(isAllowedRequestOrigin(value, approved)).toBe(false);
    const response = await repositoryPost(value); expect(response.status).toBe(403); expect(boundary.auth).not.toHaveBeenCalled();
    expect(boundary.database).not.toHaveBeenCalled();
  });
  it.each([undefined, '', 'null'])('rejects missing, empty or null Origin %s before authentication', async origin => {
    const response = await repositoryPost(request(internal, origin)); expect(response.status).toBe(403);
    expect(boundary.auth).not.toHaveBeenCalled(); expect(boundary.database).not.toHaveBeenCalled();
  });
  it('does not allow the internal URL or a foreign direct URL when a public origin is configured', () => {
    expect(isAllowedRequestOrigin(request(internal, 'http://atlas.approved-origin.test'), approved)).toBe(false);
    expect(isAllowedRequestOrigin(request('https://foreign.test/api/repositories', 'https://foreign.test', { 'X-Forwarded-Host': 'atlas.approved-origin.test' }), approved)).toBe(false);
  });
  it.each([
    '', ' ', 'not-a-url', 'null', 'http://public.test', 'https://public.test/', 'https://public.test/path',
    'https://public.test?x=1', 'https://public.test#x', 'https://user:password@public.test',
    'https://*.public.test', 'https://one.test,two.test', 'https://one.test https://two.test',
    'https://public.test:443', 'https://PUBLIC.test', ' https://public.test', 'https://public.test\n',
    'http://localhost:3001', 'http://localhost:3000/',
  ])('fails closed for malformed explicit configuration %j, including local requests', configured => {
    expect(isAllowedRequestOrigin(request(internal, approved), configured)).toBe(false);
    expect(isAllowedRequestOrigin(request('http://localhost:3000/api/repositories', 'http://localhost:3000'), configured)).toBe(false);
  });
  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])('preserves actual direct loopback %s with public or local configuration', origin => {
    const value = request(origin + '/api/repositories', origin);
    expect(isAllowedRequestOrigin(value, approved)).toBe(true); expect(isAllowedRequestOrigin(value, origin)).toBe(true);
  });
  it('does not infer a loopback origin from forged Host/proxy headers or allow mismatched loopback origins/ports', () => {
    expect(isAllowedRequestOrigin(request('http://internal.test:3000/api/repositories', 'http://localhost:3000', { Host: 'localhost:3000', 'X-Forwarded-Host': 'localhost:3000' }), approved)).toBe(false);
    expect(isAllowedRequestOrigin(request('http://internal.test:3000/api/repositories', 'http://localhost:3000', { Host: 'localhost:3000' }), 'http://localhost:3000')).toBe(false);
    expect(isAllowedRequestOrigin(request('http://127.0.0.1:3000/api/repositories', 'http://localhost:3000'), approved)).toBe(false);
    expect(isAllowedRequestOrigin(request('http://localhost:3001/api/repositories', 'http://localhost:3001'), approved)).toBe(false);
  });
  it('preserves exact direct same-origin behavior only when APP_ORIGIN is unset', () => {
    expect(isAllowedRequestOrigin(request('https://direct.test/api/repositories', 'https://direct.test'), undefined)).toBe(true);
    expect(isAllowedRequestOrigin(request('https://direct.test/api/repositories', 'https://foreign.test', { Host: 'foreign.test', 'X-Forwarded-Host': 'foreign.test' }), undefined)).toBe(false);
    expect(isAllowedRequestOrigin(request('https://direct.test/api/repositories', undefined), undefined)).toBe(false);
    expect(isAllowedRequestOrigin(request('file:///synthetic', 'null'), undefined)).toBe(false);
  });
  it('ATLAS_PUBLIC_ORIGIN cannot add another browser origin to the configured allowlist', () => {
    vi.stubEnv('ATLAS_PUBLIC_ORIGIN', 'https://issuer-only.test');
    expect(() => requireSameOrigin(request(internal, 'https://issuer-only.test'))).toThrow('Cross-origin request denied');
  });
});

describe('account POST shares the exact origin policy before workspace writes', () => {
  it('accepts the configured public proxy origin with synthetic account persistence', async () => {
    const response = await accountPost(request(internal.replace('/repositories', '/account'), approved));
    expect(response.status).toBe(200); expect(boundary.auth).toHaveBeenCalledOnce(); expect(boundary.personalWorkspace).toHaveBeenCalledExactlyOnceWith('synthetic-origin-principal');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each([undefined, 'null', 'https://foreign.test'])('rejects Origin %s with no authentication or workspace write', async origin => {
    const response = await accountPost(request(internal.replace('/repositories', '/account'), origin, { 'X-Forwarded-Host': 'atlas.approved-origin.test', 'X-Forwarded-Proto': 'https' }));
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'Same-origin request required.' });
    expect(response.headers.get('cache-control')).toBe('no-store'); expect(boundary.auth).not.toHaveBeenCalled(); expect(boundary.personalWorkspace).not.toHaveBeenCalled();
  });
  it('malformed configuration blocks account writes even for otherwise-valid local origin', async () => {
    vi.stubEnv('APP_ORIGIN', 'https://public.test/path');
    const response = await accountPost(request('http://localhost:3000/api/account', 'http://localhost:3000'));
    expect(response.status).toBe(403); expect(boundary.personalWorkspace).not.toHaveBeenCalled(); expect(boundary.auth).not.toHaveBeenCalled();
  });
});
