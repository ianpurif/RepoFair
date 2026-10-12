-- Independent provider database. It receives only the owner's signed, selected artifact.
create table atlas_provider.publications (
  provider_id uuid primary key,
  terms_digest text not null check(terms_digest ~ '^[a-f0-9]{64}$'),
  artifact jsonb not null check(jsonb_typeof(artifact)='object' and octet_length(artifact::text)<=4000000),
  signature text not null,
  installed_at timestamptz not null default now()
);
create table atlas_provider.submissions (
  provider_id text not null,principal_id text not null,idempotency_key text not null,
  challenge_id text not null,realm text not null,
  transaction_hash text not null check(transaction_hash ~ '^0x[a-f0-9]{64}$'),
  sender text not null check(sender ~ '^0x[a-f0-9]{40}$'),
  created_at timestamptz not null default now(),
  primary key(provider_id,principal_id,idempotency_key),unique(transaction_hash),
  foreign key(provider_id,principal_id,idempotency_key) references atlas_provider.sales(provider_id,principal_id,idempotency_key)
);
create table atlas_provider.deliveries (
  provider_id text not null,principal_id text not null,idempotency_key text not null,
  context jsonb not null check(jsonb_typeof(context)='object' and octet_length(context::text)<=1000000),
  content_digest text not null check(content_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  primary key(provider_id,principal_id,idempotency_key),
  foreign key(provider_id,principal_id,idempotency_key) references atlas_provider.sales(provider_id,principal_id,idempotency_key)
);
alter table atlas_provider.publications enable row level security;
alter table atlas_provider.submissions enable row level security;
alter table atlas_provider.deliveries enable row level security;
revoke all on atlas_provider.publications,atlas_provider.submissions,atlas_provider.deliveries from public,anon,authenticated;
grant all on atlas_provider.publications,atlas_provider.submissions,atlas_provider.deliveries to service_role;
-- These are immutable bindings, not a mutable provider cache. New versions use a new identity.
create function atlas_provider.prevent_binding_update() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if to_jsonb(new) is distinct from to_jsonb(old) then raise exception 'Immutable provider binding cannot change'; end if;
  return new;
end $$;
revoke all on function atlas_provider.prevent_binding_update() from public,anon,authenticated;
create trigger immutable_publication before update on atlas_provider.publications for each row execute function atlas_provider.prevent_binding_update();
create trigger immutable_submission before update on atlas_provider.submissions for each row execute function atlas_provider.prevent_binding_update();
create trigger immutable_delivery before update on atlas_provider.deliveries for each row execute function atlas_provider.prevent_binding_update();
-- No question, raw payment credential, signing key or source is written to the sale/submission ledger.
