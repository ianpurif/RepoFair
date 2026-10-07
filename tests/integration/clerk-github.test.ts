import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubForPrincipal } from '../../apps/worker/src/clerk-github.ts';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const env = { CLERK_SECRET_KEY: 'unit-test-key', GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: key };
afterEach(() => vi.restoreAllMocks());
function identity(verification = 'verified', githubId = 7) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input);
    if (url === 'https://api.clerk.com/v1/users/user_test123') return Response.json({ id: 'user_test123', external_accounts: [{ provider: 'oauth_github', provider_user_id: '7', verification: { status: verification } }] });
    if (url.endsWith('/oauth_access_tokens/oauth_github')) return Response.json([{ token: 'unit-test-oauth' }]);
    if (url === 'https://api.github.com/user') return Response.json({ id: githubId, login: 'owner' });
    throw new Error('Unexpected endpoint');
  });
}
describe('Clerk linked GitHub identity', () => {
  it('uses the actual provider_user_id field and verifies it with GitHub', async () => {
    const calls = identity();
    const result = await githubForPrincipal('user_test123', env);
    expect(result.user.githubUserId).toBe(7); expect(result.user.principalId).toBe('user_test123');
    expect(calls).toHaveBeenCalledTimes(3);
  });
  it('does not accept an unverified linked account or mismatched OAuth user', async () => {
    const calls = identity('unverified');
    await expect(githubForPrincipal('user_test123', env)).rejects.toThrow('Connect GitHub');
    expect(calls).toHaveBeenCalledTimes(1); vi.restoreAllMocks(); identity('verified', 8);
    await expect(githubForPrincipal('user_test123', env)).rejects.toThrow('does not match');
  });
  it('rejects a client supplied malformed principal before contacting either service', async () => {
    const calls = identity(); await expect(githubForPrincipal('../users/other', env)).rejects.toThrow('Verified Clerk');
    expect(calls).not.toHaveBeenCalled();
  });
});
