-- GitHub identifiers and immutable job inputs; no OAuth or installation tokens persisted.
alter table atlas.repositories add column github_repository_id bigint;
alter table atlas.repositories add column github_installation_id bigint;
alter table atlas.repositories add column github_owner text;
alter table atlas.repositories add column github_name text;
alter table atlas.repositories add column access_revoked boolean not null default false;
create unique index repositories_github_workspace on atlas.repositories(workspace_id,github_repository_id);
alter table atlas.snapshots add column requested_ref text;
alter table atlas.jobs add column error_code text;
create table atlas.webhook_deliveries (
 delivery_id uuid primary key, event text not null, body_digest text not null check(body_digest ~ '^[a-f0-9]{64}$'),
 received_at timestamptz not null default now(), processed_at timestamptz
);
alter table atlas.webhook_deliveries enable row level security;
revoke all on atlas.webhook_deliveries from anon,authenticated;
grant all on atlas.webhook_deliveries to service_role;

create function atlas.has_repository_access(repository uuid) returns boolean language sql stable security definer set search_path=pg_catalog,atlas as $$
 select exists(select 1 from atlas.repositories r join atlas.memberships m on m.workspace_id=r.workspace_id
 where r.id=repository and not r.access_revoked and m.principal_id=auth.jwt()->>'sub')
$$;
create function atlas.has_snapshot_access(snapshot uuid) returns boolean language sql stable security definer set search_path=pg_catalog,atlas as $$
 select exists(select 1 from atlas.snapshots s where s.id=snapshot and atlas.has_repository_access(s.repository_id))
$$;
revoke all on function atlas.has_repository_access(uuid),atlas.has_snapshot_access(uuid) from public;
grant execute on function atlas.has_repository_access(uuid),atlas.has_snapshot_access(uuid) to authenticated;
drop policy repo_read on atlas.repositories;
create policy repo_read on atlas.repositories for select to authenticated using(not access_revoked and atlas.has_access(workspace_id));
drop policy snapshot_read on atlas.snapshots;
create policy snapshot_read on atlas.snapshots for select to authenticated using(atlas.has_repository_access(repository_id));
drop policy source_read on atlas.source_files;
create policy source_read on atlas.source_files for select to authenticated using(atlas.has_snapshot_access(snapshot_id));
drop policy graph_read on atlas.graphs;
create policy graph_read on atlas.graphs for select to authenticated using(atlas.has_snapshot_access(snapshot_id));
drop policy job_read on atlas.jobs;
create policy job_read on atlas.jobs for select to authenticated using(atlas.has_snapshot_access(snapshot_id) and principal_id=auth.jwt()->>'sub');
