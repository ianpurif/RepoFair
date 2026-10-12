import { repositoryContext,repositoryFailure,privateHeaders,requireSameOrigin,readRepositoryBody } from '../../../../../lib/repositories';
import { commerceServices } from '../../../../../lib/commerce';
export const runtime='nodejs';
/** Resolve only the caller-selected dependency at the displayed immutable snapshot. */
export async function POST(request:Request,context:{params:Promise<{id:string}>}) {
  try {
    requireSameOrigin(request);const {principalId,service}=await repositoryContext();const {id}=await context.params;
    const input=await readRepositoryBody(request);
    if(Object.keys(input).length!==2||typeof input.snapshotId!=='string'||typeof input.nodeId!=='string')return Response.json({error:'Select one pinned dependency node',code:'invalid-dependency'},{status:400,headers:privateHeaders});
    const map=await service.getGraph(principalId,id,{snapshotId:input.snapshotId,nodeId:input.nodeId,limit:160});
    const node=map.nodes.find(item=>item.id===input.nodeId&&item.kind==='package');
    const dependency=node&&map.dependencies.find(item=>node.localId===`package:${item.packageName}@${item.version??'unresolved'}`);
    if(!dependency)return Response.json({error:'This node is not a supported imported dependency',code:'dependency-unavailable'},{status:404,headers:privateHeaders});
    const {registry}=await commerceServices();const providers=dependency.status==='exact'&&dependency.version?await registry.catalog(principalId,dependency.packageName,dependency.version):[];
    const current=await service.getGraph(principalId,id,{snapshotId:input.snapshotId,nodeId:input.nodeId,limit:1});
    if(current.scope.permissionRevision!==map.scope.permissionRevision||current.snapshot.revision!==map.snapshot.revision||current.nodes[0]?.localId!==node?.localId)return Response.json({error:'Repository permissions changed during discovery',code:'authorization-changed'},{status:403,headers:privateHeaders});
    return Response.json({snapshot:map.snapshot,dependency,providers,limitations:dependency.status==='exact'?[]:[dependency.reason??'Exact installed version is unavailable']},{headers:privateHeaders});
  } catch(error){return repositoryFailure(error);}
}
