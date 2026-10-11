import { repositoryContext, repositoryFailure, privateHeaders, requireSameOrigin, readRepositoryBody } from '../../../../../lib/repositories';
export const runtime = 'nodejs';
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { principalId, service } = await repositoryContext(); const { id } = await context.params;
    return Response.json({ job: await service.getJob(principalId, id) }, { headers: privateHeaders });
  } catch (error) { return repositoryFailure(error); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { requireSameOrigin(request); const { principalId, service } = await repositoryContext(); const { id } = await context.params;
    const body = await readRepositoryBody(request);
    if (!['cancel','retry'].includes(String(body.action)) || body.jobId !== undefined && typeof body.jobId !== 'string'
      || Object.keys(body).some(key => !['action','jobId'].includes(key))) return Response.json({ error: 'Use cancel or retry with the expected job identifier.', code: 'invalid-job-action' }, { status: 400, headers: privateHeaders });
    const job = body.action === 'cancel' ? await service.cancelImport(principalId,id,body.jobId as string | undefined)
      : await service.retryImport(principalId,id,body.jobId as string | undefined);
    return Response.json({ job }, { headers: privateHeaders });
  } catch (error) { return repositoryFailure(error); }
}
