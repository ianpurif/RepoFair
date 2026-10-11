import { verifyGitHubWebhook, GitHubError } from './github.ts';
import type { AtlasDatabase } from './database.ts';
import { IMPORT_INDEX_VERSION } from '../../../packages/contracts/src/import.ts';
export async function processGitHubWebhook(database: AtlasDatabase, body: Uint8Array, headers: Headers, secret: string | undefined) {
  const delivery = verifyGitHubWebhook(body, headers, secret);
  const payload = delivery.payload;
  // GitHub signs the body, not the event/delivery headers. Reject cross-event reinterpretation.
  const hasRepository = payload.repository !== undefined;
  const installationBody = payload.installation as Record<string, unknown> | undefined;
  if ((delivery.event === 'installation' && (hasRepository || !installationBody?.account || !installationBody.permissions || !Number.isSafeInteger(installationBody.app_id)))
    || (delivery.event === 'installation_repositories' && (hasRepository || !Array.isArray(payload.repositories_added) || !Array.isArray(payload.repositories_removed)))
    || (delivery.event === 'repository' && (!hasRepository || typeof payload.action !== 'string'))
    || (delivery.event === 'push' && (!hasRepository || payload.action !== undefined))
    || (delivery.event === 'ping' && (typeof payload.zen !== 'string' || !payload.hook || payload.action !== undefined || hasRepository))) {
    throw new GitHubError('invalid', 'Webhook body does not match its event');
  }
  const installation = payload.installation as { id?: unknown } | undefined;
  const installationId = installation?.id;
  if (delivery.event !== 'ping' && (!Number.isSafeInteger(installationId) || Number(installationId) <= 0)) throw new GitHubError('invalid', 'Installation identity required');
  return database.withAdminTransaction(async tx => {
    const inserted = await tx.query('insert into atlas.webhook_deliveries(delivery_id,event,body_digest) values ($1,$2,$3) on conflict do nothing returning delivery_id', [delivery.deliveryId,delivery.event,delivery.bodyDigest]);
    if (!inserted.rowCount) {
      const saved = await tx.query<{body_digest:string;event:string}>('select body_digest,event from atlas.webhook_deliveries where delivery_id=$1',[delivery.deliveryId]);
      if (saved.rows[0]?.body_digest !== delivery.bodyDigest || saved.rows[0]?.event !== delivery.event) throw new GitHubError('invalid','Delivery identity was reused with different content');
      return { status: 'duplicate' };
    }
    let revoked = 0; let queued = 0;
    const revoke = async (repositoryIds?: number[]) => {
      const changed = await tx.query<{id:string}>('update atlas.repositories set access_revoked=true,permission_revision=permission_revision+1 where github_installation_id=$1 and not access_revoked' + (repositoryIds ? ' and github_repository_id=any($2::bigint[])' : '') + ' returning id',repositoryIds ? [installationId,repositoryIds] : [installationId]);
      revoked += changed.rowCount ?? 0;
      for (const repository of changed.rows) {
        const jobs = await tx.query<{ snapshot_id: string }>("update atlas.jobs set status='cancelled',error_code='access-revoked',error_retryable=false,claim_token=null,lease_until=null,updated_at=now(),finished_at=now() where snapshot_id in (select id from atlas.snapshots where repository_id=$1) and status in ('queued','running') returning snapshot_id", [repository.id]);
        await tx.query("update atlas.snapshots set status='cancelled' where id=any($1::uuid[]) and status<>'complete'", [jobs.rows.map(job => job.snapshot_id)]);
      }
    };
    if (delivery.event === 'installation' && ['deleted','suspend'].includes(String(payload.action))) await revoke();
    if (delivery.event === 'installation_repositories' && payload.action === 'removed') {
      const removed = payload.repositories_removed;
      if (!Array.isArray(removed) || removed.length > 1000 || removed.some(row => !row || !Number.isSafeInteger(row.id))) throw new GitHubError('invalid','Invalid removed repository identifiers');
      await revoke(removed.map(row => row.id));
    }
    if (delivery.event === 'repository' && ['deleted','privatized','transferred','archived','renamed'].includes(String(payload.action))) {
      const repository = payload.repository as { id?: unknown } | undefined;
      if (!Number.isSafeInteger(repository?.id)) throw new GitHubError('invalid','Repository identity required');
      await revoke([Number(repository!.id)]);
    }
    if (delivery.event === 'push' && payload.deleted !== true) {
      const repository = payload.repository as { id?: unknown } | undefined;
      if (!Number.isSafeInteger(repository?.id) || typeof payload.after !== 'string' || !/^[a-f0-9]{40}$/.test(payload.after) || typeof payload.ref !== 'string' || !payload.ref.startsWith('refs/heads/')) throw new GitHubError('invalid','Invalid immutable push');
      const ref = payload.ref.slice('refs/heads/'.length);
      if (!ref || ref.length > 255 || /[\s?#\\]/.test(ref) || ref.startsWith('-')) throw new GitHubError('invalid','Invalid push branch');
      const repositories = await tx.query<{id:string;workspace_id:string;permission_revision:string}>('select id,workspace_id,permission_revision::text from atlas.repositories where github_installation_id=$1 and github_repository_id=$2 and not access_revoked for update',[installationId,repository!.id]);
      for (const row of repositories.rows) {
        const origin = await tx.query<{principal_id:string;revision:string}>("select j.principal_id,m.revision::text from atlas.jobs j join atlas.snapshots s on s.id=j.snapshot_id join atlas.memberships m on m.workspace_id=j.workspace_id and m.principal_id=j.principal_id where s.repository_id=$1 and s.requested_ref=$2 and m.role in ('owner','admin') order by j.created_at desc limit 1",[row.id,ref]);
        if (!origin.rows[0]) continue;
        const snapshot = await tx.query<{id:string}>(`insert into atlas.snapshots(workspace_id,repository_id,revision,status,requested_ref,index_version,base_snapshot_id)
          values ($1,$2,$3,'queued',$4,$5,(select id from atlas.snapshots where repository_id=$2 and workspace_id=$1 and status='complete' order by indexed_at desc nulls last,created_at desc limit 1))
          on conflict(repository_id,revision,index_version) do nothing returning id`,[row.workspace_id,row.id,payload.after,ref,IMPORT_INDEX_VERSION]);
        if (!snapshot.rows[0]) continue;
        await tx.query("insert into atlas.jobs(workspace_id,snapshot_id,principal_id,permission_revision,repository_permission_revision) values ($1,$2,$3,$4,$5)",[row.workspace_id,snapshot.rows[0].id,origin.rows[0].principal_id,origin.rows[0].revision,row.permission_revision]); queued++;
      }
    }
    await tx.query('update atlas.webhook_deliveries set processed_at=now() where delivery_id=$1',[delivery.deliveryId]);
    return { status: 'processed', revoked, queued };
  });
}
