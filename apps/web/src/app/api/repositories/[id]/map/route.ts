import { repositoryContext, repositoryFailure, privateHeaders } from '../../../../../lib/repositories';
export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { principalId, service } = await repositoryContext(); const { id } = await context.params;
    const query = new URL(request.url).searchParams;
    if (['cursor','limit'].some(key => query.has(key) && !/^\d{1,6}$/.test(query.get(key)!)))
      return Response.json({ error: 'Invalid graph page bounds.', code: 'invalid-page' }, { status: 400, headers: privateHeaders });
    const index = await service.getGraph(principalId,id,{
      ...(query.has('snapshotId') ? {snapshotId:query.get('snapshotId')!} : {}),
      ...(query.has('folder') ? {folder:query.get('folder')!} : {}),
      ...(query.has('query') ? {query:query.get('query')!} : {}),
      ...(query.has('nodeId') ? {nodeId:query.get('nodeId')!} : {}),
      ...(query.has('cursor') ? {cursor:Number(query.get('cursor'))} : {}),
      ...(query.has('limit') ? {limit:Number(query.get('limit'))} : {}),
    });
    return Response.json({ index }, { headers: privateHeaders });
  } catch (error) { return repositoryFailure(error); }
}
