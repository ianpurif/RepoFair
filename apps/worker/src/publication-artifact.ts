import { createHash } from 'node:crypto';
import type { ContextBundle, PublicationArtifact, PublicationDraft, RepositoryIndex, SignedPublicationArtifact } from '../../../packages/contracts/src/index.ts';
import { MODERATO_NETWORK, MODERATO_PATHUSD } from '../../../packages/contracts/src/commerce.ts';
import { parseQuestion } from '../../../packages/contracts/src/local.ts';
import { canonicalJson, signDocument, verifyDocument } from './commerce-signatures.ts';
import type { KeyObject } from 'node:crypto';

export function buildPublicationArtifact(draft: PublicationDraft, index: RepositoryIndex): PublicationArtifact {
  const proposal = draft.proposal; const selected = new Set(proposal.exposedPaths);
  if (draft.state !== 'draft' || draft.snapshotId !== index.snapshot.snapshotId || draft.commitSha !== index.snapshot.revision
    || !selected.size || !selected.has('package.json') || !proposal.rightsStatement.trim() || !proposal.proposedEndpoint || !proposal.testnetTerms
    || proposal.testnetTerms.network !== MODERATO_NETWORK || proposal.testnetTerms.token.toLowerCase() !== MODERATO_PATHUSD) throw new Error('Select package.json and source, declare publication rights, and configure PathUSD terms on Moderato');
  const files = index.files.filter(file => selected.has(file.path));
  if (files.length !== selected.size || files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) > 1_500_000) throw new Error('Publication source must fit the 1.5 MB selected-source bound');
  const scope = { tenantId: draft.id, principalId: 'publication', permissionRevision: draft.termsDigest };
  const evidence = index.evidence.filter(item => selected.has(item.source.path)).map(item => ({ ...item, scope, providerId: draft.id, provenance: 'provider-reported' as const }));
  const evidenceIds = new Set(evidence.map(item => item.id));
  const sourceNodeIds = new Set(index.nodes.filter(node => node.kind !== 'package' && files.some(file => node.localId === file.path || node.localId.startsWith(`${file.path}#`))).map(node => node.id));
  const packageIds = new Set(index.edges.filter(edge => evidenceIds.has(edge.evidenceId) && (sourceNodeIds.has(edge.from) || sourceNodeIds.has(edge.to))).flatMap(edge => [edge.from,edge.to]));
  const nodes = index.nodes.filter(node => sourceNodeIds.has(node.id) || (node.kind === 'package' && packageIds.has(node.id)));
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = index.edges.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to) && evidenceIds.has(edge.evidenceId)).map(edge => ({ id:edge.id,from:edge.from,to:edge.to,relation:edge.relation,evidenceId:edge.evidenceId,provenance:'provider-reported' as const }));
  const context: ContextBundle = { schemaVersion: 1, providerId: draft.id, packageName: proposal.packageName, version: proposal.version,
    evidenceState: evidence.length ? 'sufficient' : 'insufficient', evidence, nodes, edges,
    limitations: ['Provider-reported source from the explicitly approved selection.', 'A paid result is not a correctness guarantee.', 'Static relationships describe potential reachability.'] };
  const artifact: PublicationArtifact = { schemaVersion: 1, mode: 'tempo-testnet', id: draft.id, draftRevision: draft.revision, termsDigest: draft.termsDigest,
    repositoryId: draft.repositoryId, snapshotId: draft.snapshotId, commitSha: draft.commitSha, proposal, preview: draft.preview, files, context, sourceSignatures:{},graphSignatures:{nodes:{},edges:{}} };
  validatePublicationArtifact(artifact); return artifact;
}
export function validatePublicationArtifact(value: unknown): asserts value is PublicationArtifact {
  canonicalJson(value);
  const artifact = value as PublicationArtifact;
  if (!artifact || artifact.schemaVersion !== 1 || artifact.mode !== 'tempo-testnet' || !/^[a-f0-9]{64}$/.test(artifact.termsDigest)
    || !/^[a-f0-9]{40}$/.test(artifact.commitSha) || !Number.isSafeInteger(artifact.draftRevision) || artifact.draftRevision < 1
    || !Array.isArray(artifact.files) || artifact.files.length < 1 || artifact.files.length > 192
    || !artifact.proposal || artifact.preview?.snapshotId !== artifact.snapshotId || artifact.preview.commitSha !== artifact.commitSha
    || artifact.preview.fileCount !== artifact.files.length || artifact.proposal.exposedPaths?.length !== artifact.files.length
    || artifact.proposal.testnetTerms?.network !== MODERATO_NETWORK || artifact.proposal.testnetTerms.token.toLowerCase() !== MODERATO_PATHUSD
    || !artifact.proposal.rightsStatement?.trim()) throw new Error('Invalid selected publication artifact');
  let total = 0; const files = new Map<string, { text: string; lineCount: number }>();
  for (const file of artifact.files) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.split('/').some((part: string) => !part || part === '.' || part === '..')
      || typeof file.text !== 'string' || file.text.includes('\0') || files.has(file.path) || Buffer.byteLength(file.text) > 262_144
      || file.lineCount !== file.text.split('\n').length || !artifact.proposal.exposedPaths.includes(file.path)) throw new Error('Invalid selected publication file');
    const preview = artifact.preview.files.find(item => item.path === file.path); const bytes = Buffer.byteLength(file.text); total += bytes;
    if (!preview || preview.lines !== file.lineCount || preview.bytes !== bytes || preview.sourceDigest !== createHash('sha256').update(file.text).digest('hex')) throw new Error('Publication source digest differs from approved preview');
    files.set(file.path, file);
  }
  if (total > 1_500_000 || total !== artifact.preview.totalBytes || !files.has('package.json')) throw new Error('Invalid publication source budget');
  const manifest = JSON.parse(files.get('package.json')!.text) as { name?: string; version?: string };
  if (manifest.name !== artifact.proposal.packageName || manifest.version !== artifact.proposal.version
    || artifact.context?.providerId !== artifact.id || artifact.context.packageName !== manifest.name || artifact.context.version !== manifest.version
    || !Array.isArray(artifact.context.evidence) || artifact.context.evidence.length > 12_000 || !Array.isArray(artifact.context.nodes)
    || artifact.context.nodes.length > 4_000 || !Array.isArray(artifact.context.edges) || artifact.context.edges.length > 12_000) throw new Error('Publication exact release or graph is invalid');
  validateContextShape(artifact.context,artifact.id,artifact.termsDigest);
  const nodeIds = new Set(artifact.context.nodes.map(node => node.id)); const evidenceIds = new Set<string>();
  for (const item of artifact.context.evidence) {
    const file = files.get(item.source.path);
    if (!file || item.source.snapshotId !== artifact.snapshotId || item.source.repositoryId !== artifact.repositoryId || item.source.revision !== artifact.commitSha
      || item.source.kind !== 'git' || item.providerId !== artifact.id || item.provenance !== 'provider-reported'
      || !Number.isSafeInteger(item.source.startLine) || !Number.isSafeInteger(item.source.endLine) || item.source.startLine < 1 || item.source.endLine > file.lineCount
      || item.source.endLine < item.source.startLine || item.source.endLine - item.source.startLine >= 120
      || file.text.split('\n').slice(item.source.startLine - 1, item.source.endLine).join('\n') !== item.original || evidenceIds.has(item.id)) throw new Error('Publication source citation failed verification');
    evidenceIds.add(item.id);
  }
  if (nodeIds.size !== artifact.context.nodes.length || artifact.context.nodes.some(node => node.repositoryId !== artifact.repositoryId || node.snapshotId !== artifact.snapshotId)
    || artifact.context.edges.some(edge => !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || !evidenceIds.has(edge.evidenceId) || edge.provenance !== 'provider-reported')) throw new Error('Publication graph reference is invalid');
}
export function verifyPublicationArtifact(value: unknown, key: KeyObject): SignedPublicationArtifact {
  const signed = value as SignedPublicationArtifact;
  if (!signed || Object.keys(signed).some(field => !['artifact','signature'].includes(field)) || !verifyDocument(signed.artifact, signed.signature, key)) throw new Error('Publication issuer signature failed');
  validatePublicationArtifact(signed.artifact);
  for (const item of signed.artifact.context.evidence) if (!verifyDocument(publicationPassagePayload(signed.artifact.id,signed.artifact.termsDigest,item),signed.artifact.sourceSignatures[item.id],key)) throw new Error('Publisher source passage signature failed');
  verifyGraphProofs(signed.artifact.context,signed.artifact.graphSignatures,signed.artifact.id,signed.artifact.termsDigest,key);
  return signed;
}
export function publicationPassagePayload(id: string,digest: string,item: ContextBundle['evidence'][number]) {
  return {publicationId:id,publicationDigest:digest,evidence:item};
}
export function publicationGraphPayload(id:string,digest:string,kind:'node'|'edge',member:ContextBundle['nodes'][number]|ContextBundle['edges'][number]) {
  return {publicationId:id,publicationDigest:digest,kind,member};
}
export function signPublicationPassages(artifact: PublicationArtifact,key: KeyObject): PublicationArtifact {
  return {...artifact,sourceSignatures:Object.fromEntries(artifact.context.evidence.map(item => [item.id,signDocument(publicationPassagePayload(artifact.id,artifact.termsDigest,item),key)])),
    graphSignatures:{nodes:Object.fromEntries(artifact.context.nodes.map(item=>[item.id,signDocument(publicationGraphPayload(artifact.id,artifact.termsDigest,'node',item),key)])),
      edges:Object.fromEntries(artifact.context.edges.map(item=>[item.id,signDocument(publicationGraphPayload(artifact.id,artifact.termsDigest,'edge',item),key)]))}};
}
function shape(value:unknown,fields:readonly string[]):boolean {return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));}
function bounded(value:unknown,max=4096):value is string {return typeof value==='string'&&value.length>0&&value.length<=max&&!value.includes('\0');}
function validateContextShape(context:ContextBundle,id:string,digest:string):void {
  if(!shape(context,['schemaVersion','providerId','packageName','version','evidenceState','evidence','nodes','edges','limitations'])
    || !Array.isArray(context.evidence)||!Array.isArray(context.nodes)||!Array.isArray(context.edges)||!Array.isArray(context.limitations)
    || context.evidenceState!==(context.evidence.length?'sufficient':'insufficient') || context.limitations.length>8 || context.limitations.some(item=>!bounded(item,2000)))throw new Error('Invalid published context shape');
  for(const item of context.evidence) {
    if(!shape(item,['id','scope','source','original','providerId','observedAt','provenance']) || !bounded(item.id)
      || !shape(item.scope,['tenantId','principalId','permissionRevision']) || item.scope.tenantId!==id || item.scope.principalId!=='publication' || item.scope.permissionRevision!==digest
      || !shape(item.source,['repositoryId','snapshotId','kind','revision','path','startLine','endLine']) || !bounded(item.source.repositoryId) || !bounded(item.source.snapshotId)
      || !bounded(item.source.path,1000) || item.source.path.includes('\\') || item.source.path.split('/').some((part:string)=>!part||part==='.'||part==='..')
      || typeof item.observedAt!=='string' || item.observedAt.length>40 || !Number.isFinite(Date.parse(item.observedAt)))throw new Error('Invalid published source shape');
  }
  for(const node of context.nodes)if(!shape(node,['id','repositoryId','snapshotId','localId','kind','label']) || !bounded(node.id)||!bounded(node.repositoryId)||!bounded(node.snapshotId)||!bounded(node.localId)
    || !bounded(node.label,2000)||!['file','symbol','package'].includes(node.kind))throw new Error('Invalid published node shape');
  const edgeIds=new Set<string>();
  for(const edge of context.edges) {
    if(!shape(edge,['id','from','to','relation','provenance','evidenceId'])||!bounded(edge.id)||!bounded(edge.from)||!bounded(edge.to)||!bounded(edge.evidenceId)
      || !['imports','exports','references','resolved-call','package-binding','declares'].includes(edge.relation)||edge.provenance!=='provider-reported'||edgeIds.has(edge.id))throw new Error('Invalid published edge shape');
    edgeIds.add(edge.id);
  }
}
function verifyGraphProofs(context:ContextBundle,proofs:PublicationArtifact['graphSignatures'],id:string,digest:string,key:KeyObject):void {
  if(!shape(proofs,['nodes','edges']) || !proofs.nodes || !proofs.edges)throw new Error('Owner-approved graph signatures are required');
  for(const node of context.nodes)if(!verifyDocument(publicationGraphPayload(id,digest,'node',node),proofs.nodes[node.id],key))throw new Error('Delivered node differs from the owner-approved graph');
  for(const edge of context.edges)if(!verifyDocument(publicationGraphPayload(id,digest,'edge',edge),proofs.edges[edge.id],key))throw new Error('Delivered relationship differs from the owner-approved graph');
}
export function verifyDeliveredContext(context: ContextBundle,proofs: Readonly<Record<string,string>>,binding: {id:string;publicationDigest:string;commitSha:string;snapshotId:string;packageName:string;version:string},key: KeyObject,graphProofs:PublicationArtifact['graphSignatures']): void {
  canonicalJson(context);
  if (context.schemaVersion !== 1 || context.providerId !== binding.id || context.packageName !== binding.packageName || context.version !== binding.version
    || !Array.isArray(context.evidence) || context.evidence.length > 8 || !Array.isArray(context.nodes) || context.nodes.length > 160
    || !Array.isArray(context.edges) || context.edges.length > 120 || !Array.isArray(context.limitations)) throw new Error('Incorrect delivered context identity or bounds');
  validateContextShape(context,binding.id,binding.publicationDigest);verifyGraphProofs(context,graphProofs,binding.id,binding.publicationDigest,key);
  const evidenceIds=new Set<string>();const nodeIds=new Set(context.nodes.map(node=>node.id));
  for(const item of context.evidence) {
    if(item.source.snapshotId!==binding.snapshotId || item.source.revision!==binding.commitSha || item.source.kind!=='git' || item.providerId!==binding.id
      || item.provenance!=='provider-reported' || !Number.isSafeInteger(item.source.startLine) || !Number.isSafeInteger(item.source.endLine)
      || item.source.startLine<1 || item.source.endLine<item.source.startLine || item.source.endLine-item.source.startLine>=120
      || typeof item.original!=='string' || Buffer.byteLength(item.original)>262_144 || evidenceIds.has(item.id)
      || !verifyDocument(publicationPassagePayload(binding.id,binding.publicationDigest,item),proofs[item.id],key)) throw new Error('Delivered source differs from the owner-approved immutable passage');
    evidenceIds.add(item.id);
  }
  if(nodeIds.size!==context.nodes.length || context.nodes.some(node=>node.snapshotId!==binding.snapshotId)
    || context.edges.some(edge=>!nodeIds.has(edge.from)||!nodeIds.has(edge.to)||!evidenceIds.has(edge.evidenceId)||edge.provenance!=='provider-reported')) throw new Error('Delivered graph references are invalid');
}
/** Deterministic evidence selection. The question is data, never an instruction to execute code or widen access. */
export function retrievePublishedContext(artifact: PublicationArtifact, question: string): ContextBundle {
  const words = [...new Set(parseQuestion(question).toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [])].slice(0, 24);
  const ranked = artifact.context.evidence.map((item, order) => ({ item, order, score: words.reduce((sum, word) => sum + ((`${item.source.path}\n${item.original}`).toLowerCase().includes(word) ? 1 : 0), 0) }))
    .filter(item => item.score > 0).sort((a,b) => b.score - a.score || a.order - b.order).slice(0, 8).map(item => item.item);
  const ids = new Set(ranked.map(item => item.id)); const edges = artifact.context.edges.filter(edge => ids.has(edge.evidenceId)).slice(0, 120);
  const nodeIds = new Set(edges.flatMap(edge => [edge.from, edge.to]));
  const nodes=artifact.context.nodes.filter(node=>nodeIds.has(node.id)).slice(0,160);const selectedNodes=new Set(nodes.map(node=>node.id));
  return { ...artifact.context, evidenceState: ranked.length ? 'sufficient' : 'insufficient', evidence: ranked,
    nodes, edges:edges.filter(edge=>selectedNodes.has(edge.from)&&selectedNodes.has(edge.to)),
    limitations: [...artifact.context.limitations, 'Deterministic term matching selects source passages; unsupported conclusions are not generated.'] };
}
