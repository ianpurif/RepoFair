import { repositoryContext, repositoryFailure, privateHeaders, requireSameOrigin, readRepositoryBody } from '../../../lib/repositories';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try { const { principalId, service } = await repositoryContext();
    const workspaceId = new URL(request.url).searchParams.get('workspaceId') ?? '';
    return Response.json({ repositories: await service.listRepositories(principalId, workspaceId) }, { headers: privateHeaders });
  } catch (error) { return repositoryFailure(error); }
}
export async function POST(request: Request) {
  try { requireSameOrigin(request); const { principalId, service } = await repositoryContext();
    const body = await readRepositoryBody(request);
    if (!body || typeof body.workspaceId !== 'string' || typeof body.url !== 'string' || (body.ref !== undefined && typeof body.ref !== 'string')) return Response.json({ error: 'Workspace and GitHub repository URL required.' }, { status: 400, headers: privateHeaders });
    const result = await service.queueImport(principalId, body.workspaceId, body.url, body.ref);
    return Response.json(result, { status: 202, headers: privateHeaders });
  } catch (error) { return repositoryFailure(error); }
}
