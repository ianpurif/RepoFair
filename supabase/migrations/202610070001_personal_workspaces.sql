-- Personal workspace ownership is derived from a verified Clerk principal.
create table if not exists atlas.personal_workspaces (
 principal_id text primary key, workspace_id uuid not null unique references atlas.workspaces(id) on delete cascade
);
alter table atlas.personal_workspaces enable row level security;
create policy personal_workspace_read on atlas.personal_workspaces for select to authenticated
 using (principal_id = auth.jwt()->>'sub');
grant select on atlas.personal_workspaces to authenticated;
grant all on atlas.personal_workspaces to service_role;
