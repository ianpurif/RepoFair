import { repositoryContext, repositoryFailure, privateHeaders } from '../../../../lib/repositories';
export const runtime = 'nodejs';
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { principalId, service } = await repositoryContext(); const { id } = await context.params;
    const index = await service.getIndex(principalId, id);
    return Response.json({ index }, { headers: privateHeaders });
  } catch (error) { return repositoryFailure(error); }
}
