import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import { createGitHubAppClient } from '../apps/worker/src/github.ts';
import { createRepositoryService } from '../apps/worker/src/repository-service.ts';
import type { AtlasDatabase, AtlasTransaction } from '../apps/worker/src/database.ts';

// Explicit synthetic benchmark: actual GitHub client protocol and verified blob
// hashes, actual migration SQL, checkpoints and isolated trusted Node parser.
// All GitHub HTTP and identity responses are simulated; no network is used.
if ('bun' in process.versions) throw new Error('Run the pipeline benchmark with Node.js');
const sql = new PGlite(); let queryCount = 0;
async function transaction<T>(actor: string | null, work: (tx: AtlasTransaction) => Promise<T>): Promise<T> {
  await sql.exec('BEGIN');
  try {
    await sql.exec(actor ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE NONE');
    await sql.query("SELECT set_config('request.jwt.claims',$1,true),set_config('atlas.authorized_repository_ids','[]',true)",[JSON.stringify(actor ? { sub:actor,role:'authenticated' } : {})]);
    const result = await work({ query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => {
      queryCount++; const result = await sql.query<Row>(text,values);
      return { rows:result.rows,rowCount:result.affectedRows ?? result.rows.length,command:'',oid:0,fields:[] };
    } });
    await sql.exec('COMMIT'); return result;
  } catch (error) { await sql.exec('ROLLBACK'); throw error; }
}
const database = { withAdminTransaction:<T>(work:(tx:AtlasTransaction)=>Promise<T>)=>transaction(null,work),
  withPrincipalTransaction:<T>(actor:string,work:(tx:AtlasTransaction)=>Promise<T>)=>transaction(actor,work) } as AtlasDatabase;
const principal = 'user_generatedImportBenchmark';
const workspace = '10000000-0000-4000-8000-000000000001';
type Source = { path:string;text:string };
type ApiCounts = { total:number;blobs:number;trees:number;commits:number;tokens:number;authorization:number };
const counts:ApiCounts={total:0,blobs:0,trees:0,commits:0,tokens:0,authorization:0};
let repositoryId=1; let activeName='generated-17'; let activeSha=''; let activeTree=''; let sources:Source[]=[];
const blobs=new Map<string,Buffer>(); const manifests=new Map<string,{sha:string;type:'blob';mode:string;size:number;path:string}[]>();
const commits=new Map<string,string>();
const digest=(value:string)=>createHash('sha1').update(value).digest('hex');
function setSnapshot(files:Source[], label:string) {
  sources=files; activeSha=digest(label); activeTree=digest(`${label}-tree`); commits.set(activeSha,activeTree);
  manifests.set(activeTree,files.map(file=>{
    const bytes=Buffer.from(file.text); const sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); blobs.set(sha,bytes);
    return {path:file.path,sha,type:'blob',mode:'100644',size:bytes.length};
  }));
}
const fetcher:typeof fetch=async(input,init)=>{
  if(init?.signal?.aborted)throw new Error('Benchmark request aborted');
  const url=new URL(String(input)); if(url.origin!=='https://api.github.com')throw new Error('Benchmark prohibits external egress');
  const path=url.pathname; const base=`/repos/generated-benchmark/${activeName}`; counts.total++;
  const repository={id:repositoryId,owner:{login:'generated-benchmark',id:10,type:'User'},name:activeName,full_name:`generated-benchmark/${activeName}`,private:true,default_branch:'main',disabled:false};
  const installation={id:99,app_id:123,account:{login:'generated-benchmark',id:10,type:'User'},repository_selection:'selected',permissions:{contents:'read',metadata:'read'},suspended_at:null};
  if(path==='/user'){counts.authorization++;return Response.json({id:10,login:'generated-benchmark'});}
  if(path===`${base}/installation`){counts.authorization++;return Response.json(installation);}
  if(path==='/app/installations/99/access_tokens'){counts.tokens++;return Response.json({token:'ghs_synthetic_benchmark_only',expires_at:new Date(Date.now()+3600000).toISOString()});}
  if(path===base){counts.authorization++;return Response.json(repository);}
  if(path.startsWith(`${base}/commits/`)){
    counts.commits++; const ref=decodeURIComponent(path.slice(`${base}/commits/`.length)); const sha=ref==='main'?activeSha:ref; const tree=commits.get(sha);
    if(!tree)throw new Error('Synthetic commit is unavailable'); return Response.json({sha,commit:{tree:{sha:tree}}});
  }
  if(path.startsWith(`${base}/git/trees/`)){
    counts.trees++;const sha=path.slice(`${base}/git/trees/`.length);const tree=manifests.get(sha);
    if(!tree)throw new Error('Synthetic tree is unavailable');return Response.json({sha,truncated:false,tree});
  }
  if(path.startsWith(`${base}/git/blobs/`)){
    counts.blobs++;const sha=path.slice(`${base}/git/blobs/`.length);const bytes=blobs.get(sha);
    if(!bytes)throw new Error('Synthetic blob is unavailable');return Response.json({sha,size:bytes.length,encoding:'base64',content:bytes.toString('base64')});
  }
  throw new Error('Unexpected synthetic GitHub endpoint');
};
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'}).toString();
const client=await createGitHubAppClient({GITHUB_APP_ID:'123',GITHUB_APP_PRIVATE_KEY:key},{fetch:fetcher});
const service=createRepositoryService(database,{ATLAS_PARSER_SCRIPT:resolve('packages/core/.atlas/repository-parser-child.mjs')},{
  githubForPrincipal:async actor=>({client,user:await client.verifyUser({principalId:actor,githubUserId:10,userAccessToken:'synthetic_benchmark_identity_only'})}),
});
async function runImport(expectedReused:number) {
  const before={...counts};const initialQueries=queryCount; const start=performance.now();
  const queued=await service.queueImport(principal,workspace,`https://github.com/generated-benchmark/${activeName}`);
  let slices=0; const phases:Record<string,number>={};
  for(;slices<200;slices++){
    const result=await service.processOne(); phases[result.phase ?? result.status]=(phases[result.phase ?? result.status]??0)+1;
    if(result.status==='complete'){slices++;break;}
    if(result.status!=='progress')throw new Error(`Synthetic import failed: ${result.status}/${result.code??'unknown'}`);
  }
  if(slices>=200)throw new Error('Synthetic import exceeded its slice bound');
  const job=await service.getJob(principal,queued.repositoryId);
  if(!job || job.status!=='complete' || job.progress.reused!==expectedReused || job.progress.parsed!==sources.length || job.attempts!==0)throw new Error('Measured checkpoint counters differ from source');
  const storage=await sql.query<{sourceFiles:number;sourceContentBytes:string;graphBytes:string;stagedFiles:number;stagedBytes:string}>(`SELECT
    (SELECT count(*)::int FROM atlas.source_files WHERE snapshot_id=$1) AS "sourceFiles",
    (SELECT coalesce(sum(octet_length(content)),0)::text FROM atlas.source_files WHERE snapshot_id=$1) AS "sourceContentBytes",
    (SELECT octet_length(graph::text)::text FROM atlas.graphs WHERE snapshot_id=$1) AS "graphBytes",
    (SELECT count(*)::int FROM atlas.import_files WHERE snapshot_id=$1) AS "stagedFiles",
    (SELECT coalesce(sum(octet_length(content)),0)::text FROM atlas.import_files WHERE snapshot_id=$1) AS "stagedBytes"`,[queued.snapshotId]);
  const api=Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,value-before[key as keyof ApiCounts]]));
  return {files:sources.length,sourceBytes:sources.reduce((total,file)=>total+Buffer.byteLength(file.text),0),status:job.status,
    durationMs:Math.round(performance.now()-start),slices,phaseResults:phases,sqlQueries:queryCount-initialQueries,simulatedGitHubRequests:api,
    downloaded:job.progress.downloaded,reused:job.progress.reused,parsed:job.progress.parsed,failures:job.attempts,
    storageAtReturn:storage.rows[0],parentRssAtReturnBytes:process.memoryUsage().rss,parentHeapAtReturnBytes:process.memoryUsage().heapUsed,
    aiCalls:0,indexingProviderCostUsd:0};
}
try {
  await sql.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    GRANT USAGE ON SCHEMA auth TO authenticated;GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;`);
  for(const migration of ['202610030001_atlas','202610070001_personal_workspaces','202610070002_github_jobs','202610070003_server_repository_grants','202610110001_resumable_imports'])await sql.exec(await readFile(resolve(`supabase/migrations/${migration}.sql`),'utf8'));
  await sql.query("INSERT INTO atlas.workspaces(id,name) VALUES($1,'Generated import benchmark')",[workspace]);
  await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role) VALUES($1,$2,'owner')",[workspace,principal]);
  const results=[];
  for(const total of [17,145,4001]){
    activeName=`generated-${total}`; repositoryId=total;
    const files=[{path:'package.json',text:'{"name":"generated-import-benchmark","version":"1.0.0"}'},
      ...Array.from({length:total-1},(_,position)=>({path:`packages/group-${Math.floor(position/32)}/file-${position}.ts`,text:`export function value${position}(input:number) { return input + ${position}; }\n`}))];
    setSnapshot(files,`${total}-first`);const initial=await runImport(0);
    console.log(JSON.stringify({size:total,pass:'initial',...initial}));
    const changed=files.map((file,position)=>position===1?{...file,text:file.text.replace('return input','return 2 * input')}:file);
    setSnapshot(changed,`${total}-second`);const incremental=await runImport(total-1);
    console.log(JSON.stringify({size:total,pass:'one-file-change',...incremental}));
    results.push({size:total,initial,oneFileChange:incremental});
  }
  const report={timestamp:new Date().toISOString(),mode:'synthetic-local-benchmark',scope:'Simulated GitHub HTTP and identity; actual native GitHub client with hash-verified blobs, real PostgreSQL-WASM migration SQL/checkpoints, and isolated trusted Node parser. No external network, hosted authentication, hosted concurrency, or payments.',
    memoryMetric:'RSS/heap of the Node benchmark parent at pipeline return, including PGlite. Not sampled peak RSS; does not measure the transient parser child. Parser child uses a 768 MiB V8 heap bound and 60 second deadline.',
    costScope:'Measured zero AI calls and provider indexing cost. Local compute, database, storage and hosting costs are not included.',results};
  await writeFile(resolve('docs/evidence/import-pipeline-benchmark.json'),JSON.stringify(report,null,2)+'\n');
} finally {await sql.close();}
