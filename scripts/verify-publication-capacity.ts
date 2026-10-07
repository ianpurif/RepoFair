import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createAtlasDatabase, AtlasDatabaseError } from '../apps/worker/src/database.ts';
import { assertPublicationCapacity, PublicationServiceError } from '../apps/worker/src/publication-service.ts';

// Synthetic inaccessible rows exercise the actual service's capacity helper on
// native hosted PostgreSQL. No source import, GitHub proof or publication claim.
const workspace = randomUUID(); const repos = [randomUUID(), randomUUID()]; const snapshots = [randomUUID(), randomUUID()];
const env = parseEnv(await readFile('.env.local', 'utf8'));
const first = await createAtlasDatabase(env); const second = await createAtlasDatabase(env);
let cleaned = false; let failure: string | null = null; let winners = 0; let denied = 0; let count = 0;
const insert = `INSERT INTO atlas.publication_drafts(workspace_id,repository_id,snapshot_id,commit_sha,proposal,preview,terms_digest,created_by)
  VALUES($1,$2,$3,$4,'{}','{}',$5,'synthetic-capacity-audit')`;
const revision = 'a'.repeat(40); const digest = '0'.repeat(64);
try {
  await first.withAdminTransaction(async tx => {
    await tx.query('INSERT INTO atlas.workspaces(id,name) VALUES($1,$2)', [workspace, 'Isolated publication capacity audit']);
    for (let index = 0; index < 2; index++) {
      await tx.query("INSERT INTO atlas.repositories(id,workspace_id,name,visibility) VALUES($1,$2,$3,'private')", [repos[index], workspace, `synthetic-capacity-${index}`]);
      await tx.query("INSERT INTO atlas.snapshots(id,workspace_id,repository_id,revision,status) VALUES($1,$2,$3,$4,'complete')", [snapshots[index], workspace, repos[index], revision]);
    }
    await tx.query(`INSERT INTO atlas.publication_drafts(workspace_id,repository_id,snapshot_id,commit_sha,proposal,preview,terms_digest,created_by)
      SELECT $1,$2,$3,$4,'{}','{}',$5,'synthetic-capacity-audit' FROM generate_series(1,49)`, [workspace, repos[0], snapshots[0], revision, digest]);
  });
  const results = await Promise.allSettled([first, second].map((db, index) => db.withAdminTransaction(async tx => {
    await tx.query('SELECT id FROM atlas.repositories WHERE id=$1 FOR UPDATE', [repos[index]]);
    await assertPublicationCapacity(tx, index === 0 ? workspace.toUpperCase() : workspace);
    await tx.query(insert, [workspace, repos[index], snapshots[index], revision, digest]);
  })));
  winners = results.filter(result => result.status === 'fulfilled').length;
  denied = results.filter(result => result.status === 'rejected' && result.reason instanceof PublicationServiceError && result.reason.code === 'draft-limit').length;
  count = await first.withAdminTransaction(async tx => (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM atlas.publication_drafts WHERE workspace_id=$1', [workspace])).rows[0]!.count);
  if (winners !== 1 || denied !== 1 || count !== 50) throw new Error('audit-capacity-race-failed');
} catch (error) { failure = error instanceof AtlasDatabaseError ? `database-${error.code}` : error instanceof Error && error.message === 'audit-capacity-race-failed' ? error.message : 'audit-operation-failed'; }
finally {
  try { await first.withAdminTransaction(async tx => {
    await tx.query('DELETE FROM atlas.publication_drafts WHERE workspace_id=$1', [workspace]);
    await tx.query('DELETE FROM atlas.snapshots WHERE workspace_id=$1', [workspace]);
    await tx.query('DELETE FROM atlas.repositories WHERE workspace_id=$1', [workspace]);
    await tx.query('DELETE FROM atlas.workspaces WHERE id=$1', [workspace]);
    cleaned = (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM atlas.workspaces WHERE id=$1', [workspace])).rows[0]!.count === 0;
  }); } catch { cleaned = false; }
  await Promise.all([first.close(), second.close()]);
}
const evidence = { checkedAt: new Date().toISOString(), status: !failure && cleaned ? 'verified' : 'failed', scope: 'Actual capacity helper on hosted PostgreSQL, two repositories and mixed-case UUIDs, synthetic inaccessible metadata', insertedBeforeRace: 49, contenders: 2, winners, capacityDenials: denied, recordsAfterRace: count, failure, generatedRecordsCleaned: cleaned, realSourceImported: false, publicationActivated: false };
await writeFile('docs/evidence/publication-capacity.json', JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify(evidence));
if (evidence.status !== 'verified') process.exitCode = 1;
