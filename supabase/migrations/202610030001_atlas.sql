-- Apply only to an explicitly configured Supabase project. No secrets are stored.
create schema if not exists atlas;
create table atlas.workspaces (
  id uuid primary key default gen_random_uuid(), name text not null,
  created_at timestamptz not null default now()
);
create table atlas.memberships (
  workspace_id uuid not null references atlas.workspaces(id) on delete cascade,
  principal_id text not null, role text not null check (role in ('owner','admin','reader')),
  revision bigint not null default 1, primary key (workspace_id, principal_id)
);
create or replace function atlas.has_access(w uuid, admin_only boolean default false)
returns boolean language sql stable security definer set search_path = pg_catalog, atlas as $$
 select exists(select 1 from atlas.memberships m where m.workspace_id=w
 and m.principal_id=(auth.jwt()->>'sub')
 and (not admin_only or m.role in ('owner','admin')))
$$;
revoke all on function atlas.has_access(uuid,boolean) from public;
grant execute on function atlas.has_access(uuid,boolean) to authenticated;

create table atlas.repositories (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references atlas.workspaces(id),
  name text not null, visibility text not null check(visibility in ('private','public')),
  permission_revision bigint not null default 1, unique(id,workspace_id)
);
create table atlas.snapshots (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null,
  repository_id uuid not null, revision text not null check(revision ~ '^[a-f0-9]{40}$'),
  status text not null check(status in ('queued','running','complete','failed')),
  created_at timestamptz not null default now(), unique(id,workspace_id),
  foreign key(repository_id,workspace_id) references atlas.repositories(id,workspace_id),
  unique(repository_id,revision)
);
create table atlas.source_files (
  workspace_id uuid not null, snapshot_id uuid not null, path text not null,
  content text not null check(octet_length(content)<=262144),
  primary key(snapshot_id,path),
  foreign key(snapshot_id,workspace_id) references atlas.snapshots(id,workspace_id)
);
create table atlas.graphs (
  workspace_id uuid not null, snapshot_id uuid primary key,
  graph jsonb not null, foreign key(snapshot_id,workspace_id) references atlas.snapshots(id,workspace_id)
);
create table atlas.jobs (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null,
  snapshot_id uuid not null, principal_id text not null, permission_revision bigint not null,
  status text not null default 'queued' check(status in ('queued','running','complete','failed','cancelled')),
  attempts integer not null default 0, lease_until timestamptz,
  created_at timestamptz not null default now(),
  foreign key(snapshot_id,workspace_id) references atlas.snapshots(id,workspace_id)
);
create table atlas.budgets (
  workspace_id uuid not null references atlas.workspaces(id), principal_id text not null,
  network text not null, token text not null,
  allowance numeric(78,0) not null check(allowance>=0),
  reserved numeric(78,0) not null default 0 check(reserved>=0),
  spent numeric(78,0) not null default 0 check(spent>=0),
  primary key(workspace_id,principal_id,network,token), check(reserved+spent<=allowance)
);
create table atlas.purchases (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, principal_id text not null,
  idempotency_key text not null, terms_digest text not null check(terms_digest ~ '^[a-f0-9]{64}$'),
  provider_id text not null, network text not null, token text not null, recipient text not null,
  request_digest text not null check(request_digest ~ '^[a-f0-9]{64}$'),
  package_name text not null, version text not null, expires_at timestamptz not null,
  amount numeric(78,0) not null check(amount>0),
  payment_state text not null check(payment_state in ('reserved','pending','unknown','settled','failed','expired')),
  delivery_state text not null default 'awaiting-payment' check(delivery_state in ('awaiting-payment','running','ready','failed','revoked')),
  receipt jsonb, created_at timestamptz not null default now(),
  unique(workspace_id,principal_id,idempotency_key),
  foreign key(workspace_id,principal_id,network,token) references atlas.budgets(workspace_id,principal_id,network,token)
);
-- Invoked only by a trusted server after deterministic quote approval. Lock the
-- shared allowance before checking idempotency to serialize concurrent spends.
create or replace function atlas.reserve_purchase(
 w uuid, actor text, idem text, digest text, provider text, net text, asset text,
 payee text, request_hash text, package text, release text, expiry timestamptz, units numeric
) returns uuid language plpgsql security definer set search_path=pg_catalog,atlas as $$
declare b atlas.budgets; existing atlas.purchases; result uuid;
begin
 if w is null or actor is null or idem is null or digest is null or provider is null or net is null or asset is null
 or payee is null or request_hash is null or package is null or release is null or expiry is null or units is null
 or ''=any(array[actor,idem,digest,provider,net,asset,payee,request_hash,package,release])
 or units::text in ('NaN','Infinity','-Infinity') then raise exception 'Incomplete purchase terms'; end if;
 if actor is null or not exists(select 1 from atlas.memberships where workspace_id=w and principal_id=actor) then raise exception 'Access denied'; end if;
 select * into b from atlas.budgets where workspace_id=w and principal_id=actor and network=net and token=asset for update;
 if not found then raise exception 'Budget unavailable'; end if;
 select * into existing from atlas.purchases where workspace_id=w and principal_id=actor and idempotency_key=idem;
 if found then
   if existing.terms_digest is distinct from digest or existing.provider_id is distinct from provider or existing.network is distinct from net or existing.token is distinct from asset
   or existing.recipient is distinct from payee or existing.request_digest is distinct from request_hash or existing.package_name is distinct from package
   or existing.version is distinct from release or existing.amount is distinct from units or existing.expires_at is distinct from expiry then raise exception 'Idempotency terms changed'; end if;
   return existing.id;
 end if;
 if expiry<=now() or units is null or units<=0 or units<>trunc(units) then raise exception 'Invalid or expired terms'; end if;
 if b.reserved+b.spent+units>b.allowance then raise exception 'Budget exceeded'; end if;
 insert into atlas.purchases(workspace_id,principal_id,idempotency_key,terms_digest,provider_id,network,token,recipient,request_digest,package_name,version,expires_at,amount,payment_state)
 values(w,actor,idem,digest,provider,net,asset,payee,request_hash,package,release,expiry,units,'reserved') returning id into result;
 update atlas.budgets set reserved=reserved+units where workspace_id=w and principal_id=actor and network=net and token=asset;
 return result;
end $$;
-- Receipts are accepted only from the trusted SDK adapter, never a browser hash.
create or replace function atlas.reconcile_purchase(purchase uuid, outcome text, verified_receipt jsonb default null)
returns void language plpgsql security definer set search_path=pg_catalog,atlas as $$
declare p atlas.purchases;
begin
 select * into p from atlas.purchases where id=purchase for update;
 if not found then raise exception 'Purchase unavailable'; end if;
 if p.payment_state=outcome then return; end if;
 if p.payment_state in ('settled','failed','expired') then raise exception 'Final state cannot change'; end if;
 if outcome not in ('pending','unknown','settled','failed','expired') then raise exception 'Invalid outcome'; end if;
 if p.payment_state='unknown' and outcome not in ('settled','failed') then raise exception 'Unknown settlement needs reconciliation'; end if;
 if outcome='settled' and (verified_receipt is null or p.payment_state not in ('pending','unknown')) then raise exception 'Verified settlement required'; end if;
 if outcome='expired' and (p.payment_state<>'reserved' or p.expires_at>now()) then raise exception 'Submitted payments cannot expire locally'; end if;
 if outcome in ('settled','failed','expired') then
   update atlas.budgets set reserved=reserved-p.amount, spent=spent+case when outcome='settled' then p.amount else 0 end
   where workspace_id=p.workspace_id and principal_id=p.principal_id and network=p.network and token=p.token;
 end if;
 update atlas.purchases set payment_state=outcome,receipt=case when outcome='settled' then verified_receipt else receipt end where id=purchase;
end $$;
revoke all on function atlas.reserve_purchase(uuid,text,text,text,text,text,text,text,text,text,text,timestamptz,numeric) from public,authenticated;
revoke all on function atlas.reconcile_purchase(uuid,text,jsonb) from public,authenticated;
grant execute on function atlas.reserve_purchase(uuid,text,text,text,text,text,text,text,text,text,text,timestamptz,numeric) to service_role;
grant execute on function atlas.reconcile_purchase(uuid,text,jsonb) to service_role;

alter table atlas.workspaces enable row level security;
alter table atlas.memberships enable row level security;
alter table atlas.repositories enable row level security;
alter table atlas.snapshots enable row level security;
alter table atlas.source_files enable row level security;
alter table atlas.graphs enable row level security;
alter table atlas.jobs enable row level security;
alter table atlas.budgets enable row level security;
alter table atlas.purchases enable row level security;
create policy workspace_read on atlas.workspaces for select to authenticated using(atlas.has_access(id));
create policy membership_read on atlas.memberships for select to authenticated using(principal_id=auth.jwt()->>'sub');
create policy repo_read on atlas.repositories for select to authenticated using(atlas.has_access(workspace_id));
create policy snapshot_read on atlas.snapshots for select to authenticated using(atlas.has_access(workspace_id));
create policy source_read on atlas.source_files for select to authenticated using(atlas.has_access(workspace_id));
create policy graph_read on atlas.graphs for select to authenticated using(atlas.has_access(workspace_id));
create policy job_read on atlas.jobs for select to authenticated using(atlas.has_access(workspace_id) and principal_id=auth.jwt()->>'sub');
create policy budget_read on atlas.budgets for select to authenticated using(atlas.has_access(workspace_id) and principal_id=auth.jwt()->>'sub');
create policy purchase_read on atlas.purchases for select to authenticated using(atlas.has_access(workspace_id) and principal_id=auth.jwt()->>'sub');
grant usage on schema atlas to authenticated,service_role;
grant select on all tables in schema atlas to authenticated;
grant all on all tables in schema atlas to service_role;
-- No anonymous access or direct authenticated mutations. Privileged writes need
-- independently verified identity and grants in the server adapter.
