import { workspaceDatabase } from '../../../../lib/database';
import { processGitHubWebhook } from '@atlas/worker/github-webhook';
import { GitHubError, verifyGitHubWebhook } from '@atlas/worker/github';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    if (!request.body) throw new GitHubError('invalid','Body required');
    const reader = request.body.getReader(); const parts: Uint8Array[] = []; let bytes=0;
    try { for (;;) { const next=await reader.read(); if(next.done)break; bytes+=next.value.byteLength;
      if(bytes>1000000){await reader.cancel();return Response.json({error:'Webhook too large'},{status:413,headers});}parts.push(next.value); }
    } finally { reader.releaseLock(); }
    const body=Buffer.concat(parts);
    // Reject unauthenticated traffic before opening a database connection.
    verifyGitHubWebhook(body,request.headers,process.env.GITHUB_WEBHOOK_SECRET);
    const result=await processGitHubWebhook(await workspaceDatabase(),body,request.headers,process.env.GITHUB_WEBHOOK_SECRET);
    return Response.json(result,{headers});
  } catch(error) {
    return Response.json({error:'Webhook validation or durable processing failed.'},{status:error instanceof GitHubError?400:503,headers});
  }
}
