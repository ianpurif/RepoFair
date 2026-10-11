import { createPublicKey, randomBytes } from 'node:crypto';
import type { ActivePublication, CatalogProvider, ProviderGrant, PublicationArtifact, Scope, SignedPublicationArtifact } from '../../../packages/contracts/src/index.ts';
import { MODERATO_NETWORK, MODERATO_PATHUSD } from '../../../packages/contracts/src/commerce.ts';
import type { AtlasDatabase, AtlasTransaction } from './database.ts';
import { createPublicationService, PublicationServiceError } from './publication-service.ts';
import { createRepositoryService } from './repository-service.ts';
import { buildPublicationArtifact, signPublicationPassages } from './publication-artifact.ts';
import { createProviderGrant, createPublicationControlProof, documentDigest, loadCommerceKey, signDocument, verifyProviderGrant } from './commerce-signatures.ts';
import { providerHttp, publicProviderUrl } from './provider-http.ts';
import type { ProviderHttp } from './provider-http.ts';

type RegistryRow = { id: string; workspace_id: string; repository_id: string; snapshot_id: string; created_by: string; draft_revision: string | number;
  terms_digest: string; metadata: CatalogProvider; state: 'active' | 'revoked'; activated_at: Date | string; updated_at: Date | string };
type Dependencies = Readonly<{ http?: ProviderHttp; now?: () => number; sessionActive?: (principalId: string,sessionId: string) => Promise<boolean> }>;
function required(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new PublicationServiceError(code, message, status);
}
function uuid(value: string): string { required(typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value), 'invalid-id', 'Invalid publication identifier'); return value.toLowerCase(); }
function approved(input: unknown): asserts input is { expectedRevision: number; termsDigest: string; exposureApproved: true } {
  const value = input as Record<string,unknown>;
  required(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['expectedRevision','termsDigest','exposureApproved'].includes(key))
    && Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) > 0 && typeof value.termsDigest === 'string'
    && /^[a-f0-9]{64}$/.test(value.termsDigest) && value.exposureApproved === true, 'explicit-approval-required', 'Approve the saved draft revision and selected source exposure');
}
/** Clerk is contacted only by the trusted issuer. Independent providers never receive its API secret or session token. */
async function sessionActive(env: Readonly<Record<string,string|undefined>>, principalId: string, sessionId: string): Promise<boolean> {
  if (!env.CLERK_SECRET_KEY || !/^sess_[A-Za-z0-9]+$/.test(sessionId)) return false;
  try {
    const response = await fetch(`https://api.clerk.com/v1/sessions/${encodeURIComponent(sessionId)}`, { headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const body = await response.text(); if (Buffer.byteLength(body) > 65_536) return false;
    const session = JSON.parse(body) as Record<string,unknown>;
    return session.id === sessionId && session.user_id === principalId && session.status === 'active'
      && typeof session.expire_at === 'number' && session.expire_at > Date.now();
  } catch { return false; }
}
export function createPublicationRegistry(database: AtlasDatabase, env: Readonly<Record<string,string|undefined>>, dependencies: Dependencies = {}) {
  const drafts = createPublicationService(database, env); const repositories = createRepositoryService(database, env);
  const http = dependencies.http ?? providerHttp; const now = dependencies.now ?? Date.now;
  const activeSession = dependencies.sessionActive ?? ((principal: string,session: string) => sessionActive(env, principal, session));
  const issuer = (): string => {
    required(env.ATLAS_PUBLIC_ORIGIN, 'issuer-unavailable', 'Configure the public Atlas HTTPS origin before publishing', 503);
    const origin = publicProviderUrl(env.ATLAS_PUBLIC_ORIGIN).origin;
    required(origin === env.ATLAS_PUBLIC_ORIGIN, 'issuer-unavailable', 'Atlas issuer must be an exact HTTPS origin', 503); return origin;
  };
  async function lockCurrent(tx: AtlasTransaction, principal: string, verified: Awaited<ReturnType<typeof drafts.getAuthorizedDraft>>): Promise<void> {
    // Share repository-first locks and revision fences with saves/revocations.
    await drafts.lockGrant(tx,principal,verified.grant);const draft=verified.draft;
    const row=(await tx.query<{state:string;terms_digest:string}>('SELECT state,terms_digest FROM atlas.publication_drafts WHERE id=$1 AND revision=$2 FOR UPDATE',[draft.id,draft.revision])).rows[0];
    required(row && row.state === 'draft' && row.terms_digest === draft.termsDigest,
      'publication-changed', 'The draft or publishing authorization changed; reload before publishing', 409);
  }
  async function fenceAvailable(tx:AtlasTransaction,principal:string,row:RegistryRow,verified:Awaited<ReturnType<typeof drafts.getAuthorizedDraft>>,buyer:Scope|null):Promise<void> {
    await lockCurrent(tx,row.created_by,verified);
    const current=(await tx.query<RegistryRow>("SELECT * FROM atlas.publications WHERE id=$1 AND state='active' AND draft_revision=$2 AND terms_digest=$3 FOR SHARE",[row.id,row.draft_revision,row.terms_digest])).rows[0];
    required(current&&documentDigest(current.metadata)===documentDigest(row.metadata),'publication-unavailable','The exact publication was revoked or changed',403);
    if(buyer) {
      const member=(await tx.query<{revision:string}>('SELECT revision::text FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2 FOR SHARE',[row.workspace_id,principal])).rows[0];
      required(member && buyer.tenantId===row.workspace_id && buyer.principalId===principal && buyer.permissionRevision===`${member.revision}:${verified.grant.permission_revision}`,
        'delegation-denied','Private source membership or repository permissions changed',403);
    }
  }
  async function exportDraft(principal: string, id: string, input: unknown): Promise<SignedPublicationArtifact> {
    approved(input); id = uuid(id); const initial = await drafts.getAuthorizedDraft(principal,id);const draft=initial.draft;
    required(draft.revision === input.expectedRevision && draft.termsDigest === input.termsDigest && draft.state === 'draft', 'revision-conflict', 'Reload the saved draft revision', 409);
    let artifact:PublicationArtifact;
    try { artifact = buildPublicationArtifact(draft, await repositories.getIndex(principal,draft.repositoryId,draft.snapshotId)); }
    catch { throw new PublicationServiceError('export-incomplete', 'Select package.json and source, declare rights, and configure an HTTPS endpoint with PathUSD pricing; the export must fit 1.5 MB', 422); }
    let key; try { key = await loadCommerceKey(env.ATLAS_PUBLICATION_SIGNING_KEY_FILE,'private'); }
    catch { throw new PublicationServiceError('signing-key-unavailable', 'The publication issuer signing key is not configured', 503); }
    const fresh=await drafts.getAuthorizedDraft(principal,id);
    required(fresh.draft.revision===draft.revision&&fresh.draft.termsDigest===draft.termsDigest,'revision-conflict','The draft changed during export',409);
    return database.withAdminTransaction(async tx=>{
      await lockCurrent(tx,principal,fresh);artifact=signPublicationPassages(artifact,key);return {artifact,signature:signDocument(artifact,key)};
    });
  }
  async function activateDraft(principal: string, id: string, input: unknown): Promise<ActivePublication> {
    approved(input); id = uuid(id); const signed = await exportDraft(principal,id,input); const artifact = signed.artifact;
    const proposal = artifact.proposal; const terms = proposal.testnetTerms!; const url = publicProviderUrl(proposal.proposedEndpoint!);
    required(url.pathname === '/context/retrieve' && !url.search, 'invalid-endpoint', 'Use the provider /context/retrieve HTTPS endpoint');
    const nonce = randomBytes(24).toString('hex'); const origin = issuer(); let manifest: Record<string,unknown>;
    try {
      const key=await loadCommerceKey(env.ATLAS_PUBLICATION_SIGNING_KEY_FILE,'private');
      const control=createPublicationControlProof({schemaVersion:1,purpose:'activation-control',publicationId:id,draftRevision:artifact.draftRevision,
        termsDigest:artifact.termsDigest,providerOrigin:url.origin,nonce,expiresAtMs:now()+60_000},key);
      const response = await http(`${url.origin}/.well-known/atlas-provider.json?nonce=${nonce}`, { headers:{'X-Atlas-Publication-Control':control},maximumBytes: 16_384 });
      required(response.ok, 'endpoint-unavailable', 'Provider control proof is unavailable', 422);
      manifest = await response.json() as Record<string,unknown>;
    } catch { throw new PublicationServiceError('endpoint-unavailable','Deploy the independent HTTPS provider and install this signed export before activation',422); }
    required(manifest.schemaVersion === 1 && manifest.mode === 'tempo-testnet' && manifest.providerId === id && manifest.nonce === nonce
      && manifest.origin === url.origin && manifest.operation === 'context.retrieve' && manifest.publicationDigest === artifact.termsDigest
      && manifest.packageName === proposal.packageName && manifest.version === proposal.version && manifest.commitSha === artifact.commitSha
      && manifest.network === MODERATO_NETWORK && manifest.token === MODERATO_PATHUSD && manifest.tokenDecimals === 6
      && typeof manifest.recipient === 'string' && manifest.recipient.toLowerCase() === terms.recipient.toLowerCase()
      && manifest.atomicPrice === terms.atomicPrice && manifest.authorizationIssuer === origin
      && typeof manifest.realm === 'string' && manifest.realm.length > 0 && manifest.realm.length <= 200,
    'endpoint-proof-mismatch','The provider identity, installed source export, issuer, or Moderato terms differ from this saved draft',422);
    const verified=await drafts.getAuthorizedDraft(principal,id);const fresh=verified.draft;
    required(fresh.revision === input.expectedRevision && fresh.termsDigest === input.termsDigest,'revision-conflict','The draft changed during endpoint verification',409);
    const metadata: CatalogProvider = { id,packageName:proposal.packageName,version:proposal.version,endpoint:url.href,realm:manifest.realm as string,
      accessPolicy:proposal.accessPolicy,network:MODERATO_NETWORK,token:MODERATO_PATHUSD,recipient:terms.recipient.toLowerCase(),atomicPrice:terms.atomicPrice,tokenDecimals:6,
      commitSha:artifact.commitSha,snapshotId:artifact.snapshotId,publicationDigest:artifact.termsDigest,rightsStatement:proposal.rightsStatement };
    return database.withAdminTransaction(async tx => {
      await lockCurrent(tx,principal,verified);
      const row = (await tx.query<RegistryRow>(`INSERT INTO atlas.publications(id,workspace_id,repository_id,snapshot_id,created_by,draft_revision,terms_digest,state,access_policy,metadata,endpoint_proof_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9::jsonb,$10)
        ON CONFLICT(id) DO UPDATE SET state='active',draft_revision=excluded.draft_revision,terms_digest=excluded.terms_digest,access_policy=excluded.access_policy,
          metadata=excluded.metadata,endpoint_proof_digest=excluded.endpoint_proof_digest,updated_at=now()
        RETURNING *`,[id,fresh.workspaceId,fresh.repositoryId,fresh.snapshotId,principal,fresh.revision,fresh.termsDigest,proposal.accessPolicy,JSON.stringify(metadata),documentDigest(manifest)])).rows[0];
      required(row,'registry-unavailable','Publication registration failed',503); return { ...metadata,state:row.state,revision:fresh.revision,activatedAt:new Date(row.activated_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString() };
    });
  }
  async function available(principal: string,id: string): Promise<RegistryRow & {verified:Awaited<ReturnType<typeof drafts.getAuthorizedDraft>>;buyer:Scope|null}> {
    id = uuid(id);
    const row = await database.withAdminTransaction(async tx => (await tx.query<RegistryRow>(`SELECT p.* FROM atlas.publications p
      JOIN atlas.publication_drafts d ON d.id=p.id AND d.workspace_id=p.workspace_id AND d.revision=p.draft_revision AND d.terms_digest=p.terms_digest
      JOIN atlas.repositories r ON r.id=p.repository_id AND r.workspace_id=p.workspace_id
      WHERE p.id=$1 AND p.state='active' AND d.state='draft' AND NOT r.access_revoked
        AND (p.access_policy<>'private' OR EXISTS(SELECT 1 FROM atlas.memberships m WHERE m.workspace_id=p.workspace_id AND m.principal_id=$2))`,[id,principal])).rows[0]);
    required(row,'publication-unavailable','The exact publication is unavailable',404);
    // Publication authority is independently refreshed, including after an owner loses GitHub access.
    const verified=await drafts.getAuthorizedDraft(row.created_by,row.id);const owner=verified.draft;
    required(owner.state === 'draft' && owner.termsDigest === row.terms_digest && owner.revision === Number(row.draft_revision),'publication-unavailable','Publication was changed or revoked',404);
    const buyer=row.metadata.accessPolicy==='private'?(await repositories.getGraph(principal,row.repository_id,{snapshotId:row.snapshot_id,limit:1})).scope:null;
    await database.withAdminTransaction(tx=>fenceAvailable(tx,principal,row,verified,buyer));
    return {...row,verified,buyer};
  }
  async function catalog(principal: string, packageName?: string, version?: string): Promise<CatalogProvider[]> {
    const ids = await database.withAdminTransaction(async tx => (await tx.query<{ id: string }>(`SELECT p.id FROM atlas.publications p WHERE p.state='active'
      AND (p.access_policy<>'private' OR EXISTS(SELECT 1 FROM atlas.memberships m WHERE m.workspace_id=p.workspace_id AND m.principal_id=$1))
      AND ($2::text IS NULL OR p.metadata->>'packageName'=$2) AND ($3::text IS NULL OR p.metadata->>'version'=$3)
      ORDER BY p.activated_at DESC LIMIT 20`,[principal,packageName ?? null,version ?? null])).rows);
    const providers: CatalogProvider[] = [];
    for (const id of ids) { try { providers.push((await available(principal,id.id)).metadata); }
      catch (error) { if (error instanceof PublicationServiceError && [403,404,409].includes(error.status)) continue; throw error; } }
    return providers;
  }
  async function grant(principal: string,sessionId: string,workspaceId: string,providerId: string,requestDigest: string,idempotencyKey: string) {
    const row = await available(principal,providerId); workspaceId = uuid(workspaceId);
    const membership = await database.withPrincipalTransaction(principal,async tx => (await tx.query<{ revision: string }>('SELECT revision::text FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2',[workspaceId,principal])).rows[0]);
    required(membership && await activeSession(principal,sessionId),'authorization-unavailable','A current authenticated workspace session is required',403);
    let key; try { key = await loadCommerceKey(env.ATLAS_PUBLICATION_SIGNING_KEY_FILE,'private'); }
    catch { throw new PublicationServiceError('signing-key-unavailable','Provider delegation signing is not configured',503); }
    const grant: ProviderGrant = { schemaVersion:1,issuer:issuer(),providerId:row.id,principalId:principal,sessionId,workspaceId,
      permissionRevision:`${membership.revision}:${row.terms_digest}`,publicationDigest:row.terms_digest,packageName:row.metadata.packageName,version:row.metadata.version,
      requestDigest,idempotencyKey,expiresAtMs:now()+120_000 };
    return database.withAdminTransaction(async tx=>{
      await fenceAvailable(tx,principal,row,row.verified,row.buyer);
      const current=(await tx.query<{revision:string}>('SELECT revision::text FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2 FOR SHARE',[workspaceId,principal])).rows[0];
      required(current?.revision===membership.revision,'delegation-denied','Workspace membership changed during session verification',403);
      return {provider:row.metadata,grant,token:createProviderGrant(grant,key)};
    });
  }
  async function introspect(token: string): Promise<ProviderGrant> {
    let grant: ProviderGrant;
    try { const key = createPublicKey(await loadCommerceKey(env.ATLAS_PUBLICATION_SIGNING_KEY_FILE,'private')); grant = verifyProviderGrant(token,key,issuer(),undefined,now()); }
    catch { throw new PublicationServiceError('delegation-denied','Invalid or expired provider delegation',403); }
    const row = await available(grant.principalId,grant.providerId);
    const membership = await database.withPrincipalTransaction(grant.principalId,async tx => (await tx.query<{ revision: string }>('SELECT revision::text FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2',[grant.workspaceId,grant.principalId])).rows[0]);
    required(membership && grant.permissionRevision === `${membership.revision}:${row.terms_digest}` && grant.publicationDigest === row.terms_digest
      && grant.packageName === row.metadata.packageName && grant.version === row.metadata.version && await activeSession(grant.principalId,grant.sessionId),
    'delegation-denied','Provider delegation permissions or session were revoked',403);
    return database.withAdminTransaction(async tx=>{
      await fenceAvailable(tx,grant.principalId,row,row.verified,row.buyer);
      const current=(await tx.query<{revision:string}>('SELECT revision::text FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2 FOR SHARE',[grant.workspaceId,grant.principalId])).rows[0];
      required(current?.revision===membership.revision,'delegation-denied','Workspace membership changed during session verification',403);return grant;
    });
  }
  return { exportDraft,activateDraft,catalog,available,grant,introspect };
}
