-- Durable, server-only ingestion checkpoints. Existing completed snapshots remain intact.
alter table atlas.jobs add column phase text not null default 'discovering'
  check (phase in ('discovering','downloading','parsing','publishing','complete'));
alter table atlas.jobs add column next_attempt_at timestamptz not null default now();
alter table atlas.jobs add column updated_at timestamptz not null default now();
alter table atlas.jobs add column started_at timestamptz;
alter table atlas.jobs add column finished_at timestamptz;
alter table atlas.jobs add column heartbeat_at timestamptz;
alter table atlas.jobs add column claim_token uuid;
alter table atlas.jobs add column repository_permission_revision bigint;
alter table atlas.jobs add column error_retryable boolean not null default false;
alter table atlas.jobs add column files_discovered integer not null default 0 check(files_discovered>=0);
alter table atlas.jobs add column files_eligible integer check(files_eligible>=0);
alter table atlas.jobs add column files_downloaded integer not null default 0 check(files_downloaded>=0);
alter table atlas.jobs add column files_reused integer not null default 0 check(files_reused>=0);
alter table atlas.jobs add column files_parsed integer not null default 0 check(files_parsed>=0);
alter table atlas.jobs add column files_skipped integer not null default 0 check(files_skipped>=0);
alter table atlas.jobs add column bytes_total bigint check(bytes_total>=0);
alter table atlas.jobs add column bytes_processed bigint not null default 0 check(bytes_processed>=0);
update atlas.jobs j set repository_permission_revision=r.permission_revision
  from atlas.snapshots s join atlas.repositories r on r.id=s.repository_id and r.workspace_id=s.workspace_id
  where s.id=j.snapshot_id and s.workspace_id=j.workspace_id;
-- Historic finish times were not recorded. Preserve that uncertainty instead of backdating them.
update atlas.jobs set phase='complete' where status='complete';
with counts as (select workspace_id,snapshot_id,count(*)::integer as files,
  coalesce(sum(octet_length(content)),0)::bigint as bytes from atlas.source_files group by workspace_id,snapshot_id)
update atlas.jobs j set files_discovered=c.files,files_eligible=c.files,files_downloaded=c.files,files_parsed=c.files,
  bytes_total=c.bytes,bytes_processed=c.bytes from counts c
  where j.workspace_id=c.workspace_id and j.snapshot_id=c.snapshot_id and j.status='complete';
-- Preserve duplicate records as cancelled audit history; never delete source or jobs.
with ranked as (select id,row_number() over(partition by snapshot_id order by created_at,id) as ordinal
  from atlas.jobs where status in ('queued','running'))
update atlas.jobs set status='cancelled',lease_until=null,claim_token=null,
  finished_at=now(),updated_at=now(),error_code='duplicate-job'
  where id in (select id from ranked where ordinal>1);
create unique index jobs_one_active_snapshot on atlas.jobs(snapshot_id) where status in ('queued','running');
create index jobs_due on atlas.jobs(next_attempt_at,created_at) where status in ('queued','running');

alter table atlas.snapshots add column tree_sha text check(tree_sha ~ '^[a-f0-9]{40}$');
alter table atlas.snapshots add column index_version text not null default 'atlas-source-v1';
alter table atlas.snapshots add column base_snapshot_id uuid;
alter table atlas.snapshots add column indexed_at timestamptz;
alter table atlas.snapshots add constraint snapshot_base_scope foreign key(base_snapshot_id,workspace_id) references atlas.snapshots(id,workspace_id);
alter table atlas.snapshots drop constraint snapshots_status_check;
alter table atlas.snapshots add constraint snapshots_status_check check(status in ('queued','running','complete','failed','cancelled'));
alter table atlas.snapshots drop constraint snapshots_repository_id_revision_key;
alter table atlas.snapshots add unique(repository_id,revision,index_version);
alter table atlas.source_files add column blob_sha text check(blob_sha ~ '^[a-f0-9]{40}$');
create index source_blob_reuse on atlas.source_files(workspace_id,blob_sha,snapshot_id) where blob_sha is not null;

create table atlas.import_manifests (
  snapshot_id uuid primary key,workspace_id uuid not null,tree_sha text not null check(tree_sha ~ '^[a-f0-9]{40}$'),
  files jsonb not null check(jsonb_typeof(files)='array' and jsonb_array_length(files)<=5000),
  limitations jsonb not null default '[]' check(jsonb_typeof(limitations)='array'),
  discovery_state jsonb not null default '{}' check(jsonb_typeof(discovery_state)='object'),
  created_at timestamptz not null default now(),
  foreign key(snapshot_id,workspace_id) references atlas.snapshots(id,workspace_id)
);
create table atlas.import_files (
  snapshot_id uuid not null,workspace_id uuid not null,path text not null check(length(path) between 1 and 1000),
  blob_sha text not null check(blob_sha ~ '^[a-f0-9]{40}$'),size integer not null check(size between 0 and 262144),
  content text not null check(octet_length(content)<=262144),reused boolean not null default false,
  created_at timestamptz not null default now(),primary key(snapshot_id,path),
  foreign key(snapshot_id,workspace_id) references atlas.snapshots(id,workspace_id)
);
alter table atlas.import_manifests enable row level security;
alter table atlas.import_files enable row level security;
revoke all on atlas.import_manifests,atlas.import_files from public,anon,authenticated;
grant all on atlas.import_manifests,atlas.import_files to service_role;
drop policy job_read on atlas.jobs;
create policy job_read on atlas.jobs for select to authenticated using(atlas.has_snapshot_access(snapshot_id));
-- No partial source can be read through normal source RLS or external APIs.
