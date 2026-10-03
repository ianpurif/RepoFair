import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
const db = new PGlite();
const w1 = '00000000-0000-4000-8000-000000000001';
const w2 = '00000000-0000-4000-8000-000000000002';
beforeAll(async () => {
  // A local JWT-claim shim exercises PostgreSQL policy evaluation, not Clerk
  // signature verification or hosted Supabase configuration.
  await db.exec(`create role authenticated; create role service_role bypassrls;
    create schema auth; create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    grant usage on schema auth to authenticated; grant execute on function auth.jwt() to authenticated;`);
  await db.exec(await readFile('supabase/migrations/202610030001_atlas.sql', 'utf8'));
  await db.query('insert into atlas.workspaces(id,name) values ($1, $2),($3,$4)', [w1, 'A', w2, 'B']);
  await db.query("insert into atlas.memberships(workspace_id,principal_id,role) values ($1,'user_a','owner'),($2,'user_b','owner')", [w1,w2]);
  await db.query("insert into atlas.budgets(workspace_id,principal_id,network,token,allowance) values ($1,'user_a','test','asset',100)", [w1]);
}, 30000);
afterAll(async () => { await db.close(); });
async function reserve(key: string, amount = '60', recipient = 'recipient') {
  return db.query<{ id: string }>(`select atlas.reserve_purchase($1,'user_a',$2,$3,'provider','test','asset',$4,$5,'pkg','1.0.0','2030-01-01T00:00:00Z',$6) as id`,
    [w1, key, 'a'.repeat(64), recipient, 'b'.repeat(64), amount]);
}
describe('Actual PostgreSQL-WASM migration checks (not multi-connection or hosted auth)', () => {
  it('isolates membership/workspace rows and denies direct mutations', async () => {
    await db.exec("set role authenticated; set request.jwt.claims = '{\"sub\":\"user_a\"}';");
    try {
      expect((await db.query<{ id: string }>('select id from atlas.workspaces')).rows.map(r => r.id)).toEqual([w1]);
      expect((await db.query('select * from atlas.memberships')).rows).toHaveLength(1);
      await expect(db.query("insert into atlas.workspaces(name) values ('forged')")).rejects.toThrow();
      await expect(reserve('untrusted')).rejects.toThrow();
    } finally { await db.exec('reset role'); }
  });
  it('reserves exact units and enforces duplicate terms and allowance', async () => {
    const first = await reserve('approved-1');
    expect((await reserve('approved-1')).rows[0]?.id).toBe(first.rows[0]?.id);
    await expect(reserve('approved-1','60','changed')).rejects.toThrow('Idempotency terms changed');
    await expect(reserve('approved-2')).rejects.toThrow('Budget exceeded');
    const args: unknown[] = [w1,'user_a','approved-1','a'.repeat(64),'provider','test','asset','recipient','b'.repeat(64),'pkg','1.0.0','2030-01-01T00:00:00Z','60'];
    for (const position of [3,7,11]) {
      const invalid = [...args]; invalid[position] = null;
      await expect(db.query('select atlas.reserve_purchase($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',invalid)).rejects.toThrow('Incomplete purchase terms');
    }
    const row = (await db.query<{ reserved: string; spent: string }>('select reserved::text,spent::text from atlas.budgets')).rows[0];
    expect(row).toEqual({ reserved: '60', spent: '0' });
  });
  it('unknown settlement keeps reservation and cannot be retried', async () => {
    const id = (await reserve('approved-1')).rows[0]!.id;
    await db.query("select atlas.reconcile_purchase($1,'pending')", [id]);
    await db.query("select atlas.reconcile_purchase($1,'unknown')", [id]);
    await expect(db.query("select atlas.reconcile_purchase($1,'pending')", [id])).rejects.toThrow('Unknown settlement needs reconciliation');
    expect((await db.query('select reserved::text from atlas.budgets')).rows[0]).toEqual({ reserved: '60' });
    await db.query("select atlas.reconcile_purchase($1,'settled',$2)", [id, JSON.stringify({ test: 'SQL adapter test only, not a payment receipt' })]);
    await db.query("select atlas.reconcile_purchase($1,'settled',$2)", [id, '{}']);
    expect((await db.query('select reserved::text,spent::text from atlas.budgets')).rows[0]).toEqual({ reserved: '0', spent: '60' });
  });
  it('revoked membership removes purchase and budget visibility', async () => {
    await db.query("delete from atlas.memberships where workspace_id=$1 and principal_id='user_a'", [w1]);
    await db.exec("set role authenticated; set request.jwt.claims = '{\"sub\":\"user_a\"}';");
    try {
      expect((await db.query('select * from atlas.purchases')).rows).toEqual([]);
      expect((await db.query('select * from atlas.budgets')).rows).toEqual([]);
    } finally { await db.exec('reset role'); }
  });
});
