'use client';
import { useRef,useState } from 'react';
import { createWalletClient,custom,type EIP1193Provider,type Address } from 'viem';
import { tempoModerato } from 'viem/tempo/chains';
import { AuthenticatedAtlasClient,type PaidKnowledge } from '@atlas/sdk';
import type { CatalogProvider,GraphNode } from '@atlas/contracts';
import { GraphCanvas,expansionKey,nodePath } from './graph-canvas';
import { formatPathUsd } from './commerce-data';

export function PaidKnowledgeView({result}:{result:PaidKnowledge}) {
  const [selected,setSelected]=useState<GraphNode|null>(null);const [evidenceId,setEvidenceId]=useState<string|null>(null);const context=result.context;
  const evidence=context.evidence.find(item=>item.id===evidenceId)??context.evidence.find(item=>item.source.path===(selected&&nodePath(selected)))??context.evidence[0];
  return <section className="paid-knowledge"><p role="status">Payment {result.purchase.paymentState} · delivery {result.purchase.deliveryState} · owner-approved evidence</p>
    {context.evidenceState==='insufficient'&&<p>No supported source passage matches this question. The settled payment is recorded independently.</p>}
    <div style={{height:360}}><GraphCanvas index={context} expandedPaths={new Set(context.nodes.map(expansionKey))} selectedId={selected?.id??null} highlightedEdges={[]} onSelect={node=>{setSelected(node);setEvidenceId(null);}} onEdgeSelect={edge=>setEvidenceId(edge.evidenceId)} providerOrigins={Object.fromEntries(context.nodes.map(node=>[node.snapshotId,context.providerId]))}/></div>
    {evidence&&<div><p><code>{evidence.source.path}:{evidence.source.startLine}–{evidence.source.endLine}</code> · commit <code>{evidence.source.revision}</code></p><pre>{evidence.original}</pre></div>}
    <p>A paid result is not a correctness guarantee. Static relationships describe potential impact.</p>
  </section>;
}
export function BrowserPurchase({provider,workspaceId}:{provider:CatalogProvider;workspaceId:string}) {
  const [wallet,setWallet]=useState<Address|null>(null);const [question,setQuestion]=useState('');const [approved,setApproved]=useState(false);const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);const [purchaseId,setPurchaseId]=useState<string|null>(null);const [result,setResult]=useState<PaidKnowledge|null>(null);const inFlight=useRef(false);
  const ethereum=typeof window==='undefined'?undefined:(window as Window&{ethereum?:EIP1193Provider}).ethereum;
  function api(){return new AuthenticatedAtlasClient(window.location.origin,{sessionToken:async()=>null,allowLocalDevelopment:true});}
  async function connect(){if(!ethereum||inFlight.current)return;setError(null);setBusy(true);inFlight.current=true;
    try {if(await ethereum.request({method:'eth_chainId'})!=='0xa5bf')throw new Error('Select Tempo Moderato (42431) in your wallet before connecting.');
      const accounts=await ethereum.request({method:'eth_requestAccounts'});const address=accounts[0];if(!address)throw new Error('No wallet account was returned.');setWallet(address);}
    catch(error){setError(error instanceof Error?error.message:'Wallet connection unavailable.');}finally{inFlight.current=false;setBusy(false);}}
  async function buy(){if(!wallet||!ethereum||!approved||!question.trim()||!workspaceId||inFlight.current||purchaseId)return;inFlight.current=true;setBusy(true);setError(null);
    try {
      if(await ethereum.request({method:'eth_chainId'})!=='0xa5bf')throw new Error('Only Tempo Moderato is permitted.');
      const client=api();const reserved=await client.approvePurchase({workspaceId,providerId:provider.id,question,idempotencyKey:crypto.randomUUID().replaceAll('-',''),approvedAtomicAmount:provider.atomicPrice});setPurchaseId(reserved.purchase.id);
      const signer=createWalletClient({account:wallet,chain:tempoModerato,transport:custom(ethereum,{retryCount:0})});
      setResult(await client.pay(reserved,{account:wallet,getClient:()=>signer}));
    }catch(error){setError(error instanceof Error?error.message:'Purchase outcome is unavailable. Resume the recorded purchase without signing again.');}finally{inFlight.current=false;setBusy(false);}}
  async function resume(){if(!purchaseId||inFlight.current)return;inFlight.current=true;setBusy(true);setError(null);
    try{setResult(await api().resumePurchase(purchaseId));}catch(error){setError(error instanceof Error?error.message:'Settlement or delivery remains unresolved.');}finally{inFlight.current=false;setBusy(false);}}
  return <div>{!ethereum?<><p>A wallet that supports Tempo pull transaction signing is required. Agents can supply their own signer through the authenticated SDK.</p><button className="button secondary" disabled>Purchase signing unavailable</button></>:!wallet?<button className="button secondary" disabled={busy||!workspaceId} onClick={()=>void connect()}>Connect Tempo wallet</button>:<><p>Wallet <code>{wallet}</code> · Moderato testnet</p><label className="field-label">Question<textarea maxLength={2000} value={question} disabled={busy||!!purchaseId} onChange={event=>{setQuestion(event.target.value);setApproved(false);}}/></label><label><input type="checkbox" checked={approved} disabled={busy||!!purchaseId} onChange={event=>setApproved(event.target.checked)}/> I approve {formatPathUsd(provider.atomicPrice)} for this exact service, version and question.</label><button className="button primary" disabled={busy||!approved||!question.trim()||!!purchaseId} onClick={()=>void buy()}>{busy?'Processing…':'Approve and sign testnet purchase'}</button></>}
    {error&&<p className="inline-error" role="alert">{error}</p>}{purchaseId&&!result&&<><p>Recorded purchase <code>{purchaseId}</code>. Do not sign another payment while its outcome is unresolved.</p><button className="button secondary" disabled={busy} onClick={()=>void resume()}>Resume recorded purchase</button></>}{result&&<PaidKnowledgeView result={result}/>}</div>;
}
