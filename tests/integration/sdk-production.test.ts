import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { BodyDigest, Challenge, Store } from 'mppx';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticatedAtlasClient, AtlasApiError } from '../../packages/sdk/src/authenticated.ts';
import type { ModeratoSigner, PurchaseReservation } from '../../packages/sdk/src/authenticated.ts';
import { createAtlasMcpServer } from '../../packages/sdk/src/mcp.ts';
import { createTempoTestnetAdapter } from '../../apps/provider/src/tempo-adapter.ts';
import { MODERATO_NETWORK, MODERATO_PATHUSD } from '../../packages/contracts/src/commerce.ts';
import { parseRepositoryIndex } from '../../packages/core/src/local/parser.ts';
import { answerLocal, lookupSource } from '../../packages/core/src/local/index.ts';

// The SDK, native loopback HTTP, official MPP challenge generation, MCP protocol,
// and production stdio entrypoint execute. Server identity/authorization is an
// explicit synthetic transport; no Clerk, hosted SQL, live RPC, wallet signature,
// broadcast, or settlement is claimed. Every supplied signer rejects invocation.
const sessionToken = 'synthetic_sdk_transport_session_only';
const workspaceId = '11000000-0000-4000-8000-000000000001';
const repositoryId = '22000000-0000-4000-8000-000000000002';
const snapshotId = '33000000-0000-4000-8000-000000000003';
const providerId = '44000000-0000-4000-8000-000000000004';
const purchaseId = '55000000-0000-4000-8000-000000000005';
const principalId = 'user_sdk_transport_synthetic';
const providerOrigin = 'https://provider.sdk-verifier.dev';
const idempotencyKey = 'sdk_transport_purchase_0001';
const sourceText = 'export function retry(value: number) {\n  return value + 1;\n}\n';
const index = parseRepositoryIndex({ scope: { tenantId: workspaceId, principalId, permissionRevision: '1:1' },
  snapshot: { kind: 'git', repositoryId, snapshotId, revision: 'a'.repeat(40) }, packageName: '@verifier/sdk', version: '1.2.3',
  observedAt: '2026-10-11T00:00:00Z', files: [
    { path: 'package.json', text: JSON.stringify({ name: '@verifier/sdk', version: '1.2.3' }) },
    { path: 'src/index.ts', text: sourceText },
  ] });
type Seen = { url: string; method: string; authorization: string | undefined; origin: string | undefined; payment: string | undefined; body: string };
const seen: Seen[] = [];
let server: Server; let apiOrigin = ''; let directory = ''; let tokenFile = ''; let reservation: PurchaseReservation;
let behavior: 'normal' | 'redirect' | 'oversized' | 'bad-utf8' | 'bad-json' | 'private-error' = 'normal';
let signingState: 'claimed' | 'pending' | 'unknown' | 'settled' | 'failed' = 'claimed';
function response(reply: ServerResponse, status: number, value: unknown) {
  reply.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); reply.end(JSON.stringify(value));
}
async function handle(request: IncomingMessage, reply: ServerResponse) {
  const parts: Buffer[] = []; let bytes = 0;
  for await (const value of request) { const part = Buffer.from(value); bytes += part.length; if (bytes > 65_536) throw new Error('Synthetic request too large'); parts.push(part); }
  const body = Buffer.concat(parts).toString('utf8');
  seen.push({ url: request.url!, method: request.method!, authorization: request.headers.authorization,
    origin: request.headers.origin, payment: request.headers['payment-authorization'] as string | undefined, body });
  if (request.headers.authorization !== `Bearer ${sessionToken}`) return response(reply, 401, { code: 'session-required' });
  if (request.method === 'POST' && request.headers.origin !== apiOrigin) return response(reply, 403, { code: 'origin-denied' });
  const url = new URL(request.url!, apiOrigin);
  if (url.pathname === '/api/account') {
    if (behavior === 'redirect') { reply.writeHead(302, { Location: apiOrigin + '/redirect-sink' }); reply.end(); return; }
    if (behavior === 'oversized') return response(reply, 200, { padding: 'x'.repeat(4_000_001) });
    if (behavior === 'bad-utf8') { reply.writeHead(200, { 'Content-Type': 'application/json' }); reply.end(Buffer.from([0xff])); return; }
    if (behavior === 'bad-json') return response(reply, 200, []);
    if (behavior === 'private-error') return response(reply, 503, { code: '../private/internal', error: 'SYNTHETIC_PRIVATE_ERROR_SENTINEL' });
    return response(reply, 200, { authenticated: true, principalId, workspaces: [{ id: workspaceId, name: 'Synthetic transport', role: 'owner' }] });
  }
  if (url.pathname === '/api/repositories') return response(reply, 200, { repositories: [{ id: repositoryId, workspaceId }] });
  if (url.pathname === `/api/repositories/${repositoryId}/map`) return response(reply, 200, { index });
  if (url.pathname === `/api/repositories/${repositoryId}/source`) return response(reply, 200, { evidence: lookupSource(index,
    url.searchParams.get('path')!, Number(url.searchParams.get('startLine')), Number(url.searchParams.get('endLine'))) });
  if (url.pathname === `/api/repositories/${repositoryId}/questions`) return response(reply, 200, { answer: answerLocal(index, JSON.parse(body).question) });
  if (url.pathname === '/api/purchases') return response(reply, 201, reservation);
  if (url.pathname === `/api/purchases/${purchaseId}/claim-signing`) return response(reply, 200, { state: signingState });
  if (url.pathname === `/api/purchases/${purchaseId}/unknown`) { signingState = 'unknown'; return response(reply, 200, { state: 'unknown' }); }
  if (url.pathname === `/api/purchases/${purchaseId}/resume`) return response(reply, 503, { code: 'delivery-pending' });
  return response(reply, 404, { code: 'unavailable' });
}
function api(token: () => Promise<string | null> = async () => sessionToken) {
  return new AuthenticatedAtlasClient(apiOrigin, { sessionToken: token, allowLocalDevelopment: true });
}
function signer(descriptorChain = 42431, remoteChain = 42431) {
  const rejectedSignature = vi.fn(async () => { throw new Error('No synthetic or live signing is permitted in this test'); });
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method !== 'eth_chainId') throw new Error('No broadcast or other signer RPC is permitted');
    return '0x' + remoteChain.toString(16);
  });
  const account = { address: ('0x' + '3'.repeat(40)) as `0x${string}`, type: 'local' as const, source: 'custom',
    signTransaction: rejectedSignature, signTypedData: rejectedSignature, signMessage: rejectedSignature };
  const getClient = vi.fn(async () => ({ chain: { id: descriptorChain }, request, account }) as never);
  return { value: { account: account as unknown as ModeratoSigner['account'], getClient } satisfies ModeratoSigner,
    request, getClient, rejectedSignature };
}
function mcpText(result: Awaited<ReturnType<Client['callTool']>>) {
  expect(result.isError).not.toBe(true); const content = result.content as { type: string; text: string }[];
  expect(content).toHaveLength(1); expect(content[0]!.type).toBe('text'); return JSON.parse(content[0]!.text);
}
beforeAll(async () => {
  const now = Date.now(); const requestBody = JSON.stringify({ packageName: '@verifier/sdk', version: '1.2.3', question: 'retry', idempotencyKey });
  const adapter = createTempoTestnetAdapter({ providerId, origin: providerOrigin, realm: 'sdk-verifier', token: MODERATO_PATHUSD,
    recipient: `0x${'2'.repeat(40)}`, decimals: 6, atomicPrice: '1000', secretKey: randomBytes(32).toString('base64'), quoteLifetimeMs: 300_000 }, {
    authorize: async (_request, input) => ({ principalId, permissionRevision: 'synthetic:1', input }),
    quote: async (_authorization, terms) => terms, lookup: async () => null,
    claim: async () => { throw new Error('No charge is permitted'); }, bindSubmission: async () => { throw new Error('No submission is permitted'); },
    verifySettlement: async () => false, saveSettlement: async () => { throw new Error('No settlement is permitted'); },
    markUnknown: async () => {}, deliver: async () => { throw new Error('No paid delivery is permitted'); }, replayStore: Store.memory(), now: () => now,
    getClient: () => ({ chain: { id: 42431 }, request: async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0xa5bf'; throw new Error('No external RPC is permitted');
    } }) as never,
  });
  const quote = await adapter.handle(new Request(providerOrigin + '/context/retrieve', { method: 'POST', body: requestBody }));
  expect(quote.status).toBe(402); const challenge = Challenge.deserialize(quote.headers.get('WWW-Authenticate')!);
  reservation = { purchase: { id: purchaseId, providerId, packageName: '@verifier/sdk', version: '1.2.3', network: MODERATO_NETWORK,
    token: MODERATO_PATHUSD, recipient: `0x${'2'.repeat(40)}`, atomicAmount: '1000', paymentState: 'reserved', deliveryState: 'awaiting-payment', receiptReference: null,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
  approval: { terms: { providerId, operation: 'context.retrieve', requestDigest: BodyDigest.compute(requestBody), packageName: '@verifier/sdk', version: '1.2.3',
    network: MODERATO_NETWORK, token: MODERATO_PATHUSD, recipient: `0x${'2'.repeat(40)}`, atomicAmount: '1000', expiresAtMs: Date.parse(challenge.expires!) },
  origin: providerOrigin, realm: challenge.realm, challengeId: challenge.id, idempotencyKey, tokenDecimals: 6,
  publicationDigest: 'b'.repeat(64), commitSha: 'a'.repeat(40), snapshotId, challenge }, requestBody, endpoint: providerOrigin + '/context/retrieve' };
  server = createServer((request, reply) => { handle(request, reply).catch(() => { if (!reply.headersSent) response(reply, 500, { code: 'synthetic-transport-error' }); else reply.destroy(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Loopback test server unavailable');
  apiOrigin = `http://127.0.0.1:${address.port}`;
  directory = await mkdtemp(join(tmpdir(), 'atlas-sdk-production-')); tokenFile = join(directory, 'synthetic-session.txt');
  await writeFile(tokenFile, sessionToken, { flag: 'wx' });
}, 30_000);
beforeEach(() => { seen.length = 0; behavior = 'normal'; signingState = 'claimed'; vi.stubEnv('ATLAS_MODE', 'github'); vi.stubEnv('ATLAS_FIXTURES_ENABLED', 'false'); });
afterAll(async () => {
  vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>((complete, reject) => server.close(error => error ? reject(error) : complete()));
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.split(/[\\/]/).at(-1)?.startsWith('atlas-sdk-production-')) throw new Error('Temporary SDK cleanup target is invalid');
  await rm(directory, { recursive: true, force: true });
});
describe('authenticated SDK over native loopback HTTP', () => {
  it('requires exact HTTPS origins or explicit loopback development, with no URL credentials', () => {
    for (const origin of ['http://remote.verifier.dev', 'https://user:pass@atlas.verifier.dev', 'https://atlas.verifier.dev/path', 'https://atlas.verifier.dev?token=x']) {
      expect(() => new AuthenticatedAtlasClient(origin, { sessionToken: async () => null, allowLocalDevelopment: true })).toThrow();
    }
    expect(() => new AuthenticatedAtlasClient(apiOrigin, { sessionToken: async () => null })).toThrow();
    expect(() => api()).not.toThrow();
  });
  it('sends current session only to RepoFair and preserves exact snapshot/source selectors over real HTTP', async () => {
    const client = api(); expect((await client.account()).principalId).toBe(principalId);
    await client.repositories(workspaceId); const map = await client.map(repositoryId, snapshotId, { query: 'retry & auth', folder: 'src/' });
    expect(map.index.snapshot.snapshotId).toBe(snapshotId);
    const source = await client.source(repositoryId, snapshotId, 'src/index.ts', 1, 3); expect(source.evidence.original).toBe(sourceText.trimEnd());
    expect(source.evidence.source.revision).toBe('a'.repeat(40));
    const quote = await client.approvePurchase({ workspaceId, providerId, question: 'retry', idempotencyKey, approvedAtomicAmount: '1000' });
    expect(quote.endpoint).toBe(providerOrigin + '/context/retrieve');
    expect(seen.every(item => item.authorization === `Bearer ${sessionToken}` && item.url.startsWith('/api/'))).toBe(true);
    expect(seen.every(item => !item.url.includes(sessionToken) && !item.body.includes(sessionToken) && item.payment === undefined)).toBe(true);
    const selected = new URL(seen.find(item => item.url.includes('/map?'))!.url, apiOrigin);
    expect(selected.searchParams.get('snapshotId')).toBe(snapshotId); expect(selected.searchParams.get('query')).toBe('retry & auth');
    expect(seen.at(-1)!.origin).toBe(apiOrigin); expect(JSON.parse(seen.at(-1)!.body).approvedAtomicAmount).toBe('1000');
  });
  it('never follows a redirect or forwards authorization to its destination', async () => {
    behavior = 'redirect'; await expect(api().account()).rejects.toThrow(); expect(seen.map(item => item.url)).toEqual(['/api/account']);
  });
  it('permits a slow authorized quote or read-only delivery while ordinary requests still expire at 30 seconds, without retrying', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Bounded test timeout', 'TimeoutError')), milliseconds);
      return controller.signal;
    });
    const transport = vi.fn(async (_input: string | URL | Request, options?: RequestInit) => new Promise<Response>((complete, reject) => {
      const signal = options!.signal!;
      const timer = setTimeout(() => complete(Response.json(reservation)), 45_000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }));
    const client = new AuthenticatedAtlasClient('https://repofair.sdk-verifier.dev', { sessionToken: async () => sessionToken, fetch: transport as typeof fetch });
    try {
      for (const operation of [
        () => client.approvePurchase({ workspaceId, providerId, question: 'retry', idempotencyKey, approvedAtomicAmount: '1000' }),
        () => client.resumePurchase(purchaseId),
      ]) {
        const pending = operation(); await vi.advanceTimersByTimeAsync(45_000);
        await expect(pending).resolves.toEqual(reservation);
      }
      const ordinary = client.account(); const rejected = expect(ordinary).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(30_000); await rejected;
      expect(timeout.mock.calls.map(call => call[0])).toEqual([240_000, 240_000, 30_000]);
      expect(transport).toHaveBeenCalledTimes(3);
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });
  it('rejects missing, multiline, empty, or unbounded session credentials without leakage', async () => {
    await expect(api(async () => null).account()).rejects.toMatchObject({ status: 401, code: 'session-required' });
    seen.length = 0;
    for (const token of ['', 'synthetic\r\nheader', 'x'.repeat(16_385)]) await expect(api(async () => token).account()).rejects.toThrow('Invalid session credential');
    expect(seen).toEqual([]);
  });
  it('cancels an oversized response and rejects non-object JSON and malformed UTF-8', async () => {
    behavior = 'oversized'; await expect(api().account()).rejects.toThrow('response exceeds bounds');
    behavior = 'bad-json'; await expect(api().account()).rejects.toThrow('Invalid RepoFair response');
    behavior = 'bad-utf8'; await expect(api().account()).rejects.toThrow();
  });
  it('reports sanitized status/code without propagating private server error contents', async () => {
    behavior = 'private-error'; const error = await api().account().catch(value => value);
    expect(error).toBeInstanceOf(AtlasApiError); expect(error).toMatchObject({ status: 503, code: 'unavailable' });
    expect(error.message).not.toContain('SYNTHETIC_PRIVATE_ERROR_SENTINEL'); expect(error.message).not.toContain(sessionToken);
  });
});
describe('genuine offline MPP preparation and fail-closed signing', () => {
  it('rejects altered network/token/price/body/endpoint/challenge before claiming or touching signer RPC', async () => {
    const wallet = signer(); const changes = [
      { ...reservation, approval: { ...reservation.approval, terms: { ...reservation.approval.terms, network: 'eip155:4217' } } },
      { ...reservation, approval: { ...reservation.approval, terms: { ...reservation.approval.terms, token: '0x' + '1'.repeat(40) } } },
      { ...reservation, purchase: { ...reservation.purchase, atomicAmount: '1001' } },
      { ...reservation, requestBody: reservation.requestBody + ' ' },
      { ...reservation, endpoint: 'https://other.sdk-verifier.dev/context/retrieve' },
      { ...reservation, approval: { ...reservation.approval, challenge: { ...reservation.approval.challenge, request: { ...reservation.approval.challenge.request, amount: '1001' } } } },
      { ...reservation, approval: { ...reservation.approval, challenge: { ...reservation.approval.challenge, request: { ...reservation.approval.challenge.request, methodDetails: { chainId: 4217, supportedModes: ['pull'] } } } } },
    ];
    for (const altered of changes) await expect(api().pay(altered as PurchaseReservation, wallet.value)).rejects.toThrow();
    expect(seen).toEqual([]); expect(wallet.getClient).not.toHaveBeenCalled(); expect(wallet.rejectedSignature).not.toHaveBeenCalled();
  });
  it('prepares the real SDK challenge but never resolves signer or signs when claim is pending/unknown/settled/failed', async () => {
    const wallet = signer();
    for (const state of ['pending', 'unknown', 'settled', 'failed'] as const) {
      signingState = state; await expect(api().pay(reservation, wallet.value)).rejects.toThrow('signing cannot be retried');
    }
    expect(seen).toHaveLength(4); expect(seen.every(item => item.url.endsWith('/claim-signing') && item.body === '{}' && item.origin === apiOrigin)).toBe(true);
    expect(wallet.getClient).not.toHaveBeenCalled(); expect(wallet.request).not.toHaveBeenCalled(); expect(wallet.rejectedSignature).not.toHaveBeenCalled();
  });
  it('rejects wrong remote chain despite a 42431 descriptor, records uncertainty, and blocks the next signing attempt', async () => {
    const wallet = signer(42431, 4217);
    await expect(api().pay(reservation, wallet.value)).rejects.toThrow('Signing outcome is unknown');
    expect(wallet.getClient).toHaveBeenCalledTimes(1); expect(wallet.request.mock.calls.map(([request]) => request.method)).toEqual(['eth_chainId']);
    expect(wallet.rejectedSignature).not.toHaveBeenCalled(); expect(signingState).toBe('unknown');
    expect(seen.map(item => item.url)).toEqual([`/api/purchases/${purchaseId}/claim-signing`, `/api/purchases/${purchaseId}/unknown`]);
    await expect(api().pay(reservation, wallet.value)).rejects.toThrow('signing cannot be retried'); expect(wallet.getClient).toHaveBeenCalledTimes(1);
    expect(seen.some(item => /\/(credential|resume)$/.test(item.url) || item.payment !== undefined)).toBe(false);
  });
  it('rejects a mismatched client descriptor before any remote RPC or signature', async () => {
    const wallet = signer(4217, 42431); await expect(api().pay(reservation, wallet.value)).rejects.toThrow('Signing outcome is unknown');
    expect(wallet.request).not.toHaveBeenCalled(); expect(wallet.rejectedSignature).not.toHaveBeenCalled(); expect(signingState).toBe('unknown');
  });
});
describe('authenticated production MCP protocol and process transport', () => {
  it('negotiates actual MCP against authenticated HTTP and exposes no budget/approval/signing tools', async () => {
    const server = createAtlasMcpServer(api()); const client = new Client({ name: 'sdk-production-verifier', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport); expect(client.getServerVersion()?.name).toBe('repofair');
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toContain('atlas_resolve_dependency'); expect(names).toContain('atlas_resume_purchase');
      expect(names.some(name => /fixture|budget|allowance|approve|sign|pay$/.test(name))).toBe(false);
      const source = mcpText(await client.callTool({ name: 'atlas_source', arguments: { repositoryId, snapshotId, path: 'src/index.ts', startLine: 1, endLine: 3 } }));
      expect(source.evidence.original).toBe(sourceText.trimEnd()); expect(source.evidence.source.snapshotId).toBe(snapshotId);
      const invalid = await client.callTool({ name: 'atlas_explore', arguments: { repositoryId: '../../private', snapshotId } }); expect(invalid.isError).toBe(true);
      const before = seen.length; const resume = await client.callTool({ name: 'atlas_resume_purchase', arguments: { purchaseId } }); expect(resume.isError).toBe(true);
      expect(seen.slice(before)).toMatchObject([{ url: `/api/purchases/${purchaseId}/resume`, method: 'POST', body: '{}', payment: undefined }]);
      expect(JSON.stringify(resume.content)).not.toContain(sessionToken);
    } finally { await client.close(); await server.close(); }
  });
  it('runs the production stdio entrypoint with a synthetic token file and real loopback source citations', async () => {
    const client = new Client({ name: 'sdk-production-stdio-verifier', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: 'bun', args: ['packages/sdk/src/mcp.ts'], cwd: resolve('.'), stderr: 'pipe', env: {
      ...getDefaultEnvironment(), ATLAS_MODE: 'github', ATLAS_FIXTURES_ENABLED: 'false', NODE_ENV: 'production',
      ATLAS_API_ORIGIN: apiOrigin, ATLAS_SESSION_TOKEN_FILE: tokenFile, ATLAS_ALLOW_LOCAL_DEVELOPMENT: 'true',
    } });
    const stderr: string[] = []; transport.stderr?.on('data', chunk => stderr.push(String(chunk)));
    try {
      await client.connect(transport); expect(transport.pid).toBeGreaterThan(0); expect(client.getServerVersion()?.name).toBe('repofair');
      expect(mcpText(await client.callTool({ name: 'atlas_account', arguments: {} })).principalId).toBe(principalId);
      const answered = mcpText(await client.callTool({ name: 'atlas_question', arguments: { repositoryId, snapshotId, question: 'How does retry work?' } }));
      expect(answered.answer.citations.length).toBeGreaterThan(0); expect(answered.answer.citations.every((item: { source: { snapshotId: string } }) => item.source.snapshotId === snapshotId)).toBe(true);
      expect(seen.every(item => item.authorization === `Bearer ${sessionToken}` && item.payment === undefined)).toBe(true); expect(stderr).toEqual([]);
      expect(JSON.stringify(answered)).not.toContain(sessionToken);
    } finally { await client.close(); await transport.close(); }
  }, 30_000);
});
