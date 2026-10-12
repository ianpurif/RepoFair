import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { AuthenticatedAtlasClient } from './authenticated.ts';
import { FIXTURE_IDS, parseFixtureId } from '@atlas/contracts';
import { indexFixture } from '@atlas/worker/fixtures';
import { answerLocal, lookupSource } from '@atlas/core/local';

function createFixtureMcpServer(): McpServer {
  if(process.env.ATLAS_FIXTURES_ENABLED!=='true'||process.env.NODE_ENV==='production')throw new Error('Fixture MCP requires explicit development configuration');
  const server = new McpServer({ name: 'chronos-atlas-fixture', version: '0.1.0' });
  const fixtureId = z.enum(['jobboard-app@1.0.0', 'jobboard-app@2.0.0', 'retry-kit@1.0.0', 'retry-kit@2.0.0', 'event-log@1.0.0']);
  const wrap = async (operation: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation()) }] }; }
    catch { return { isError: true, content: [{ type: 'text' as const, text: 'Fixture operation failed. Check snapshot and input bounds.' }] }; }
  };
  server.registerTool('atlas_list_fixtures', { description: 'List public demonstration snapshots. No private repository access.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: JSON.stringify({ mode: 'fixture', fixtureIds: FIXTURE_IDS, payments: 'disabled' }) }] }));
  server.registerTool('atlas_explore', { description: 'Parse a bounded public fixture graph. Static edges show potential relationships.', inputSchema: { fixtureId } },
    ({ fixtureId }) => wrap(async () => indexFixture(parseFixtureId(fixtureId))));
  server.registerTool('atlas_question', { description: 'Retrieve original cited fixture passages. Extractive, no generation model or paid calls.', inputSchema: { fixtureId, question: z.string().trim().min(1).max(2000) } },
    ({ fixtureId, question }) => wrap(async () => answerLocal(await indexFixture(parseFixtureId(fixtureId)), question)));
  server.registerTool('atlas_source', { description: 'Read exact original source lines from a public fixture snapshot.', inputSchema: { fixtureId, path: z.string().min(1).max(500), startLine: z.number().int().min(1), endLine: z.number().int().min(1) } },
    ({ fixtureId, path, startLine, endLine }) => wrap(async () => lookupSource(await indexFixture(parseFixtureId(fixtureId)), path, startLine, endLine)));
  return server;
}
export function createAtlasMcpServer(client?:AuthenticatedAtlasClient):McpServer {
  if(process.env.ATLAS_MODE==='fixture')return createFixtureMcpServer();
  if(!client)throw new Error('Configure an authenticated Atlas API client');
  const server=new McpServer({name:'chronos-atlas',version:'0.2.0'});const uuid=z.string().uuid();
  const wrap=async(operation:()=>Promise<unknown>)=>{
    try{return {content:[{type:'text' as const,text:JSON.stringify(await operation())}]};}
    catch{return {isError:true,content:[{type:'text' as const,text:'Authenticated Atlas operation failed. Check current session, repository access, exact snapshot, and saved purchase status.'}]};}
  };
  server.registerTool('atlas_account',{description:'Read authenticated workspace membership.',inputSchema:{}},()=>wrap(()=>client.account()));
  server.registerTool('atlas_repositories',{description:'List authorized persisted repositories.',inputSchema:{workspaceId:uuid}},({workspaceId})=>wrap(()=>client.repositories(workspaceId)));
  server.registerTool('atlas_import_status',{description:'Read durable import progress; this tool never queues or runs imported code.',inputSchema:{repositoryId:uuid}},({repositoryId})=>wrap(()=>client.job(repositoryId)));
  server.registerTool('atlas_explore',{description:'Read a bounded authorized graph page at an immutable snapshot.',inputSchema:{repositoryId:uuid,snapshotId:uuid,cursor:z.number().int().min(0).max(50000).optional(),folder:z.string().max(1000).optional(),query:z.string().max(200).optional()}},
    ({repositoryId,snapshotId,cursor,folder,query})=>wrap(()=>client.map(repositoryId,snapshotId,{...(cursor===undefined?{}:{cursor}),...(folder===undefined?{}:{folder}),...(query===undefined?{}:{query})})));
  server.registerTool('atlas_source',{description:'Read at most120 exact source lines after current authorization.',inputSchema:{repositoryId:uuid,snapshotId:uuid,path:z.string().min(1).max(1000),startLine:z.number().int().min(1),endLine:z.number().int().min(1)}},
    ({repositoryId,snapshotId,path,startLine,endLine})=>wrap(()=>client.source(repositoryId,snapshotId,path,startLine,endLine)));
  server.registerTool('atlas_question',{description:'Retrieve deterministic source-grounded evidence with commit-pinned citations. No paid AI call.',inputSchema:{repositoryId:uuid,snapshotId:uuid,question:z.string().trim().min(1).max(2000)}},({repositoryId,snapshotId,question})=>wrap(()=>client.question(repositoryId,snapshotId,question)));
  server.registerTool('atlas_resolve_dependency',{description:'Discover authorized independent providers only for the exact supported dependency selected in this snapshot.',inputSchema:{repositoryId:uuid,snapshotId:uuid,nodeId:z.string().min(1).max(2000)}},({repositoryId,snapshotId,nodeId})=>wrap(()=>client.resolveDependency(repositoryId,snapshotId,nodeId)));
  server.registerTool('atlas_purchase_history',{description:'Read persisted reservations, receipts and delivery status; no spending approval.',inputSchema:{workspaceId:uuid}},({workspaceId})=>wrap(()=>client.purchaseHistory(workspaceId)));
  server.registerTool('atlas_resume_purchase',{description:'Read-only reconciliation and knowledge retrieval for an already submitted owner-approved purchase. Never signs or rebroadcasts.',inputSchema:{purchaseId:uuid}},({purchaseId})=>wrap(()=>client.resumePurchase(purchaseId)));
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let client:AuthenticatedAtlasClient|undefined;
    if(process.env.ATLAS_MODE!=='fixture') {
      if(!process.env.ATLAS_API_ORIGIN||!process.env.ATLAS_SESSION_TOKEN_FILE)throw new Error('Authenticated MCP configuration missing');
      const file=process.env.ATLAS_SESSION_TOKEN_FILE;
      client=new AuthenticatedAtlasClient(process.env.ATLAS_API_ORIGIN,{allowLocalDevelopment:process.env.ATLAS_ALLOW_LOCAL_DEVELOPMENT==='true',sessionToken:async()=>{
        const token=(await readFile(file,'utf8')).trim();if(!token||token.length>16_384)throw new Error('Session token unavailable');return token;
      }});
    }
    await createAtlasMcpServer(client).connect(new StdioServerTransport());
  }catch{console.error('Atlas MCP configuration or session unavailable. Configure the API origin and session-token file, or explicitly enable development fixtures.');process.exitCode=1;}
}
