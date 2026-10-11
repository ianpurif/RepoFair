'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { MODERATO_PATHUSD, type CatalogProvider, type PurchaseBudget } from '@atlas/contracts';
import { ArrowUpRight, Box, CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import { objectValue, readRepositoryAccount, repositoryRequest, RepositoryRequestError, RepositorySessionBoundary, type RepositoryAccount } from './repository-browser';
import { BrowserPurchase } from './browser-purchase';
import { formatPathUsd, readPurchaseBudget, readPurchaseHistory, remainingAllowance } from './commerce-data';

export type PublishedProvider = CatalogProvider;

export function readPublishedProvider(value: unknown): PublishedProvider {
  const row = objectValue(value);
  if (typeof row.id !== 'string' || !row.id || typeof row.packageName !== 'string' || !row.packageName || typeof row.version !== 'string' || !row.version || typeof row.endpoint !== 'string' || typeof row.realm !== 'string' || !row.realm || typeof row.snapshotId !== 'string' || !row.snapshotId || typeof row.publicationDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.publicationDigest) || row.tokenDecimals !== 6 || !['private', 'authenticated', 'public'].includes(String(row.accessPolicy)) || typeof row.atomicPrice !== 'string' || !/^[1-9][0-9]{0,77}$/.test(row.atomicPrice) || String(row.token).toLowerCase() !== MODERATO_PATHUSD || !/^0x[0-9a-f]{40}$/i.test(String(row.recipient)) || row.network !== 'eip155:42431' || !/^[a-f0-9]{40}$/i.test(String(row.commitSha)) || typeof row.rightsStatement !== 'string' || !row.rightsStatement.trim()) throw new Error('The provider catalog returned invalid testnet terms.');
  const endpoint = new URL(row.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error('The provider returned an invalid endpoint.');
  return row as unknown as PublishedProvider;
}

function WorkspaceAllowance({ account, onSessionChanged,workspaceId,setWorkspaceId }: { account: RepositoryAccount; onSessionChanged: () => void;workspaceId:string;setWorkspaceId:(id:string)=>void }) {
  const [budget, setBudget] = useState<PurchaseBudget | null>(null);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowance, setAllowance] = useState('0');
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setLoaded(false); setBudget(null); setError(null); setNotice(null);
    if (!workspaceId) { setBusy(false); return () => controller.abort(); }
    repositoryRequest(`/api/purchases?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal }).then(({ data }) => {
      const result = readPurchaseHistory(data); const saved = result.budgets.find(item => item.token.toLowerCase() === MODERATO_PATHUSD) ?? null;
      if (!controller.signal.aborted) { setBudget(saved); setAllowance(saved?.allowance ?? '0'); setLoaded(true); setUncertain(false); setBusy(false); }
    }).catch(error => { if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : 'Testnet allowance unavailable.'); setBusy(false); if (error instanceof RepositoryRequestError && [401, 403].includes(error.status)) onSessionChanged(); } });
    return () => controller.abort();
  }, [workspaceId, refresh, onSessionChanged]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!workspaceId || !loaded || busy || uncertain || mutation.current) return;
    if (!/^(0|[1-9][0-9]{0,77})$/.test(allowance)) { setError('Enter a non-negative integer allowance in atomic PathUSD units.'); return; }
    const controller = new AbortController(); mutation.current = controller; setSaving(true); setError(null); setNotice(null);
    try {
      const { data } = await repositoryRequest('/api/purchases/budget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, allowance }), signal: controller.signal });
      const result = readPurchaseBudget(data.budget); if (result.allowance !== allowance) throw new Error('The saved allowance does not match the amount submitted. Refresh before changing it again.');
      if (!controller.signal.aborted) { setBudget(result); setAllowance(result.allowance); setNotice('Workspace allowance saved. No purchase or wallet transaction was approved.'); }
    } catch (error) { if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : 'Allowance could not be saved.'); setUncertain(!(error instanceof RepositoryRequestError) || error.status === 409); if (error instanceof RepositoryRequestError && [401, 403].includes(error.status)) onSessionChanged(); } }
    finally { if (!controller.signal.aborted) { mutation.current = null; setSaving(false); } }
  }
  if (account.workspaces.length === 0) return <p>No workspace is available for purchase approval.</p>;
  return <div className="provider-allowance"><label className="field-label" htmlFor="provider-purchase-workspace">Purchase workspace<select id="provider-purchase-workspace" value={workspaceId} disabled={saving} onChange={event => setWorkspaceId(event.target.value)}>{account.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{busy ? <p role="status">Loading testnet allowance…</p> : !loaded ? <p>Workspace allowance unavailable.</p> : budget ? <p>Remaining workspace allowance: <strong>{formatPathUsd(remainingAllowance(budget))}</strong>. Reserved: {formatPathUsd(budget.reserved)}.</p> : <p>No testnet spending allowance is configured for this workspace.</p>}<form className="allowance-form" onSubmit={event => void save(event)}><label className="field-label" htmlFor="provider-testnet-allowance">Total allowance in atomic PathUSD units<input id="provider-testnet-allowance" inputMode="numeric" maxLength={78} value={allowance} disabled={!loaded || busy || saving || uncertain} onChange={event => { setAllowance(event.target.value); setNotice(null); }} aria-describedby="provider-allowance-description" /></label><p id="provider-allowance-description">Your workspace policy for Moderato testnet, including spent and reserved amounts. Saving does not fund an account or approve a purchase.</p><button className="button secondary" type="submit" disabled={!loaded || busy || saving || uncertain || allowance === (budget?.allowance ?? '0')}>{saving ? 'Saving allowance…' : 'Save workspace allowance'}</button></form>{error && <p className="inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{uncertain && <p role="status">Refresh the saved allowance before making another change.</p>}<button className="text-button" disabled={busy || saving} onClick={() => setRefresh(value => value + 1)}>Refresh allowance</button></div>;
}

function PurchaseReadiness({provider}:{provider:CatalogProvider}) {
  const [workspaceId,setWorkspaceId]=useState('');
  const [account, setAccount] = useState<RepositoryAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const refreshAccount = useCallback(() => { setAccount(null); setRefresh(value => value + 1); }, []);
  useEffect(() => {
    const controller = new AbortController(); setAccount(null); setError(null); setNeedsSignIn(false);
    repositoryRequest('/api/account', { signal: controller.signal }).then(({ data }) => { const result = readRepositoryAccount(data); if (!controller.signal.aborted) {setAccount(result);setWorkspaceId(result.workspaces[0]?.id??'');} }).catch(error => { if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : 'Purchase account unavailable.'); setNeedsSignIn(error instanceof RepositoryRequestError && error.status === 401); } });
    return () => controller.abort();
  }, [refresh]);
  return <div className="provider-purchase-state">{account ? <RepositorySessionBoundary principalId={account.principalId} onSessionChanged={refreshAccount}><WorkspaceAllowance key={account.principalId} account={account} onSessionChanged={refreshAccount} workspaceId={workspaceId} setWorkspaceId={setWorkspaceId} /><BrowserPurchase provider={provider} workspaceId={workspaceId}/></RepositorySessionBoundary> : <><button className="button secondary" disabled>Purchase signing unavailable</button>{error ? needsSignIn ? <Link className="text-button" href="/sign-in">Sign in to review your workspace allowance</Link> : <p className="inline-error" role="alert">{error}<button className="text-button" onClick={refreshAccount}>Retry account request</button></p> : <p role="status">Checking purchase account…</p>}</>}<Link className="text-button" href="/app/activity">View recorded purchases <ArrowUpRight size={13} /></Link></div>;
}

export function ProviderDirectory({ providerId,packageName,version }: { providerId?: string;packageName?:string;version?:string }) {
  const [providers, setProviders] = useState<PublishedProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setProviders(null); setError(null); setNeedsSignIn(false);
    repositoryRequest('/api/catalog'+(packageName||version?'?'+new URLSearchParams({...(packageName?{packageName}:{}),...(version?{version}:{})}):''), { signal: controller.signal }).then(({ data }) => {
      if (!Array.isArray(data.providers)) throw new Error('The server did not return a provider catalog.');
      const rows = data.providers.map(readPublishedProvider);
      if (new Set(rows.map(item => item.id)).size !== rows.length) throw new Error('The provider catalog contains duplicate services.');
      if (!controller.signal.aborted) setProviders(providerId ? rows.filter(item => item.id === providerId) : rows);
    }).catch(error => { if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : 'Provider discovery failed.'); setNeedsSignIn(error instanceof RepositoryRequestError && error.status === 401); } });
    return () => controller.abort();
  }, [providerId,packageName,version,refresh]);
  return <section className="provider-directory"><div className="section-toolbar"><span className="status-tag">Tempo Moderato testnet · 42431</span><button className="button secondary" onClick={() => setRefresh(value => value + 1)} disabled={providers === null && !error}><RefreshCw size={13} />Refresh providers</button></div>
    {error ? <div className="empty-card" role="alert"><CircleAlert size={24} /><h2>{needsSignIn ? 'Sign in to discover providers' : 'Provider catalog unavailable'}</h2><p>{error}</p>{needsSignIn && <Link className="button primary" href="/sign-in">Sign in</Link>}</div> : providers === null ? <div className="empty-card" role="status"><LoaderCircle className="spin" size={24} /><h2>Loading published providers</h2></div> : providers.length === 0 ? <div className="empty-card"><Box size={24} /><h2>{providerId ? 'Provider unavailable' : 'No published providers yet'}</h2><p>{providerId ? 'No accessible service was returned for this provider.' : 'Published knowledge services will appear here with their exact version and testnet terms.'}</p><Link className="button secondary" href="/app/publish">Prepare a knowledge service</Link></div> : <div className="provider-cards">{providers.map(provider => <article key={provider.id}><div className="provider-card-title"><Box size={18} /><h2>{provider.packageName}@{provider.version}</h2><span className="status-tag">{provider.accessPolicy}</span></div><dl><div><dt>Price</dt><dd>{formatPathUsd(provider.atomicPrice)} · {provider.atomicPrice} atomic units</dd></div><div><dt>Asset</dt><dd><code>{provider.token}</code></dd></div><div><dt>Recipient</dt><dd><code>{provider.recipient}</code></dd></div><div><dt>Network</dt><dd>Tempo Moderato testnet · 42431</dd></div><div><dt>Operation</dt><dd>context.retrieve</dd></div><div><dt>Commit</dt><dd><code>{provider.commitSha}</code></dd></div><div><dt>Endpoint</dt><dd><code>{provider.endpoint}</code></dd></div></dl><details className="provider-rights"><summary>Provider rights declaration</summary><p>{provider.rightsStatement}</p></details>{providerId ? <PurchaseReadiness provider={provider}/> : <Link className="text-button" href={`/app/providers/${encodeURIComponent(provider.id)}`}>Review service and terms <ArrowUpRight size={13} /></Link>}</article>)}</div>}
  </section>;
}
