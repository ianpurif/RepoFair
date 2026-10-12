import { commerceContext } from '../../../../lib/commerce';
import { publicationBody,publicationFailure } from '../../../../lib/publications';
import { privateHeaders,requireSameOrigin } from '../../../../lib/repositories';

export const runtime='nodejs';
export async function POST(request:Request) {
  try {requireSameOrigin(request);const context=await commerceContext();const body=await publicationBody(request,['workspaceId','allowance']);
    return Response.json({budget:await context.commerce.setAllowance(context.principalId,String(body.workspaceId??''),body.allowance)},{headers:privateHeaders});
  }catch(error){return publicationFailure(error);}
}
