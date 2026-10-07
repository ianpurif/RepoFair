import { createAtlasDatabase } from '@atlas/worker/database';
import { processGitHubWebhook } from '@atlas/worker/github-webhook';
import { GitHubError } from '@atlas/worker/github';
export const runtime = 'nodejs';
let database: ReturnType<typeof createAtlasDatabase> | undefined;
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    if (!request.body) throw new GitHubError('invalid','Body required');
    const reader = request.body.getReader(); const parts: Uint8Array[] = []; let bytes=0;
    try { for (;;) { const next=await reader.read(); if(next.done)break; bytes+=next.value.byteLength;
      if(bytes>1000000){await reader.cancel();return Response.json({error:'Webhook too large'},{status:413,headers});}parts.push(next.value); }
    } finally { reader.releaseLock(); }
    const body=Buffer.concat(parts);
    database ??= createAtlasDatabase(process.env).catch(error=>{database=undefined;throw error;});
    const result=await processGitHubWebhook(await database,body,request.headers,process.env.GITHUB_WEBHOOK_SECRET);
    return Response.json(result,{headers});
  } catch(error) {
    return Response.json({error:'Webhook validation or durable processing failed.'},{status:error instanceof GitHubError?400:503,headers});
  }
}
