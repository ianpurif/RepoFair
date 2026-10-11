'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Activity as ActivityIcon, CircleAlert, Clock3, LoaderCircle, RefreshCw } from 'lucide-react';
import type { PurchaseBudget, PurchaseRecord } from '@atlas/contracts';
import { AuthenticatedAtlasClient, AtlasApiError, type PaidKnowledge } from '@atlas/sdk';
import { readRepositoryAccount, repositoryRequest, RepositoryRequestError, RepositorySessionBoundary, type RepositoryAccount } from './repository-browser';
import { formatPathUsd, readPurchaseHistory, remainingAllowance } from './commerce-data';
import { PaidKnowledgeView } from './browser-purchase';

function PurchaseItem({purchase,onChanged,onSessionChanged}:{purchase:PurchaseRecord;onChanged:(record:PurchaseRecord)=>void;onSessionChanged:()=>void}) {
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const [result,setResult]=useState<PaidKnowledge|null>(null);
  async function act(cancel=false){if(busy)return;setBusy(true);setError(null);
    try {const client=new AuthenticatedAtlasClient(window.location.origin,{sessionToken:async()=>null,allowLocalDevelopment:true});
      if(cancel){await client.cancelUnsigned(purchase.id);onChanged({...purchase,paymentState:'failed'});}
      else {const recovered=await client.resumePurchase(purchase.id);setResult(recovered);onChanged(recovered.purchase);}
    }catch(error){setError(error instanceof Error?error.message:'Purchase recovery is unavailable.');if(error instanceof AtlasApiError&&error.status===401)onSessionChanged();}
    finally{setBusy(false);}
  }
  return <li><ActivityIcon size={16}/><div className="activity-body"><strong>{purchase.packageName}@{purchase.version}</strong>
    <dl className="purchase-states"><div><dt>Payment</dt><dd>{purchase.paymentState}</dd></div><div><dt>Delivery</dt><dd>{purchase.deliveryState}</dd></div><div><dt>Evidence quality</dt><dd>{result?result.context.evidenceState:'Not loaded'}</dd></div></dl>
    <p>{formatPathUsd(purchase.atomicAmount)} · {purchase.atomicAmount} atomic units</p>
    {purchase.paymentState==='unknown'&&<p className="inline-error">Settlement is unresolved. Resume this record before attempting another purchase.</p>}
    {['pending','unknown','settled'].includes(purchase.paymentState)&&<button className="button secondary" disabled={busy} onClick={()=>void act()}>{busy?'Checking recorded purchase…':'Resume payment and delivery'}</button>}
    {purchase.paymentState==='reserved'&&<button className="button secondary" disabled={busy} onClick={()=>void act(true)}>Cancel unsigned reservation</button>}
    {error&&<p role="alert" className="inline-error">{error}</p>}{result&&<PaidKnowledgeView result={result}/>}
    <details><summary>Purchase terms and receipt</summary><dl className="purchase-terms"><div><dt>Provider</dt><dd>{purchase.providerId}</dd></div><div><dt>Network</dt><dd>Tempo Moderato testnet · 42431</dd></div><div><dt>Asset</dt><dd><code>{purchase.token}</code></dd></div><div><dt>Recipient</dt><dd><code>{purchase.recipient}</code></dd></div><div><dt>Receipt</dt><dd>{purchase.receiptReference?<code>{purchase.receiptReference}</code>:'No verified receipt returned'}</dd></div><div><dt>Record</dt><dd>{purchase.id}</dd></div></dl></details>
    <small><Clock3 size={12}/><time dateTime={purchase.createdAt}>{new Date(purchase.createdAt).toLocaleString()}</time></small></div></li>;
}

function WorkspacePurchases({ workspaceId, onSessionChanged }: { workspaceId: string; onSessionChanged: () => void }) {
  const [purchases, setPurchases] = useState<PurchaseRecord[] | null>(null);
  const [budgets, setBudgets] = useState<PurchaseBudget[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setPurchases(null); setBudgets([]); setError(null);
    repositoryRequest(`/api/purchases?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal }).then(({ data }) => {
      const result = readPurchaseHistory(data);
      if (!controller.signal.aborted) { setPurchases(result.purchases); setBudgets(result.budgets); }
    }).catch(error => { if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : 'Purchase history unavailable.'); if (error instanceof RepositoryRequestError && [401, 403].includes(error.status)) onSessionChanged(); } });
    return () => controller.abort();
  }, [workspaceId, refresh, onSessionChanged]);
  return <section className="activity-history">
    <div className="section-toolbar"><span className="quiet-label">Persisted purchases · Tempo testnet</span><button className="button secondary" disabled={purchases===null&&!error} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={14}/>Refresh history</button></div>
    {purchases!==null&&<section className="purchase-allowance" aria-label="Workspace testnet allowances">{budgets.length===0?<p className="quiet-label">No testnet spending allowance is configured for this workspace.</p>:budgets.map(budget=><div key={`${budget.network}:${budget.token}`}><h2>Moderato PathUSD allowance</h2><dl className="purchase-states"><div><dt>Remaining</dt><dd>{formatPathUsd(remainingAllowance(budget))}</dd></div><div><dt>Reserved</dt><dd>{formatPathUsd(budget.reserved)}</dd></div><div><dt>Spent</dt><dd>{formatPathUsd(budget.spent)}</dd></div></dl></div>)}</section>}
    {error?<div className="empty-card" role="alert"><CircleAlert size={25}/><h2>Purchase history unavailable</h2><p>{error}</p></div>:purchases===null?<div className="empty-card" role="status"><LoaderCircle className="spin" size={25}/><p>Loading your purchases…</p></div>:purchases.length===0?<div className="empty-card"><ActivityIcon size={27}/><h2>No purchases yet</h2><p>Your account has no recorded purchases in this workspace.</p><Link className="button secondary" href="/app/providers">Explore knowledge providers</Link></div>:<ol className="activity-list">{purchases.map(purchase=><PurchaseItem key={purchase.id} purchase={purchase} onSessionChanged={onSessionChanged} onChanged={record=>{setPurchases(current=>current?.map(item=>item.id===record.id?record:item)??null);}}/>)}</ol>}
  </section>;
}

export function ActivityHistory() {
  const [account, setAccount] = useState<RepositoryAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [workspaceId, setWorkspaceId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const refreshAccount = useCallback(() => { setAccount(null); setRefresh(value => value + 1); }, []);
  useEffect(() => {
    const controller = new AbortController(); setAccount(null); setError(null); setNeedsSignIn(false);
    repositoryRequest('/api/account', { signal: controller.signal }).then(({ data }) => {
      const result = readRepositoryAccount(data); if (controller.signal.aborted) return;
      setAccount(result); setWorkspaceId(current => result.workspaces.some(item => item.id === current) ? current : result.workspaces[0]?.id ?? '');
    }).catch(error => { if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : 'Workspace unavailable.'); setNeedsSignIn(error instanceof RepositoryRequestError && error.status === 401); } });
    return () => controller.abort();
  }, [refresh]);
  if (error) return <div className="unavailable-state" role="alert"><CircleAlert size={22} /><h2>{needsSignIn ? 'Sign in to view purchases' : 'Workspace unavailable'}</h2><p>{error}</p>{needsSignIn ? <Link className="button primary" href="/sign-in">Sign in</Link> : <button className="button secondary" onClick={refreshAccount}>Retry account request</button>}</div>;
  if (!account) return <div className="empty-card" role="status"><LoaderCircle className="spin" size={22} /><p>Loading your workspace…</p></div>;
  return <RepositorySessionBoundary principalId={account.principalId} onSessionChanged={refreshAccount}>{account.workspaces.length === 0 ? <div className="empty-card"><h2>No workspace available</h2><Link className="button secondary" href="/app/repositories">Open repositories</Link></div> : <><label className="field-label" htmlFor="purchases-workspace">Workspace<select id="purchases-workspace" value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}>{account.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><WorkspacePurchases key={`${account.principalId}:${workspaceId}`} workspaceId={workspaceId} onSessionChanged={refreshAccount} /></>}</RepositorySessionBoundary>;
}
