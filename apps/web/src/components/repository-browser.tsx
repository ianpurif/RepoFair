'use client';

import { useClerk, useUser } from '@clerk/nextjs';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, CircleAlert, GitBranch, LoaderCircle, RefreshCw } from 'lucide-react';

export interface RepositoryAccount {
  authenticated: true;
  principalId: string;
  workspaces: { id: string; name: string; role: string }[];
}
interface RepositoryRow { id: string; name: string; visibility: string; status: string; snapshotId?: string; revision?: string; errorCode?: string }
export const repositoryUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const objectValue = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export class RepositoryRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function repositoryRequest(url: string, options: RequestInit = {}, timeoutMs = 20_000): Promise<{ response: Response; data: Record<string, unknown> }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, { ...options, signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  const data = objectValue(await response.json().catch(() => null) as unknown);
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : typeof objectValue(data.error).message === 'string' ? String(objectValue(data.error).message) : `The request failed (${response.status}).`;
    throw new RepositoryRequestError(message, response.status);
  }
  return { response, data };
}

export function readRepositoryAccount(data: Record<string, unknown>): RepositoryAccount {
  if (data.authenticated !== true || typeof data.principalId !== 'string' || !Array.isArray(data.workspaces)) throw new Error('The server did not return an authenticated workspace list.');
  const workspaces = data.workspaces.map(item => {
    const row = objectValue(item);
    if (typeof row.id !== 'string' || !repositoryUuid.test(row.id) || typeof row.name !== 'string' || typeof row.role !== 'string') throw new Error('The workspace response is invalid.');
    return { id: row.id, name: row.name, role: row.role };
  });
  return { authenticated: true, principalId: data.principalId, workspaces };
}

/** Hide delivered private data immediately if Clerk changes the active principal. */
export function RepositorySessionBoundary({ principalId, onSessionChanged, children }: { principalId: string; onSessionChanged: () => void; children: ReactNode }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const current = isLoaded && isSignedIn && user?.id === principalId;
  useEffect(() => { if (isLoaded && !current) onSessionChanged(); }, [isLoaded, current, onSessionChanged]);
  if (!current) return <div className="panel-state" role="status"><LoaderCircle className="spin" size={22} /><h3>Checking your session</h3><p>Repository data is hidden until your account is verified.</p></div>;
  return children;
}

function GitHubConnectionButton() {
  const clerk = useClerk();
  return <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><button type="button" className="button secondary" onClick={() => clerk.openUserProfile()}><GitBranch size={15} /> GitHub account settings</button><a className="button secondary" href="https://github.com/apps/repofair/installations/new" target="_blank" rel="noopener noreferrer">Install RepoFair GitHub App <ArrowRight size={15} /></a></div>;
}

const inputStyle: CSSProperties = { display: 'block', width: '100%', minWidth: 0, padding: '10px 12px', marginTop: 6, background: 'var(--surface-alt)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 5, fontSize: 12 };
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';

function WorkspaceRepositories({ account, workspaceId, onWorkspaceChange, onAccountRefresh }: { account: RepositoryAccount; workspaceId: string; onWorkspaceChange: (id: string) => void; onAccountRefresh: () => void }) {
  const router = useRouter();
  const [repositories, setRepositories] = useState<RepositoryRow[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const mutationAbort = useRef<AbortController | null>(null);
  const selectedWorkspace = account.workspaces.find(item => item.id === workspaceId);
  const availableWorkspaceId = selectedWorkspace?.id ?? null;
  useEffect(() => () => mutationAbort.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    setRepositories(null); setCatalogError(null);
    if (!availableWorkspaceId) return () => controller.abort();
    repositoryRequest(`/api/repositories?workspaceId=${encodeURIComponent(availableWorkspaceId)}`, { signal: controller.signal }).then(({ data }) => {
      if (!Array.isArray(data.repositories)) throw new Error('The server did not return a repository catalog.');
      const rows = data.repositories.map(item => {
        const row = objectValue(item);
        if (typeof row.id !== 'string' || !repositoryUuid.test(row.id) || typeof row.name !== 'string' || typeof row.visibility !== 'string' || typeof row.status !== 'string') throw new Error('The repository catalog is invalid.');
        const revision = typeof row.revision === 'string' ? row.revision : typeof row.commitSha === 'string' ? row.commitSha : undefined;
        return { id: row.id, name: row.name, visibility: row.visibility, status: row.status, ...(typeof row.snapshotId === 'string' ? { snapshotId: row.snapshotId } : {}), ...(revision ? { revision } : {}), ...(typeof row.errorCode === 'string' ? { errorCode: row.errorCode } : {}) };
      });
      if (!controller.signal.aborted) setRepositories(rows);
    }).catch(error => { if (!controller.signal.aborted) setCatalogError(messageOf(error)); });
    return () => controller.abort();
  }, [availableWorkspaceId, refresh]);

  async function createWorkspace() {
    if (mutationAbort.current) return;
    const controller = new AbortController(); mutationAbort.current = controller;
    setSetupBusy(true); setSetupError(null);
    try {
      const { data } = await repositoryRequest('/api/account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal });
      if (controller.signal.aborted) return;
      if (typeof data.workspaceId !== 'string' || !repositoryUuid.test(data.workspaceId)) throw new Error('Workspace setup returned an invalid identifier.');
      onWorkspaceChange(data.workspaceId); onAccountRefresh();
    } catch (error) { if (!controller.signal.aborted) setSetupError(messageOf(error)); }
    finally { if (!controller.signal.aborted) { mutationAbort.current = null; setSetupBusy(false); } }
  }

  async function importRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!availableWorkspaceId || importBusy || mutationAbort.current) return;
    setImportError(null);
    let repositoryUrl: URL;
    try {
      repositoryUrl = new URL(url.trim());
      if (repositoryUrl.protocol !== 'https:' || repositoryUrl.hostname !== 'github.com' || repositoryUrl.port || repositoryUrl.username || repositoryUrl.password || repositoryUrl.search || repositoryUrl.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(repositoryUrl.pathname)) throw new Error('Use the repository URL https://github.com/owner/repository.');
    } catch (error) { setImportError(messageOf(error)); return; }
    const controller = new AbortController(); mutationAbort.current = controller;
    setImportBusy(true);
    try {
      const { data } = await repositoryRequest('/api/repositories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: availableWorkspaceId, url: repositoryUrl.toString(), ...(ref.trim() ? { ref: ref.trim() } : {}) }), signal: controller.signal });
      if (controller.signal.aborted) return;
      if (typeof data.repositoryId !== 'string' || !repositoryUuid.test(data.repositoryId) || typeof data.status !== 'string') throw new Error('The import request returned an invalid job response.');
      router.push(`/app/repositories/${encodeURIComponent(data.repositoryId)}`);
    } catch (error) { if (!controller.signal.aborted) setImportError(messageOf(error)); }
    finally { if (!controller.signal.aborted) { mutationAbort.current = null; setImportBusy(false); } }
  }

  return <>
    <section className="settings-card" aria-label="Repository account connection"><div><h2>GitHub connection</h2><p>Connect your GitHub account in Clerk, and grant the RepoFair GitHub App access to the repositories you choose. Import permission is verified by the server.</p></div><GitHubConnectionButton /></section>
    <section style={{ marginTop: 24 }} aria-label="Workspace selection">
      {account.workspaces.length === 0 ? <div className="empty-card"><GitBranch size={24} /><h2>No workspace yet</h2><p>Create your personal workspace before importing a repository.</p><button className="button primary" onClick={() => void createWorkspace()} disabled={setupBusy}>{setupBusy && <LoaderCircle className="spin" size={15} />}Create personal workspace</button>{setupError && <p className="inline-error" role="alert">{setupError}</p>}</div> : <><label className="quiet-label" htmlFor="repository-workspace">Workspace</label><select id="repository-workspace" value={workspaceId} onChange={event => onWorkspaceChange(event.target.value)} style={inputStyle}>{account.workspaces.map(item => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></>}
    </section>
    {selectedWorkspace && <>
      <form className="settings-card" onSubmit={event => void importRepository(event)} style={{ display: 'grid', gap: 16, marginTop: 24 }} aria-label="Import GitHub repository"><div><h2>Import a repository</h2><p>RepoFair reads supported source files at an immutable Git commit. Imported code and repository scripts are not executed.</p></div><label className="quiet-label" htmlFor="github-repository-url">GitHub repository URL<input id="github-repository-url" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repository" maxLength={500} required disabled={importBusy} style={inputStyle} /></label><label className="quiet-label" htmlFor="github-repository-ref">Branch, tag, or commit (optional)<input id="github-repository-ref" value={ref} onChange={event => setRef(event.target.value)} maxLength={200} disabled={importBusy} style={inputStyle} /></label><div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}><button className="button primary" type="submit" disabled={importBusy || !url.trim()}>{importBusy ? <LoaderCircle size={15} className="spin" /> : <GitBranch size={15} />}{importBusy ? 'Submitting import request…' : 'Import repository'}</button><span className="quiet-label">Source access follows this workspace’s permissions.</span></div>{importError && <p className="inline-error" role="alert">{importError}</p>}</form>
      <section style={{ marginTop: 32 }} aria-label="Authorized repository catalog"><div className="section-toolbar"><h2 style={{ fontSize: 14 }}>Your repositories</h2><button className="button secondary" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13} />Refresh</button></div>{catalogError ? <div className="unavailable-state" role="alert"><CircleAlert size={20} /><h2>Repository catalog unavailable</h2><p>{catalogError}</p><button className="button secondary" onClick={() => setRefresh(value => value + 1)}>Retry catalog request</button></div> : repositories === null ? <div className="empty-card" role="status"><LoaderCircle className="spin" size={22} /><p>Loading repositories you can access…</p></div> : repositories.length === 0 ? <div className="empty-card"><GitBranch size={24} /><h2>No repositories imported</h2><p>Import an authorized GitHub repository to map its source.</p></div> : <ul className="activity-list">{repositories.map(repository => <li key={repository.id}><GitBranch size={17} /><div className="activity-body"><div style={{ flexWrap: 'wrap' }}><strong>{repository.name}</strong><span className="status-tag">{repository.visibility}</span><span className="status-tag">{repository.status}</span></div>{repository.revision && <p>Commit <code>{repository.revision}</code></p>}{repository.snapshotId && <small>Snapshot {repository.snapshotId}</small>}</div><Link className="button secondary" href={`/app/repositories/${encodeURIComponent(repository.id)}`}>Open <ArrowRight size={13} /></Link></li>)}</ul>}</section>
    </>}
  </>;
}

export function RepositoryBrowser() {
  const [account, setAccount] = useState<RepositoryAccount | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [workspaceId, setWorkspaceId] = useState('');
  const refreshAccount = useCallback(() => setRefresh(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setAccount(null); setAccountError(null); setNeedsSignIn(false);
    repositoryRequest('/api/account', { signal: controller.signal }).then(({ data }) => {
      const result = readRepositoryAccount(data);
      if (controller.signal.aborted) return;
      setAccount(result);
      setWorkspaceId(current => result.workspaces.some(item => item.id === current) ? current : result.workspaces[0]?.id ?? '');
    }).catch(error => { if (!controller.signal.aborted) { setAccountError(messageOf(error)); setNeedsSignIn(error instanceof RepositoryRequestError && error.status === 401); } });
    return () => controller.abort();
  }, [refresh]);

  return <main id="main" className="content-page"><header className="page-header"><div><h1>Your repositories</h1><p>Import source, explore its map, and open evidence at the exact commit.</p></div></header>{accountError ? <div className="unavailable-state" role="alert"><CircleAlert size={22} /><h2>{needsSignIn ? 'Sign in to your workspace' : 'Workspace unavailable'}</h2><p>{accountError}</p>{needsSignIn ? <Link className="button primary" href="/sign-in">Sign in</Link> : <button className="button secondary" onClick={refreshAccount}>Retry account request</button>}</div> : account ? <RepositorySessionBoundary principalId={account.principalId} onSessionChanged={refreshAccount}><WorkspaceRepositories key={`${account.principalId}:${workspaceId}`} account={account} workspaceId={workspaceId} onWorkspaceChange={setWorkspaceId} onAccountRefresh={refreshAccount} /></RepositorySessionBoundary> : <div className="empty-card" role="status"><LoaderCircle className="spin" size={22} /><p>Loading your workspace…</p></div>}</main>;
}
