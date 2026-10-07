'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { PublicationAccessPolicy, PublicationDraft, PublicationProposal } from '@atlas/contracts';
import { CircleAlert, FileCode2, GitBranch, LoaderCircle, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { objectValue, readRepositoryAccount, repositoryRequest, RepositoryRequestError, RepositorySessionBoundary, repositoryUuid, type RepositoryAccount } from './repository-browser';

const inputStyle: CSSProperties = { display: 'block', width: '100%', minWidth: 0, padding: '10px 12px', marginTop: 6, background: 'var(--surface-alt)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 5, fontSize: 12 };
const cardStyle: CSSProperties = { display: 'grid', gap: 16, minWidth: 0, marginTop: 24 };
const flowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' };
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Response validation preserves the delivered boundary; authority remains on the server. */
function readDraft(value: unknown, workspaceId: string): PublicationDraft {
  const row = objectValue(value); const proposal = objectValue(row.proposal); const preview = objectValue(row.preview);
  const administration = objectValue(row.administration); const exports = objectValue(proposal.exports);
  const terms = proposal.testnetTerms === null ? null : objectValue(proposal.testnetTerms);
  if (row.schemaVersion !== 1 || typeof row.id !== 'string' || !repositoryUuid.test(row.id) || row.workspaceId !== workspaceId || typeof row.repositoryId !== 'string' || !repositoryUuid.test(row.repositoryId) || typeof row.snapshotId !== 'string' || typeof row.commitSha !== 'string' || !/^[a-f0-9]{40}$/i.test(row.commitSha) || !integer(row.revision) || row.revision < 1 || typeof row.termsDigest !== 'string' || !['draft', 'revoked'].includes(String(row.state)) || row.published !== false || row.approval !== null || row.endpointProof !== 'unverified' || row.payment !== 'disabled' || row.accuracy !== 'unverified' || administration.status !== 'verified' || !['personal-owner', 'repository-admin'].includes(String(administration.basis)) || typeof administration.checkedAt !== 'string' || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') throw new Error('The server returned an invalid private draft.');
  if (typeof proposal.packageName !== 'string' || typeof proposal.version !== 'string' || !stringList(proposal.exposedPaths) || new Set(proposal.exposedPaths).size !== proposal.exposedPaths.length || typeof proposal.rightsStatement !== 'string' || row.rights !== (proposal.rightsStatement.trim() ? 'declared' : 'not-declared') || !['private', 'authenticated', 'public'].includes(String(proposal.accessPolicy)) || (proposal.proposedEndpoint !== null && typeof proposal.proposedEndpoint !== 'string') || proposal.exports === null || typeof proposal.exports !== 'object' || Array.isArray(proposal.exports)) throw new Error('The draft proposal is invalid.');
  const exposedPaths = proposal.exposedPaths;
  if (Object.values(exports).some(path => typeof path !== 'string' || !exposedPaths.includes(path))) throw new Error('An export is not bound to an explicitly selected path.');
  if (terms !== null && (terms.network !== 'eip155:42431' || terms.operation !== 'context.retrieve' || typeof terms.token !== 'string' || typeof terms.recipient !== 'string' || typeof terms.atomicPrice !== 'string' || !/^[1-9][0-9]*$/.test(terms.atomicPrice))) throw new Error('The proposed testnet terms are invalid.');
  if (preview.snapshotId !== row.snapshotId || preview.commitSha !== row.commitSha || !Array.isArray(preview.files) || !integer(preview.fileCount) || preview.fileCount !== preview.files.length || !integer(preview.totalBytes)) throw new Error('The exposure preview does not match this snapshot.');
  const paths = new Set<string>(); let totalBytes = 0;
  for (const value of preview.files) {
    const file = objectValue(value);
    if (typeof file.path !== 'string' || paths.has(file.path) || !exposedPaths.includes(file.path) || !integer(file.lines) || file.lines < 1 || !integer(file.bytes) || typeof file.sourceDigest !== 'string') throw new Error('The server returned an invalid exposure preview.');
    paths.add(file.path); totalBytes += file.bytes;
  }
  if (paths.size !== exposedPaths.length || totalBytes !== preview.totalBytes) throw new Error('The preview does not include exactly the selected source paths.');
  return row as unknown as PublicationDraft;
}

interface PathChoice { path: string; lines: number }
interface RepositoryChoice { id: string; name: string; status: string }
interface ExportInput { key: number; name: string; path: string }

function DraftDetails({ draft, account, onUpdated, onSessionChanged, onDirtyChange, onBusyChange }: { draft: PublicationDraft; account: RepositoryAccount; onUpdated: (draft: PublicationDraft) => void; onSessionChanged: () => void; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void }) {
  const [paths, setPaths] = useState<PathChoice[] | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceRefresh, setSourceRefresh] = useState(0);
  const [rights, setRights] = useState(draft.proposal.rightsStatement);
  const [selectedPaths, setSelectedPaths] = useState<readonly string[]>(draft.proposal.exposedPaths);
  const [exports, setExports] = useState<ExportInput[]>(Object.entries(draft.proposal.exports).map(([name, path], key) => ({ key, name, path })));
  const [accessPolicy, setAccessPolicy] = useState<PublicationAccessPolicy>(draft.proposal.accessPolicy);
  const [endpoint, setEndpoint] = useState(draft.proposal.proposedEndpoint ?? '');
  const [termsEnabled, setTermsEnabled] = useState(draft.proposal.testnetTerms !== null);
  const [token, setToken] = useState(draft.proposal.testnetTerms?.token ?? '');
  const [recipient, setRecipient] = useState(draft.proposal.testnetTerms?.recipient ?? '');
  const [atomicPrice, setAtomicPrice] = useState(draft.proposal.testnetTerms?.atomicPrice ?? '');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<'save' | 'reload' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const mutation = useRef<AbortController | null>(null);
  const exportKey = useRef(Object.keys(draft.proposal.exports).length);
  const revokeTrigger = useRef<HTMLButtonElement>(null);
  const revokeCancel = useRef<HTMLButtonElement>(null);
  const revoked = draft.state === 'revoked';

  useEffect(() => {
    setRights(draft.proposal.rightsStatement); setSelectedPaths(draft.proposal.exposedPaths);
    setExports(Object.entries(draft.proposal.exports).map(([name, path], key) => ({ key, name, path }))); exportKey.current = Object.keys(draft.proposal.exports).length;
    setAccessPolicy(draft.proposal.accessPolicy); setEndpoint(draft.proposal.proposedEndpoint ?? '');
    setTermsEnabled(draft.proposal.testnetTerms !== null); setToken(draft.proposal.testnetTerms?.token ?? ''); setRecipient(draft.proposal.testnetTerms?.recipient ?? ''); setAtomicPrice(draft.proposal.testnetTerms?.atomicPrice ?? '');
    setConfirmRevoke(false); setUncertain(false);
  }, [draft]);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => { onBusyChange(busy !== null); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => { if (confirmRevoke) revokeCancel.current?.focus(); }, [confirmRevoke]);
  useEffect(() => {
    const controller = new AbortController(); setPaths(null); setSourceError(null);
    repositoryRequest(`/api/repositories/${encodeURIComponent(draft.repositoryId)}`, { signal: controller.signal }).then(({ response, data }) => {
      if (response.status === 202) throw new Error('The repository snapshot is still being indexed. Reload source paths after indexing completes.');
      const index = objectValue(data.index); const snapshot = objectValue(index.snapshot); const scope = objectValue(index.scope);
      if (index.mode !== 'git' || snapshot.repositoryId !== draft.repositoryId || snapshot.snapshotId !== draft.snapshotId || snapshot.revision !== draft.commitSha || scope.tenantId !== draft.workspaceId || scope.principalId !== account.principalId || !Array.isArray(index.files)) throw new Error('The source choices do not belong to this authorized draft snapshot.');
      const seen = new Set<string>();
      const choices = index.files.map(value => { const file = objectValue(value); if (typeof file.path !== 'string' || seen.has(file.path) || !integer(file.lineCount) || file.lineCount < 1) throw new Error('The source path list is invalid.'); seen.add(file.path); return { path: file.path, lines: file.lineCount }; }).sort((a, b) => a.path.localeCompare(b.path));
      if (!controller.signal.aborted) setPaths(choices);
    }).catch(error => { if (!controller.signal.aborted) { setSourceError(messageOf(error)); if (error instanceof RepositoryRequestError && [401, 403].includes(error.status)) onSessionChanged(); } });
    return () => controller.abort();
  }, [draft.repositoryId, draft.snapshotId, draft.commitSha, draft.workspaceId, account.principalId, sourceRefresh, onSessionChanged]);

  const dirty = rights !== draft.proposal.rightsStatement || JSON.stringify([...selectedPaths].sort()) !== JSON.stringify([...draft.proposal.exposedPaths].sort()) || JSON.stringify(exports.map(item => [item.name, item.path]).sort()) !== JSON.stringify(Object.entries(draft.proposal.exports).sort()) || accessPolicy !== draft.proposal.accessPolicy || endpoint !== (draft.proposal.proposedEndpoint ?? '') || termsEnabled !== (draft.proposal.testnetTerms !== null) || (termsEnabled && (token !== draft.proposal.testnetTerms?.token || recipient !== draft.proposal.testnetTerms?.recipient || atomicPrice !== draft.proposal.testnetTerms?.atomicPrice));
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const visiblePaths = useMemo(() => paths?.filter(file => file.path.toLowerCase().includes(filter.toLowerCase())) ?? [], [paths, filter]);
  function selectPath(path: string, checked: boolean) { setSelectedPaths(current => checked ? [...current, path] : current.filter(item => item !== path)); if (!checked) setExports(current => current.filter(item => item.path !== path)); setNotice(null); }
  function proposal(): PublicationProposal {
    if (!paths || selectedPaths.some(path => !paths.some(file => file.path === path))) throw new Error('Wait for the authorized path list before saving.');
    const mappings: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const item of exports) { const name = item.name.trim(); if (!name || Object.hasOwn(mappings, name) || !selectedPaths.includes(item.path)) throw new Error('Every export needs a unique package export name and an explicitly selected source path.'); mappings[name] = item.path; }
    if (endpoint.trim()) { const url = new URL(endpoint.trim()); if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('The proposed endpoint must use HTTPS without credentials or a fragment.'); }
    if (termsEnabled && (!/^0x[0-9a-f]{40}$/i.test(token) || !/^0x[0-9a-f]{40}$/i.test(recipient) || !/^[1-9][0-9]*$/.test(atomicPrice))) throw new Error('Testnet terms need token and recipient addresses plus a positive integer price in atomic units.');
    return { packageName: draft.proposal.packageName, version: draft.proposal.version, rightsStatement: rights, exports: mappings, exposedPaths: [...selectedPaths].sort(), accessPolicy, proposedEndpoint: endpoint.trim() || null, testnetTerms: termsEnabled ? { network: 'eip155:42431', operation: 'context.retrieve', token, recipient, atomicPrice } : null };
  }
  async function request(action: 'save' | 'reload' | 'revoke', event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault(); if (mutation.current || (action !== 'reload' && (revoked || uncertain))) return;
    if (action === 'reload' && dirty && !window.confirm('Discard unsaved changes and reload the saved draft?')) return;
    let body: string | undefined;
    try { body = action === 'save' ? JSON.stringify({ expectedRevision: draft.revision, proposal: proposal() }) : action === 'revoke' ? JSON.stringify({ expectedRevision: draft.revision }) : undefined; }
    catch (error) { setError(messageOf(error)); return; }
    const controller = new AbortController(); mutation.current = controller; setBusy(action); setError(null); setNotice(null);
    try {
      const { data } = await repositoryRequest(`/api/publications/${encodeURIComponent(draft.id)}`, { method: action === 'reload' ? 'GET' : action === 'save' ? 'PATCH' : 'DELETE', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }), signal: controller.signal });
      const result = readDraft(data.draft, draft.workspaceId);
      if (result.id !== draft.id || result.repositoryId !== draft.repositoryId || result.snapshotId !== draft.snapshotId || result.commitSha !== draft.commitSha) throw new Error('The response belongs to another draft.');
      if (controller.signal.aborted) return;
      onUpdated(result); setNotice(action === 'save' ? 'Draft saved. The preview reflects this saved revision.' : action === 'revoke' ? 'Draft revoked. Publication remains unavailable.' : 'Saved draft reloaded.');
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof RepositoryRequestError && [401, 403].includes(error.status)) { onSessionChanged(); return; }
      if (!(error instanceof RepositoryRequestError) && action !== 'reload') { setUncertain(true); setError('The result of the draft change is uncertain. Reload the saved draft before trying another change.'); }
      else { if (error instanceof RepositoryRequestError && error.status === 409) setUncertain(true); setError(error instanceof RepositoryRequestError && error.status === 409 ? 'This draft changed elsewhere. Reload the saved draft before applying your changes.' : messageOf(error)); }
    } finally { if (!controller.signal.aborted) { mutation.current = null; setBusy(null); } }
  }

  return <section aria-label="Selected publication draft" style={{ minWidth: 0 }}>
    <div className="settings-card" style={cardStyle}><div style={flowStyle}><h2>Saved draft</h2><span className="status-tag">{revoked ? 'Revoked' : 'Draft saved'}</span>{dirty && <span className="status-tag unavailable">Unsaved changes</span>}</div><p>Package <code>{draft.proposal.packageName}@{draft.proposal.version}</code> · revision {draft.revision}</p><p style={{ overflowWrap: 'anywhere' }}>Immutable commit <code>{draft.commitSha}</code></p><div style={flowStyle}><span className="status-tag">Repository administration verified</span><span className="status-tag">{draft.rights === 'declared' ? 'Rights declared' : 'Rights not declared'}</span><span className="status-tag unavailable">Endpoint unverified</span><span className="status-tag unavailable">Accuracy unverified</span><span className="status-tag unavailable">Publication unavailable</span><span className="status-tag unavailable">Payment disabled</span></div><p>A saved proposal grants no public access and makes no charge. The rights statement is your declaration.</p><details><summary>Repository administration check</summary><p>{draft.administration.basis === 'personal-owner' ? 'Personal workspace owner' : 'Repository administrator'} · checked {draft.administration.checkedAt}. Permission is checked again on each request.</p></details><Link className="button secondary" style={{ justifySelf: 'start' }} href={`/app/repositories/${draft.repositoryId}`}>Inspect snapshot <GitBranch size={14} /></Link></div>
    <form aria-label="Edit publication draft" onSubmit={event => void request('save', event)}>
      <fieldset disabled={revoked || busy !== null || uncertain} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <section className="settings-card" style={cardStyle} aria-label="Repository rights"><div><h2>Repository rights</h2><p>Declare your authority to offer this source. This statement does not verify a license or ownership.</p></div><label htmlFor="publication-rights">Rights statement<textarea id="publication-rights" value={rights} onChange={event => { setRights(event.target.value); setNotice(null); }} maxLength={2000} rows={3} style={{ ...inputStyle, resize: 'vertical' }} /></label></section>
        <section className="settings-card" style={cardStyle} aria-label="Explicit source selection"><div><h2>Choose source paths</h2><p>Select exact paths for the proposal. New drafts have no source selected.</p></div>{sourceError ? <div role="alert"><p className="inline-error">{sourceError}</p><button type="button" className="button secondary" onClick={() => setSourceRefresh(value => value + 1)}>Reload source paths</button></div> : paths === null ? <p role="status"><LoaderCircle className="spin" size={15} /> Loading authorized source paths…</p> : <><label htmlFor="publication-path-filter">Filter paths<input id="publication-path-filter" value={filter} onChange={event => setFilter(event.target.value)} style={inputStyle} /></label><p className="quiet-label">{selectedPaths.length} paths selected · {visiblePaths.length} matching paths</p><div style={{ maxHeight: 300, overflowY: 'auto', minWidth: 0, border: '1px solid var(--line)', borderRadius: 5 }} role="group" aria-label="Source paths">{visiblePaths.length === 0 ? <p style={{ padding: 12 }}>No matching paths.</p> : visiblePaths.map(file => <label key={file.path} style={{ display: 'flex', gap: 10, padding: '10px 12px', alignItems: 'flex-start', overflowWrap: 'anywhere', fontSize: 12 }}><input type="checkbox" checked={selectedPaths.includes(file.path)} onChange={event => selectPath(file.path, event.target.checked)} style={{ flexShrink: 0, marginTop: 3 }} /><span style={{ minWidth: 0 }}>{file.path}<small style={{ display: 'block', color: 'var(--muted)' }}>{file.lines} lines</small></span></label>)}</div></>}
        </section>
        <section className="settings-card" style={cardStyle} aria-label="Exact release exports"><div><h2>Exact release exports</h2><p>Map only package.json-declared export names to their exact selected source paths. Package and version remain bound to the saved snapshot.</p></div>{exports.map((item, index) => <div key={item.key} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))', gap: 10 }}><label htmlFor={`publication-export-${item.key}`}>Export name {index + 1}<input id={`publication-export-${item.key}`} value={item.name} maxLength={200} onChange={event => setExports(current => current.map(row => row.key === item.key ? { ...row, name: event.target.value } : row))} style={inputStyle} /></label><label htmlFor={`publication-export-path-${item.key}`}>Source path {index + 1}<select id={`publication-export-path-${item.key}`} value={item.path} onChange={event => setExports(current => current.map(row => row.key === item.key ? { ...row, path: event.target.value } : row))} style={inputStyle}><option value="">Choose selected path</option>{selectedPaths.map(path => <option key={path} value={path}>{path}</option>)}</select></label><button type="button" className="button secondary" style={{ alignSelf: 'end' }} onClick={() => setExports(current => current.filter(row => row.key !== item.key))}>Remove export {index + 1}</button></div>)}<button type="button" className="button secondary" style={{ justifySelf: 'start' }} disabled={selectedPaths.length === 0 || exports.length >= 100} onClick={() => setExports(current => [...current, { key: exportKey.current++, name: '', path: selectedPaths[0] ?? '' }])}>Add export mapping</button></section>
        <section className="settings-card" style={cardStyle} aria-label="Proposed access and endpoint"><div><h2>Proposed access and endpoint</h2><p>These terms are inactive. Saving does not expose source or contact the endpoint.</p></div><label htmlFor="publication-policy">Proposed access policy<select id="publication-policy" value={accessPolicy} onChange={event => setAccessPolicy(event.target.value as PublicationAccessPolicy)} style={inputStyle}><option value="private">Private</option><option value="authenticated">Authenticated</option><option value="public">Public</option></select></label><label htmlFor="publication-endpoint">Proposed HTTPS endpoint (optional)<input id="publication-endpoint" type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://your-provider.example/context" maxLength={2000} style={inputStyle} /></label></section>
        <section className="settings-card" style={cardStyle} aria-label="Disabled testnet payment proposal"><div><h2>Testnet terms proposal</h2><p>Tempo testnet · chain 42431 · context.retrieve. Saving terms does not approve spending, sign a transaction, or enable payment.</p></div><label style={flowStyle}><input type="checkbox" checked={termsEnabled} onChange={event => setTermsEnabled(event.target.checked)} />Include proposed testnet terms</label>{termsEnabled && <><label htmlFor="publication-token">Token address<input id="publication-token" value={token} onChange={event => setToken(event.target.value)} maxLength={42} style={inputStyle} /></label><label htmlFor="publication-recipient">Recipient address<input id="publication-recipient" value={recipient} onChange={event => setRecipient(event.target.value)} maxLength={42} style={inputStyle} /></label><label htmlFor="publication-price">Price in atomic token units<input id="publication-price" inputMode="numeric" value={atomicPrice} onChange={event => setAtomicPrice(event.target.value)} maxLength={78} style={inputStyle} /></label></>}</section>
      </fieldset>
      <div style={{ ...flowStyle, marginTop: 24 }}><button className="button primary" type="submit" disabled={revoked || busy !== null || !dirty || paths === null || uncertain}>{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}Save private draft</button><button className="button secondary" type="button" disabled={busy !== null} onClick={() => void request('reload')}><RefreshCw size={14} />Reload saved draft</button>{!revoked && <button className="button secondary" type="button" disabled={busy !== null || uncertain} ref={revokeTrigger} onClick={() => setConfirmRevoke(true)}>Revoke draft</button>}</div>
      {confirmRevoke && !revoked && <div className="notice" style={{ marginTop: 16 }} role="alertdialog" aria-label="Confirm draft revocation" aria-describedby="publication-revoke-description" onKeyDown={event => { if (event.key === 'Escape' && busy === null) { setConfirmRevoke(false); revokeTrigger.current?.focus(); } }}><div><strong>Revoke this draft?</strong><p id="publication-revoke-description">The saved record remains for audit and becomes read-only. Unsaved edits are discarded.</p><div style={flowStyle}><button type="button" className="button secondary" disabled={busy !== null} ref={revokeCancel} onClick={() => { setConfirmRevoke(false); revokeTrigger.current?.focus(); }}>Keep draft</button><button type="button" className="button primary" disabled={busy !== null} onClick={() => void request('revoke')}>Confirm revoke draft</button></div></div></div>}
      {error && <p className="inline-error" role="alert" style={{ marginTop: 16 }}>{error}</p>}{notice && <p role="status" style={{ marginTop: 16 }}>{notice}</p>}
    </form>
    <section className="settings-card" style={cardStyle} aria-label="Saved exposure preview"><div><h2>Saved exposure preview</h2><p>{draft.preview.fileCount} selected files · {draft.preview.totalBytes} bytes. {dirty ? 'Unsaved edits are not included in this preview.' : 'This preview matches the saved revision.'}</p></div>{draft.preview.files.length === 0 ? <p>No source paths selected in the saved draft.</p> : <ul style={{ margin: 0, paddingLeft: 20, overflowWrap: 'anywhere' }}>{draft.preview.files.map(file => <li key={file.path} style={{ marginBottom: 12 }}><strong>{file.path}</strong><p>{file.lines} lines · {file.bytes} bytes</p><details><summary>Source digest</summary><code style={{ overflowWrap: 'anywhere' }}>{file.sourceDigest}</code></details></li>)}</ul>}<details><summary>Saved terms digest</summary><code style={{ overflowWrap: 'anywhere' }}>{draft.termsDigest}</code></details><p className="quiet-label">Published: no · Approval: none · Endpoint proof: unverified · Payment: disabled</p></section>
  </section>;
}

function WorkspaceDrafts({ account, workspaceId, onSessionChanged, dirty, onDirtyChange, onBusyChange }: { account: RepositoryAccount; workspaceId: string; onSessionChanged: () => void; dirty: boolean; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void }) {
  const [drafts, setDrafts] = useState<PublicationDraft[] | null>(null);
  const [repositories, setRepositories] = useState<RepositoryChoice[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [repositoryId, setRepositoryId] = useState('');
  const [selected, setSelected] = useState<PublicationDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createUncertain, setCreateUncertain] = useState(false);
  const [editingBusy, setEditingBusy] = useState(false);
  const createAbort = useRef<AbortController | null>(null);
  const role = account.workspaces.find(item => item.id === workspaceId)?.role;
  const admin = role === 'owner' || role === 'admin';
  useEffect(() => () => createAbort.current?.abort(), []);
  useEffect(() => { onBusyChange(creating || editingBusy); return () => onBusyChange(false); }, [creating, editingBusy, onBusyChange]);
  useEffect(() => {
    const controller = new AbortController(); setDrafts(null); setCatalogError(null);
    repositoryRequest(`/api/publications?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal }).then(({ data }) => {
      if (!Array.isArray(data.drafts)) throw new Error('The server did not return a draft catalog.');
      const rows = data.drafts.map(value => readDraft(value, workspaceId));
      if (new Set(rows.map(item => item.id)).size !== rows.length) throw new Error('The draft catalog contains duplicate records.');
      if (!controller.signal.aborted) { setDrafts(rows); setCreateUncertain(false); }
    }).catch(error => { if (!controller.signal.aborted) { setCatalogError(messageOf(error)); if (error instanceof RepositoryRequestError && error.status === 401) onSessionChanged(); } });
    return () => controller.abort();
  }, [workspaceId, refresh, onSessionChanged]);
  useEffect(() => {
    const controller = new AbortController(); setRepositories(null); setRepositoryError(null);
    repositoryRequest(`/api/repositories?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal }).then(({ data }) => {
      if (!Array.isArray(data.repositories)) throw new Error('The server did not return authorized repositories.');
      const rows = data.repositories.map(value => { const row = objectValue(value); if (typeof row.id !== 'string' || !repositoryUuid.test(row.id) || typeof row.name !== 'string' || typeof row.status !== 'string') throw new Error('The repository catalog is invalid.'); return { id: row.id, name: row.name, status: row.status }; });
      if (!controller.signal.aborted) { setRepositories(rows); setRepositoryId(current => rows.some(item => item.id === current && item.status === 'complete') ? current : rows.find(item => item.status === 'complete')?.id ?? ''); }
    }).catch(error => { if (!controller.signal.aborted) { setRepositoryError(messageOf(error)); if (error instanceof RepositoryRequestError && error.status === 401) onSessionChanged(); } });
    return () => controller.abort();
  }, [workspaceId, refresh, onSessionChanged]);
  const updated = useCallback((draft: PublicationDraft) => { setSelected(draft); setDrafts(current => current?.map(item => item.id === draft.id ? draft : item) ?? null); }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!admin || !repositoryId || createAbort.current || createUncertain || editingBusy) return;
    if (dirty && !window.confirm('Discard unsaved changes and create a new private draft?')) return;
    const controller = new AbortController(); createAbort.current = controller; setCreating(true); setCreateError(null);
    try {
      const { data } = await repositoryRequest('/api/publications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, repositoryId }), signal: controller.signal });
      const draft = readDraft(data.draft, workspaceId);
      if (draft.repositoryId !== repositoryId || draft.proposal.accessPolicy !== 'private' || draft.proposal.exposedPaths.length !== 0 || draft.proposal.testnetTerms !== null || draft.proposal.proposedEndpoint !== null) throw new Error('The new draft did not start private with empty exposure.');
      if (!controller.signal.aborted) { setSelected(draft); setDrafts(current => [draft, ...(current ?? []).filter(item => item.id !== draft.id)]); }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof RepositoryRequestError && error.status === 401) { onSessionChanged(); return; }
      if (!(error instanceof RepositoryRequestError)) { setCreateUncertain(true); setCreateError('The create result is uncertain. Refresh the draft catalog before creating another draft.'); }
      else setCreateError(messageOf(error));
    } finally { if (!controller.signal.aborted) { createAbort.current = null; setCreating(false); } }
  }
  function open(draft: PublicationDraft) { if (!dirty || window.confirm('Discard unsaved changes and open this saved draft?')) setSelected(draft); }
  return <>
    <form className="settings-card" style={cardStyle} aria-label="Create private publication draft" onSubmit={event => void create(event)}><div><h2>Create a private draft</h2><p>Workspace administration and current GitHub owner or administrator permission are required. Read access is insufficient.</p></div>{!admin && <p role="status">Your workspace role cannot administer publication drafts.</p>}{repositoryError ? <p className="inline-error" role="alert">{repositoryError}</p> : repositories === null ? <p role="status">Loading authorized repositories…</p> : repositories.some(item => item.status === 'complete') ? <label htmlFor="publication-repository">Indexed repository<select id="publication-repository" value={repositoryId} onChange={event => setRepositoryId(event.target.value)} disabled={creating || editingBusy || !admin || createUncertain} style={inputStyle}>{repositories.filter(item => item.status === 'complete').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : <p>No completed repository snapshot is available. <Link href="/app/repositories">Import a repository</Link> first.</p>}<button className="button primary" style={{ justifySelf: 'start' }} disabled={!admin || !repositoryId || creating || editingBusy || createUncertain || drafts === null} type="submit">{creating ? <LoaderCircle className="spin" size={15} /> : <FileCode2 size={15} />}Create private draft</button>{createError && <p className="inline-error" role="alert">{createError}</p>}</form>
    <section aria-label="Private publication drafts" style={{ marginTop: 28 }}><div className="section-toolbar"><h2 style={{ fontSize: 14 }}>Saved drafts</h2><button className="button secondary" disabled={creating || editingBusy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />Refresh draft catalog</button></div>{catalogError ? <div className="unavailable-state" role="alert"><CircleAlert size={20} /><h2>Draft catalog unavailable</h2><p>{catalogError}</p></div> : drafts === null ? <div className="empty-card" role="status"><LoaderCircle className="spin" size={20} /><p>Loading private drafts…</p></div> : drafts.length === 0 ? <div className="empty-card"><p>No publication drafts in this workspace.</p></div> : <ul className="activity-list">{drafts.map(draft => <li key={draft.id}><FileCode2 size={17} /><div className="activity-body"><div style={{ flexWrap: 'wrap' }}><strong style={{ overflowWrap: 'anywhere' }}>{draft.proposal.packageName}@{draft.proposal.version}</strong><span className="status-tag">{draft.state}</span></div><p>Revision {draft.revision} · {draft.preview.fileCount} selected files · Publication unavailable</p></div><button className="button secondary" aria-pressed={selected?.id === draft.id} disabled={creating || editingBusy} onClick={() => open(draft)}>Open draft</button></li>)}</ul>}</section>
    {selected && <DraftDetails key={selected.id} draft={selected} account={account} onUpdated={updated} onSessionChanged={onSessionChanged} onDirtyChange={onDirtyChange} onBusyChange={setEditingBusy} />}
  </>;
}

export function PublicationEditor() {
  const [account, setAccount] = useState<RepositoryAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [workspaceId, setWorkspaceId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false);
  const refreshAccount = useCallback(() => setRefresh(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController(); setAccount(null); setError(null); setNeedsSignIn(false);
    repositoryRequest('/api/account', { signal: controller.signal }).then(({ data }) => {
      const result = readRepositoryAccount(data); if (controller.signal.aborted) return;
      setAccount(result); setWorkspaceId(current => result.workspaces.some(item => item.id === current) ? current : result.workspaces[0]?.id ?? '');
    }).catch(error => { if (!controller.signal.aborted) { setError(messageOf(error)); setNeedsSignIn(error instanceof RepositoryRequestError && error.status === 401); } });
    return () => controller.abort();
  }, [refresh]);
  return <main id="main" className="content-page publication-editor"><header className="page-header"><div><span className="eyebrow">Private administrative draft</span><h1>Prepare a knowledge service</h1><p>Review repository rights, exact version, explicit source paths, and proposed terms.</p></div></header><div className="notice"><ShieldCheck size={19} /><div><strong>Private drafts are available; publication is unavailable</strong><p>Saving a draft does not approve publication, expose source publicly, verify an endpoint, or execute a payment.</p></div></div>{error ? <div className="unavailable-state" role="alert" style={{ marginTop: 24 }}><CircleAlert size={20} /><h2>{needsSignIn ? 'Sign in to manage drafts' : 'Workspace unavailable'}</h2><p>{error}</p>{needsSignIn ? <Link className="button primary" href="/sign-in">Sign in</Link> : <button className="button secondary" onClick={refreshAccount}>Retry account request</button>}</div> : account ? <RepositorySessionBoundary principalId={account.principalId} onSessionChanged={refreshAccount}>{account.workspaces.length === 0 ? <div className="empty-card" style={{ marginTop: 24 }}><h2>No workspace available</h2><p>Set up an authorized workspace and import a repository before preparing a draft.</p><Link className="button secondary" href="/app/repositories">Open repositories</Link></div> : <><label htmlFor="publication-workspace" style={{ display: 'block', marginTop: 24 }}>Workspace<select id="publication-workspace" value={workspaceId} disabled={draftBusy} onChange={event => { if (!dirty || window.confirm('Discard unsaved draft changes and change workspace?')) setWorkspaceId(event.target.value); }} style={inputStyle}>{account.workspaces.map(item => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label><WorkspaceDrafts key={`${account.principalId}:${workspaceId}`} account={account} workspaceId={workspaceId} onSessionChanged={refreshAccount} dirty={dirty} onDirtyChange={setDirty} onBusyChange={setDraftBusy} /></>}</RepositorySessionBoundary> : <div className="empty-card" role="status" style={{ marginTop: 24 }}><LoaderCircle className="spin" size={20} /><p>Loading your authenticated workspace…</p></div>}</main>;
}
