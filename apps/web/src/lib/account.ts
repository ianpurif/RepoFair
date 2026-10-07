import 'server-only';
import { createAtlasDatabase } from '@atlas/worker/database';
let database: ReturnType<typeof createAtlasDatabase> | undefined;
function connection() { return database ??= createAtlasDatabase(process.env).catch(error => { database = undefined; throw error; }); }
export async function accountWorkspaces(principalId: string) {
  const db = await connection();
  return db.withPrincipalTransaction(principalId, async transaction => {
    const result = await transaction.query<{ id: string; name: string; role: string }>(
      'select w.id,w.name,m.role from atlas.workspaces w join atlas.memberships m on m.workspace_id=w.id where m.principal_id=$1 order by w.created_at limit 100', [principalId]);
    return result.rows;
  });
}
/** Called only after server session verification. No client workspace/role is accepted. */
export async function ensurePersonalWorkspace(principalId: string) {
  const db = await connection();
  return db.withAdminTransaction(async transaction => {
    await transaction.query('select pg_advisory_xact_lock(hashtextextended($1,0))', ['atlas-personal:' + principalId]);
    const existing = await transaction.query<{ workspace_id: string }>('select workspace_id from atlas.personal_workspaces where principal_id=$1', [principalId]);
    if (existing.rows[0]) return existing.rows[0].workspace_id;
    const result = await transaction.query<{ id: string }>("insert into atlas.workspaces(name) values ('Personal workspace') returning id");
    const id = result.rows[0]!.id;
    await transaction.query("insert into atlas.memberships(workspace_id,principal_id,role) values ($1,$2,'owner')", [id, principalId]);
    await transaction.query('insert into atlas.personal_workspaces(principal_id,workspace_id) values ($1,$2)', [principalId, id]);
    return id;
  });
}
