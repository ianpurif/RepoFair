import { publicationContext, publicationBody, publicationFailure } from '../../../lib/publications';
import { privateHeaders, requireSameOrigin } from '../../../lib/repositories';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const { principalId, service } = await publicationContext();
    return Response.json({ drafts: await service.listDrafts(principalId, new URL(request.url).searchParams.get('workspaceId') ?? '') }, { headers: privateHeaders });
  } catch (error) { return publicationFailure(error); }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { principalId, service } = await publicationContext();
    const body = await publicationBody(request, ['workspaceId', 'repositoryId']);
    if (typeof body.workspaceId !== 'string' || typeof body.repositoryId !== 'string') return Response.json({ error: 'Workspace and repository identifiers are required', code: 'invalid-body' }, { status: 400, headers: privateHeaders });
    return Response.json({ draft: await service.createDraft(principalId, body.workspaceId, body.repositoryId) }, { status: 201, headers: privateHeaders });
  } catch (error) { return publicationFailure(error); }
}
