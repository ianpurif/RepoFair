import { commerceServices } from '../../../../lib/commerce';
import { publicationBody,publicationFailure } from '../../../../lib/publications';
import { privateHeaders } from '../../../../lib/repositories';

export const runtime='nodejs';
/** Server-to-server scoped delegation only. This handler never accepts a Clerk cookie as authorization. */
export async function POST(request:Request) {
  try {const token=request.headers.get('X-Atlas-Provider-Grant')??'';
    if(!token||token.length>4096)return Response.json({error:'Provider-scoped authorization required',code:'delegation-denied'},{status:403,headers:privateHeaders});
    await publicationBody(request,[]);
    const {registry}=await commerceServices();return Response.json({active:true,grant:await registry.introspect(token)},{headers:privateHeaders});
  }catch(error){return publicationFailure(error);}
}
