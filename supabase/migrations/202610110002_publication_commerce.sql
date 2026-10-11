-- Owner-approved source exports and buyer policy. No automatic external publication.
create table atlas.publications (
  id uuid primary key references atlas.publication_drafts(id),
  workspace_id uuid not null references atlas.workspaces(id),
  repository_id uuid not null,
  snapshot_id uuid not null,
  created_by text not null,
  draft_revision bigint not null check(draft_revision>0),
  terms_digest text not null check(terms_digest ~ '^[a-f0-9]{64}$'),
  state text not null check(state in ('active','revoked')),
  access_policy text not null check(access_policy in ('private','authenticated','public')),
  metadata jsonb not null check(jsonb_typeof(metadata)='object' and octet_length(metadata::text)<=16384),
  endpoint_proof_digest text not null check(endpoint_proof_digest ~ '^[a-f0-9]{64}$'),
  activated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(repository_id,workspace_id) references atlas.repositories(id,workspace_id),
  foreign key(snapshot_id,workspace_id) references atlas.snapshots(id,workspace_id)
);
alter table atlas.publications enable row level security;
revoke all on atlas.publications from public,anon,authenticated;
grant all on atlas.publications to service_role;
-- Reading public/authenticated metadata still requires a verified application identity.
grant select on atlas.publications to authenticated;
create policy publication_read on atlas.publications for select to authenticated using (
  state='active' and exists(select 1 from atlas.publication_drafts d join atlas.repositories r on r.id=d.repository_id
    where d.id=atlas.publications.id and d.state='draft' and d.revision=atlas.publications.draft_revision
      and d.terms_digest=atlas.publications.terms_digest and not r.access_revoked)
  and (access_policy<>'private' or atlas.has_snapshot_access(snapshot_id))
);
create function atlas.invalidate_publication() returns trigger language plpgsql security definer set search_path=pg_catalog,atlas as $$
begin
  if row(new.revision,new.state,new.terms_digest) is distinct from row(old.revision,old.state,old.terms_digest) then
    update atlas.publications set state='revoked',updated_at=now() where id=new.id and state='active';
  end if;
  return new;
end $$;
revoke all on function atlas.invalidate_publication() from public,anon,authenticated;
create trigger invalidate_publication after update on atlas.publication_drafts for each row execute function atlas.invalidate_publication();

alter table atlas.purchases add column approval jsonb;
alter table atlas.purchases add column request_body text check(octet_length(request_body)<=8192);
alter table atlas.purchases add column provider_url text;
alter table atlas.purchases add column challenge_id text;
alter table atlas.purchases add column realm text;
alter table atlas.purchases add column transaction_hash text check(transaction_hash ~ '^0x[a-f0-9]{64}$');
alter table atlas.purchases add column sender text check(sender ~ '^0x[a-f0-9]{40}$');
alter table atlas.purchases add column updated_at timestamptz not null default now();
alter table atlas.purchases add column credential_dispatched_at timestamptz;
alter table atlas.budgets add constraint budget_moderato_only check(network='eip155:42431');
alter table atlas.purchases add constraint purchase_moderato_only check(network='eip155:42431');
create unique index buyer_transaction_once on atlas.purchases(network,transaction_hash) where transaction_hash is not null;
-- Immutable policy cannot be substituted between reservation and signing.
create function atlas.protect_purchase_policy() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if row(new.workspace_id,new.principal_id,new.idempotency_key,new.terms_digest,new.provider_id,new.network,new.token,new.recipient,
    new.request_digest,new.package_name,new.version,new.expires_at,new.amount)
    is distinct from row(old.workspace_id,old.principal_id,old.idempotency_key,old.terms_digest,old.provider_id,old.network,old.token,old.recipient,
    old.request_digest,old.package_name,old.version,old.expires_at,old.amount) then raise exception 'Immutable purchase terms cannot change'; end if;
  if old.approval is not null and row(new.approval,new.request_body,new.provider_url,new.challenge_id,new.realm)
    is distinct from row(old.approval,old.request_body,old.provider_url,old.challenge_id,old.realm) then raise exception 'Immutable signing policy cannot change'; end if;
  if old.transaction_hash is not null and row(new.transaction_hash,new.sender) is distinct from row(old.transaction_hash,old.sender) then
    raise exception 'Immutable submitted transaction cannot change'; end if;
  if old.credential_dispatched_at is not null and new.credential_dispatched_at is distinct from old.credential_dispatched_at then
    raise exception 'Credential forwarding cannot be retried'; end if;
  new.updated_at=now(); return new;
end $$;
revoke all on function atlas.protect_purchase_policy() from public,anon,authenticated;
create trigger protect_purchase_policy before update on atlas.purchases for each row execute function atlas.protect_purchase_policy();

