import { repositoryContext, repositoryFailure, privateHeaders, requireSameOrigin, readRepositoryBody } from '../../../../../lib/repositories';
import { answerLocal } from '@atlas/core/local';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { requireSameOrigin(request); const { principalId, service } = await repositoryContext(); const { id } = await context.params;
    const body = await readRepositoryBody(request);
    if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 2000) return Response.json({ error: 'Question must contain 1–2000 characters', code: 'invalid-question' }, { status: 400, headers: privateHeaders });
    if (typeof body.snapshotId !== 'string') return Response.json({ error: 'Pin the question to the displayed snapshot.', code: 'snapshot-required' }, { status: 400, headers: privateHeaders });
    const index = await service.getIndex(principalId, id, body.snapshotId);
    return Response.json({ answer: answerLocal(index, body?.question) }, { headers: privateHeaders });
  } catch (error) { return repositoryFailure(error); }
}
