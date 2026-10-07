import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createGitHubAppClient, createGitHubAppJwt, loadGitHubConfiguration } from '../apps/worker/src/github.ts';
import { createAtlasDatabase } from '../apps/worker/src/database.ts';
const env = { ...parseEnv(readFileSync('.env.local', 'utf8')), ...process.env };
const results: Record<string, unknown>[] = [];
async function probe(id: string, work: () => Promise<Record<string, unknown>>) {
  try { results.push({ id, ...await work() }); }
  catch (error) { results.push({ id, status: 'failed', code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'request-failed' }); }
}
async function request(url: string, headers: Record<string, string>) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => null);
  return { response, data };
}
await probe('clerk', async () => {
  const { response, data } = await request('https://api.clerk.com/v1/instance', { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` });
  return { status: response.ok ? 'verified' : 'failed', httpStatus: response.status, development: data?.environment_type === 'development' };
});
await probe('supabase-auth', async () => {
  const { response } = await request(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY! });
  return { status: response.ok ? 'verified' : 'failed', httpStatus: response.status };
});
await probe('supabase-storage', async () => {
  const { response, data } = await request(`${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/bucket`, { apikey: env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` });
  return { status: response.ok ? 'verified' : 'failed', httpStatus: response.status, bucketCount: Array.isArray(data) ? data.length : null, tenantIsolationVerified: false };
});
await probe('database', async () => {
  const database = await createAtlasDatabase(env);
  try { return await database.withAdminTransaction(async transaction => {
    const result = await transaction.query<{ tables: number }>("select count(*)::int as tables from information_schema.tables where table_schema='atlas'");
    return { status: 'verified', tlsVerified: true, atlasTables: result.rows[0]?.tables, rlsVerified: false };
  }); } finally { await database.close(); }
});
await probe('github-app', async () => {
  const client = await createGitHubAppClient(env);
  const app = await client.getAppMetadata();
  const configuration = await loadGitHubConfiguration(env);
  const headers = { Authorization: `Bearer ${createGitHubAppJwt(configuration)}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' };
  const { response, data } = await request('https://api.github.com/app/installations', headers);
  const hook = await request('https://api.github.com/app/hook/config', headers);
  let repositoryRead: Record<string, unknown> = { status: 'unverified' };
  if (Array.isArray(data) && data.length === 1 && Number.isSafeInteger(data[0].id)) {
    const issued = await fetch('https://api.github.com/app/installations/' + data[0].id + '/access_tokens', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ permissions: { contents: 'read', metadata: 'read' } }),
    });
    const token = await issued.json();
    if (issued.ok && typeof token.token === 'string') {
      const installationHeaders = { ...headers, Authorization: 'Bearer ' + token.token };
      try {
        const repositories = await request('https://api.github.com/installation/repositories?per_page=100', installationHeaders);
        repositoryRead = { status: repositories.response.ok ? 'verified' : 'failed', httpStatus: repositories.response.status,
          accessibleRepositoryCount: repositories.data?.total_count, userOAuthAuthorizationVerified: false };
      } finally { await fetch('https://api.github.com/installation/token', { method: 'DELETE', headers: installationHeaders, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    } else repositoryRead = { status: 'failed', httpStatus: issued.status };
  }

  return { status: 'verified', idMatches: String(app.id) === env.GITHUB_APP_ID, permissions: app.permissions, events: app.events,
    repositoryRead, installationsHttpStatus: response.status, installationCount: Array.isArray(data) ? data.length : null,
    webhookConfigurationHttpStatus: hook.response.status, webhookConfigured: hook.response.ok && typeof hook.data?.url === 'string' && hook.data.url.length > 0 };
});
await probe('deepseek-models', async () => {
  const { response, data } = await request('https://api.deepseek.com/models', { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` });
  return { status: response.ok ? 'verified' : 'failed', httpStatus: response.status, configuredModelAvailable: data?.data?.some((row: { id: string }) => row.id === env.DEEPSEEK_MODEL) === true };
});
const report = { date: new Date().toISOString(), scope: 'Read-only integration probes; no AI inference, payments, migrations, private repository downloads, or signed-in user acceptance.', results };
writeFileSync('docs/evidence/integration-probes.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (results.some(row => row.status !== 'verified')) process.exitCode = 1;
