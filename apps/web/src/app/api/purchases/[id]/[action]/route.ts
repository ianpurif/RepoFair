import { commerceContext } from '../../../../../lib/commerce';
import { publicationBody,publicationFailure } from '../../../../../lib/publications';
import { privateHeaders,requireSameOrigin } from '../../../../../lib/repositories';

export const runtime='nodejs';
export async function POST(request:Request,{params}:{params:Promise<{id:string;action:string}>}) {
  try {requireSameOrigin(request);const context=await commerceContext();const {id,action}=await params;
    const allowed:Record<string,string[]>={'claim-signing':[],unknown:[],credential:['credential'],reconcile:['receipt'],cancel:[],resume:['credential']};
    if(!Object.hasOwn(allowed,action))return Response.json({error:'Purchase action unavailable'},{status:404,headers:privateHeaders});
    const body=await publicationBody(request,allowed[action]!);const {commerce,principalId,sessionId}=context;
    if(action==='claim-signing')return Response.json(await commerce.claimSigning(principalId,sessionId,id),{headers:privateHeaders});
    if(action==='unknown'){await commerce.markUnknown(principalId,id);return Response.json({state:'unknown'},{headers:privateHeaders});}
    if(action==='credential'){await commerce.bindCredential(principalId,id,body.credential);return Response.json({state:'bound'},{headers:privateHeaders});}
    if(action==='reconcile')return Response.json({purchase:await commerce.reconcile(principalId,id,body.receipt)},{headers:privateHeaders});
    if(action==='cancel'){await commerce.releaseUnsigned(principalId,id);return Response.json({state:'failed'},{headers:privateHeaders});}
    if(body.credential!==undefined&&typeof body.credential!=='string')return Response.json({error:'Invalid payment credential'},{status:400,headers:privateHeaders});
    return Response.json(await commerce.resume(principalId,sessionId,id,body.credential as string|undefined),{headers:privateHeaders});
  }catch(error){return publicationFailure(error);}
}
