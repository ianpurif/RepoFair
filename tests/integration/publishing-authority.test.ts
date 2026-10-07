import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGitHubAppClient } from '../../apps/worker/src/github.ts';
import type { VerifiedGitHubUser } from '../../apps/worker/src/github.ts';

// Native GitHub boundary against mocked HTTP responses, never real authority.
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const env = { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: pem }; const now = Date.parse('2026-10-07T00:00:00Z');
function api(admin: boolean, personal = false) {
  const owner = { login: personal ? 'alice' : 'organization', id: personal ? 10 : 20, type: personal ? 'User' : 'Organization' };
  const selected = { id: 100, owner, name: 'repository', full_name: `${owner.login}/repository`, private: true, default_branch: 'main', disabled: false, permissions: { pull: true, push: true, maintain: true, admin } };
  const entries: Record<string, unknown> = { '/user': { id: 10, login: 'alice' }, [`/repos/${owner.login}/repository`]: selected,
    [`/repos/${owner.login}/repository/installation`]: { id: 99, app_id: 123, account: owner, repository_selection: 'selected', permissions: { contents: 'read', metadata: 'read', administration: 'write' }, suspended_at: null },
    '/app/installations/99/access_tokens': { token: 'fixture-installation-token', expires_at: '2026-10-07T01:00:00Z' } };
  const calls: { path: string; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input)); expect(url.origin).toBe('https://api.github.com'); expect(options?.redirect).toBe('error');
    calls.push({ path: url.pathname, body: options?.body ? JSON.parse(String(options.body)) : null });
    if (!(url.pathname in entries)) throw new Error('Unexpected mock endpoint');
    const value = entries[url.pathname]; return value instanceof Response ? value : Response.json(value);
  };
  return { owner, selected, entries, calls, fetcher };
}
async function prepared(admin: boolean, personal = false) {
  const mock = api(admin, personal); const client = await createGitHubAppClient(env, { fetch: mock.fetcher, now: () => now });
  const user = await client.verifyUser({ principalId: 'user_test', githubUserId: 10, userAccessToken: 'fixture-user-token' });
  return { ...mock, client, user, selection: { owner: mock.owner.login, name: 'repository', repositoryId: 100, installationId: 99 } };
}
describe('distinct GitHub publishing authority', () => {
  it('denies collaborators with pull/push/maintain even when the App installation has administration permission', async () => {
    const fixture = await prepared(false);
    expect((await fixture.client.authorizeRepository(fixture.user, fixture.selection)).id).toBe(100);
    await expect(fixture.client.authorizePublication(fixture.user, fixture.selection)).rejects.toThrow('administrative publishing');
  });
  it('accepts fresh user admin permission without issuing write credentials and rechecks it on each request', async () => {
    const fixture = await prepared(true); const proof = await fixture.client.authorizePublication(fixture.user, fixture.selection);
    expect(proof).toMatchObject({ principalId: 'user_test', githubUserId: 10, authority: 'repository-admin', repository: { id: 100, installationId: 99 } });
    const issued = fixture.calls.find(call => call.path.endsWith('/access_tokens'));
    expect(issued?.body).toEqual({ repository_ids: [100], permissions: { contents: 'read', metadata: 'read' } });
    fixture.entries[`/repos/${fixture.owner.login}/repository`] = { ...fixture.selected, permissions: { pull: true, admin: false } };
    await expect(fixture.client.authorizePublication(fixture.user, fixture.selection)).rejects.toThrow('administrative publishing');
  });
  it('accepts verified numeric personal ownership, independently of repository read flags', async () => {
    const fixture = await prepared(false, true); const proof = await fixture.client.authorizePublication(fixture.user, fixture.selection);
    expect(proof.authority).toBe('personal-owner');
    fixture.entries['/repos/alice/repository'] = { ...fixture.selected, owner: { ...fixture.owner, id: 11 } };
    await expect(fixture.client.authorizePublication(fixture.user, fixture.selection)).rejects.toThrow('ownership');
  });
  it('rejects changed actual user identity, organization-owner naming tricks and fabricated verified handles', async () => {
    const fixture = await prepared(true); fixture.entries['/user'] = { id: 11, login: 'alice' };
    await expect(fixture.client.authorizePublication(fixture.user, fixture.selection)).rejects.toThrow('identity changed');
    const personal = await prepared(true, true);
    personal.entries['/repos/alice/repository/installation'] = { ...(personal.entries['/repos/alice/repository/installation'] as object), account: { login: 'alice', id: 10, type: 'Organization' } };
    await expect(personal.client.authorizePublication(personal.user, personal.selection)).rejects.toThrow('ownership');
    await expect(fixture.client.authorizePublication({ principalId: 'user_test', githubUserId: 10, login: 'alice' } as VerifiedGitHubUser, fixture.selection)).rejects.toThrow('verification');
  });
});
