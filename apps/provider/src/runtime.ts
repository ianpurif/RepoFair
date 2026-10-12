import { readFile, stat } from 'node:fs/promises';
import { BodyDigest, Receipt } from 'mppx';
import type { PublicClient } from 'viem';
import type { PublicationArtifact, ProviderGrant, PurchaseTerms, SignedPublicationArtifact } from '../../../packages/contracts/src/index.ts';
import { MODERATO_NETWORK, MODERATO_PATHUSD } from '../../../packages/contracts/src/commerce.ts';
import { createAtlasDatabase } from '../../worker/src/database.ts';
import type { AtlasDatabase,AtlasTransaction } from '../../worker/src/database.ts';
import { canonicalJson, documentDigest, loadCommerceKey, verifyProviderGrant, verifyPublicationControlProof } from '../../worker/src/commerce-signatures.ts';
import { retrievePublishedContext, verifyPublicationArtifact } from '../../worker/src/publication-artifact.ts';
import { providerHttp, publicProviderUrl } from '../../worker/src/provider-http.ts';
import type { ProviderHttp } from '../../worker/src/provider-http.ts';
import { createModeratoClient, verifyModeratoSettlement } from '../../worker/src/tempo-verification.ts';
import type { PaymentSubmission } from '../../worker/src/tempo-verification.ts';
import { createPostgresReplayStore } from './postgres-replay-store.ts';
import { createPostgresPurchaseLedger } from './postgres-purchase-ledger.ts';
import { createTempoTestnetAdapter } from './tempo-adapter.ts';
import type { AuthorizedRetrieval, RetrievalInput, TempoProviderConfig } from './tempo-adapter.ts';

type RuntimeDependencies = Readonly<{ database?: AtlasDatabase; http?: ProviderHttp; client?: PublicClient; now?: () => number }>;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function independentProviderEnvironment(env: Readonly<Record<string,string|undefined>>) {
  requireValue(env.ATLAS_PROVIDER_DATABASE_URL,'Independent provider database is not configured');
  return {DATABASE_URL:env.ATLAS_PROVIDER_DATABASE_URL,DATABASE_SSL_CA_FILE:env.ATLAS_PROVIDER_DATABASE_SSL_CA_FILE,DATABASE_SSL_CA:env.ATLAS_PROVIDER_DATABASE_SSL_CA};
}
/** Independent provider secret only; no issuer private key or central credential fallback. */
export async function loadProviderMppSecret(env: Readonly<Record<string,string|undefined>>): Promise<string> {
  const file = env.ATLAS_PROVIDER_MPP_SECRET_FILE; const inline = env.ATLAS_PROVIDER_MPP_SECRET;
  if ((file !== undefined && typeof file !== 'string') || (inline !== undefined && typeof inline !== 'string')) throw new Error('MPP challenge secret configuration must use a string or file path');
  const path = file?.trim(); const value = inline?.trim();
  if (path && value) throw new Error('Configure exactly one MPP challenge secret source: inline value or file');
  if (!path && !value) throw new Error('Independent MPP challenge secret is not configured');
  let secret: string;
  try {
    if (path) {
      if (path.length > 8192) throw new Error();
      const file = await stat(path); if (!file.isFile() || file.size < 1 || file.size > 4096) throw new Error();
      secret = await readFile(path, 'utf8');
    } else secret = inline!;
    if (Buffer.byteLength(secret) > 4096) throw new Error();
    secret = secret.trim();
  } catch { throw new Error('MPP challenge secret is unavailable or invalid'); }
  requireValue(Buffer.byteLength(secret) >= 32 && Buffer.byteLength(secret) <= 1024,'MPP challenge secret must contain 32–1024 bytes');
  return secret;
}
export async function installProviderArtifact(database: AtlasDatabase, env: Readonly<Record<string,string|undefined>>, raw: unknown): Promise<void> {
  const key = await loadCommerceKey(env.ATLAS_PROVIDER_ISSUER_PUBLIC_KEY_FILE,'public',env.ATLAS_PROVIDER_ISSUER_PUBLIC_KEY); const signed = verifyPublicationArtifact(raw,key);
  requireValue(signed.artifact.id === env.ATLAS_PROVIDER_ID && uuid.test(signed.artifact.id),'Artifact differs from the independently configured provider identity');
  await database.withAdminTransaction(async tx => {
    const row = (await tx.query<{terms_digest:string}>('SELECT terms_digest FROM atlas_provider.publications WHERE provider_id=$1 FOR UPDATE',[signed.artifact.id])).rows[0];
    // A new revision uses a new publication identity. Never substitute source behind a paid immutable release.
    requireValue(!row || row.terms_digest === signed.artifact.termsDigest,'Install a new provider identity for changed publication terms');
    await tx.query(`INSERT INTO atlas_provider.publications(provider_id,terms_digest,artifact,signature) VALUES($1,$2,$3::jsonb,$4)
      ON CONFLICT(provider_id) DO NOTHING`,[signed.artifact.id,signed.artifact.termsDigest,canonicalJson(signed.artifact),signed.signature]);
  });
}
export async function createIndependentProvider(env: Readonly<Record<string,string|undefined>>, supplied: RuntimeDependencies = {}) {
  requireValue(env.ATLAS_PROVIDER_ID && uuid.test(env.ATLAS_PROVIDER_ID),'Configure an independent publication UUID');
  const origin = publicProviderUrl(env.ATLAS_PROVIDER_ORIGIN ?? '').origin;
  requireValue(origin === env.ATLAS_PROVIDER_ORIGIN,'Configure the exact public provider HTTPS origin');
  const issuer = publicProviderUrl(env.ATLAS_PROVIDER_AUTHORIZATION_ISSUER ?? '').origin;
  requireValue(issuer === env.ATLAS_PROVIDER_AUTHORIZATION_ISSUER,'Configure the exact trusted authorization issuer');
  const key = await loadCommerceKey(env.ATLAS_PROVIDER_ISSUER_PUBLIC_KEY_FILE,'public',env.ATLAS_PROVIDER_ISSUER_PUBLIC_KEY);
  const secret = await loadProviderMppSecret(env);
  requireValue(env.TEMPO_CHAIN_ID === '42431','Only explicitly configured Tempo Moderato chain 42431 is permitted');
  const client = supplied.client ?? createModeratoClient(env.TEMPO_RPC_URL);
  requireValue(client.chain?.id === 42431 && await client.getChainId() === 42431,'Remote RPC is not Tempo Moderato');
  const suppliedDatabase = supplied.database;
  const database = suppliedDatabase ?? await createAtlasDatabase(independentProviderEnvironment(env));
  try {
  const http = supplied.http ?? providerHttp; const now = supplied.now ?? Date.now;
  const stored = await database.withAdminTransaction(async tx => (await tx.query<{artifact:PublicationArtifact;signature:string;terms_digest:string}>(
    'SELECT artifact,signature,terms_digest FROM atlas_provider.publications WHERE provider_id=$1',[env.ATLAS_PROVIDER_ID])).rows[0]);
  requireValue(stored,'Install the owner-approved signed publication export in the provider database');
  const signed = verifyPublicationArtifact({artifact:stored.artifact,signature:stored.signature},key); const artifact = signed.artifact;
  requireValue(artifact.termsDigest === stored.terms_digest && artifact.id === env.ATLAS_PROVIDER_ID,'Installed artifact binding is invalid');
  const terms = artifact.proposal.testnetTerms!;
  requireValue(artifact.proposal.proposedEndpoint === `${origin}/context/retrieve` && terms.token === MODERATO_PATHUSD && terms.network === MODERATO_NETWORK
    && env.ATLAS_PROVIDER_RECIPIENT?.toLowerCase() === terms.recipient.toLowerCase() && env.ATLAS_PROVIDER_PRICE_UNITS === terms.atomicPrice,
  'Independent provider origin, recipient or integer pricing differs from the signed export');
  const config: TempoProviderConfig = {providerId:artifact.id,origin,realm:env.ATLAS_PROVIDER_REALM ?? new URL(origin).hostname,
    recipient:terms.recipient as `0x${string}`,token:MODERATO_PATHUSD,decimals:6,atomicPrice:terms.atomicPrice,secretKey:secret,quoteLifetimeMs:300_000};
  const replayStore = createPostgresReplayStore(database,artifact.id);
  async function currentArtifact(connection?:AtlasTransaction): Promise<void> {
    const read=async(tx:AtlasTransaction)=>(await tx.query<{terms_digest:string}>('SELECT terms_digest FROM atlas_provider.publications WHERE provider_id=$1',[artifact.id])).rows[0];
    const row=connection?await read(connection):await database.withAdminTransaction(read);
    requireValue(row?.terms_digest === artifact.termsDigest,'Installed publication was changed or removed');
  }
  async function authorize(token: string,input: RetrievalInput,digest: string,connection?:AtlasTransaction): Promise<AuthorizedRetrieval> {
    const grant = verifyProviderGrant(token,key,issuer,artifact.id,now());
    requireValue(grant.publicationDigest === artifact.termsDigest && grant.packageName === input.packageName && grant.version === input.version
      && grant.idempotencyKey === input.idempotencyKey && grant.requestDigest === digest,'Delegation differs from this exact request');
    // Reauthorization also occurs inside provider transactions with a 15-second idle guard.
    const response = await http(`${issuer}/api/provider-grants/introspect`,{method:'POST',headers:{'X-Atlas-Provider-Grant':token,'Content-Type':'application/json'},body:'{}',maximumBytes:8192,timeoutMs:12_000});
    requireValue(response.ok,'Current provider delegation authorization is unavailable');
    const active = await response.json() as {active?:boolean;grant?:ProviderGrant};
    requireValue(active.active === true && active.grant && canonicalJson(active.grant) === canonicalJson(grant),'Current issuer authorization differs from the signed delegation');
    await currentArtifact(connection);
    requireValue(grant.expiresAtMs > now(),'Provider delegation expired during reauthorization');
    return {principalId:grant.principalId,permissionRevision:grant.permissionRevision,input};
  }
  async function submission(auth: AuthorizedRetrieval): Promise<PaymentSubmission|null> {
    const row = await database.withAdminTransaction(async tx => (await tx.query<{challenge_id:string;realm:string;transaction_hash:`0x${string}`;sender:`0x${string}`}>(
      'SELECT challenge_id,realm,transaction_hash,sender FROM atlas_provider.submissions WHERE provider_id=$1 AND principal_id=$2 AND idempotency_key=$3',
      [artifact.id,auth.principalId,auth.input.idempotencyKey])).rows[0]);
    return row ? {challengeId:row.challenge_id,realm:row.realm,transactionHash:row.transaction_hash,sender:row.sender} : null;
  }
  function adapter(token: string,body: string) {
    const digest = BodyDigest.compute(body);
    const ledger = createPostgresPurchaseLedger(database,{providerId:artifact.id,now,
      reauthorize:(check,tx) => authorize(token,check.authorization.input,check.requestDigest,tx),
      verifySettlement:async(auth,price,receipt) => {const bound = await submission(auth); return bound !== null && verifyModeratoSettlement(client,price,receipt,bound);},
    });
    return createTempoTestnetAdapter(config,{
      ...ledger,replayStore,now,getClient:() => client,
      authorize:(_request,input) => authorize(token,input,digest),
      bindSubmission:async(auth,price,bound) => {
        await authorize(token,auth.input,price.requestDigest);
        await database.withAdminTransaction(async tx => {
          const sale = (await tx.query<{state:string;terms:PurchaseTerms}>(`SELECT state,terms FROM atlas_provider.sales WHERE provider_id=$1 AND principal_id=$2 AND idempotency_key=$3 FOR UPDATE`,[artifact.id,auth.principalId,auth.input.idempotencyKey])).rows[0];
          requireValue(sale?.state === 'pending' && canonicalJson(sale.terms) === canonicalJson(price),'A matching durable claim is required before submission');
          await tx.query(`INSERT INTO atlas_provider.submissions(provider_id,principal_id,idempotency_key,challenge_id,realm,transaction_hash,sender)
            VALUES($1,$2,$3,$4,$5,$6,$7)`,[artifact.id,auth.principalId,auth.input.idempotencyKey,bound.challengeId,bound.realm,bound.transactionHash,bound.sender]);
        });
      },
      lookup:async(auth,requestDigest) => {
        const saved = await ledger.lookup(auth,requestDigest);
        if (!saved || saved.state === 'settled' || saved.state === 'rejected') return saved;
        const bound = await submission(auth); if (!bound) return saved;
        // Read-only recovery of the persisted transaction. Never submit it again.
        try {
          const receipt = await client.getTransactionReceipt({hash:bound.transactionHash}); const block = await client.getBlock({blockNumber:receipt.blockNumber});
          const reconciled: Receipt.Receipt = {method:'tempo',status:'success',reference:receipt.transactionHash,timestamp:new Date(Number(block.timestamp)*1000).toISOString()};
          if (await ledger.verifySettlement(auth,saved.terms,reconciled)) {await ledger.saveSettlement(auth,saved.terms,reconciled);return ledger.lookup(auth,requestDigest);}
        } catch { /* Pending/unknown remains reserved until actual finality can be verified. */ }
        return saved;
      },
      deliver:async(auth,price) => {
        await authorize(token,auth.input,price.requestDigest); const paid = await ledger.lookup(auth,price.requestDigest);
        requireValue(paid?.state === 'settled' && paid.receipt && await ledger.verifySettlement(auth,price,paid.receipt),'Verified durable settlement is required for delivery');
        const context = retrievePublishedContext(artifact,auth.input.question);
        const delivered = {schemaVersion:1,mode:'tempo-testnet',providerId:artifact.id,publicationDigest:artifact.termsDigest,commitSha:artifact.commitSha,snapshotId:artifact.snapshotId,payment:'settled',delivery:'ready',context,
          sourceSignatures:Object.fromEntries(context.evidence.map(item=>[item.id,artifact.sourceSignatures[item.id]])),
          graphSignatures:{nodes:Object.fromEntries(context.nodes.map(item=>[item.id,artifact.graphSignatures.nodes[item.id]])),edges:Object.fromEntries(context.edges.map(item=>[item.id,artifact.graphSignatures.edges[item.id]]))}};
        requireValue(Buffer.byteLength(canonicalJson(delivered)) <= 1_000_000,'Delivered source context exceeds the bound');
        const saved = await database.withAdminTransaction(async tx => {
          const sale = (await tx.query<{state:string}>('SELECT state FROM atlas_provider.sales WHERE provider_id=$1 AND principal_id=$2 AND idempotency_key=$3 FOR UPDATE',[artifact.id,auth.principalId,auth.input.idempotencyKey])).rows[0];
          requireValue(sale?.state === 'settled','Settlement is unavailable');
          await tx.query(`INSERT INTO atlas_provider.deliveries(provider_id,principal_id,idempotency_key,context,content_digest) VALUES($1,$2,$3,$4::jsonb,$5)
            ON CONFLICT(provider_id,principal_id,idempotency_key) DO NOTHING`,[artifact.id,auth.principalId,auth.input.idempotencyKey,canonicalJson(delivered),documentDigest(delivered)]);
          return (await tx.query<{context:unknown;content_digest:string}>('SELECT context,content_digest FROM atlas_provider.deliveries WHERE provider_id=$1 AND principal_id=$2 AND idempotency_key=$3',[artifact.id,auth.principalId,auth.input.idempotencyKey])).rows[0];
        });
        requireValue(saved && saved.content_digest === documentDigest(saved.context),'Stored delivery failed verification');
        await authorize(token,auth.input,price.requestDigest);
        return Response.json(saved.context,{headers:{'Cache-Control':'no-store','X-Atlas-Mode':'tempo-testnet'}});
      },
    });
  }
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url); let response: Response;
    const originHeader = request.headers.get('Origin');
    if (originHeader && originHeader !== issuer) return Response.json({error:'Origin denied',mode:'tempo-testnet'},{status:403});
    if (request.method === 'OPTIONS' && url.pathname === '/context/retrieve') response = new Response(null,{status:204});
    else if (request.method === 'GET' && url.pathname === '/health') response = Response.json({mode:'tempo-testnet',configuration:'ready',network:MODERATO_NETWORK});
    else if (request.method === 'GET' && url.pathname === '/.well-known/atlas-provider.json') {
      const nonce = url.searchParams.get('nonce');
      const control=request.headers.get('X-Atlas-Publication-Control')??'';
      try {
        requireValue(nonce&&/^[a-f0-9]{48}$/.test(nonce),'Control nonce required');
        verifyPublicationControlProof(control,key,{id:artifact.id,revision:artifact.draftRevision,digest:artifact.termsDigest,origin,nonce},now());await currentArtifact();
      } catch {return Response.json({error:'Publication control authorization required',mode:'tempo-testnet'},{status:403,headers:{'Cache-Control':'no-store'}});}
      response = Response.json({schemaVersion:1,mode:'tempo-testnet',providerId:artifact.id,origin,nonce,operation:'context.retrieve',publicationDigest:artifact.termsDigest,
        packageName:artifact.proposal.packageName,version:artifact.proposal.version,commitSha:artifact.commitSha,network:MODERATO_NETWORK,token:MODERATO_PATHUSD,tokenDecimals:6,
        recipient:terms.recipient,atomicPrice:terms.atomicPrice,realm:config.realm,authorizationIssuer:issuer});
    } else if (request.method === 'POST' && url.pathname === '/context/retrieve' && !url.search) {
      const authorization = request.headers.get('Authorization') ?? ''; const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!token || token.length > 4096) return Response.json({error:'A provider-scoped delegation is required',mode:'tempo-testnet'},{status:401});
      let body: string;
      try {
        const reader = request.clone().body?.getReader(); requireValue(reader,'Body required');const parts:Uint8Array[]=[];let bytes=0;
        try {for (;;) {const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;requireValue(bytes<=8192,'Body exceeds bounds');parts.push(item.value);}} finally {reader.releaseLock();}
        body = new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));
      } catch {return Response.json({error:'Invalid bounded request body',mode:'tempo-testnet'},{status:400});}
      response = await adapter(token,body).handle(request);
    } else response = Response.json({error:'Route unavailable',mode:'tempo-testnet'},{status:404});
    response.headers.set('Cache-Control','no-store'); response.headers.set('X-Content-Type-Options','nosniff'); response.headers.set('X-Atlas-Mode','tempo-testnet');
    if (originHeader === issuer) {response.headers.set('Access-Control-Allow-Origin',issuer);response.headers.set('Vary','Origin');
      response.headers.set('Access-Control-Allow-Methods','POST, OPTIONS');response.headers.set('Access-Control-Allow-Headers','Authorization, Content-Type, Payment-Authorization');
      response.headers.set('Access-Control-Expose-Headers','WWW-Authenticate, Payment-Receipt, X-Atlas-Mode');}
    return response;
  }
  return {handle,close:() => database.close(),artifact:signed as SignedPublicationArtifact};
  } catch (error) {
    // Initialization may reject an absent/invalid installed artifact after opening a pool.
    // Retry must not leak that owned pool; injected databases remain caller-owned.
    if (!suppliedDatabase) {
      try { await database.close(); } catch { /* Retain the original initialization failure. */ }
    }
    throw error;
  }
}
