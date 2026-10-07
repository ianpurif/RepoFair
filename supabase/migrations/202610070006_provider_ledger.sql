-- Independent provider sale ledger. No buyer budgets, credentials or source data.
-- Apply to the provider's own PostgreSQL database; service-only access is required.
create schema if not exists atlas_provider;
revoke all on schema atlas_provider from public, anon, authenticated;
grant usage on schema atlas_provider to service_role;
create table atlas_provider.sales (
  provider_id text not null check(provider_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  principal_id text not null check(octet_length(principal_id) between 1 and 256),
  idempotency_key text not null check(idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  permission_revision text not null check(octet_length(permission_revision) between 1 and 256),
  authorization_digest text not null check(authorization_digest ~ '^[a-f0-9]{64}$'),
  request_digest text not null check(request_digest ~ '^sha-256=[A-Za-z0-9+/]{43}=$'),
  package_name text not null check(octet_length(package_name) between 1 and 200),
  version text not null check(octet_length(version) between 1 and 100),
  network text not null check(network='eip155:42431'),
  terms jsonb not null check(jsonb_typeof(terms)='object' and octet_length(terms::text)<=8192),
  terms_digest text not null check(terms_digest ~ '^[a-f0-9]{64}$'),
  state text not null default 'quoted' check(state in ('quoted','pending','unknown','settled','rejected')),
  receipt jsonb check(jsonb_typeof(receipt)='object' and octet_length(receipt::text)<=16384),
  receipt_reference text check(octet_length(receipt_reference) between 1 and 512),
  delivery text not null default 'unavailable' check(delivery='unavailable'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  claimed_at timestamptz,
  settled_at timestamptz,
  primary key(provider_id,principal_id,idempotency_key),
  unique(provider_id,network,receipt_reference),
  check(coalesce(terms ?& array['providerId','operation','requestDigest','packageName','version','network','token','recipient','atomicAmount','expiresAtMs']
    and terms - array['providerId','operation','requestDigest','packageName','version','network','token','recipient','atomicAmount','expiresAtMs']='{}'::jsonb
    and jsonb_typeof(terms->'providerId')='string' and jsonb_typeof(terms->'operation')='string' and jsonb_typeof(terms->'requestDigest')='string'
    and jsonb_typeof(terms->'packageName')='string' and jsonb_typeof(terms->'version')='string' and jsonb_typeof(terms->'network')='string'
    and jsonb_typeof(terms->'token')='string' and jsonb_typeof(terms->'recipient')='string' and jsonb_typeof(terms->'atomicAmount')='string'
    and (terms->>'providerId') is not distinct from provider_id and terms->>'operation'='context.retrieve'
    and (terms->>'requestDigest') is not distinct from request_digest and (terms->>'packageName') is not distinct from package_name
    and (terms->>'version') is not distinct from version and (terms->>'network') is not distinct from network
    and terms->>'token' ~ '^0x[a-fA-F0-9]{40}$' and terms->>'token' !~ '^0x0{40}$'
    and terms->>'recipient' ~ '^0x[a-fA-F0-9]{40}$' and terms->>'recipient' !~ '^0x0{40}$'
    and terms->>'atomicAmount' ~ '^[1-9][0-9]{0,77}$' and (terms->>'atomicAmount')::numeric<=115792089237316195423570985008687907853269984665640564039457584007913129639935
    and jsonb_typeof(terms->'expiresAtMs')='number' and terms->>'expiresAtMs' ~ '^[1-9][0-9]{0,15}$'
    and (terms->>'expiresAtMs')::numeric<=9007199254740991,false)),
  check((state='quoted' or state='rejected') = (claimed_at is null)),
  check((state='settled' and receipt is not null and receipt_reference is not null and settled_at is not null)
    or (state<>'settled' and receipt is null and receipt_reference is null and settled_at is null)),
  check(receipt is null or coalesce(receipt ?& array['method','status','timestamp','reference']
    and receipt - array['method','status','timestamp','reference','externalId','fundingCurrency']='{}'::jsonb
    and jsonb_typeof(receipt->'method')='string' and receipt->>'method'='tempo'
    and jsonb_typeof(receipt->'status')='string' and receipt->>'status'='success' and jsonb_typeof(receipt->'reference')='string'
    and jsonb_typeof(receipt->'timestamp')='string' and octet_length(receipt->>'timestamp') between 1 and 64
    and (not receipt ? 'externalId' or (jsonb_typeof(receipt->'externalId')='string' and receipt->>'externalId'=idempotency_key))
    and (not receipt ? 'fundingCurrency' or (jsonb_typeof(receipt->'fundingCurrency')='string' and octet_length(receipt->>'fundingCurrency') between 1 and 256))
    and (receipt->>'reference'=receipt_reference
      or (receipt->>'reference' ~ '^0x[a-fA-F0-9]{64}$' and lower(receipt->>'reference')=receipt_reference)),false))
);
-- Defense against accidental terms mutation or reopening a processed sale in
-- trusted service code. Reconciliation can settle an unknown sale but not retry it.
create function atlas_provider.protect_sale() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if row(new.provider_id,new.principal_id,new.idempotency_key,new.permission_revision,new.authorization_digest,new.request_digest,
    new.package_name,new.version,new.network,new.terms,new.terms_digest,new.created_at,new.delivery)
    is distinct from row(old.provider_id,old.principal_id,old.idempotency_key,old.permission_revision,old.authorization_digest,old.request_digest,
    old.package_name,old.version,old.network,old.terms,old.terms_digest,old.created_at,old.delivery) then
    raise exception 'Immutable provider sale binding cannot change';
  end if;
  if new.state<>old.state and not ((old.state='quoted' and new.state in ('pending','rejected'))
    or (old.state='pending' and new.state in ('unknown','settled')) or (old.state='unknown' and new.state='settled')) then
    raise exception 'Invalid provider sale transition';
  end if;
  if old.claimed_at is not null and new.claimed_at is distinct from old.claimed_at then raise exception 'Immutable provider claim cannot change'; end if;
  if old.state='settled' and row(new.receipt,new.receipt_reference,new.settled_at) is distinct from row(old.receipt,old.receipt_reference,old.settled_at) then
    raise exception 'Immutable provider settlement cannot change';
  end if;
  return new;
end $$;
revoke all on function atlas_provider.protect_sale() from public,anon,authenticated;
create trigger protect_sale before update on atlas_provider.sales for each row execute function atlas_provider.protect_sale();
alter table atlas_provider.sales enable row level security;
revoke all on atlas_provider.sales from public,anon,authenticated;
grant all on atlas_provider.sales to service_role;
