import type { PublicationProposal } from '@atlas/contracts';
import { publicationContext, publicationBody, publicationFailure } from '../../../../lib/publications';
import { privateHeaders, requireSameOrigin } from '../../../../lib/repositories';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const { principalId, service } = await publicationContext(); const { id } = await context.params;
    return Response.json({ draft: await service.getDraft(principalId, id) }, { headers: privateHeaders });
  } catch (error) { return publicationFailure(error); }
}
export async function PATCH(request: Request, context: Context) {
  try {
    requireSameOrigin(request);
    const { principalId, service } = await publicationContext(); const { id } = await context.params;
    const body = await publicationBody(request, ['expectedRevision', 'proposal']);
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1 || !body.proposal || typeof body.proposal !== 'object' || Array.isArray(body.proposal)) return Response.json({ error: 'Expected revision and publication proposal are required', code: 'invalid-body' }, { status: 400, headers: privateHeaders });
    return Response.json({ draft: await service.updateDraft(principalId, id, Number(body.expectedRevision), body.proposal as PublicationProposal) }, { headers: privateHeaders });
  } catch (error) { return publicationFailure(error); }
}
/** Revokes this private draft; retains its audit record and never publishes source. */
export async function DELETE(request: Request, context: Context) {
  try {
    requireSameOrigin(request);
    const { principalId, service } = await publicationContext(); const { id } = await context.params;
    const body = await publicationBody(request, ['expectedRevision']);
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) return Response.json({ error: 'Expected draft revision is required', code: 'invalid-body' }, { status: 400, headers: privateHeaders });
    return Response.json({ draft: await service.revokeDraft(principalId, id, Number(body.expectedRevision)) }, { headers: privateHeaders });
  } catch (error) { return publicationFailure(error); }
}
