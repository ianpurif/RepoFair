import { BodyDigest,Challenge } from 'mppx';
import { Mppx,tempo } from 'mppx/client';
import { getChainId } from 'viem/actions';
import type { CatalogProvider,ContextBundle,ImportJob,LocalAnswer,PublicationArtifact,PurchaseBudget,PurchaseRecord,RepositoryGraphPage,SourceEvidence } from '../../contracts/src/index.ts';
import { MODERATO_NETWORK,MODERATO_PATHUSD } from '../../contracts/src/commerce.ts';
import { assertApprovedChallenge,createApprovedCredential } from './payment-policy.ts';
import type { ApprovedTestnetPurchase } from './payment-policy.ts';

export type PurchaseReservation=Readonly<{purchase:PurchaseRecord;approval:ApprovedTestnetPurchase&Readonly<{publicationDigest:string;commitSha:string;snapshotId:string;challenge:Challenge.Challenge}>;requestBody:string;endpoint:string}>;
export type PaidKnowledge=Readonly<{purchase:PurchaseRecord;context:ContextBundle;sourceSignatures:Readonly<Record<string,string>>;graphSignatures:PublicationArtifact['graphSignatures']}>;
type ChargeParameters=NonNullable<Parameters<typeof tempo.charge>[0]>;
export type ModeratoSigner=Readonly<{account:NonNullable<ChargeParameters['account']>;getClient:NonNullable<ChargeParameters['getClient']>}>;
export class AtlasApiError extends Error {
  readonly status:number;readonly code:string;
  constructor(status:number,code:string){super(`Atlas operation failed (${status}, ${code})`);this.status=status;this.code=code;}
}
function id(value:string):string {if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))throw new Error('Invalid Atlas identifier');return encodeURIComponent(value);}
async function json(response:Response):Promise<Record<string,unknown>> {
  const reader=response.body?.getReader();if(!reader)throw new Error('Empty Atlas response');const parts:Uint8Array[]=[];let size=0;
  try {for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>4_000_000){await reader.cancel();throw new Error('Atlas response exceeds bounds');}parts.push(next.value);}}
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid RepoFair response');return value as Record<string,unknown>;
}
/** Authenticated repository and purchase API. The session credential is sent only to this exact Atlas origin. */
export class AuthenticatedAtlasClient {
  readonly #origin:URL;readonly #token:()=>Promise<string|null>;readonly #fetch:typeof fetch;
  constructor(origin:string,options:{sessionToken:()=>Promise<string|null>;allowLocalDevelopment?:boolean;fetch?:typeof fetch}) {
    const url=new URL(origin);const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if(url.origin!==origin||url.username||url.password||url.search||url.hash||(url.protocol!=='https:'&&!(options.allowLocalDevelopment&&local&&url.protocol==='http:')))throw new Error('Use an exact Atlas HTTPS origin or explicit loopback development origin');
    this.#origin=url;this.#token=options.sessionToken;this.#fetch=(options.fetch??globalThis.fetch).bind(globalThis);
  }
  async #request<T>(path:string,input?:unknown):Promise<T> {
    if(!path.startsWith('/api/')||path.startsWith('//'))throw new Error('Invalid Atlas route');const token=await this.#token();
    if(token!==null&&(typeof token!=='string'||!token||token.length>16_384||/[\r\n]/.test(token)))throw new Error('Invalid session credential');
    const body=input===undefined?undefined:JSON.stringify(input);if(body&&new TextEncoder().encode(body).length>65_536)throw new Error('Atlas request exceeds bounds');
    const response=await this.#fetch(new URL(path,this.#origin),{method:body?'POST':'GET',redirect:'error',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(30_000),
      headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body?{'Content-Type':'application/json',Origin:this.#origin.origin}:{})},...(body?{body}:{})});
    const data=await json(response);if(!response.ok)throw new AtlasApiError(response.status,typeof data.code==='string'&&/^[a-z0-9-]{1,100}$/.test(data.code)?data.code:'unavailable');return data as T;
  }
  account(){return this.#request<{authenticated:true;principalId:string;workspaces:readonly {id:string;name:string;role:string}[]}>('/api/account');}
  createPersonalWorkspace(){return this.#request<{workspaceId:string}>('/api/account',{});}
  repositories(workspaceId:string){return this.#request<{repositories:readonly unknown[]}>(`/api/repositories?workspaceId=${id(workspaceId)}`);}
  importRepository(workspaceId:string,url:string,ref?:string){return this.#request<{repositoryId:string;snapshotId:string;jobId:string;commitSha:string}>('/api/repositories',{workspaceId,url,...(ref?{ref}:{})});}
  job(repositoryId:string){return this.#request<{job:ImportJob|null}>(`/api/repositories/${id(repositoryId)}/jobs`);}
  controlImport(repositoryId:string,jobId:string,action:'cancel'|'retry'){return this.#request<{job:ImportJob}>(`/api/repositories/${id(repositoryId)}/jobs`,{jobId,action});}
  map(repositoryId:string,snapshotId:string,options:{cursor?:number;folder?:string;query?:string;nodeId?:string}={}) {
    const query=new URLSearchParams({snapshotId});for(const [key,value]of Object.entries(options))if(value!==undefined)query.set(key,String(value));
    return this.#request<{index:RepositoryGraphPage}>(`/api/repositories/${id(repositoryId)}/map?${query}`);
  }
  source(repositoryId:string,snapshotId:string,path:string,startLine=1,endLine?:number){return this.#request<{evidence:SourceEvidence}>(`/api/repositories/${id(repositoryId)}/source?${new URLSearchParams({snapshotId,path,startLine:String(startLine),...(endLine===undefined?{}:{endLine:String(endLine)})})}`);}
  question(repositoryId:string,snapshotId:string,question:string){return this.#request<{answer:LocalAnswer}>(`/api/repositories/${id(repositoryId)}/questions`,{snapshotId,question});}
  resolveDependency(repositoryId:string,snapshotId:string,nodeId:string){return this.#request<{snapshot:RepositoryGraphPage['snapshot'];dependency:RepositoryGraphPage['dependencies'][number];providers:CatalogProvider[]}>(`/api/repositories/${id(repositoryId)}/dependencies`,{snapshotId,nodeId});}
  catalog(packageName?:string,version?:string){const query=new URLSearchParams();if(packageName)query.set('packageName',packageName);if(version)query.set('version',version);return this.#request<{providers:CatalogProvider[]}>(`/api/catalog?${query}`);}
  purchaseHistory(workspaceId:string){return this.#request<{purchases:PurchaseRecord[];budgets:PurchaseBudget[]}>(`/api/purchases?workspaceId=${id(workspaceId)}`);}
  setAllowance(workspaceId:string,allowance:string){return this.#request<{budget:PurchaseBudget}>('/api/purchases/budget',{workspaceId,allowance});}
  approvePurchase(input:{workspaceId:string;providerId:string;question:string;idempotencyKey:string;approvedAtomicAmount:string}){return this.#request<PurchaseReservation>('/api/purchases',input);}
  cancelUnsigned(purchaseId:string){return this.#request(`/api/purchases/${id(purchaseId)}/cancel`,{});}
  /** Reconcile/retrieve an already submitted purchase; this never supplies another credential. */
  resumePurchase(purchaseId:string){return this.#request<PaidKnowledge>(`/api/purchases/${id(purchaseId)}/resume`,{});}
  /** Caller owns the signer. Server reserves/claims policy before signing; uncertain outcomes cannot be retried. */
  async pay(reservation:PurchaseReservation,signer:ModeratoSigner):Promise<PaidKnowledge> {
    const approval=reservation.approval;
    if(approval.terms.network!==MODERATO_NETWORK||approval.terms.token.toLowerCase()!==MODERATO_PATHUSD||reservation.purchase.paymentState!=='reserved'
      ||reservation.purchase.providerId!==approval.terms.providerId||reservation.purchase.atomicAmount!==approval.terms.atomicAmount)throw new Error('A reserved, explicitly approved Moderato PathUSD purchase is required');
    const digest=BodyDigest.compute(reservation.requestBody);assertApprovedChallenge(approval.challenge,approval,digest,Date.now(),reservation.endpoint);
    const getClient:ModeratoSigner['getClient']=async parameters=>{if(parameters.chainId!==42431)throw new Error('Only Moderato is permitted');const client=await signer.getClient(parameters);
      if(client.chain?.id!==42431||await getChainId(client)!==42431)throw new Error('Remote signer RPC is not Moderato');return client;};
    const payment=Mppx.create({polyfill:false,methods:[tempo.charge({account:signer.account,getClient,mode:'pull',autoSwap:false,expectedChainId:42431,allowedChainIds:[42431],expectedRecipients:[approval.terms.recipient as `0x${string}`]})]});
    const prepared=await payment.preparePayment(new Response(null,{status:402,headers:{'WWW-Authenticate':Challenge.serialize(approval.challenge)}}),{request:{method:'POST',body:reservation.requestBody}});
    const markUnknown=()=>this.#request(`/api/purchases/${id(reservation.purchase.id)}/unknown`,{}).then(()=>{});
    const credential=await createApprovedCredential({...prepared,providerUrl:reservation.endpoint},approval,digest,{now:Date.now,
      claimSigning:async()=> (await this.#request<{state:'claimed'|'pending'|'unknown'|'settled'|'failed'}>(`/api/purchases/${id(reservation.purchase.id)}/claim-signing`,{})).state,markUnknown});
    try {
      await this.#request(`/api/purchases/${id(reservation.purchase.id)}/credential`,{credential});
      return await this.#request<PaidKnowledge>(`/api/purchases/${id(reservation.purchase.id)}/resume`,{credential});
    }catch(error){try{await markUnknown();}catch{/* Durable pending claim remains reserved. */}throw error;}
  }
}
