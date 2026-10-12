import { repositoryContext, repositoryFailure, privateHeaders } from '../../../../../lib/repositories';
export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { principalId, service } = await repositoryContext(); const { id } = await context.params;
    const query = new URL(request.url).searchParams;
    if (!query.get('snapshotId') || !query.get('path') || ['startLine','endLine'].some(key => query.has(key) && !/^\d{1,6}$/.test(query.get(key)!)))
      return Response.json({ error: 'An immutable snapshot, source path and valid line range are required.', code: 'invalid-source' }, { status: 400, headers: privateHeaders });
    const evidence = await service.getSource(principalId,id,query.get('snapshotId')!,query.get('path')!,
      query.has('startLine') ? Number(query.get('startLine')) : undefined,query.has('endLine') ? Number(query.get('endLine')) : undefined);
    return Response.json({ evidence }, { headers: privateHeaders });
  } catch (error) { return repositoryFailure(error); }
}
