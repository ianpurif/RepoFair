import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { Store } from 'mppx';
import { createAtlasDatabase, AtlasDatabaseError } from '../apps/worker/src/database.ts';
import { createPostgresReplayStore } from '../apps/provider/src/postgres-replay-store.ts';

// Real database contention, generated replay keys only. No payment credential,
// signing, RPC, purchase, provider delivery or external source disclosure.
const namespace = `audit-${randomUUID()}`;
const env = parseEnv(await readFile('.env.local', 'utf8'));
const first = await createAtlasDatabase(env); const second = await createAtlasDatabase(env);
const stores = [createPostgresReplayStore(first, namespace), createPostgresReplayStore(second, namespace)];
const checks: string[] = []; let failure: string | null = null; let cleaned = false;
function assert(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
try {
  const pids = await Promise.all([first, second].map(db => db.withAdminTransaction(async tx => (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)));
  assert(pids[0] !== pids[1], 'audit-distinct-backends'); checks.push('separate-native-postgres-backends');
  const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => Store.tryClaim(stores[index % 2]!, 'shared-credential', Date.now() + 60_000)));
  assert(claims.filter(Boolean).length === 1, 'audit-replay-duplicate-claim'); checks.push('eight-concurrent-claims-exactly-one-winner');
  await Promise.all(Array.from({ length: 8 }, (_, index) => stores[index % 2]!.update('counter', value => ({ op: 'set', value: Number(value ?? 0) + 1, result: undefined }))));
  assert(await stores[0]!.get('counter') === 8, 'audit-lost-atomic-update'); checks.push('eight-concurrent-updates-no-lost-write');
  const other = createPostgresReplayStore(second, `${namespace}-isolated`);
  assert(await other.get('counter') === null, 'audit-namespace-leak'); checks.push('provider-namespaces-isolated');
  let rolledBack = false;
  try { await stores[0]!.update('counter', () => { throw new Error('audit-callback-rejected'); }); } catch { rolledBack = true; }
  assert(rolledBack && await stores[1]!.get('counter') === 8, 'audit-callback-not-rolled-back'); checks.push('callback-failure-rolls-back');
  await stores[0]!.delete('counter'); assert(await stores[1]!.get('counter') === null, 'audit-delete-failed'); checks.push('committed-delete-visible-to-other-backend');
  const denied = await Promise.all(["SET LOCAL ROLE authenticated", "SET LOCAL ROLE anon"].map(async role => {
    try { await first.withAdminTransaction(async tx => { await tx.query(role); await tx.query('SELECT * FROM atlas_provider.replay LIMIT 1'); }); return false; }
    catch (error) { return error instanceof AtlasDatabaseError && error.code === 'permission'; }
  }));
  assert(denied.every(Boolean), 'audit-public-replay-access'); checks.push('anonymous-and-authenticated-role-denied');
} catch (error) {
  failure = error instanceof Error && /^audit-[a-z-]+$/.test(error.message) ? error.message : error instanceof AtlasDatabaseError ? `database-${error.code}` : 'audit-operation-failed';
} finally {
  try { await first.withAdminTransaction(async tx => {
    await tx.query('DELETE FROM atlas_provider.replay WHERE namespace=$1 OR namespace=$2', [namespace, `${namespace}-isolated`]);
    cleaned = (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM atlas_provider.replay WHERE namespace=$1 OR namespace=$2', [namespace, `${namespace}-isolated`])).rows[0]!.count === 0;
  }); } catch { cleaned = false; }
  await Promise.all([first.close(), second.close()]);
}
const evidence = { verifiedAt: new Date().toISOString(), status: !failure && cleaned ? 'verified' : 'failed', checks, failure, generatedRecordsCleaned: cleaned, paymentSubmitted: false, settlementVerified: false };
await writeFile('docs/evidence/provider-replay.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence)); if (evidence.status !== 'verified') process.exitCode = 1;
