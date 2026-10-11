import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseEnv } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { githubForPrincipal } from '../apps/worker/src/clerk-github.ts';
import { createAtlasDatabase, type AtlasDatabase, type AtlasTransaction } from '../apps/worker/src/database.ts';
import { createRepositoryService } from '../apps/worker/src/repository-service.ts';
import { answerLocal, validateLocalAnswer, validateSourceIndex } from '../packages/core/src/local/index.ts';

/** Real authorized GitHub reads; all new source and migration writes stay in memory. */
if ('bun' in process.versions) throw new Error('Use Node.js for the isolated PostgreSQL-WASM acceptance');
const envPath = resolve('.env.local');
const env = { ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}), ...process.env };
const report: Record<string, unknown> = {
  schemaVersion: 1, checkedAt: new Date().toISOString(), status: 'unverified',
  scope: 'Real Clerk-linked GitHub user and App authorization; actual GitHub immutable source reads; production repository service and isolated parser with new migration SQL in an in-memory PostgreSQL-WASM database. Hosted database reads only existing membership/repository metadata. No hosted writes, AI calls, publication, payment, or private source in this report.',
  identityBoundary: 'Existing authorized durable-job principal, freshly reverified by Clerk/GitHub. This script is not a new sign-in or hosted RLS/concurrency acceptance.',
  sourcePersistedByVerifier: false, credentialsOrRepositoryIdentifiersPersisted: false,
  apiRequestCount: 'not instrumented', aiCalls: 0, providerIndexingCostUsd: 0,
  hostedMigrationsApplied: false, hostedWrites: false, cleanup: 'not-required',
};
let hosted: AtlasDatabase | undefined; let sql: PGlite | undefined; let stage = 'configuration';
class CheckFailure extends Error { constructor(readonly code: string) { super(code); } }
function check(value: unknown, code: string): asserts value { if (!value) throw new CheckFailure(code); }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function safeCode(error: unknown): string { const value = object(error).code; return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : 'verification-failed'; }
try {
  check(process.argv.includes('--allow-authorized-source-read'), 'EXPLICIT_AUTHORIZED_SOURCE_READ_REQUIRED');
  const identity = object(JSON.parse(readFileSync(resolve('.atlas/live-principal.json'), 'utf8')));
  const previous = object(JSON.parse(readFileSync(resolve('.atlas/live-import.json'), 'utf8')));
  check(typeof identity.principalId === 'string' && /^user_[A-Za-z0-9]+$/.test(identity.principalId), 'AUTHORIZED_PRINCIPAL_REQUIRED');
  check(typeof previous.repositoryId === 'string' && /^[a-f0-9-]{36}$/i.test(previous.repositoryId) && typeof previous.commitSha === 'string' && /^[a-f0-9]{40}$/i.test(previous.commitSha), 'AUTHORIZED_EXISTING_IMPORT_REQUIRED');
  const principal = identity.principalId;
  stage = 'fresh-github-authorization';
  const linked = await githubForPrincipal(principal, env);
  hosted = await createAtlasDatabase(env);
  const metadata = await hosted.withAdminTransaction(async tx => (await tx.query<{ github_owner: string; github_name: string }>(`SELECT r.github_owner,r.github_name FROM atlas.repositories r
    JOIN atlas.memberships m ON m.workspace_id=r.workspace_id WHERE r.id=$1 AND m.principal_id=$2 AND r.access_revoked=false`, [previous.repositoryId, principal])).rows[0]);
  check(metadata && typeof metadata.github_owner === 'string' && typeof metadata.github_name === 'string', 'EXISTING_MEMBERSHIP_REQUIRED');
  await linked.client.authorizeRepository(linked.user, { owner: metadata.github_owner, name: metadata.github_name });
  report.authorization = { clerkLinkedGitHubVerified: true, repositoryReadVerified: true };
  await hosted.close(); hosted = undefined;

  stage = 'isolated-local-database'; sql = new PGlite(); const local = sql;
  await local.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    GRANT USAGE ON SCHEMA auth TO authenticated;GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;`);
  for (const name of ['202610030001_atlas', '202610070001_personal_workspaces', '202610070002_github_jobs', '202610070003_server_repository_grants', '202610110001_resumable_imports']) await local.exec(await readFile(resolve(`supabase/migrations/${name}.sql`), 'utf8'));
  const workspace = randomUUID();
  await local.query("INSERT INTO atlas.workspaces(id,name) VALUES($1,'Isolated authorized acceptance')", [workspace]);
  await local.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role) VALUES($1,$2,'owner')", [workspace, principal]);
  let tail: Promise<unknown> = Promise.resolve(); let queryCount = 0;
  function transaction<T>(actor: string | null, work: (tx: AtlasTransaction) => Promise<T>): Promise<T> {
    const run = async () => {
      await local.exec('BEGIN');
      try {
        await local.exec(actor ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE NONE');
        await local.query("SELECT set_config('request.jwt.claims',$1,true),set_config('atlas.authorized_repository_ids','[]',true)", [JSON.stringify(actor ? { sub: actor, role: 'authenticated' } : {})]);
        const result = await work({ query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => {
          queryCount++; const value = await local.query<Row>(text, values);
          return { rows: value.rows, rowCount: value.affectedRows ?? value.rows.length, command: '', oid: 0, fields: [] };
        } });
        await local.exec('COMMIT'); return result;
      } catch (error) { await local.exec('ROLLBACK'); throw error; }
    };
    const result = tail.then(run, run); tail = result.catch(() => undefined); return result;
  }
  const database = { withAdminTransaction: <T>(work: (tx: AtlasTransaction) => Promise<T>) => transaction(null, work),
    withPrincipalTransaction: <T>(actor: string, work: (tx: AtlasTransaction) => Promise<T>) => transaction(actor, work) } as AtlasDatabase;
  const service = createRepositoryService(database, { ...env, ATLAS_PARSER_SCRIPT: resolve('packages/core/.atlas/repository-parser-child.mjs') });
  stage = 'real-immutable-import'; const started = performance.now();
  const url = `https://github.com/${metadata.github_owner}/${metadata.github_name}`;
  const queued = await service.queueImport(principal, workspace, url, previous.commitSha);
  const signal = AbortSignal.timeout(120_000); let slices = 0; const phases: Record<string, number> = {};
  for (; slices < 200; slices++) {
    check(!signal.aborted, 'REAL_IMPORT_ACCEPTANCE_DEADLINE');
    const result = await service.processOne({ signal }); phases[result.phase ?? result.status] = (phases[result.phase ?? result.status] ?? 0) + 1;
    if (result.status === 'complete') { slices++; break; }
    if (result.status !== 'progress') throw new CheckFailure(result.code ?? `import-${result.status}`);
  }
  check(slices < 200, 'REAL_IMPORT_SLICE_BOUND');
  const job = await service.getJob(principal, queued.repositoryId);
  check(job?.status === 'complete' && job.commitSha === previous.commitSha, 'REAL_IMPORT_NOT_COMPLETE');
  stage = 'source-graph-answer-validation';
  const index = await service.getIndex(principal, queued.repositoryId, queued.snapshotId); validateSourceIndex(index);
  const graph = await service.getGraph(principal, queued.repositoryId, { snapshotId: queued.snapshotId, limit: 160 });
  const evidence = index.evidence.find(item => /\.(?:[cm]?ts|tsx|[cm]?js|jsx|py|go|rs|java|sql)$/.test(item.source.path));
  check(evidence, 'REAL_SOURCE_EVIDENCE_REQUIRED');
  const source = await service.getSource(principal, queued.repositoryId, queued.snapshotId, evidence.source.path, evidence.source.startLine, evidence.source.endLine);
  check(source.original === evidence.original && source.source.snapshotId === index.snapshot.snapshotId, 'REAL_SOURCE_RANGE_INVALID');
  const term = evidence.original.match(/\b(?:function|def|class|export|import)\b/)?.[0] ?? evidence.original.match(/[a-zA-Z]{3,}/)?.[0];
  check(term, 'REAL_SOURCE_QUERY_TERM_REQUIRED');
  const answer = answerLocal(index, `Show source evidence for ${term}`); validateLocalAnswer(answer, index);
  check(answer.status === 'evidence_ready' && answer.citations.length > 0, 'REAL_EXTRACTIVE_ANSWER_REQUIRED');
  const repeat = await service.queueImport(principal, workspace, url, previous.commitSha);
  check(repeat.status === 'complete' && repeat.snapshotId === queued.snapshotId, 'REAL_SAME_COMMIT_IDEMPOTENCY_FAILED');
  report.result = { durationMs: Math.round(performance.now() - started), slices, phases, localSqlQueries: queryCount,
    files: index.files.length, nodes: index.nodes.length, edges: index.edges.length, evidencePassages: index.evidence.length,
    downloaded: job.progress.downloaded, reused: job.progress.reused, parsed: job.progress.parsed, failures: job.attempts,
    immutableCommitMatchedExistingAuthorizedImport: index.snapshot.revision === previous.commitSha,
    sourceRangeVerified: true, boundedGraphNodesReturned: graph.nodes.length, extractiveCitationCount: answer.citations.length,
    sameCommitRepeatReusedCompleteSnapshot: true, parentRssAtReturnBytes: process.memoryUsage().rss,
    memoryScope: 'Parent RSS at return, including PostgreSQL-WASM; not peak RSS or parser child RSS.' };
  report.incrementalNewCommit = 'Not attempted against another real commit; generated changed-commit checkpoint/blob-reuse tests remain separate.';
  report.status = 'passed';
} catch (error) { report.status = 'blocked'; report.stage = stage; report.code = safeCode(error); process.exitCode = 1; }
finally {
  try { await hosted?.close(); await sql?.close(); report.cleanup = 'local database closed; no hosted writes or verifier-owned source files'; }
  catch { report.cleanup = 'close-failed'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve('docs/evidence/overhaul-real-import.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
