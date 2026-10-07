import { createGitHubAppClient, GitHubError } from './github.ts';
/** The caller supplies a server-verified session principal or a trusted durable job principal. */
export async function githubForPrincipal(principalId: string, env: Readonly<Record<string, string | undefined>>) {
  if (!/^user_[A-Za-z0-9]+$/.test(principalId) || !env.CLERK_SECRET_KEY) throw new GitHubError('unauthorized', 'Verified Clerk identity required');
  async function clerk(path: string) {
    const response = await fetch('https://api.clerk.com/v1' + path, { headers: { Authorization: 'Bearer ' + env.CLERK_SECRET_KEY },
      redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new GitHubError('unauthorized', 'Linked GitHub authorization unavailable');
    if (!response.body) throw new GitHubError('invalid', 'Identity response is empty');
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const next=await reader.read(); if(next.done)break; bytes+=next.value.byteLength;
      if(bytes>256000){await reader.cancel();throw new GitHubError('limit','Identity response exceeded its bound');}parts.push(next.value); }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }
  const user = await clerk('/users/' + principalId);
  if (user.id !== principalId || !Array.isArray(user.external_accounts)) throw new GitHubError('unauthorized', 'Linked GitHub identity unavailable');
  const linked = user.external_accounts.filter((account: { provider?: string }) => account.provider === 'oauth_github');
  if (linked.length !== 1 || linked[0].verification?.status !== 'verified' || !/^\d+$/.test(String(linked[0].provider_user_id))) throw new GitHubError('unauthorized', 'Connect GitHub in account settings before importing');
  const tokens = await clerk('/users/' + principalId + '/oauth_access_tokens/oauth_github');
  if (!Array.isArray(tokens) || tokens.length !== 1 || typeof tokens[0].token !== 'string') throw new GitHubError('unauthorized', 'Reconnect GitHub in account settings');
  const client = await createGitHubAppClient(env);
  const verifiedUser = await client.verifyUser({ principalId, githubUserId: Number(linked[0].provider_user_id), userAccessToken: tokens[0].token });
  return { client, user: verifiedUser };
}
