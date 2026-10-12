import { commerceContext } from '../../../lib/commerce';
import { publicationFailure } from '../../../lib/publications';
import { privateHeaders } from '../../../lib/repositories';

export const runtime='nodejs';
export async function GET(request:Request) {
  try {const context=await commerceContext();const url=new URL(request.url);const packageName=url.searchParams.get('packageName')??undefined;const version=url.searchParams.get('version')??undefined;
    if((packageName?.length??0)>200||(version?.length??0)>100)return Response.json({error:'Invalid exact release filter'},{status:400,headers:privateHeaders});
    return Response.json({providers:await context.registry.catalog(context.principalId,packageName,version)},{headers:privateHeaders});
  }catch(error){return publicationFailure(error);}
}
