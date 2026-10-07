-- Provider-owned payment replay state. This schema does not read buyer budgets.
-- An independent provider can apply this migration to its own PostgreSQL database.
create schema if not exists atlas_provider;
revoke all on schema atlas_provider from public, anon, authenticated;
grant usage on schema atlas_provider to service_role;
create table atlas_provider.replay (
  namespace text not null check(length(namespace) between 1 and 128),
  key_digest text not null check(key_digest ~ '^[a-f0-9]{64}$'),
  value jsonb not null check(octet_length(value::text) <= 131072),
  updated_at timestamptz not null default now(),
  primary key(namespace,key_digest)
);
alter table atlas_provider.replay enable row level security;
revoke all on atlas_provider.replay from public,anon,authenticated;
grant all on atlas_provider.replay to service_role;
