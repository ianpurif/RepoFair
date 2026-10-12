import { createHash, createHmac, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createGitHubAppClient, createGitHubAppJwt, GITHUB_API_VERSION, GitHubError, loadGitHubConfiguration, verifyGitHubWebhook } from '../../apps/worker/src/github.ts';
import type { AuthorizedGitHubRepository, VerifiedGitHubUser } from '../../apps/worker/src/github.ts';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const env = { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: pem };
const now = Date.parse('2026-10-07T00:00:00Z');
const commitSha = 'a'.repeat(40); const treeSha = 'b'.repeat(40);
const source = 'throw new Error("Imported code must never execute");\nexport const value = 1;\n';
const bytes = Buffer.from(source);
const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const repo = { id: 100, owner: { login: 'owner' }, name: 'repository', full_name: 'owner/repository', private: true, default_branch: 'main', permissions: { pull: true }, disabled: false };
const installed = { id: 99, app_id: 123, account: { login: 'owner' }, repository_selection: 'selected', permissions: { contents: 'read', metadata: 'read' }, suspended_at: null };
function mockApi(patch: Record<string, unknown> = {}) {
  const entries: Record<string, unknown> = {
    '/app': { id: 123, slug: 'atlas', permissions: { contents: 'read' }, events: ['push'] },
    '/user': { id: 10, login: 'alice' },
    '/user/installations?per_page=100&page=1': { installations: [installed] },
    '/user/installations/99/repositories?per_page=100&page=1': { repositories: [repo] },
    '/repos/owner/repository': repo,
    '/repos/owner/repository/installation': installed,
    '/app/installations/99/access_tokens': { token: 'ghs_test_only', expires_at: '2026-10-07T01:00:00Z' },
    '/repos/owner/repository/commits/main': { sha: commitSha, commit: { tree: { sha: treeSha } } },
    [`/repos/owner/repository/commits/${commitSha}`]: { sha: commitSha, commit: { tree: { sha: treeSha } } },
    [`/repos/owner/repository/git/trees/${treeSha}?recursive=1`]: { sha: treeSha, truncated: false, tree: [{ path: 'src/index.ts', sha: blobSha, type: 'blob', mode: '100644', size: bytes.length }] },
    [`/repos/owner/repository/git/blobs/${blobSha}`]: { sha: blobSha, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') },
    ...patch,
  };
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input)); const path = `${url.pathname}${url.search}`;
    expect(url.origin).toBe('https://api.github.com'); calls.push({ path, init });
    if (!(path in entries)) throw new Error('Unexpected mock endpoint');
    const value = entries[path]; return value instanceof Response ? value : Response.json(value);
  });
  return { fetch: fn as typeof fetch, calls, entries };
}
async function authorized(patch: Record<string, unknown> = {}) {
  const api = mockApi(patch); const client = await createGitHubAppClient(env, { fetch: api.fetch, now: () => now });
  const user = await client.verifyUser({ principalId: 'clerk-user-1', githubUserId: 10, userAccessToken: 'user-test-only' });
  const access = await client.authorizeRepository(user, { owner: 'owner', name: 'repository', installationId: 99, repositoryId: 100 });
  return { api, client, user, access };
}
describe('GitHub App authentication and authorization', () => {
  it('rejects missing, client-secret, non-RSA, and ambiguous key configuration before requests', async () => {
    for (const config of [{}, { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'a'.repeat(40) }, { ...env, GITHUB_APP_ID: 'Iv23client-id' }, { ...env, GITHUB_APP_PRIVATE_KEY_FILE: 'key.pem' }]) {
      await expect(createGitHubAppClient(config)).rejects.toBeInstanceOf(GitHubError);
    }
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await expect(loadGitHubConfiguration({ ...env, GITHUB_APP_PRIVATE_KEY: ec })).rejects.toThrow('RSA');
  });
  it('loads escaped PEM and server-side PEM file and signs verifiable RS256 JWTs', async () => {
    const config = await loadGitHubConfiguration({ ...env, GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, '\\n') });
    const token = createGitHubAppJwt(config, now); const [header, payload, signature] = token.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ iss: '123', iat: now / 1000 - 60, exp: now / 1000 + 540 });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey(keys.privateKey), Buffer.from(signature, 'base64url'))).toBe(true);
    const directory = await mkdtemp(join(tmpdir(), 'atlas-github-key-'));
    try { const file = join(directory, 'app.pem'); await writeFile(file, pem); expect((await loadGitHubConfiguration({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY_FILE: file })).appId).toBe('123'); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('checks actual App identity and uses fixed host, current version, and no redirect', async () => {
    const api = mockApi(); const client = await createGitHubAppClient(env, { fetch: api.fetch, now: () => now });
    expect((await client.getAppMetadata()).id).toBe(123);
    expect(api.calls[0]?.init?.redirect).toBe('error');
    expect((api.calls[0]?.init?.headers as Record<string, string>)['X-GitHub-Api-Version']).toBe(GITHUB_API_VERSION);
    api.entries['/app'] = { id: 456, slug: 'other', permissions: {}, events: [] };
    await expect(client.getAppMetadata()).rejects.toThrow('different App');
  });
  it('rejects user-token identity mismatches and forged verified handles', async () => {
    const api = mockApi(); const client = await createGitHubAppClient(env, { fetch: api.fetch, now: () => now });
    await expect(client.verifyUser({ principalId: 'clerk-user-1', githubUserId: 11, userAccessToken: 'user-test-only' })).rejects.toThrow('linked user');
    await expect(client.authorizeRepository({ principalId: 'clerk-user-1', githubUserId: 10, login: 'alice' } as VerifiedGitHubUser, { owner: 'owner', name: 'repository' })).rejects.toThrow('verification');
    expect(api.calls).toHaveLength(1);
  });
  it('requires independent user read and limits the App token to one repository with read permissions', async () => {
    const { api, access } = await authorized();
    expect(access.principalId).toBe('clerk-user-1'); expect(JSON.stringify(access)).not.toContain('ghs_');
    const issued = api.calls.find(call => call.path.endsWith('/access_tokens'));
    expect(JSON.parse(String(issued?.init?.body))).toEqual({ repository_ids: [100], permissions: { contents: 'read', metadata: 'read' } });
    const denied = mockApi({ '/repos/owner/repository': { ...repo, permissions: { pull: false } } });
    const client = await createGitHubAppClient(env, { fetch: denied.fetch, now: () => now });
    const user = await client.verifyUser({ principalId: 'clerk-user-1', githubUserId: 10, userAccessToken: 'user-test-only' });
    await expect(client.authorizeRepository(user, { owner: 'owner', name: 'repository' })).rejects.toThrow('cannot read');
    expect(denied.calls.some(call => call.path.endsWith('/access_tokens'))).toBe(false);
  });
  it('rejects wrong repository or installation selections and suspended or foreign Apps', async () => {
    for (const selected of [{ repositoryId: 101 }, { installationId: 98 }]) {
      const { client, user } = await authorized();
      await expect(client.authorizeRepository(user, { owner: 'owner', name: 'repository', ...selected })).rejects.toThrow('match');
    }
    for (const changed of [{ ...installed, app_id: 456 }, { ...installed, suspended_at: '2026-10-07' }, { ...installed, permissions: { contents: 'none' } }]) {
      await expect(authorized({ '/repos/owner/repository/installation': changed })).rejects.toThrow('cannot read');
    }
  });
  it('authorizes a verified personal owner without broad repository OAuth scopes', async () => {
    const owner = { login: 'owner', id: 10, type: 'User' };
    const api = mockApi({ '/user': { id: 10, login: 'owner' }, '/repos/owner/repository': { ...repo, owner }, '/repos/owner/repository/installation': { ...installed, account: owner } });
    const client = await createGitHubAppClient(env, { fetch: api.fetch, now: () => now });
    const user = await client.verifyUser({ principalId: 'clerk-owner', githubUserId: 10, userAccessToken: 'identity-only-token' });
    const access = await client.authorizeRepository(user, { owner: 'owner', name: 'repository' });
    expect(access.id).toBe(100);
    const issued = api.calls.find(call => call.path.endsWith('/access_tokens'));
    expect(JSON.parse(String(issued?.init?.body))).toEqual({ repositories: ['repository'], permissions: { contents: 'read', metadata: 'read' } });
    const metadata = api.calls.find(call => call.path === '/repos/owner/repository');
    expect((metadata?.init?.headers as Record<string,string>).Authorization).toBe('Bearer ghs_test_only');
    api.entries['/repos/owner/repository'] = { ...repo, owner: { ...owner, id: 11 } };
    await expect(client.resolveCommit(access, 'main')).rejects.toThrow('access changed');
  });
  it('rejects personal-owner claims for organization installations or a different numeric owner', async () => {
    for (const account of [{ login: 'owner', id: 10, type: 'Organization' }, { login: 'owner', id: 11, type: 'User' }]) {
      const api = mockApi({ '/user': { id: 10, login: 'owner' }, '/repos/owner/repository/installation': { ...installed, account } });
      const client = await createGitHubAppClient(env, { fetch: api.fetch, now: () => now });
      const user = await client.verifyUser({ principalId: 'clerk-owner', githubUserId: 10, userAccessToken: 'identity-only-token' });
      await expect(client.authorizeRepository(user, { owner: 'owner', name: 'repository' })).rejects.toThrow('ownership');
      expect(api.calls.some(call => call.path.endsWith('/access_tokens'))).toBe(false);
    }
  });
  it('lists only user-accessible installations and repository intersections', async () => {
    const { client, user, api } = await authorized();
    api.entries['/user/installations?per_page=100&page=1'] = { installations: [installed, { ...installed, id: 88, app_id: 456 }] };
    expect((await client.listInstallations(user)).map(item => item.id)).toEqual([99]);
    expect((await client.listInstallationRepositories(user, 99)).map(item => item.id)).toEqual([100]);
    await expect(client.getInstallation(user, 88)).rejects.toThrow('unavailable');
  });
  it('sanitizes upstream failures and expires verified user/repository handles', async () => {
    const api = mockApi({ '/app': new Response('private-token-secret', { status: 401 }) });
    let time = now; const client = await createGitHubAppClient(env, { fetch: api.fetch, now: () => time });
    await expect(client.getAppMetadata()).rejects.toThrow('HTTP 401');
    try { await client.getAppMetadata(); } catch (error) { expect(String(error)).not.toContain('private-token'); }
    const user = await client.verifyUser({ principalId: 'clerk-user-1', githubUserId: 10, userAccessToken: 'user-test-only' });
    const access = await client.authorizeRepository(user, { owner: 'owner', name: 'repository' }); time += 300_001;
    await expect(client.resolveCommit(access, 'main')).rejects.toThrow('expired');
  });
});
describe('bounded immutable GitHub source download', () => {
  it('checkpoints truncated trees and traverses only eligible subtrees without reading discarded partial entries', async () => {
    const subtree = 'c'.repeat(40); const dependencyTree = 'd'.repeat(40);
    const { client, access, api } = await authorized({
      [`/repos/owner/repository/git/trees/${treeSha}?recursive=1`]: { sha: treeSha, truncated: true, tree: [{ path: 'partial.ts', sha: blobSha, type: 'blob', mode: '100644', size: bytes.length }] },
      [`/repos/owner/repository/git/trees/${treeSha}`]: { sha: treeSha, truncated: false, tree: [{ path: 'src', sha: subtree, type: 'tree', mode: '040000' }, { path: 'node_modules', sha: dependencyTree, type: 'tree', mode: '040000' }] },
      [`/repos/owner/repository/git/trees/${subtree}`]: { sha: subtree, truncated: false, tree: [{ path: 'index.ts', sha: blobSha, type: 'blob', mode: '100644', size: bytes.length }] },
    });
    const first = await client.discoverSnapshot(access, commitSha, undefined, { maxRequests: 1 });
    expect(first.complete).toBe(false); expect(first.files).toEqual([]); expect(first.pending).toEqual([{ prefix: '', sha: treeSha, recursive: false }]);
    const second = await client.discoverSnapshot(access, commitSha, first, { maxRequests: 1 });
    expect(second.complete).toBe(false); expect(second.pending).toEqual([{ prefix: 'src', sha: subtree, recursive: false }]);
    const third = await client.discoverSnapshot(access, commitSha, second, { maxRequests: 1 });
    expect(third.complete).toBe(true); expect(third.files.map(file => file.path)).toEqual(['src/index.ts']); expect(third.treesVisited).toBe(3);
    expect(api.calls.some(call => call.path.includes(dependencyTree) || call.path.includes('/git/blobs/'))).toBe(false);
  });
  it('accepts large metadata trees while excluding irrelevant files and enforcing the actual 5000 source-file bound', async () => {
    const entry = { sha: blobSha, type: 'blob', mode: '100644', size: bytes.length };
    const excluded = Array.from({ length: 12000 }, (_, position) => ({ ...entry, path: `node_modules/pkg/${position}.ts` }));
    const treePath = `/repos/owner/repository/git/trees/${treeSha}?recursive=1`;
    const { client, access, api } = await authorized({ [treePath]: { sha: treeSha, truncated: false, tree: [...excluded, { ...entry, path: 'main.py' }, { ...entry, path: 'oversized.go', size: 262145 }, { ...entry, path: '.env.local' }] } });
    const state = await client.discoverSnapshot(access, commitSha);
    expect(state.files.map(file => file.path)).toEqual(['main.py']); expect(state.discovered).toBe(12003); expect(state.skipped).toBe(12002);
    api.entries[treePath] = { sha: treeSha, truncated: false, tree: Array.from({ length: 5001 }, (_, position) => ({ ...entry, path: `src/${position}.ts` })) };
    await expect(client.discoverSnapshot(access, commitSha)).rejects.toMatchObject({ code: 'limit' });
    expect(api.calls.some(call => call.path.includes('/git/blobs/'))).toBe(false);
  });
  it('classifies primary and secondary rate limits separately from authorization and retains Retry-After', async () => {
    const cases: [Response, string, number | undefined][] = [
      [new Response('limited', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 120), 'retry-after': '30' } }), 'rate-limit', 120000],
      [Response.json({ message: 'You have exceeded a secondary rate limit.' }, { status: 403 }), 'rate-limit', 60000],
      [new Response('limited', { status: 429, headers: { 'retry-after': '45' } }), 'rate-limit', 45000],
      [new Response('forbidden', { status: 403 }), 'unauthorized', undefined],
      [new Response('unavailable', { status: 503, headers: { 'retry-after': '20' } }), 'upstream', 20000],
    ];
    for (const [response, code, retryAfterMs] of cases) {
      const { client, access, api } = await authorized(); api.entries[`/repos/owner/repository/commits/${commitSha}`] = response;
      await expect(client.discoverSnapshot(access, commitSha)).rejects.toMatchObject({ code, retryAfterMs });
    }
  });
  it('refreshes an expired installation token once on a 401 while keeping a single repository read scope', async () => {
    const api = mockApi(); let refreshed = false;
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).includes('/git/blobs/') && (init?.headers as Record<string,string>).Authorization === 'Bearer ghs_test_only') {
        api.entries['/app/installations/99/access_tokens'] = { token: 'ghs_refreshed_test_only', expires_at: '2026-10-07T01:00:00Z' }; refreshed = true;
        return new Response('expired', { status: 401 });
      }
      return api.fetch(input, init);
    };
    const client = await createGitHubAppClient(env, { fetch: fetcher, now: () => now });
    const user = await client.verifyUser({ principalId: 'clerk-user-1', githubUserId: 10, userAccessToken: 'user-test-only' });
    const access = await client.authorizeRepository(user, { owner: 'owner', name: 'repository' });
    expect((await client.downloadSnapshot(access, commitSha)).files[0]?.text).toBe(source); expect(refreshed).toBe(true);
    const issuance = api.calls.filter(call => call.path.endsWith('/access_tokens')); expect(issuance).toHaveLength(2);
    expect(JSON.parse(String(issuance[1]?.init?.body))).toEqual({ repository_ids: [100], permissions: { contents: 'read', metadata: 'read' } });
  });
  it('aborts active downloads and starts no new requests after the caller cancels', async () => {
    const api = mockApi(); let started = 0; const controller = new AbortController();
    const fetcher: typeof fetch = async (input, init) => {
      if (!String(input).includes('/git/blobs/')) return api.fetch(input, init);
      started++; return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
    };
    const client = await createGitHubAppClient(env, { fetch: fetcher, now: () => now });
    const user = await client.verifyUser({ principalId: 'clerk-user-1', githubUserId: 10, userAccessToken: 'user-test-only' });
    const access = await client.authorizeRepository(user, { owner: 'owner', name: 'repository' });
    const work = client.downloadFiles(access, Array.from({ length: 10 }, (_, position) => ({ path: `src/${position}.ts`, size: bytes.length, blobSha })), { signal: controller.signal });
    while (!started) await new Promise(resolve => setTimeout(resolve, 1));
    controller.abort(); await expect(work).rejects.toMatchObject({ code: 'aborted' }); expect(started).toBeLessThanOrEqual(4);
  });
  it('preserves a UTF-8 byte order mark so staged text still hashes to the immutable blob', async () => {
    const original = '\uFEFFexport const value = 1;\n'; const data = Buffer.from(original); const hash = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
    const { client, access } = await authorized({ [`/repos/owner/repository/git/blobs/${hash}`]: { sha: hash, encoding: 'base64', size: data.length, content: data.toString('base64') } });
    expect((await client.downloadFiles(access, [{ path: 'src/bom.ts', size: data.length, blobSha: hash }]))[0]?.text).toBe(original);
  });
  it('inspects immutable authorized tree metadata without reading any source blob', async () => {
    const { client, access, api } = await authorized();
    expect(await client.inspectSnapshot(access, commitSha)).toEqual({ commitSha, treeSha, files: [{ path: 'src/index.ts', size: bytes.length, blobSha }], limitations: [] });
    expect(api.calls.some(call => call.path.includes('/git/blobs/'))).toBe(false);
  });
  it('preflights complete tree file, per-file and total byte bounds before any blob request', async () => {
    const treePath = `/repos/owner/repository/git/trees/${treeSha}?recursive=1`;
    const entry = { path: 'src/index.ts', sha: blobSha, type: 'blob', mode: '100644', size: bytes.length };
    for (const limits of [{ maxFiles: 1, maxFileBytes: 262144, maxTotalBytes: 30000000 }, { maxFiles: 5000, maxFileBytes: bytes.length - 1, maxTotalBytes: 30000000 }, { maxFiles: 5000, maxFileBytes: 262144, maxTotalBytes: bytes.length }]) {
      const { client, access, api } = await authorized({ [treePath]: { sha: treeSha, truncated: false, tree: [entry, { ...entry, path: 'src/other.ts' }] } });
      await expect(client.downloadSnapshot(access, commitSha, limits)).rejects.toMatchObject({ code: 'limit' });
      expect(api.calls.some(call => call.path.includes('/git/blobs/'))).toBe(false);
    }
    const { client, access } = await authorized();
    await expect(client.downloadSnapshot(access, commitSha, { maxFiles: 5001, maxFileBytes: 262144, maxTotalBytes: 30000000 })).rejects.toThrow('trusted');
  });
  it('bounds blob concurrency at four and preserves complete source order and hashes', async () => {
    const entry = { sha: blobSha, type: 'blob', mode: '100644', size: bytes.length };
    const api = mockApi({ [`/repos/owner/repository/git/trees/${treeSha}?recursive=1`]: { sha: treeSha, truncated: false, tree: Array.from({ length: 11 }, (_, index) => ({ ...entry, path: `src/${index}.ts` })) } });
    let active = 0; let maximum = 0;
    const fetcher: typeof fetch = async (input, init) => {
      if (!String(input).includes('/git/blobs/')) return api.fetch(input, init);
      active++; maximum = Math.max(maximum, active);
      try { await new Promise(resolve => setTimeout(resolve, 5)); return await api.fetch(input, init); }
      finally { active--; }
    };
    const client = await createGitHubAppClient(env, { fetch: fetcher, now: () => now });
    const user = await client.verifyUser({ principalId: 'clerk-user-1', githubUserId: 10, userAccessToken: 'user-test-only' });
    const access = await client.authorizeRepository(user, { owner: 'owner', name: 'repository' });
    const result = await client.downloadSnapshot(access, commitSha);
    expect(maximum).toBe(4); expect(active).toBe(0);
    expect(result.files.map(file => file.path)).toEqual(Array.from({ length: 11 }, (_, index) => `src/${index}.ts`).sort());
    expect(result.files.every(file => file.text === source && file.blobSha === blobSha)).toBe(true);
  });
  it('resolves exact commit and verifies source blob bytes without executing source', async () => {
    const { client, access } = await authorized();
    expect(await client.resolveCommit(access, 'main')).toEqual({ sha: commitSha, treeSha });
    const snapshot = await client.downloadSnapshot(access, commitSha);
    expect(snapshot.commitSha).toBe(commitSha); expect(snapshot.files).toEqual([{ path: 'src/index.ts', text: source, lineCount: 3, blobSha }]);
    await expect(client.resolveCommit({ ...access } as AuthorizedGitHubRepository, 'main')).rejects.toThrow('authorization');
  });
  it('rechecks user access before reading source after revocation', async () => {
    const { client, access, api } = await authorized(); api.entries['/repos/owner/repository'] = new Response('revoked', { status: 404 });
    await expect(client.downloadSnapshot(access, commitSha)).rejects.toThrow('HTTP 404');
    expect(api.calls.some(call => call.path.includes('/git/'))).toBe(false);
  });
  it('fails closed on truncated trees, unsafe paths, large source, forged blob content, and changed commit', async () => {
    const treePath = `/repos/owner/repository/git/trees/${treeSha}?recursive=1`;
    const entry = { path: 'src/index.ts', sha: blobSha, type: 'blob', mode: '100644', size: bytes.length };
    for (const badTree of [{ sha: treeSha, truncated: true, tree: [entry] }, { sha: treeSha, truncated: false, tree: [{ ...entry, path: '../secret.ts' }] }, { sha: treeSha, truncated: false, tree: [{ ...entry, size: 512_001 }] }]) {
      const { client, access } = await authorized({ [treePath]: badTree });
      await expect(client.downloadSnapshot(access, commitSha)).rejects.toBeInstanceOf(GitHubError);
    }
    const { client, access } = await authorized({ [`/repos/owner/repository/git/blobs/${blobSha}`]: { sha: blobSha, size: bytes.length, encoding: 'base64', content: Buffer.alloc(bytes.length, 65).toString('base64') } });
    await expect(client.downloadSnapshot(access, commitSha)).rejects.toThrow('immutable object');
    const changed = await authorized({ [`/repos/owner/repository/commits/${commitSha}`]: { sha: 'c'.repeat(40), commit: { tree: { sha: treeSha } } } });
    await expect(changed.client.downloadSnapshot(changed.access, commitSha)).rejects.toThrow('different immutable');
  });
  it('skips symlinks, submodules, generated files, and unsupported credentials files explicitly', async () => {
    const { client, access } = await authorized({ [`/repos/owner/repository/git/trees/${treeSha}?recursive=1`]: { sha: treeSha, truncated: false, tree: [
      { path: 'src/index.ts', sha: blobSha, type: 'blob', mode: '100644', size: bytes.length },
      { path: 'src/link.ts', type: 'blob', mode: '120000' }, { path: 'external', type: 'commit', mode: '160000' },
      { path: '.env.local', type: 'blob', mode: '100644' }, { path: 'node_modules/lib/index.ts', type: 'blob', mode: '100644' },
    ] } });
    const result = await client.downloadSnapshot(access, commitSha);
    expect(result.files).toHaveLength(1); expect(result.limitations).toHaveLength(2);
  });
});
describe('GitHub webhook authentication', () => {
  const secret = 'test-only-long-secret'; const body = Buffer.from(JSON.stringify({ zen: 'Unicode 安全', hook_id: 7 }));
  function headers(data = body): Headers { return new Headers({ 'content-type': 'application/json', 'x-github-event': 'ping', 'x-github-delivery': '01234567-89ab-cdef-0123-456789abcdef', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(data).digest('hex')}` }); }
  it('verifies raw UTF-8 bytes and returns stable delivery/event/body digest', () => {
    const result = verifyGitHubWebhook(body, headers(), secret);
    expect(result.deliveryId).toBe('01234567-89ab-cdef-0123-456789abcdef'); expect(result.event).toBe('ping');
    expect(result.bodyDigest).toBe(createHash('sha256').update(body).digest('hex')); expect(result.payload.zen).toBe('Unicode 安全');
  });
  it('rejects tampering, malformed signatures, missing secret, bad metadata and oversized payloads', () => {
    expect(() => verifyGitHubWebhook(Buffer.from('{}'), headers(), secret)).toThrow('verification');
    const malformed = headers(); malformed.set('x-hub-signature-256', 'sha256=00');
    expect(() => verifyGitHubWebhook(body, malformed, secret)).toThrow('signature');
    expect(() => verifyGitHubWebhook(body, headers(), undefined)).toThrow('secret');
    const invalid = headers(); invalid.set('x-github-delivery', '../unsafe');
    expect(() => verifyGitHubWebhook(body, invalid, secret)).toThrow('delivery');
    expect(() => verifyGitHubWebhook(Buffer.alloc(1_000_001), headers(), secret)).toThrow('limit');
    const unsupported = headers(); unsupported.set('x-github-event', 'made_up');
    expect(() => verifyGitHubWebhook(body, unsupported, secret)).toThrow('Unsupported');
  });
  it('rejects signed invalid JSON, dangerous keys and excessive nesting', () => {
    for (const text of ['bad json', '{"__proto__":{"polluted":true}}', '['.repeat(40) + '0' + ']'.repeat(40)]) {
      const raw = Buffer.from(text); expect(() => verifyGitHubWebhook(raw, headers(raw), secret)).toThrow();
    }
    const nested = Buffer.from('{"nested":' + '['.repeat(40) + '0' + ']'.repeat(40) + '}');
    expect(() => verifyGitHubWebhook(nested, headers(nested), secret)).toThrow('structure');
  });
});
