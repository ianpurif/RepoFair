import { commerceContext } from '../../../lib/commerce';
import { publicationBody,publicationFailure } from '../../../lib/publications';
import { privateHeaders,requireSameOrigin } from '../../../lib/repositories';

export const runtime='nodejs';
export async function GET(request:Request) {
  try {const context=await commerceContext();const workspaceId=new URL(request.url).searchParams.get('workspaceId')??'';
    return Response.json(await context.commerce.history(context.principalId,workspaceId),{headers:privateHeaders});
  }catch(error){return publicationFailure(error);}
}
export async function POST(request:Request) {
  try {requireSameOrigin(request);const context=await commerceContext();const body=await publicationBody(request,['workspaceId','providerId','question','idempotencyKey','approvedAtomicAmount']);
    return Response.json(await context.commerce.createPurchase(context.principalId,context.sessionId,body),{status:201,headers:privateHeaders});
  }catch(error){return publicationFailure(error);}
}
