import { createPublicKey } from 'node:crypto';
import { BodyDigest, Challenge, Receipt } from 'mppx';
import type { PublicClient } from 'viem';
import type { ContextBundle, PublicationArtifact, PurchaseBudget, PurchaseRecord } from '../../../packages/contracts/src/index.ts';
import { MODERATO_NETWORK, MODERATO_PATHUSD } from '../../../packages/contracts/src/commerce.ts';
import { parseQuestion } from '../../../packages/contracts/src/local.ts';
import { assertApprovedChallenge } from '../../../packages/sdk/src/payment-policy.ts';
import type { ApprovedTestnetPurchase } from '../../../packages/sdk/src/payment-policy.ts';
import type { AtlasDatabase, AtlasTransaction } from './database.ts';
import { documentDigest, loadCommerceKey } from './commerce-signatures.ts';
import { PublicationServiceError } from './publication-service.ts';
import { createPublicationRegistry } from './publication-registry.ts';
import { verifyDeliveredContext } from './publication-artifact.ts';
import { providerHttp } from './provider-http.ts';
import type { ProviderHttp } from './provider-http.ts';
import { createModeratoClient, inspectPaymentCredential, verifyModeratoSettlement } from './tempo-verification.ts';
import type { PaymentSubmission } from './tempo-verification.ts';

type Approval = ApprovedTestnetPurchase & Readonly<{publicationDigest:string;commitSha:string;snapshotId:string;challenge:Challenge.Challenge}>;
type PurchaseRow = {id:string;workspace_id:string;principal_id:string;provider_id:string;package_name:string;version:string;network:typeof MODERATO_NETWORK;token:string;recipient:string;amount:string;
  payment_state:PurchaseRecord['paymentState'];delivery_state:PurchaseRecord['deliveryState'];receipt:Receipt.Receipt|null;created_at:Date|string;updated_at:Date|string;
  request_body:string;request_digest:string;approval:Approval;idempotency_key:string;transaction_hash:`0x${string}`|null;sender:`0x${string}`|null;challenge_id:string;realm:string;provider_url:string;expires_at:Date|string};
type Dependencies = Readonly<{registry?:ReturnType<typeof createPublicationRegistry>;http?:ProviderHttp;client?:PublicClient;now?:()=>number}>;
function required(value:unknown,code:string,message:string,status=400):asserts value {if(!value)throw new PublicationServiceError(code,message,status);}
function uuid(value:unknown):string {required(typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value),'invalid-id','Invalid workspace or purchase identifier');return value.toLowerCase();}
function units(value:unknown,zero=false):string {
  required(typeof value==='string'&&/^(?:0|[1-9][0-9]{0,77})$/.test(value)&&BigInt(value)<=(1n<<256n)-1n&&(zero||BigInt(value)>0n),'invalid-amount','Use bounded integer PathUSD token units');return value;
}
function record(row:PurchaseRow):PurchaseRecord {
  return {id:row.id,providerId:row.provider_id,packageName:row.package_name,version:row.version,network:row.network,token:row.token,recipient:row.recipient,atomicAmount:row.amount,
    paymentState:row.payment_state,deliveryState:row.delivery_state,receiptReference:row.receipt?.reference??null,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};
}
export function createCommerceService(database:AtlasDatabase,env:Readonly<Record<string,string|undefined>>,dependencies:Dependencies={}) {
  const registry=dependencies.registry??createPublicationRegistry(database,env);const http=dependencies.http??providerHttp;const now=dependencies.now??Date.now;
  const client=()=>dependencies.client??createModeratoClient(env.TEMPO_RPC_URL);
  async function member(tx:AtlasTransaction,principal:string,workspace:string,locked=true):Promise<void> {
    const row=(await tx.query(`SELECT revision FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2 ${locked?'FOR SHARE':''}`,[workspace,principal])).rows[0];
    required(row,'denied','Current workspace membership is required',403);
  }
  async function read(principal:string,id:string,locked=false,tx?:AtlasTransaction):Promise<PurchaseRow> {
    id=uuid(id);
    const query=async(connection:AtlasTransaction)=>{
      const row=(await connection.query<PurchaseRow>(`SELECT p.*,p.amount::text AS amount FROM atlas.purchases p JOIN atlas.memberships m ON m.workspace_id=p.workspace_id
        WHERE p.id=$1 AND p.principal_id=$2 AND m.principal_id=$2 ${locked?'FOR UPDATE OF p FOR SHARE OF m':''}`,[id,principal])).rows[0];
      required(row,'purchase-unavailable','Purchase is unavailable in this workspace scope',404);return row;
    };
    return tx?query(tx):database.withPrincipalTransaction(principal,query);
  }
  async function history(principal:string,workspace:string):Promise<{purchases:PurchaseRecord[];budgets:PurchaseBudget[]}> {
    workspace=uuid(workspace);return database.withPrincipalTransaction(principal,async tx=>{
      await member(tx,principal,workspace,false);
      const rows=(await tx.query<PurchaseRow>('SELECT *,amount::text AS amount FROM atlas.purchases WHERE workspace_id=$1 AND principal_id=$2 AND network=$3 ORDER BY created_at DESC LIMIT 50',[workspace,principal,MODERATO_NETWORK])).rows;
      const budgets=(await tx.query<PurchaseBudget>('SELECT network,token,allowance::text AS allowance,reserved::text AS reserved,spent::text AS spent FROM atlas.budgets WHERE workspace_id=$1 AND principal_id=$2 AND network=$3',[workspace,principal,MODERATO_NETWORK])).rows;
      return {purchases:rows.map(record),budgets};
    });
  }
  async function setAllowance(principal:string,workspace:string,allowance:unknown):Promise<PurchaseBudget> {
    workspace=uuid(workspace);const amount=units(allowance,true);
    return database.withAdminTransaction(async tx=>{
      await member(tx,principal,workspace);
      const row=(await tx.query<{reserved:string;spent:string}>('SELECT reserved::text,spent::text FROM atlas.budgets WHERE workspace_id=$1 AND principal_id=$2 AND network=$3 AND token=$4 FOR UPDATE',[workspace,principal,MODERATO_NETWORK,MODERATO_PATHUSD])).rows[0];
      required(!row||BigInt(amount)>=BigInt(row.reserved)+BigInt(row.spent),'budget-reserved','Allowance cannot be lowered below spent and reserved token units',409);
      const saved=(await tx.query<PurchaseBudget>(`INSERT INTO atlas.budgets(workspace_id,principal_id,network,token,allowance) VALUES($1,$2,$3,$4,$5::numeric)
        ON CONFLICT(workspace_id,principal_id,network,token) DO UPDATE SET allowance=excluded.allowance
        RETURNING network,token,allowance::text,reserved::text,spent::text`,[workspace,principal,MODERATO_NETWORK,MODERATO_PATHUSD,amount])).rows[0];
      required(saved,'budget-unavailable','Allowance could not be saved',503);return saved;
    });
  }
  async function currentAuthorization(principal:string,sessionId:string,row:PurchaseRow) {
    const authorization=await registry.grant(principal,sessionId,row.workspace_id,row.provider_id,row.request_digest,row.idempotency_key);const provider=authorization.provider;
    required(row.approval && provider.id===row.provider_id && provider.packageName===row.package_name && provider.version===row.version
      && provider.publicationDigest===row.approval.publicationDigest && provider.commitSha===row.approval.commitSha && provider.snapshotId===row.approval.snapshotId
      && provider.network===row.network && provider.token.toLowerCase()===row.token.toLowerCase() && provider.recipient.toLowerCase()===row.recipient.toLowerCase()
      && provider.atomicPrice===row.amount && provider.endpoint===row.provider_url && provider.realm===row.realm,
    'purchase-entitlement-changed','The paid immutable publication or endpoint changed; this purchase cannot broaden access',403);
    return authorization;
  }
  async function createPurchase(principal:string,sessionId:string,input:unknown) {
    const raw=input as Record<string,unknown>;
    required(raw&&typeof raw==='object'&&!Array.isArray(raw)&&Object.keys(raw).length===5&&Object.keys(raw).every(key=>['workspaceId','providerId','question','idempotencyKey','approvedAtomicAmount'].includes(key)),'invalid-purchase','Use the exact explicit purchase request');
    const workspace=uuid(raw.workspaceId);const providerId=uuid(raw.providerId);const amount=units(raw.approvedAtomicAmount);const question=parseQuestion(raw.question);
    required(typeof raw.idempotencyKey==='string'&&/^[A-Za-z0-9_-]{16,128}$/.test(raw.idempotencyKey),'invalid-idempotency','Use a stable purchase idempotency key');
    const idem=raw.idempotencyKey;
    const provider=(await registry.available(principal,providerId)).metadata;
    required(provider.atomicPrice===amount&&provider.network===MODERATO_NETWORK&&provider.token===MODERATO_PATHUSD,'approval-mismatch','The saved provider price differs from your exact approval',409);
    const body=JSON.stringify({packageName:provider.packageName,version:provider.version,question,idempotencyKey:idem});const digest=BodyDigest.compute(body);
    const existing=await database.withPrincipalTransaction(principal,async tx=>{
      await member(tx,principal,workspace,false);
      const row=(await tx.query<PurchaseRow>('SELECT *,amount::text AS amount FROM atlas.purchases WHERE workspace_id=$1 AND principal_id=$2 AND idempotency_key=$3',[workspace,principal,idem])).rows[0];
      if(row)required(row.provider_id===providerId&&row.request_body===body&&row.amount===amount,'idempotency-mismatch','This key already belongs to different immutable purchase terms',409);
      return row;
    });
    if(existing) {const authorization=await currentAuthorization(principal,sessionId,existing);return {purchase:record(existing),approval:existing.approval,requestBody:existing.request_body,authorizationToken:authorization.token,endpoint:existing.provider_url};}
    const authorization=await registry.grant(principal,sessionId,workspace,providerId,digest,idem);
    const response=await http(provider.endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${authorization.token}`},body,maximumBytes:65_536});
    required(response.status===402,'quote-unavailable','The authorized provider did not issue a Tempo testnet quote',422);
    let approval:Approval;
    try {
      const challenge=Challenge.deserialize(response.headers.get('WWW-Authenticate')??'');
      approval={terms:{providerId,operation:'context.retrieve',requestDigest:digest,packageName:provider.packageName,version:provider.version,network:MODERATO_NETWORK,
        token:MODERATO_PATHUSD,recipient:provider.recipient,atomicAmount:amount,expiresAtMs:Date.parse(challenge.expires??'')},origin:new URL(provider.endpoint).origin,
        realm:provider.realm,challengeId:challenge.id,idempotencyKey:idem,tokenDecimals:6,publicationDigest:provider.publicationDigest,commitSha:provider.commitSha,snapshotId:provider.snapshotId,challenge};
      assertApprovedChallenge(challenge,approval,digest,now(),provider.endpoint);
    }catch{throw new PublicationServiceError('quote-mismatch','Provider challenge differs from the explicitly approved exact release and Moderato price',422);}
    // A refresh of the current publication is required before the atomic database reservation.
    const fresh=(await registry.available(principal,providerId)).metadata;
    required(documentDigest(fresh)===documentDigest(provider),'publication-changed','Provider terms changed while quoting; approve them again',409);
    const row=await database.withAdminTransaction(async tx=>{
      await member(tx,principal,workspace);
      const inFlight=(await tx.query(`SELECT id FROM atlas.purchases WHERE workspace_id=$1 AND principal_id=$2 AND provider_id=$3 AND payment_state IN ('pending','unknown') FOR UPDATE`,[workspace,principal,providerId])).rows[0];
      required(!inFlight,'purchase-pending','Reconcile the pending or unknown provider purchase before approving another',409);
      const reservation=(await tx.query<{id:string}>(`SELECT atlas.reserve_purchase($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::numeric) AS id`,
        [workspace,principal,idem,documentDigest(approval),providerId,MODERATO_NETWORK,MODERATO_PATHUSD,provider.recipient,digest,provider.packageName,provider.version,new Date(approval.terms.expiresAtMs).toISOString(),amount])).rows[0];
      required(reservation,'reservation-unavailable','A configured allowance is required before signing',422);
      const saved=(await tx.query<PurchaseRow>(`UPDATE atlas.purchases SET approval=$1::jsonb,request_body=$2,provider_url=$3,challenge_id=$4,realm=$5 WHERE id=$6
        RETURNING *,amount::text AS amount`,[JSON.stringify(approval),body,provider.endpoint,approval.challengeId,approval.realm,reservation.id])).rows[0];
      required(saved,'reservation-unavailable','Purchase reservation is unavailable',503);return saved;
    });
    return {purchase:record(row),approval,requestBody:body,authorizationToken:authorization.token,endpoint:provider.endpoint};
  }
  async function claimSigning(principal:string,sessionId:string,id:string):Promise<{state:'claimed'|'pending'|'unknown'|'settled'|'failed'}> {
    const selected=await read(principal,id);await currentAuthorization(principal,sessionId,selected);
    return database.withAdminTransaction(async tx=>{
      const row=await read(principal,id,true,tx);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`atlas-signing:${row.workspace_id}:${principal}:${row.provider_id}`]);
      if(row.payment_state!=='reserved')return {state:row.payment_state==='expired'?'failed':row.payment_state};
      const other=(await tx.query("SELECT id FROM atlas.purchases WHERE workspace_id=$1 AND principal_id=$2 AND provider_id=$3 AND id<>$4 AND payment_state IN ('pending','unknown')",[row.workspace_id,principal,row.provider_id,row.id])).rows[0];
      required(!other,'purchase-pending','Another provider purchase has a pending or unknown outcome; reconcile it before signing',409);
      required(row.approval&&row.approval.terms.expiresAtMs>now(),'quote-expired','Quote expired before signing; release this unsigned reservation',410);
      await tx.query("SELECT atlas.reconcile_purchase($1,'pending',null)",[row.id]);return {state:'claimed'};
    });
  }
  async function markUnknown(principal:string,id:string):Promise<void> {
    await database.withAdminTransaction(async tx=>{const row=await read(principal,id,true,tx);if(['unknown','settled'].includes(row.payment_state))return;
      required(row.payment_state==='pending','invalid-state','An existing signing claim is required',409);await tx.query("SELECT atlas.reconcile_purchase($1,'unknown',null)",[row.id]);});
  }
  async function bindCredential(principal:string,id:string,credential:unknown):Promise<void> {
    const row=await read(principal,id);required(typeof credential==='string','invalid-credential','A bounded official payment credential is required');
    const submission=await inspectPaymentCredential(credential,row.approval,now());
    await database.withAdminTransaction(async tx=>{const current=await read(principal,id,true,tx);
      required(current.payment_state==='pending'&&!current.transaction_hash,'invalid-state','Submission is already bound or has an unknown outcome',409);
      await tx.query('UPDATE atlas.purchases SET transaction_hash=$1,sender=$2 WHERE id=$3',[submission.transactionHash,submission.sender,current.id]);});
  }
  async function reconcile(principal:string,id:string,rawReceipt:unknown):Promise<PurchaseRecord> {
    const row=await read(principal,id);let receipt:Receipt.Receipt;
    try{receipt=Receipt.Schema.parse(rawReceipt);}catch{throw new PublicationServiceError('invalid-receipt','A complete Tempo receipt is required',400);}
    required(row.transaction_hash&&row.sender&&row.approval,'submission-unavailable','Reconcile the recorded transaction; a browser hash alone is not payment proof',409);
    const submission:PaymentSubmission={transactionHash:row.transaction_hash,sender:row.sender,challengeId:row.challenge_id,realm:row.realm};
    required(await verifyModeratoSettlement(client(),row.approval.terms,receipt,submission),'settlement-unverified','The remote Moderato transfer, sender or challenge attribution could not be verified',422);
    return database.withAdminTransaction(async tx=>{const current=await read(principal,id,true,tx);
      required(['pending','unknown','settled'].includes(current.payment_state),'invalid-state','Only submitted purchases can settle',409);
      if(current.payment_state!=='settled')await tx.query("SELECT atlas.reconcile_purchase($1,'settled',$2::jsonb)",[id,JSON.stringify(receipt)]);
      return record(await read(principal,id,false,tx));});
  }
  async function releaseUnsigned(principal:string,id:string):Promise<void> {
    await database.withAdminTransaction(async tx=>{const row=await read(principal,id,true,tx);
      required(row.payment_state==='reserved'&&!row.transaction_hash,'invalid-state','Submitted or unknown purchases cannot be released locally',409);
      await tx.query("SELECT atlas.reconcile_purchase($1,'failed',null)",[row.id]);});
  }
  async function resume(principal:string,sessionId:string,id:string,credential?:string):Promise<{purchase:PurchaseRecord;context:ContextBundle;sourceSignatures:Readonly<Record<string,string>>;graphSignatures:PublicationArtifact['graphSignatures']}> {
    const row=await read(principal,id);required(['pending','unknown','settled'].includes(row.payment_state),'invalid-state','A submitted purchase is required',409);
    if(credential!==undefined) {
      required(row.payment_state==='pending'&&row.transaction_hash,'invalid-state','Only the recorded first submission can be forwarded',409);
      const inspected=await inspectPaymentCredential(credential,row.approval,now());required(inspected.transactionHash===row.transaction_hash,'credential-mismatch','Credential differs from the recorded transaction',409);
      await database.withAdminTransaction(async tx=>{
        await read(principal,id,true,tx);
        const dispatched=(await tx.query("UPDATE atlas.purchases SET credential_dispatched_at=now() WHERE id=$1 AND payment_state='pending' AND credential_dispatched_at IS NULL RETURNING id",[id])).rows[0];
        required(dispatched,'submission-already-forwarded','The credential was already forwarded or its outcome is unknown; resume without broadcasting again',409);
      });
    }
    const authorization=await currentAuthorization(principal,sessionId,row);let response:Response;
    try {response=await http(row.provider_url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${authorization.token}`,...(credential?{'Payment-Authorization':credential}:{})},body:row.request_body,maximumBytes:1_000_000});}
    catch {await markUnknown(principal,id);throw new PublicationServiceError('payment-unknown','Provider outcome is unknown; resume this purchase without sending another credential',503);}
    if(response.status!==200) {
      if(row.payment_state!=='settled')await markUnknown(principal,id);
      else await database.withAdminTransaction(tx=>tx.query("UPDATE atlas.purchases SET delivery_state='failed' WHERE id=$1 AND principal_id=$2",[id,principal]));
      throw new PublicationServiceError('delivery-pending','Provider settlement or delivery is pending; reconcile this purchase without another charge',503);
    }
    let receipt:Receipt.Receipt;let delivered:{mode:string;providerId:string;publicationDigest:string;commitSha:string;snapshotId:string;payment:string;delivery:string;context:ContextBundle;sourceSignatures:Readonly<Record<string,string>>;graphSignatures:PublicationArtifact['graphSignatures']};
    try {receipt=Receipt.deserialize(response.headers.get('Payment-Receipt')??'');delivered=await response.json() as typeof delivered;}
    catch {if(row.payment_state!=='settled')await markUnknown(principal,id);throw new PublicationServiceError('delivery-invalid','Provider receipt or context is invalid; reconcile without another purchase',422);}
    const settled=await reconcile(principal,id,receipt);
    try {
      required(delivered.mode==='tempo-testnet'&&delivered.payment==='settled'&&delivered.delivery==='ready'&&delivered.providerId===row.provider_id
        && delivered.publicationDigest===row.approval.publicationDigest&&delivered.commitSha===row.approval.commitSha&&delivered.snapshotId===row.approval.snapshotId,'delivery-mismatch','Delivered publication or commit differs from the paid request',422);
      const key=createPublicKey(await loadCommerceKey(env.ATLAS_PUBLICATION_SIGNING_KEY_FILE,'private',env.ATLAS_PUBLICATION_SIGNING_KEY));
      verifyDeliveredContext(delivered.context,delivered.sourceSignatures,{id:row.provider_id,publicationDigest:row.approval.publicationDigest,commitSha:row.approval.commitSha,
        snapshotId:row.approval.snapshotId,packageName:row.package_name,version:row.version},key,delivered.graphSignatures);
    }catch {await database.withAdminTransaction(tx=>tx.query("UPDATE atlas.purchases SET delivery_state='failed' WHERE id=$1 AND principal_id=$2",[id,principal]));throw new PublicationServiceError('evidence-invalid','Payment settled, but delivered evidence does not match the owner-approved source',422);}
    await database.withAdminTransaction(tx=>tx.query("UPDATE atlas.purchases SET delivery_state='ready' WHERE id=$1 AND principal_id=$2 AND payment_state='settled'",[id,principal]));
    try {await currentAuthorization(principal,sessionId,row);}
    catch {await database.withAdminTransaction(tx=>tx.query("UPDATE atlas.purchases SET delivery_state='revoked' WHERE id=$1 AND principal_id=$2",[id,principal]));throw new PublicationServiceError('delivery-revoked','Payment settled, but current source entitlement was revoked',403);}
    return {purchase:{...settled,deliveryState:'ready'},context:delivered.context,sourceSignatures:delivered.sourceSignatures,graphSignatures:delivered.graphSignatures};
  }
  return {history,setAllowance,createPurchase,claimSigning,markUnknown,bindCredential,reconcile,releaseUnsigned,resume};
}
