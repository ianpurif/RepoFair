'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { PublicationAccessPolicy, PublicationDraft, PublicationProposal, SignedPublicationArtifact } from '@atlas/contracts';
import { CircleAlert, FileCode2, GitBranch, LoaderCircle, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { objectValue, readRepositoryAccount, repositoryRequest, RepositoryRequestError, RepositorySessionBoundary, repositoryUuid, type RepositoryAccount } from './repository-browser';
import { readRepositoryGraphPage, safeSourcePath } from './repository-data';
import { readPublishedProvider, type PublishedProvider } from './provider-directory';

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
interface RepositoryChoice { id: string; name: string; status: string; snapshotId: string | null }
interface ExportInput { key: number; name: string; path: string }

async function readPublicationExport(value: unknown, draft: PublicationDraft): Promise<SignedPublicationArtifact> {
  const signed = objectValue(value); const artifact = objectValue(signed.artifact); const proposal = objectValue(artifact.proposal); const preview = objectValue(artifact.preview);
  const terms = objectValue(proposal.testnetTerms); const approvedTerms = draft.proposal.testnetTerms;
  if (Object.keys(signed).some(key => !['artifact', 'signature'].includes(key)) || Object.keys(artifact).some(key => !['schemaVersion', 'mode', 'id', 'draftRevision', 'termsDigest', 'repositoryId', 'snapshotId', 'commitSha', 'proposal', 'preview', 'files', 'context', 'sourceSignatures'].includes(key))) throw new Error('The source export contains unexpected data.');
  if (typeof signed.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signed.signature) || artifact.schemaVersion !== 1 || artifact.mode !== 'tempo-testnet' || artifact.id !== draft.id || artifact.draftRevision !== draft.revision || artifact.termsDigest !== draft.termsDigest || artifact.repositoryId !== draft.repositoryId || artifact.snapshotId !== draft.snapshotId || artifact.commitSha !== draft.commitSha || !Array.isArray(artifact.files) || artifact.files.length !== draft.preview.fileCount || artifact.files.length > 192 || preview.totalBytes !== draft.preview.totalBytes || preview.fileCount !== draft.preview.fileCount || proposal.packageName !== draft.proposal.packageName || proposal.version !== draft.proposal.version || proposal.accessPolicy !== draft.proposal.accessPolicy || proposal.rightsStatement !== draft.proposal.rightsStatement || proposal.proposedEndpoint !== draft.proposal.proposedEndpoint || !approvedTerms || terms.network !== 'eip155:42431' || terms.token !== approvedTerms.token || terms.recipient !== approvedTerms.recipient || terms.atomicPrice !== approvedTerms.atomicPrice || !stringList(proposal.exposedPaths) || JSON.stringify([...proposal.exposedPaths].sort()) !== JSON.stringify([...draft.proposal.exposedPaths].sort()) || JSON.stringify(Object.entries(objectValue(proposal.exports)).sort()) !== JSON.stringify(Object.entries(draft.proposal.exports).sort())) throw new Error('The export does not match the approved saved source and terms.');
  const expected = new Map(draft.preview.files.map(file => [file.path, file])); const seen = new Set<string>(); const selectedFiles = new Map<string, { text: string; lines: string[] }>(); let total = 0;
  for (const value of artifact.files) {
    const file = objectValue(value);
    if (Object.keys(file).some(key => !['path', 'text', 'lineCount'].includes(key)) || !safeSourcePath(file.path) || seen.has(file.path) || typeof file.text !== 'string' || file.text.includes('\0') || !integer(file.lineCount)) throw new Error('The exported source file is invalid.');
    const original = expected.get(file.path); const bytes = new TextEncoder().encode(file.text); total += bytes.byteLength;
    if (!original || original.lines !== file.lineCount || file.lineCount !== file.text.split('\n').length || original.bytes !== bytes.byteLength || bytes.byteLength > 262_144 || total > 1_500_000) throw new Error('The source export differs from the saved exposure preview.');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== original.sourceDigest) throw new Error('The exported source digest differs from the saved preview.');
    seen.add(file.path); selectedFiles.set(file.path, { text: file.text, lines: file.text.split('\n') });
  }
  if (total !== draft.preview.totalBytes || !seen.has('package.json')) throw new Error('The exported package selection is incomplete.');
  const packageManifest = objectValue(JSON.parse(selectedFiles.get('package.json')!.text) as unknown);
  const context = objectValue(artifact.context);
  if (packageManifest.name !== draft.proposal.packageName || packageManifest.version !== draft.proposal.version || context.schemaVersion !== 1 || context.providerId !== draft.id || context.packageName !== draft.proposal.packageName || context.version !== draft.proposal.version || !Array.isArray(context.evidence) || context.evidence.length > 12_000 || !Array.isArray(context.nodes) || context.nodes.length > 4_000 || !Array.isArray(context.edges) || context.edges.length > 12_000 || !stringList(context.limitations) || !['sufficient', 'insufficient', 'unknown'].includes(String(context.evidenceState))) throw new Error('The exported context does not match the selected package.');
  const evidenceIds = new Set<string>(); const nodeIds = new Set<string>();
  for (const value of context.evidence) {
    const item = objectValue(value); const source = objectValue(item.source); const scope = objectValue(item.scope); const file = typeof source.path === 'string' ? selectedFiles.get(source.path) : null;
    if (!file || typeof item.id !== 'string' || evidenceIds.has(item.id) || source.kind !== 'git' || source.repositoryId !== draft.repositoryId || source.snapshotId !== draft.snapshotId || source.revision !== draft.commitSha || item.providerId !== draft.id || item.provenance !== 'provider-reported' || scope.tenantId !== draft.id || scope.principalId !== 'publication' || scope.permissionRevision !== draft.termsDigest || !integer(source.startLine) || !integer(source.endLine) || source.startLine < 1 || source.endLine < source.startLine || source.endLine - source.startLine >= 120 || source.endLine > file.lines.length || file.lines.slice(source.startLine - 1, source.endLine).join('\n') !== item.original) throw new Error('The export includes source outside the approved selection or line ranges.');
    evidenceIds.add(item.id);
  }
  for (const value of context.nodes) {
    const node = objectValue(value);
    if (typeof node.id !== 'string' || nodeIds.has(node.id) || node.repositoryId !== draft.repositoryId || node.snapshotId !== draft.snapshotId || typeof node.localId !== 'string' || !['file', 'symbol', 'package'].includes(String(node.kind)) || node.id !== JSON.stringify([draft.repositoryId, draft.snapshotId, node.localId]) || node.kind === 'file' && !selectedFiles.has(node.localId) || node.kind === 'symbol' && ![...selectedFiles.keys()].some(path => String(node.localId).startsWith(`${path}#`))) throw new Error('The export includes a graph identity outside the selected source.');
    nodeIds.add(node.id);
  }
  for (const value of context.edges) {
    const edge = objectValue(value);
    if (!nodeIds.has(String(edge.from)) || !nodeIds.has(String(edge.to)) || !evidenceIds.has(String(edge.evidenceId)) || edge.provenance !== 'provider-reported') throw new Error('The export includes a graph relationship without selected source evidence.');
  }
  const sourceSignatures = objectValue(artifact.sourceSignatures);
  if (Object.keys(sourceSignatures).length !== evidenceIds.size || Object.entries(sourceSignatures).some(([id, signature]) => !evidenceIds.has(id) || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature))) throw new Error('The source export does not include signatures for exactly its selected passages.');
  return signed as unknown as SignedPublicationArtifact;
}

function PublicationActivation({ draft, dirty, onSessionChanged, onBusyChange }: { draft: PublicationDraft; dirty: boolean; onSessionChanged: () => void; onBusyChange: (busy: boolean) => void }) {
  const [published, setPublished] = useState<PublishedProvider | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => { setApproved(false); }, [draft.revision, draft.termsDigest, dirty]);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    const controller = new AbortController(); setChecking(true); setError(null);
    repositoryRequest('/api/catalog', { signal: controller.signal }).then(({ data }) => {
      if (!Array.isArray(data.providers)) throw new Error('The publication catalog is unavailable.');
      const providers = data.providers.map(readPublishedProvider);
      const result = providers.find(provider => provider.id === draft.id) ?? null;
      const terms = draft.proposal.testnetTerms;
      if (result && (result.packageName !== draft.proposal.packageName || result.version !== draft.proposal.version || result.commitSha !== draft.commitSha || result.snapshotId !== draft.snapshotId || result.endpoint !== draft.proposal.proposedEndpoint || result.accessPolicy !== draft.proposal.accessPolicy || result.rightsStatement !== draft.proposal.rightsStatement || !terms || result.network !== terms.network || result.token.toLowerCase() !== terms.token.toLowerCase() || result.recipient.toLowerCase() !== terms.recipient.toLowerCase() || result.atomicPrice !== terms.atomicPrice)) throw new Error('The catalog does not match this saved release and its terms. Refresh or review the publication before approval.');
      if (!controller.signal.aborted) { setPublished(result); setUncertain(false); setChecking(false); }
    }).catch(error => { if (!controller.signal.aborted) { setError(messageOf(error)); setChecking(false); } });
    return () => controller.abort();
  }, [draft.id, draft.revision, draft.proposal, draft.commitSha, draft.snapshotId, refresh]);
  const complete = draft.state !== 'revoked' && draft.rights === 'declared' && draft.proposal.exposedPaths.includes('package.json') && draft.preview.fileCount > 0 && draft.proposal.accessPolicy !== 'private' && draft.proposal.proposedEndpoint !== null && draft.proposal.testnetTerms?.token.toLowerCase() === '0x20c0000000000000000000000000000000000000';
  async function download() {
    if (!complete || dirty || !approved || mutation.current || checking || uncertain) return;
    const controller = new AbortController(); mutation.current = controller; setBusy(true); setError(null); setNotice(null); setApproved(false);
    try {
      const { data } = await repositoryRequest(`/api/publications/${encodeURIComponent(draft.id)}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: draft.revision, termsDigest: draft.termsDigest, exposureApproved: true }), signal: controller.signal });
      const signed = await readPublicationExport(data, draft); const contents = JSON.stringify(signed);
      if (new TextEncoder().encode(contents).byteLength > 4_100_000) throw new Error('The selected export exceeds the download limit. Reduce the selected source.');
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `atlas-${draft.id}-r${draft.revision}.json`; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('Source artifact downloaded. Install it on your independent provider, then approve publication after reviewing its endpoint.');
    } catch (error) { if (!controller.signal.aborted) { setError(messageOf(error)); if (error instanceof RepositoryRequestError && [401, 403].includes(error.status)) onSessionChanged(); } }
    finally { if (!controller.signal.aborted) { mutation.current = null; setBusy(false); } }
  }
  async function activate() {
    if (!complete || dirty || !approved || mutation.current || uncertain || checking || published || error) return;
    const controller = new AbortController(); mutation.current = controller; setBusy(true); setError(null); setApproved(false);
    try {
      await repositoryRequest(`/api/publications/${encodeURIComponent(draft.id)}/activate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: draft.revision, termsDigest: draft.termsDigest, exposureApproved: true }), signal: controller.signal });
      if (!controller.signal.aborted) { setUncertain(true); setRefresh(value => value + 1); }
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(messageOf(error)); setUncertain(!(error instanceof RepositoryRequestError) || error.status === 409);
      if (error instanceof RepositoryRequestError && [401, 403].includes(error.status)) onSessionChanged();
    } finally { if (!controller.signal.aborted) { mutation.current = null; setBusy(false); } }
  }
  return <section className="settings-card" style={cardStyle} aria-label="Publication activation"><div style={flowStyle}><h2>Export and publish</h2><span className="status-tag">{checking ? 'Checking status' : published ? 'Published' : 'Inactive'}</span></div>{checking ? <p role="status">Checking publication status…</p> : published ? <><p>This exact release is listed with its saved testnet terms.</p><Link className="text-button" href={`/app/providers/${encodeURIComponent(published.id)}`}>Review published service</Link></> : <><p>Download the selected source artifact and install it on your independent HTTPS provider. Publication verifies that endpoint before making the saved service discoverable.</p>{!complete && <p className="quiet-label">Save a rights statement, package.json and source paths, an authenticated or public policy, an HTTPS endpoint, and Moderato PathUSD price and recipient.</p>}<label className="publication-exposure-approval"><input type="checkbox" checked={approved} disabled={!complete || dirty || busy || checking || uncertain} onChange={event => setApproved(event.target.checked)} />I approve exporting and exposing exactly the saved source paths and terms for {draft.proposal.packageName}@{draft.proposal.version}, revision {draft.revision}.</label><div style={flowStyle}><button type="button" className="button secondary" disabled={!complete || dirty || !approved || busy || checking || uncertain} onClick={() => void download()}>Download selected source artifact</button><button type="button" className="button primary" disabled={!complete || dirty || !approved || busy || checking || uncertain || !!error} onClick={() => void activate()}>{busy && <LoaderCircle className="spin" size={15} />}Publish saved revision</button></div></>}{error && <p className="inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{uncertain && <p role="status">The publication result needs confirmation before another activation request.</p>}<button type="button" className="text-button" disabled={busy || checking} onClick={() => setRefresh(value => value + 1)}>Refresh publication status</button></section>;
}

function DraftDetails({ draft, account, onUpdated, onSessionChanged, onDirtyChange, onBusyChange }: { draft: PublicationDraft; account: RepositoryAccount; onUpdated: (draft: PublicationDraft) => void; onSessionChanged: () => void; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void }) {
  const [paths, setPaths] = useState<PathChoice[] | null>(null);
  const [pagePaths, setPagePaths] = useState<PathChoice[]>([]);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceRefresh, setSourceRefresh] = useState(0);
  const [sourceCursor, setSourceCursor] = useState<number | null>(null);
  const [sourceQuery, setSourceQuery] = useState('');
  const [pathsBusy, setPathsBusy] = useState(false);
  const [nextSourceCursor, setNextSourceCursor] = useState<number | null>(null);
  const [rights, setRights] = useState(draft.proposal.rightsStatement);
  const [selectedPaths, setSelectedPaths] = useState<readonly string[]>(draft.proposal.exposedPaths);
  const selectedPathsRef = useRef(selectedPaths);
  selectedPathsRef.current = selectedPaths;
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
  const [activationBusy, setActivationBusy] = useState(false);
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
  useEffect(() => { onBusyChange(busy !== null || activationBusy); return () => onBusyChange(false); }, [busy, activationBusy, onBusyChange]);
  useEffect(() => { if (confirmRevoke) revokeCancel.current?.focus(); }, [confirmRevoke]);
  useEffect(() => { const timer = setTimeout(() => { setSourceQuery(filter.trim()); setSourceCursor(null); }, 300); return () => clearTimeout(timer); }, [filter]);
  useEffect(() => {
    const controller = new AbortController(); setPathsBusy(true); setSourceError(null);
    const params = new URLSearchParams({ snapshotId: draft.snapshotId, limit: '120' });
    if (sourceCursor !== null) params.set('cursor', String(sourceCursor)); if (sourceQuery) params.set('query', sourceQuery);
    repositoryRequest(`/api/repositories/${encodeURIComponent(draft.repositoryId)}/map?${params}`, { signal: controller.signal }).then(({ response, data }) => {
      if (response.status === 202) throw new Error('The repository snapshot is still being indexed. Reload source paths after indexing completes.');
      const index = readRepositoryGraphPage(data.index, draft.repositoryId, account, draft.snapshotId);
      if (index.snapshot.revision !== draft.commitSha || index.scope.tenantId !== draft.workspaceId || index.packageName !== draft.proposal.packageName || index.version !== draft.proposal.version) throw new Error('The source choices do not belong to the saved release.');
      const choices = index.files.map(file => ({ path: file.path, lines: file.lineCount }));
      if (!controller.signal.aborted) { setPagePaths(choices); setPaths(current => {
        const all = [...new Map([...draft.preview.files.map(file => ({ path: file.path, lines: file.lines })), ...(current ?? []), ...choices].map(file => [file.path, file])).values()];
        const selected = new Set(selectedPathsRef.current); const retained = all.slice(-480);
        return [...new Map([...all.filter(file => selected.has(file.path)), ...retained].map(file => [file.path, file])).values()].sort((a, b) => a.path.localeCompare(b.path));
      }); setNextSourceCursor(index.page.nextCursor); setPathsBusy(false); }
    }).catch(error => { if (!controller.signal.aborted) { setSourceError(messageOf(error)); setPathsBusy(false); if (error instanceof RepositoryRequestError && [401, 403].includes(error.status)) onSessionChanged(); } });
    return () => controller.abort();
  }, [draft.repositoryId, draft.snapshotId, draft.commitSha, draft.workspaceId, draft.proposal.packageName, draft.proposal.version, draft.preview.files, account, sourceRefresh, sourceCursor, sourceQuery, onSessionChanged]);

  const dirty = rights !== draft.proposal.rightsStatement || JSON.stringify([...selectedPaths].sort()) !== JSON.stringify([...draft.proposal.exposedPaths].sort()) || JSON.stringify(exports.map(item => [item.name, item.path]).sort()) !== JSON.stringify(Object.entries(draft.proposal.exports).sort()) || accessPolicy !== draft.proposal.accessPolicy || endpoint !== (draft.proposal.proposedEndpoint ?? '') || termsEnabled !== (draft.proposal.testnetTerms !== null) || (termsEnabled && (token !== draft.proposal.testnetTerms?.token || recipient !== draft.proposal.testnetTerms?.recipient || atomicPrice !== draft.proposal.testnetTerms?.atomicPrice));
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const visiblePaths = useMemo(() => pagePaths.filter(file => file.path.toLowerCase().includes(filter.toLowerCase())).slice(0, 160), [pagePaths, filter]);
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
    event?.preventDefault(); if (mutation.current || activationBusy || (action !== 'reload' && (revoked || uncertain))) return;
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
      onUpdated(result); setNotice(action === 'save' ? 'Draft saved. The preview reflects this saved revision.' : action === 'revoke' ? 'Draft revoked.' : 'Saved draft reloaded.');
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof RepositoryRequestError && [401, 403].includes(error.status)) { onSessionChanged(); return; }
      if (!(error instanceof RepositoryRequestError) && action !== 'reload') { setUncertain(true); setError('The result of the draft change is uncertain. Reload the saved draft before trying another change.'); }
      else { if (error instanceof RepositoryRequestError && error.status === 409) setUncertain(true); setError(error instanceof RepositoryRequestError && error.status === 409 ? 'This draft changed elsewhere. Reload the saved draft before applying your changes.' : messageOf(error)); }
    } finally { if (!controller.signal.aborted) { mutation.current = null; setBusy(null); } }
  }

  return <section aria-label="Selected publication draft" style={{ minWidth: 0 }}>
    <div className="settings-card" style={cardStyle}><div style={flowStyle}><h2>Saved draft</h2><span className="status-tag">{revoked ? 'Revoked' : 'Draft saved'}</span>{dirty && <span className="status-tag unavailable">Unsaved changes</span>}</div><p>Package <code>{draft.proposal.packageName}@{draft.proposal.version}</code> · revision {draft.revision}</p><p style={{ overflowWrap: 'anywhere' }}>Immutable commit <code>{draft.commitSha}</code></p><div style={flowStyle}><span className="status-tag">Repository administration verified</span><span className="status-tag">{draft.rights === 'declared' ? 'Rights declared' : 'Rights not declared'}</span><span className="status-tag unavailable">Accuracy unverified</span></div><details><summary>Repository administration check</summary><p>{draft.administration.basis === 'personal-owner' ? 'Personal workspace owner' : 'Repository administrator'} · checked {draft.administration.checkedAt}. Permission is checked again on each request.</p></details><Link className="button secondary" style={{ justifySelf: 'start' }} href={`/app/repositories/${draft.repositoryId}`}>Inspect snapshot <GitBranch size={14} /></Link></div>
    <form aria-label="Edit publication draft" onSubmit={event => void request('save', event)}>
      <fieldset disabled={revoked || busy !== null || activationBusy || uncertain} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <section className="settings-card" style={cardStyle} aria-label="Repository rights"><div><h2>Repository rights</h2><p>Declare your authority to offer this source. This statement does not verify a license or ownership.</p></div><label htmlFor="publication-rights">Rights statement<textarea id="publication-rights" value={rights} onChange={event => { setRights(event.target.value); setNotice(null); }} maxLength={2000} rows={3} style={{ ...inputStyle, resize: 'vertical' }} /></label></section>
        <section className="settings-card" style={cardStyle} aria-label="Explicit source selection"><div><h2>Choose source paths</h2><p>Only selected paths are included. Search and load another page to find source.</p></div>
          <label htmlFor="publication-path-filter">Filter paths<input id="publication-path-filter" value={filter} onChange={event => setFilter(event.target.value)} style={inputStyle} /></label>
          {sourceError && <div role="alert"><p className="inline-error">{sourceError}</p><button type="button" className="button secondary" onClick={() => setSourceRefresh(value => value + 1)}>Reload source paths</button></div>}
          {pathsBusy && <p role="status"><LoaderCircle className="spin" size={15} /> Loading authorized path metadata…</p>}
          {paths !== null && <><p className="quiet-label">{selectedPaths.length} paths selected · {visiblePaths.length} loaded matches</p><div className="publication-paths" role="group" aria-label="Source paths">{visiblePaths.length === 0 && !pathsBusy ? <p>No matching paths.</p> : visiblePaths.map(file => <label key={file.path}><input type="checkbox" checked={selectedPaths.includes(file.path)} onChange={event => selectPath(file.path, event.target.checked)} /><span>{file.path}<small>{file.lines} lines</small></span></label>)}</div>{nextSourceCursor !== null && <button type="button" className="button secondary" disabled={pathsBusy} style={{ justifySelf: 'start' }} onClick={() => setSourceCursor(nextSourceCursor)}>Load more source paths</button>}</>}
        </section>
        <section className="settings-card" style={cardStyle} aria-label="Exact release exports"><div><h2>Exact release exports</h2><p>Map only package.json-declared export names to their exact selected source paths. Package and version remain bound to the saved snapshot.</p></div>{exports.map((item, index) => <div key={item.key} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))', gap: 10 }}><label htmlFor={`publication-export-${item.key}`}>Export name {index + 1}<input id={`publication-export-${item.key}`} value={item.name} maxLength={200} onChange={event => setExports(current => current.map(row => row.key === item.key ? { ...row, name: event.target.value } : row))} style={inputStyle} /></label><label htmlFor={`publication-export-path-${item.key}`}>Source path {index + 1}<select id={`publication-export-path-${item.key}`} value={item.path} onChange={event => setExports(current => current.map(row => row.key === item.key ? { ...row, path: event.target.value } : row))} style={inputStyle}><option value="">Choose selected path</option>{selectedPaths.map(path => <option key={path} value={path}>{path}</option>)}</select></label><button type="button" className="button secondary" style={{ alignSelf: 'end' }} onClick={() => setExports(current => current.filter(row => row.key !== item.key))}>Remove export {index + 1}</button></div>)}<button type="button" className="button secondary" style={{ justifySelf: 'start' }} disabled={selectedPaths.length === 0 || exports.length >= 100} onClick={() => setExports(current => [...current, { key: exportKey.current++, name: '', path: selectedPaths[0] ?? '' }])}>Add export mapping</button></section>
        <section className="settings-card" style={cardStyle} aria-label="Proposed access and endpoint"><div><h2>Proposed access and endpoint</h2><p>These terms are inactive. Saving does not expose source or contact the endpoint.</p></div><label htmlFor="publication-policy">Proposed access policy<select id="publication-policy" value={accessPolicy} onChange={event => setAccessPolicy(event.target.value as PublicationAccessPolicy)} style={inputStyle}><option value="private">Private</option><option value="authenticated">Authenticated</option><option value="public">Public</option></select></label><label htmlFor="publication-endpoint">Proposed HTTPS endpoint (optional)<input id="publication-endpoint" type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://your-provider.example/context" maxLength={2000} style={inputStyle} /></label></section>
        <section className="settings-card" style={cardStyle} aria-label="Disabled testnet payment proposal"><div><h2>Testnet terms proposal</h2><p>Tempo testnet · chain 42431 · context.retrieve. Saving terms does not approve spending, sign a transaction, or enable payment.</p></div><label style={flowStyle}><input type="checkbox" checked={termsEnabled} onChange={event => setTermsEnabled(event.target.checked)} />Include proposed testnet terms</label>{termsEnabled && <><label htmlFor="publication-token">Token address<input id="publication-token" value={token} onChange={event => setToken(event.target.value)} maxLength={42} style={inputStyle} /></label><label htmlFor="publication-recipient">Recipient address<input id="publication-recipient" value={recipient} onChange={event => setRecipient(event.target.value)} maxLength={42} style={inputStyle} /></label><label htmlFor="publication-price">Price in atomic token units<input id="publication-price" inputMode="numeric" value={atomicPrice} onChange={event => setAtomicPrice(event.target.value)} maxLength={78} style={inputStyle} /></label></>}</section>
      </fieldset>
      <div style={{ ...flowStyle, marginTop: 24 }}><button className="button primary" type="submit" disabled={revoked || busy !== null || activationBusy || !dirty || paths === null || uncertain}>{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}Save private draft</button><button className="button secondary" type="button" disabled={busy !== null || activationBusy} onClick={() => void request('reload')}><RefreshCw size={14} />Reload saved draft</button>{!revoked && <button className="button secondary" type="button" disabled={busy !== null || activationBusy || uncertain} ref={revokeTrigger} onClick={() => setConfirmRevoke(true)}>Revoke draft</button>}</div>
      {confirmRevoke && !revoked && <div className="notice" style={{ marginTop: 16 }} role="alertdialog" aria-label="Confirm draft revocation" aria-describedby="publication-revoke-description" onKeyDown={event => { if (event.key === 'Escape' && busy === null) { setConfirmRevoke(false); revokeTrigger.current?.focus(); } }}><div><strong>Revoke this draft?</strong><p id="publication-revoke-description">The saved record remains for audit and becomes read-only. Unsaved edits are discarded.</p><div style={flowStyle}><button type="button" className="button secondary" disabled={busy !== null} ref={revokeCancel} onClick={() => { setConfirmRevoke(false); revokeTrigger.current?.focus(); }}>Keep draft</button><button type="button" className="button primary" disabled={busy !== null} onClick={() => void request('revoke')}>Confirm revoke draft</button></div></div></div>}
      {error && <p className="inline-error" role="alert" style={{ marginTop: 16 }}>{error}</p>}{notice && <p role="status" style={{ marginTop: 16 }}>{notice}</p>}
    </form>
    <section className="settings-card" style={cardStyle} aria-label="Saved exposure preview"><div><h2>Saved exposure preview</h2><p>{draft.preview.fileCount} selected files · {draft.preview.totalBytes} bytes. {dirty ? 'Unsaved edits are not included in this preview.' : 'This preview matches the saved revision.'}</p></div>{draft.preview.files.length === 0 ? <p>No source paths selected in the saved draft.</p> : <ul style={{ margin: 0, paddingLeft: 20, overflowWrap: 'anywhere' }}>{draft.preview.files.map(file => <li key={file.path} style={{ marginBottom: 12 }}><strong>{file.path}</strong><p>{file.lines} lines · {file.bytes} bytes</p><details><summary>Source digest</summary><code style={{ overflowWrap: 'anywhere' }}>{file.sourceDigest}</code></details></li>)}</ul>}<details><summary>Saved terms digest</summary><code style={{ overflowWrap: 'anywhere' }}>{draft.termsDigest}</code></details></section>
    {!revoked && <PublicationActivation draft={draft} dirty={dirty || busy !== null} onSessionChanged={onSessionChanged} onBusyChange={setActivationBusy} />}
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
  const [release, setRelease] = useState<{ packageName: string; version: string } | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
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
      const rows = data.repositories.map(value => { const row = objectValue(value); if (typeof row.id !== 'string' || !repositoryUuid.test(row.id) || typeof row.name !== 'string' || typeof row.status !== 'string') throw new Error('The repository catalog is invalid.'); return { id: row.id, name: row.name, status: row.status, snapshotId: typeof row.snapshotId === 'string' ? row.snapshotId : null }; });
      if (!controller.signal.aborted) { setRepositories(rows); setRepositoryId(current => rows.some(item => item.id === current && (item.snapshotId || item.status === 'complete')) ? current : rows.find(item => item.snapshotId || item.status === 'complete')?.id ?? ''); }
    }).catch(error => { if (!controller.signal.aborted) { setRepositoryError(messageOf(error)); if (error instanceof RepositoryRequestError && error.status === 401) onSessionChanged(); } });
    return () => controller.abort();
  }, [workspaceId, refresh, onSessionChanged]);
  useEffect(() => {
    const controller = new AbortController(); setRelease(null); setReleaseError(null);
    if (!repositoryId) return () => controller.abort();
    repositoryRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/map?limit=1`, { signal: controller.signal }).then(({ data }) => {
      const index = readRepositoryGraphPage(data.index, repositoryId, account);
      if (!index.packageName || !index.version) throw new Error('This repository has no exact npm package release. Its commit map is available, but it cannot publish npm versioned knowledge.');
      if (!controller.signal.aborted) setRelease({ packageName: index.packageName, version: index.version });
    }).catch(error => { if (!controller.signal.aborted) { setReleaseError(messageOf(error)); if (error instanceof RepositoryRequestError && [401, 403].includes(error.status)) onSessionChanged(); } });
    return () => controller.abort();
  }, [repositoryId, account, onSessionChanged]);
  const updated = useCallback((draft: PublicationDraft) => { setSelected(draft); setDrafts(current => current?.map(item => item.id === draft.id ? draft : item) ?? null); }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!admin || !repositoryId || !release || createAbort.current || createUncertain || editingBusy) return;
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
    <form className="settings-card" style={cardStyle} aria-label="Create private publication draft" onSubmit={event => void create(event)}><div><h2>Create a private draft</h2><p>Requires workspace administration and current GitHub repository ownership or administrator permission.</p></div>{!admin && <p role="status">Your workspace role cannot administer publication drafts.</p>}{repositoryError ? <p className="inline-error" role="alert">{repositoryError}</p> : repositories === null ? <p role="status">Loading authorized repositories…</p> : repositories.some(item => item.snapshotId || item.status === 'complete') ? <label htmlFor="publication-repository">Indexed repository<select id="publication-repository" value={repositoryId} onChange={event => setRepositoryId(event.target.value)} disabled={creating || editingBusy || !admin || createUncertain} style={inputStyle}>{repositories.filter(item => item.snapshotId || item.status === 'complete').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : <p>No completed repository snapshot is available. <Link href="/app/repositories">Import a repository</Link> first.</p>}{releaseError && <p className="inline-error" role="alert">{releaseError}</p>}{repositoryId && !release && !releaseError && <p role="status">Checking exact package release…</p>}{release && <p className="quiet-label">{release.packageName}@{release.version}</p>}<button className="button primary" style={{ justifySelf: 'start' }} disabled={!admin || !repositoryId || !release || creating || editingBusy || createUncertain || drafts === null} type="submit">{creating ? <LoaderCircle className="spin" size={15} /> : <FileCode2 size={15} />}Create private draft</button>{createError && <p className="inline-error" role="alert">{createError}</p>}</form>
    <section aria-label="Private publication drafts" style={{ marginTop: 28 }}><div className="section-toolbar"><h2 style={{ fontSize: 14 }}>Saved drafts</h2><button className="button secondary" disabled={creating || editingBusy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />Refresh draft catalog</button></div>{catalogError ? <div className="unavailable-state" role="alert"><CircleAlert size={20} /><h2>Draft catalog unavailable</h2><p>{catalogError}</p></div> : drafts === null ? <div className="empty-card" role="status"><LoaderCircle className="spin" size={20} /><p>Loading private drafts…</p></div> : drafts.length === 0 ? <div className="empty-card"><p>No publication drafts in this workspace.</p></div> : <ul className="activity-list">{drafts.map(draft => <li key={draft.id}><FileCode2 size={17} /><div className="activity-body"><div style={{ flexWrap: 'wrap' }}><strong style={{ overflowWrap: 'anywhere' }}>{draft.proposal.packageName}@{draft.proposal.version}</strong><span className="status-tag">{draft.state}</span></div><p>Revision {draft.revision} · {draft.preview.fileCount} selected files</p></div><button className="button secondary" aria-pressed={selected?.id === draft.id} disabled={creating || editingBusy} onClick={() => open(draft)}>Open draft</button></li>)}</ul>}</section>
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
  return <main id="main" className="content-page publication-editor"><header className="page-header"><div><h1>Prepare a knowledge service</h1><p>Review repository rights, exact version, selected source, and testnet terms.</p></div></header><div className="notice"><ShieldCheck size={19} /><div><strong>Publication requires separate approval</strong><p>Draft changes stay private until you approve exposing the saved revision.</p></div></div>{error ? <div className="unavailable-state" role="alert" style={{ marginTop: 24 }}><CircleAlert size={20} /><h2>{needsSignIn ? 'Sign in to manage drafts' : 'Workspace unavailable'}</h2><p>{error}</p>{needsSignIn ? <Link className="button primary" href="/sign-in">Sign in</Link> : <button className="button secondary" onClick={refreshAccount}>Retry account request</button>}</div> : account ? <RepositorySessionBoundary principalId={account.principalId} onSessionChanged={refreshAccount}>{account.workspaces.length === 0 ? <div className="empty-card" style={{ marginTop: 24 }}><h2>No workspace available</h2><p>Import a repository before preparing a draft.</p><Link className="button secondary" href="/app/repositories">Open repositories</Link></div> : <><label htmlFor="publication-workspace" style={{ display: 'block', marginTop: 24 }}>Workspace<select id="publication-workspace" value={workspaceId} disabled={draftBusy} onChange={event => { if (!dirty || window.confirm('Discard unsaved draft changes and change workspace?')) setWorkspaceId(event.target.value); }} style={inputStyle}>{account.workspaces.map(item => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label><WorkspaceDrafts key={`${account.principalId}:${workspaceId}`} account={account} workspaceId={workspaceId} onSessionChanged={refreshAccount} dirty={dirty} onDirtyChange={setDirty} onBusyChange={setDraftBusy} /></>}</RepositorySessionBoundary> : <div className="empty-card" role="status" style={{ marginTop: 24 }}><LoaderCircle className="spin" size={20} /><p>Loading your workspace…</p></div>}</main>;
}
