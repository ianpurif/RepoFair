-- Private server-written administrative proposals only. No publication,
-- approval, endpoint verification, sale or payment is enabled by this table.
create table atlas.publication_drafts (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null,
  repository_id uuid not null, snapshot_id uuid not null,
  commit_sha text not null check(commit_sha ~ '^[a-f0-9]{40}$'),
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  state text not null default 'draft' check(state in ('draft','revoked')),
  proposal jsonb not null check(jsonb_typeof(proposal)='object' and octet_length(proposal::text)<=65536),
  preview jsonb not null check(jsonb_typeof(preview)='object' and octet_length(preview::text)<=262144),
  terms_digest text not null check(terms_digest ~ '^[a-f0-9]{64}$'),
  published boolean not null default false check(not published),
  approval jsonb check(approval is null),
  endpoint_proof text not null default 'unverified' check(endpoint_proof='unverified'),
  payment text not null default 'disabled' check(payment='disabled'),
  created_by text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(repository_id,workspace_id) references atlas.repositories(id,workspace_id),
  foreign key(snapshot_id,workspace_id) references atlas.snapshots(id,workspace_id)
);
create index publication_drafts_workspace on atlas.publication_drafts(workspace_id,created_at desc);
alter table atlas.publication_drafts enable row level security;
revoke all on atlas.publication_drafts from public,anon,authenticated;
grant select on atlas.publication_drafts to authenticated;
grant all on atlas.publication_drafts to service_role;
create policy publication_draft_admin_read on atlas.publication_drafts for select to authenticated using(
  atlas.has_access(workspace_id,true) and atlas.has_repository_access(repository_id)
  and exists(select 1 from atlas.snapshots s where s.id=snapshot_id and s.workspace_id=publication_drafts.workspace_id
    and s.repository_id=publication_drafts.repository_id and s.revision=publication_drafts.commit_sha)
);
