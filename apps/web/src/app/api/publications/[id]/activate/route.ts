import { commerceContext } from '../../../../../lib/commerce';
import { publicationBody,publicationFailure } from '../../../../../lib/publications';
import { privateHeaders,requireSameOrigin } from '../../../../../lib/repositories';

export const runtime='nodejs';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {
  try {requireSameOrigin(request);const context=await commerceContext();const {id}=await params;const body=await publicationBody(request,['expectedRevision','termsDigest','exposureApproved']);
    return Response.json({publication:await context.registry.activateDraft(context.principalId,id,body)},{headers:privateHeaders});
  }catch(error){return publicationFailure(error);}
}
