import { commerceContext } from '../../../../../lib/commerce';
import { publicationBody,publicationFailure } from '../../../../../lib/publications';
import { privateHeaders,requireSameOrigin } from '../../../../../lib/repositories';

export const runtime='nodejs';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {
  try {requireSameOrigin(request);const context=await commerceContext();const {id}=await params;const body=await publicationBody(request,['expectedRevision','termsDigest','exposureApproved']);
    const artifact=await context.registry.exportDraft(context.principalId,id,body);
    return Response.json(artifact,{headers:{...privateHeaders,'Content-Disposition':`attachment; filename="atlas-publication-${id}.json"`}});
  }catch(error){return publicationFailure(error);}
}
