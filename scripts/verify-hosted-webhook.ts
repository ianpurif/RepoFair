import assert from 'node:assert/strict';
import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createAtlasDatabase } from '../apps/worker/src/database.ts';
import type { AtlasDatabase, AtlasTransaction } from '../apps/worker/src/database.ts';
import { processGitHubWebhook } from '../apps/worker/src/github-webhook.ts';

// Deliberately synthetic, generated rows only. No GitHub API, existing tenant
// source, real Clerk tokens, AI, or payments are involved in this verifier.
const env = { ...parseEnv(readFileSync('.env.local', 'utf8')), ...process.env };
const workspace = randomUUID(); const repository = randomUUID(); const snapshot = randomUUID();
const principal = 'user_syntheticWebhook_' + randomUUID().replaceAll('-', '');
const installationId = 9_000_000_000_000 + randomInt(1_000_000_000);
const githubRepositoryId = installationId + 1;
const initialCommit = '1'.repeat(40); const pushedCommit = '2'.repeat(40);
const deliveryIds: string[] = []; const checks: { id: string; status: 'passed' | 'failed'; code?: string }[] = [];
const secret = env.GITHUB_WEBHOOK_SECRET;
let database: AtlasDatabase | undefined; let cleanup = 'not-required'; let httpRouteVerified = false;
function delivery(event: string, payload: Record<string, unknown>, id?: string) {
  const deliveryId = id ?? randomUUID(); if (!deliveryIds.includes(deliveryId)) deliveryIds.push(deliveryId);
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const headers = new Headers({ 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': deliveryId,
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret ?? '').update(body).digest('hex') });
  return { body, headers, id: deliveryId };
}
function push(after = pushedCommit) { return { installation: { id: installationId }, repository: { id: githubRepositoryId }, ref: 'refs/heads/main', after, deleted: false }; }
function processDelivery(item: ReturnType<typeof delivery>) { return processGitHubWebhook(database!, item.body, item.headers, secret); }
async function probe(id: string, work: () => Promise<void>) {
  try { await work(); checks.push({ id, status: 'passed' }); }
  catch (error) { checks.push({ id, status: 'failed', code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'assertion-or-operation-failed' }); }
}
async function scopedCount(tx: AtlasTransaction, table: string): Promise<number> {
  assert(['repositories', 'snapshots', 'source_files', 'graphs', 'jobs'].includes(table));
  return (await tx.query<{ count: number }>(`select count(*)::int as count from atlas.${table} where workspace_id=$1`, [workspace])).rows[0].count;
}
async function visibility(actor: string, grant: boolean) {
  return database!.withPrincipalTransaction(actor, async tx => {
    if (grant) await tx.query("select set_config('atlas.authorized_repository_ids',$1,true)", [JSON.stringify([repository])]);
    return { repository: await scopedCount(tx, 'repositories'), source: await scopedCount(tx, 'source_files'), graph: await scopedCount(tx, 'graphs') };
  });
}
async function counts() {
  return database!.withAdminTransaction(async tx => ({ snapshots: await scopedCount(tx, 'snapshots'), jobs: await scopedCount(tx, 'jobs'),
    deliveries: (await tx.query<{ count: number }>('select count(*)::int as count from atlas.webhook_deliveries where delivery_id=any($1::uuid[])', [deliveryIds])).rows[0].count }));
}
try {
  assert(secret && secret.length >= 16, 'A configured webhook secret is required');
  database = await createAtlasDatabase(env);
  await probe('hosted-migrations-and-server-grant-policy', async () => {
    await database!.withAdminTransaction(async tx => {
      const result = await tx.query<{ installed: boolean; server_grant: boolean }>(`select
        to_regclass('atlas.webhook_deliveries') is not null and exists(select 1 from information_schema.columns where table_schema='atlas' and table_name='repositories' and column_name='github_installation_id') as installed,
        position('atlas.authorized_repository_ids' in pg_get_functiondef('atlas.has_repository_access(uuid)'::regprocedure))>0 as server_grant`);
      assert.equal(result.rows[0].installed, true); assert.equal(result.rows[0].server_grant, true);
    });
  });
  // Seed only if the exact migration preconditions passed; never alter schema.
  assert.equal(checks[0]?.status, 'passed', 'Required hosted migrations are not applied');
  await database.withAdminTransaction(async tx => {
    await tx.query("insert into atlas.workspaces(id,name) values ($1,'Synthetic hosted webhook verification')", [workspace]);
    await tx.query("insert into atlas.memberships(workspace_id,principal_id,role) values ($1,$2,'owner')", [workspace, principal]);
    await tx.query("insert into atlas.repositories(id,workspace_id,name,visibility,github_repository_id,github_installation_id) values ($1,$2,'Synthetic hosted webhook verification','private',$3,$4)", [repository, workspace, githubRepositoryId, installationId]);
    await tx.query("insert into atlas.snapshots(id,workspace_id,repository_id,revision,status,requested_ref) values ($1,$2,$3,$4,'complete','main')", [snapshot, workspace, repository, initialCommit]);
    await tx.query("insert into atlas.source_files(workspace_id,snapshot_id,path,content) values ($1,$2,'synthetic.ts','export const synthetic = true;')", [workspace, snapshot]);
    await tx.query('insert into atlas.graphs(workspace_id,snapshot_id,graph) values ($1,$2,$3::jsonb)', [workspace, snapshot, JSON.stringify({ synthetic: true })]);
    for (const status of ['queued', 'running', 'complete']) await tx.query("insert into atlas.jobs(workspace_id,snapshot_id,principal_id,permission_revision,status,lease_until) values ($1,$2,$3,1,$4,now()+interval '1 hour')", [workspace, snapshot, principal, status]);
  });
  cleanup = 'pending';
  await probe('forged-hmac-no-durable-mutation', async () => {
    const item = delivery('push', push()); item.headers.set('x-hub-signature-256', 'sha256=' + '0'.repeat(64));
    await assert.rejects(processDelivery(item), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'unauthorized'));
    assert.deepEqual(await counts(), { snapshots: 1, jobs: 3, deliveries: 0 });
  });
  await probe('no-source-or-graph-without-server-grant', async () => { assert.deepEqual(await visibility(principal, false), { repository: 0, source: 0, graph: 0 }); });
  await probe('authorized-grant-enables-isolated-source-and-graph', async () => { assert.deepEqual(await visibility(principal, true), { repository: 1, source: 1, graph: 1 }); });
  await probe('other-principal-denied-despite-grant', async () => { assert.deepEqual(await visibility(principal + '_other', true), { repository: 0, source: 0, graph: 0 }); });
  await probe('unsigned-event-header-reinterpretation-denied', async () => {
    const item = delivery('repository', { action: 'deleted', installation: { id: installationId }, repository: { id: githubRepositoryId } }); item.headers.set('x-github-event', 'installation');
    await assert.rejects(processDelivery(item), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'invalid'));
    assert.deepEqual(await counts(), { snapshots: 1, jobs: 3, deliveries: 0 });
  });
  const firstPush = delivery('push', push());
  await probe('concurrent-same-delivery-one-immutable-job', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => processDelivery(firstPush)));
    assert.equal(results.filter(result => result.status === 'processed').length, 1); assert.equal(results.filter(result => result.status === 'duplicate').length, 3);
    assert.deepEqual(results.find(result => result.status === 'processed'), { status: 'processed', revoked: 0, queued: 1 });
    assert.deepEqual(await counts(), { snapshots: 2, jobs: 4, deliveries: 1 });
    await database!.withAdminTransaction(async tx => {
      const rows = (await tx.query<{ revision: string; requested_ref: string }>('select revision,requested_ref from atlas.snapshots where repository_id=$1 and revision=$2', [repository, pushedCommit])).rows;
      assert.deepEqual(rows, [{ revision: pushedCommit, requested_ref: 'main' }]);
    });
  });
  await probe('same-uuid-changed-signed-body-denied', async () => {
    await assert.rejects(processDelivery(delivery('push', push('3'.repeat(40)), firstPush.id)), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'invalid'));
    assert.deepEqual(await counts(), { snapshots: 2, jobs: 4, deliveries: 1 });
  });
  await probe('different-delivery-same-commit-no-second-job', async () => {
    assert.deepEqual(await processDelivery(delivery('push', push())), { status: 'processed', revoked: 0, queued: 0 });
    assert.deepEqual(await counts(), { snapshots: 2, jobs: 4, deliveries: 2 });
  });
  await probe('invalid-removal-transaction-rolls-back-delivery', async () => {
    await assert.rejects(processDelivery(delivery('installation_repositories', { action: 'removed', installation: { id: installationId }, repositories_added: [], repositories_removed: [{ id: 'invalid' }] })), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'invalid'));
    assert.deepEqual(await counts(), { snapshots: 2, jobs: 4, deliveries: 2 });
  });
  const removal = delivery('installation_repositories', { action: 'removed', installation: { id: installationId }, repositories_added: [], repositories_removed: [{ id: githubRepositoryId }] });
  await probe('installation-repository-removal-revokes-and-cancels', async () => {
    assert.deepEqual(await processDelivery(removal), { status: 'processed', revoked: 1, queued: 0 });
    await database!.withAdminTransaction(async tx => {
      const repositoryRows = (await tx.query<{ access_revoked: boolean; revision: number }>('select access_revoked,permission_revision::int as revision from atlas.repositories where id=$1 and workspace_id=$2', [repository, workspace])).rows;
      assert.deepEqual(repositoryRows, [{ access_revoked: true, revision: 2 }]);
      const jobs = (await tx.query<{ status: string; error_code: string | null; lease_until: unknown }>('select status,error_code,lease_until from atlas.jobs where workspace_id=$1', [workspace])).rows;
      assert.equal(jobs.filter(job => job.status === 'cancelled' && job.error_code === 'access-revoked' && job.lease_until === null).length, 3);
      assert.equal(jobs.filter(job => job.status === 'complete').length, 1);
    });
  });
  await probe('revocation-denies-source-and-graph-even-with-prior-grant', async () => { assert.deepEqual(await visibility(principal, true), { repository: 0, source: 0, graph: 0 }); });
  await probe('revoked-repository-push-cannot-queue', async () => { assert.deepEqual(await processDelivery(delivery('push', push('4'.repeat(40)))), { status: 'processed', revoked: 0, queued: 0 }); });
  await probe('exact-removal-replay-is-duplicate', async () => { assert.deepEqual(await processDelivery(removal), { status: 'duplicate' }); });
  // Exercise the actual existing localhost route. This sends only synthetic
  // ping data; it is not a GitHub-origin delivery or a public endpoint check.
  const webhookUrl = 'http://localhost:3000/api/webhooks/github';
  const httpPing = delivery('ping', { zen: 'Synthetic local webhook route verification', hook: { id: installationId } });
  await probe('localhost-http-invalid-signature-denied', async () => {
    const headers = new Headers(httpPing.headers); headers.set('x-hub-signature-256', 'sha256=' + '0'.repeat(64));
    const response = await fetch(webhookUrl, { method: 'POST', headers, body: httpPing.body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'no-store');
  });
  await probe('localhost-http-signed-ping-and-replay', async () => {
    const first = await fetch(webhookUrl, { method: 'POST', headers: httpPing.headers, body: httpPing.body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store'); assert.deepEqual(await first.json(), { status: 'processed', revoked: 0, queued: 0 });
    const duplicate = await fetch(webhookUrl, { method: 'POST', headers: httpPing.headers, body: httpPing.body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), { status: 'duplicate' });
    await database!.withAdminTransaction(async tx => {
      const saved = (await tx.query<{ event: string; body_digest: string; processed: boolean }>('select event,body_digest,processed_at is not null as processed from atlas.webhook_deliveries where delivery_id=$1', [httpPing.id])).rows;
      assert.deepEqual(saved, [{ event: 'ping', body_digest: createHash('sha256').update(httpPing.body).digest('hex'), processed: true }]);
    });
  });
  await probe('localhost-http-oversized-body-denied', async () => {
    const response = await fetch(webhookUrl, { method: 'POST', headers: httpPing.headers, body: 'x'.repeat(1_000_001), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 413); assert.equal(response.headers.get('cache-control'), 'no-store');
  });
  httpRouteVerified = checks.filter(check => check.id.startsWith('localhost-http-')).every(check => check.status === 'passed');
} catch (error) {
  checks.push({ id: 'hosted-verifier-prerequisite-or-setup', status: 'failed', code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'assertion-or-operation-failed' });
} finally {
  if (database) {
    try {
      await database.withAdminTransaction(async tx => {
        for (const table of ['jobs', 'source_files', 'graphs', 'snapshots', 'repositories', 'memberships']) await tx.query(`delete from atlas.${table} where workspace_id=$1`, [workspace]);
        await tx.query('delete from atlas.workspaces where id=$1', [workspace]);
        await tx.query('delete from atlas.webhook_deliveries where delivery_id=any($1::uuid[])', [deliveryIds]);
        assert.deepEqual((await tx.query<{ count: number }>('select count(*)::int as count from atlas.workspaces where id=$1', [workspace])).rows, [{ count: 0 }]);
        assert.deepEqual((await tx.query<{ count: number }>('select count(*)::int as count from atlas.webhook_deliveries where delivery_id=any($1::uuid[])', [deliveryIds])).rows, [{ count: 0 }]);
      });
      cleanup = 'verified-generated-rows-only';
    } catch { cleanup = 'failed'; checks.push({ id: 'generated-row-cleanup', status: 'failed', code: 'cleanup-failed' }); }
    finally { await database.close(); }
  }
}
const report = { date: new Date().toISOString(), scope: 'Native hosted PostgreSQL handler tests with synthetic generated workspaces and GitHub IDs; server principal claim injection, not a Clerk authentication test.',
  databaseTls: 'native-adapter-verifies-certificate-and-host', command: 'bun scripts/verify-hosted-webhook.ts', cleanup,
  checks, remoteGitHubDeliveryVerified: false, httpRouteVerified,
  limitations: ['No GitHub-origin HTTP delivery, webhook dashboard secret match, public endpoint, browser session, or remote source was exercised.'] };
writeFileSync('docs/evidence/webhook-verification.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (checks.some(check => check.status === 'failed') || cleanup === 'failed') process.exitCode = 1;
