-- Only the trusted server sets this transaction-local grant after fresh GitHub proof.
-- Clerk JWT claims or client headers cannot populate this custom PostgreSQL setting.
create or replace function atlas.has_repository_access(repository uuid) returns boolean language sql stable security definer set search_path=pg_catalog,atlas as $$
 select exists(select 1 from atlas.repositories r join atlas.memberships m on m.workspace_id=r.workspace_id
 where r.id=repository and not r.access_revoked and m.principal_id=auth.jwt()->>'sub'
 and coalesce(nullif(current_setting('atlas.authorized_repository_ids',true),'')::jsonb,'[]'::jsonb) ? r.id::text)
$$;
drop policy repo_read on atlas.repositories;
create policy repo_read on atlas.repositories for select to authenticated using(atlas.has_repository_access(id));
