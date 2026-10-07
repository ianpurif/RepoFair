import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AtlasDatabase, AtlasTransaction } from '../../apps/worker/src/database.ts';
import { processGitHubWebhook } from '../../apps/worker/src/github-webhook.ts';

// Real HMAC and migration SQL; the JWT shim does not establish hosted Clerk login.
const sql = new PGlite();
const secret = 'synthetic-webhook-test-secret-only';
const principal = 'user_syntheticWebhookOwner';
const workspace = randomUUID(); const repository = randomUUID(); const snapshot = randomUUID();
const installationId = 9_001_000_001; const githubRepositoryId = 9_001_000_002;
const installationBody = { id: installationId, app_id: 9_001_000_003, account: { id: 9_001_000_004, login: 'synthetic-owner' }, permissions: { contents: 'read', metadata: 'read' } };
const initialCommit = '1'.repeat(40); const pushedCommit = '2'.repeat(40);
async function transaction<T>(actor: string | null, work: (tx: AtlasTransaction) => Promise<T>): Promise<T> {
  await sql.exec('BEGIN');
  try {
    await sql.exec(actor ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE NONE');
    await sql.query("select set_config('request.jwt.claims',$1,true),set_config('atlas.authorized_repository_ids','[]',true)", [JSON.stringify(actor ? { sub: actor, role: 'authenticated' } : {})]);
    const result = await work({ query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => {
      const result = await sql.query<Row>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, command: '', oid: 0, fields: [] };
    } });
    await sql.exec('COMMIT'); return result;
  } catch (error) { await sql.exec('ROLLBACK'); throw error; }
}
const database = { withAdminTransaction: <T>(work: (tx: AtlasTransaction) => Promise<T>) => transaction(null, work) } as AtlasDatabase;
function delivery(event: string, payload: Record<string, unknown>, id = randomUUID()) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const headers = new Headers({ 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': id,
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') });
  return { body, headers, id };
}
function push(after = pushedCommit) { return { installation: { id: installationId }, repository: { id: githubRepositoryId }, ref: 'refs/heads/main', after, deleted: false }; }
async function process(item: ReturnType<typeof delivery>) { return processGitHubWebhook(database, item.body, item.headers, secret); }
async function state() {
  return transaction(null, async tx => ({
    repository: (await tx.query('select access_revoked,permission_revision::int as revision from atlas.repositories where id=$1', [repository])).rows[0],
    snapshots: (await tx.query('select revision,requested_ref from atlas.snapshots where repository_id=$1 order by revision', [repository])).rows,
    jobs: (await tx.query('select status,error_code,lease_until from atlas.jobs where workspace_id=$1 order by status', [workspace])).rows,
    deliveries: (await tx.query('select delivery_id from atlas.webhook_deliveries')).rows,
  }));
}
async function visible(actor = principal, grant = true) {
  return transaction(actor, async tx => {
    if (grant) await tx.query("select set_config('atlas.authorized_repository_ids',$1,true)", [JSON.stringify([repository])]);
    const result: Record<string, number> = {};
    for (const table of ['repositories', 'snapshots', 'source_files', 'graphs', 'jobs']) {
      result[table] = (await tx.query<{ count: number }>(`select count(*)::int as count from atlas.${table} where workspace_id=$1`, [workspace])).rows[0].count;
    }
    return result;
  });
}
beforeAll(async () => {
  await sql.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    GRANT USAGE ON SCHEMA auth TO authenticated; GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;`);
  for (const migration of ['202610030001_atlas', '202610070001_personal_workspaces', '202610070002_github_jobs', '202610070003_server_repository_grants']) {
    await sql.exec(await readFile(`supabase/migrations/${migration}.sql`, 'utf8'));
  }
});
beforeEach(async () => {
  await transaction(null, async tx => {
    for (const table of ['jobs', 'source_files', 'graphs', 'snapshots', 'repositories', 'memberships']) await tx.query(`delete from atlas.${table} where workspace_id=$1`, [workspace]);
    await tx.query('delete from atlas.workspaces where id=$1', [workspace]);
    await tx.query('delete from atlas.webhook_deliveries');
    await tx.query("insert into atlas.workspaces(id,name) values ($1,'Synthetic webhook local test')", [workspace]);
    await tx.query("insert into atlas.memberships(workspace_id,principal_id,role) values ($1,$2,'owner')", [workspace, principal]);
    await tx.query("insert into atlas.repositories(id,workspace_id,name,visibility,github_repository_id,github_installation_id) values ($1,$2,'Synthetic webhook local test','private',$3,$4)", [repository, workspace, githubRepositoryId, installationId]);
    await tx.query("insert into atlas.snapshots(id,workspace_id,repository_id,revision,status,requested_ref) values ($1,$2,$3,$4,'complete','main')", [snapshot, workspace, repository, initialCommit]);
    await tx.query("insert into atlas.source_files(workspace_id,snapshot_id,path,content) values ($1,$2,'synthetic.ts','export const synthetic = true;')", [workspace, snapshot]);
    await tx.query('insert into atlas.graphs(workspace_id,snapshot_id,graph) values ($1,$2,$3::jsonb)', [workspace, snapshot, JSON.stringify({ synthetic: true })]);
    for (const status of ['queued', 'running', 'complete']) await tx.query("insert into atlas.jobs(workspace_id,snapshot_id,principal_id,permission_revision,status,lease_until) values ($1,$2,$3,1,$4,now()+interval '1 hour')", [workspace, snapshot, principal, status]);
  });
});
afterAll(async () => { await sql.close(); });
describe('GitHub webhook actual handler and migration policies', () => {
  it('rejects a forged HMAC before any delivery or repository mutation', async () => {
    const item = delivery('push', push()); item.headers.set('x-hub-signature-256', 'sha256=' + '0'.repeat(64));
    await expect(process(item)).rejects.toMatchObject({ code: 'unauthorized' });
    const saved = await state(); expect(saved.deliveries).toHaveLength(0); expect(saved.snapshots).toHaveLength(1); expect(saved.repository?.revision).toBe(1);
  });
  it('rejects a changed raw body even when its JSON remains valid', async () => {
    const item = delivery('push', push()); item.body = new TextEncoder().encode(JSON.stringify(push('3'.repeat(40))));
    await expect(process(item)).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await state()).deliveries).toHaveLength(0);
  });
  it('queues one immutable commit and treats an exact delivery replay as duplicate', async () => {
    const item = delivery('push', push());
    await expect(process(item)).resolves.toEqual({ status: 'processed', revoked: 0, queued: 1 });
    await expect(process(item)).resolves.toEqual({ status: 'duplicate' });
    const saved = await state(); expect(saved.deliveries).toHaveLength(1); expect(saved.snapshots).toEqual([{ revision: initialCommit, requested_ref: 'main' }, { revision: pushedCommit, requested_ref: 'main' }]); expect(saved.jobs).toHaveLength(4);
  });
  it('does not queue the same commit again under a new delivery UUID', async () => {
    await process(delivery('push', push()));
    await expect(process(delivery('push', push()))).resolves.toEqual({ status: 'processed', revoked: 0, queued: 0 });
    expect((await state()).jobs).toHaveLength(4);
  });
  it('rejects a correctly signed changed body reusing an existing delivery UUID', async () => {
    const item = delivery('push', push()); await process(item);
    await expect(process(delivery('push', push('3'.repeat(40)), item.id))).rejects.toMatchObject({ code: 'invalid' });
    const saved = await state(); expect(saved.snapshots).toHaveLength(2); expect(saved.deliveries).toHaveLength(1);
  });
  it('rejects unsigned event-header reinterpretation of a signed repository deletion', async () => {
    const item = delivery('repository', { action: 'deleted', installation: { id: installationId }, repository: { id: githubRepositoryId } });
    item.headers.set('x-github-event', 'installation');
    await expect(process(item)).rejects.toMatchObject({ code: 'invalid' });
    const saved = await state(); expect(saved.repository?.access_revoked).toBe(false); expect(saved.deliveries).toHaveLength(0);
  });
  it('rejects delivery-header reuse with a changed event', async () => {
    const item = delivery('push', push()); await process(item); item.headers.set('x-github-event', 'repository');
    await expect(process(item)).rejects.toMatchObject({ code: 'invalid' });
    expect((await state()).deliveries).toHaveLength(1);
  });
  it('requires the server repository grant and tenant membership before source or graph reads', async () => {
    expect(await visible(principal, false)).toEqual({ repositories: 0, snapshots: 0, source_files: 0, graphs: 0, jobs: 0 });
    expect(await visible()).toEqual({ repositories: 1, snapshots: 1, source_files: 1, graphs: 1, jobs: 3 });
    expect(await visible('user_syntheticOtherTenant')).toEqual({ repositories: 0, snapshots: 0, source_files: 0, graphs: 0, jobs: 0 });
  });
  it.each([
    ['installation', { action: 'deleted', repositories: [] }],
    ['installation', { action: 'suspend', repositories: [] }],
    ['installation_repositories', { action: 'removed', repositories_added: [], repositories_removed: [{ id: githubRepositoryId }] }],
    ['repository', { action: 'deleted', repository: { id: githubRepositoryId } }],
  ])('revokes and cancels pending jobs after %s removal', async (event, payload) => {
    await expect(process(delivery(String(event), { ...payload, installation: installationBody }))).resolves.toEqual({ status: 'processed', revoked: 1, queued: 0 });
    expect(await visible()).toEqual({ repositories: 0, snapshots: 0, source_files: 0, graphs: 0, jobs: 0 });
    const saved = await state(); expect(saved.repository).toEqual({ access_revoked: true, revision: 2 });
    expect(saved.jobs.filter(job => job.status === 'cancelled')).toEqual([
      { status: 'cancelled', error_code: 'access-revoked', lease_until: null }, { status: 'cancelled', error_code: 'access-revoked', lease_until: null },
    ]); expect(saved.jobs.filter(job => job.status === 'complete')).toHaveLength(1);
    await expect(process(delivery('push', push()))).resolves.toEqual({ status: 'processed', revoked: 0, queued: 0 });
  });
  it('does not repeatedly increment the permission revision for separately delivered removal replays', async () => {
    const payload = { action: 'deleted', repositories: [], installation: installationBody };
    await process(delivery('installation', payload));
    await expect(process(delivery('installation', payload))).resolves.toEqual({ status: 'processed', revoked: 0, queued: 0 });
    expect((await state()).repository?.revision).toBe(2);
  });
  it('rolls back delivery recording when signed removal identifiers are invalid', async () => {
    await expect(process(delivery('installation_repositories', { action: 'removed', installation: { id: installationId }, repositories_added: [], repositories_removed: [{ id: 'invalid' }] }))).rejects.toMatchObject({ code: 'invalid' });
    const saved = await state(); expect(saved.deliveries).toHaveLength(0); expect(saved.repository?.access_revoked).toBe(false);
  });
  it('ignores a signed deleted-branch push and refuses a non-immutable commit', async () => {
    await expect(process(delivery('push', { ...push(), deleted: true }))).resolves.toEqual({ status: 'processed', revoked: 0, queued: 0 });
    await expect(process(delivery('push', push('main')))).rejects.toMatchObject({ code: 'invalid' });
    expect((await state()).snapshots).toHaveLength(1);
  });
  it('does not create an automatic import job for a principal who lost owner/admin authority', async () => {
    await transaction(null, tx => tx.query("update atlas.memberships set role='reader',revision=revision+1 where workspace_id=$1 and principal_id=$2", [workspace, principal]));
    await expect(process(delivery('push', push()))).resolves.toEqual({ status: 'processed', revoked: 0, queued: 0 });
    expect((await state()).snapshots).toHaveLength(1);
  });
});
