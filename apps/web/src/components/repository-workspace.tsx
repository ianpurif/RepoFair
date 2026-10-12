'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, KeyboardEvent, PointerEvent } from 'react';
import { parseImportJob, type GraphNode, type ImportJob, type LocalAnswer, type ParsedEdge, type RepositoryGraphPage, type SourceEvidence } from '@atlas/contracts';
import { ArrowLeft, ArrowRight, ArrowUp, BookOpen, Box, Braces, ChevronDown, ChevronRight, CircleAlert, FileCode2, Folder, GitBranch, List, LoaderCircle, Network, RefreshCw, Search, X } from 'lucide-react';
import { expansionKey, GraphCanvas, nodePath } from './graph-canvas';
import { readRepositoryAccount, repositoryRequest, RepositoryRequestError, RepositorySessionBoundary, type RepositoryAccount } from './repository-browser';
import { BROWSER_NODE_LIMIT, mergeRepositoryGraphPages, readRepositoryAnswer, readRepositoryCitation, readRepositoryGraphPage } from './repository-data';

type MobilePanel = 'explorer' | 'map' | 'inspector';
type SourceSelection = { path: string; startLine: number; endLine: number };
const SOURCE_PAGE_LINES = 120;
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';
const phaseNames = { discovering: 'Discovering files', downloading: 'Reading source', parsing: 'Parsing source', publishing: 'Saving snapshot', complete: 'Complete' };
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;

function ResizeHandle({ label, value, minimum, maximum, onChange, reverse = false }: { label: string; value: number; minimum: number; maximum: number; onChange: (value: number) => void; reverse?: boolean }) {
  const drag = useRef<{ x: number; value: number } | null>(null);
  const clamp = (value: number) => Math.max(minimum, Math.min(maximum, value));
  function key(event: KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0;
    if (!delta && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault(); onChange(event.key === 'Home' ? minimum : event.key === 'End' ? maximum : clamp(value + delta * (reverse ? -1 : 1)));
  }
  function move(event: PointerEvent<HTMLDivElement>) { if (drag.current) onChange(clamp(drag.current.value + (event.clientX - drag.current.x) * (reverse ? -1 : 1))); }
  return <div className="resize-handle" role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)} pixels. Use left and right arrow keys to resize.`} onKeyDown={key} onPointerDown={event => { drag.current = { x: event.clientX, value }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={move} onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = null; }}><span /></div>;
}

function ImportProgress({ job, error, busy, uncertain, hasMap, onAction, onRefresh }: { job: ImportJob | null; error: string | null; busy: boolean; uncertain: boolean; hasMap: boolean; onAction: (action: 'cancel' | 'retry') => void; onRefresh: () => void }) {
  if (!job && !error) return null;
  const active = job?.status === 'queued' || job?.status === 'running';
  const loaded = job ? job.progress.downloaded + job.progress.reused : 0;
  return <section className={`import-progress ${job?.status ?? 'unavailable'}`} aria-label="Repository import progress">
    <div className="import-progress-heading"><span className="job-status">{active ? <LoaderCircle className="spin" size={14} /> : job?.status === 'failed' || error ? <CircleAlert size={14} /> : <GitBranch size={14} />}<strong>{job ? `Import ${job.status}` : 'Import status unavailable'}</strong>{job && <span>{phaseNames[job.phase]}</span>}</span><div className="import-actions">{job?.canCancel && <button className="text-button" disabled={busy || uncertain} onClick={() => onAction('cancel')}>Cancel import</button>}{job?.canRetry && <button className="button secondary" disabled={busy || uncertain} onClick={() => onAction('retry')}>{busy ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}Retry import</button>}<button className="icon-button" disabled={busy} aria-label="Refresh import status" onClick={onRefresh}><RefreshCw size={14} /></button></div></div>
    {job && <><div className="import-counters"><span>{job.progress.discovered} discovered</span><span>{loaded}{job.progress.eligible === null ? '' : ` / ${job.progress.eligible}`} files read</span><span>{job.progress.reused} reused</span><span>{job.progress.parsed} parsed</span><span>{job.progress.skipped} skipped</span><span>{formatBytes(job.progress.bytesProcessed)}{job.progress.bytesTotal === null ? '' : ` / ${formatBytes(job.progress.bytesTotal)}`}</span></div>{active && job.phase === 'downloading' && <progress aria-label="Committed source download progress" max={Math.max(1, job.progress.eligible ?? 1)} {...(job.progress.eligible === null ? {} : { value: loaded })} />}{hasMap && active && <p>Viewing the last completed snapshot while this import runs.</p>}{job.nextAttemptAt && active && <p role="status">Next attempt scheduled for <time dateTime={job.nextAttemptAt}>{new Date(job.nextAttemptAt).toLocaleString()}</time>.</p>}{job.error && <p className="inline-error">{job.error.code.replace(/-/g, ' ')}.{job.error.action === 'reconnect-github' || job.error.action === 'install-app' ? <> <Link href="/app/repositories">Review GitHub access</Link>.</> : job.error.action === 'reduce-scope' ? ' Reduce the import scope before retrying.' : job.error.action === 'contact-admin' ? ' Contact your workspace administrator.' : ''}</p>}<details><summary>Import details</summary><p>Attempt {job.attempts} · Updated <time dateTime={job.updatedAt}>{new Date(job.updatedAt).toLocaleString()}</time></p><code>{job.commitSha}</code></details></>}
    {error && <p className="inline-error" role="alert">{error}</p>}{uncertain && <p role="status">Refresh status before another import action.</p>}
  </section>;
}

function SourceView({ index, source, busy, error, onRange, onRetry }: { index: RepositoryGraphPage; source: SourceEvidence | null; busy: boolean; error: string | null; onRange: (selection: SourceSelection) => void; onRetry: () => void }) {
  if (busy) return <div className="panel-state" role="status"><LoaderCircle className="spin" size={22} /><h3>Loading source lines</h3><p>Checking the selected range at this commit.</p></div>;
  if (error) return <div className="panel-state error" role="alert"><CircleAlert size={22} /><h3>Source unavailable</h3><p>{error}</p><button className="button secondary" onClick={onRetry}>Retry source request</button></div>;
  if (!source) return <div className="panel-state"><BookOpen size={27} /><h3>Follow the source</h3><p>Select a file, symbol, or relationship to open its original lines.</p></div>;
  const { path, startLine, endLine } = source.source;
  const file = index.files.find(item => item.path === path);
  const lines = source.original.replace(/\r\n/g, '\n').split('\n');
  return <div className="source-view"><div className="source-file-heading"><FileCode2 size={15} /><strong>{path}</strong><span>L{startLine}–{endLine}</span></div><div className="code-block" tabIndex={0} role="region" aria-label={`${path}, lines ${startLine} through ${endLine}. Scroll horizontally to read source.`}><pre>{lines.map((line, offset) => <div className="code-line" key={startLine + offset}><span className="line-number" aria-hidden="true">{startLine + offset}</span><code>{line || ' '}</code></div>)}</pre></div><nav className="source-range-controls" aria-label="Source line ranges">{startLine > 1 && <button className="text-button" onClick={() => onRange({ path, startLine: Math.max(1, startLine - SOURCE_PAGE_LINES), endLine: startLine - 1 })}><ArrowLeft size={13} />Previous lines</button>}{file && endLine < file.lineCount && <button className="text-button" onClick={() => onRange({ path, startLine: endLine + 1, endLine: Math.min(file.lineCount, endLine + SOURCE_PAGE_LINES) })}>Next lines <ArrowRight size={13} /></button>}</nav><div className="provenance-card"><h3>Source provenance</h3><dl><div><dt>Snapshot</dt><dd>{index.snapshot.snapshotId}</dd></div><div><dt>Origin</dt><dd>{source.provenance}</dd></div><div><dt>Provider</dt><dd>Authorized repository source</dd></div></dl><details><summary>Immutable Git commit</summary><code>{index.snapshot.revision}</code></details><details><summary>Source evidence identifier</summary><code>{source.id}</code></details></div></div>;
}

function AnswerView({ answer, busy, error, onCitation }: { answer: LocalAnswer | null; busy: boolean; error: string | null; onCitation: (citation: SourceEvidence) => void }) {
  if (busy) return <div className="panel-state" role="status"><LoaderCircle className="spin" size={22} /><h3>Retrieving source evidence</h3><p>Searching the selected commit and its parsed relationships.</p></div>;
  if (error) return <div className="panel-state error" role="alert"><CircleAlert size={22} /><h3>Lookup failed</h3><p>{error}</p></div>;
  if (!answer) return <div className="panel-state"><Search size={27} /><h3>Ask the codebase</h3><p>Find supporting context from the imported source.</p><span className="quiet-label">Source extraction</span></div>;
  return <div className="answer-view"><div className="answer-heading"><span className={`status-tag ${answer.status === 'abstained' ? 'unavailable' : 'available'}`}>{answer.status === 'abstained' ? 'Insufficient evidence' : 'Evidence retrieved'}</span><span className="quiet-label">Extractive</span></div><p className="answer-text">{answer.answer}</p><section className="answer-citations"><h3>Original sources <span>{answer.citations.length}</span></h3>{answer.citations.length === 0 ? <p className="quiet-label">No supporting source range was returned.</p> : answer.citations.map((citation, i) => <button className="citation" key={`${citation.id}:${i}`} onClick={() => onCitation(citation)}><span className="citation-number">{i + 1}</span><span><strong>{citation.source.path}</strong><small>{citation.source.revision.slice(0, 7)} · L{citation.source.startLine}–{citation.source.endLine}</small></span><ArrowRight size={14} /></button>)}</section>{answer.missingEvidence.length > 0 && <section className="limitations"><h3><CircleAlert size={14} /> Missing evidence</h3><ul>{answer.missingEvidence.map((item, i) => <li key={i}>{item}</li>)}</ul></section>}<p className="extractive-note">Static source relationships do not establish runtime behavior or confirmed breakage.</p>{answer.activities.length > 0 && <details className="retrieval-details"><summary>Retrieval operations</summary><ul>{answer.activities.map((activity, i) => <li key={`${activity.id}:${i}`}><span>{activity.operation}</span><span>{activity.status} · {activity.durationMs} ms</span></li>)}</ul></details>}</div>;
}

function GitWorkspace({ repositoryId, account, onSessionChanged }: { repositoryId: string; account: RepositoryAccount; onSessionChanged: () => void }) {
  const [index, setIndex] = useState<RepositoryGraphPage | null>(null);
  const [mapBusy, setMapBusy] = useState(true);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapRefresh, setMapRefresh] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [jobRefresh, setJobRefresh] = useState(0);
  const [jobBusy, setJobBusy] = useState(false);
  const [jobUncertain, setJobUncertain] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState('');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set());
  const [source, setSource] = useState<SourceEvidence | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<LocalAnswer | null>(null);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [inspectorTab, setInspectorTab] = useState<'source' | 'evidence'>('source');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('map');
  const [graphView, setGraphView] = useState<'map' | 'list'>('map');
  const [leftWidth, setLeftWidth] = useState(232);
  const [rightWidth, setRightWidth] = useState(354);
  const [pageBusy, setPageBusy] = useState(false);
  const [expansionBusy, setExpansionBusy] = useState<string | null>(null);
  const [expansionError, setExpansionError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const indexRef = useRef<RepositoryGraphPage | null>(null);
  const completion = useRef<string | null>(null);
  const sourceAbort = useRef<AbortController | null>(null);
  const questionAbort = useRef<AbortController | null>(null);
  const pageAbort = useRef<AbortController | null>(null);
  const expansionAbort = useRef<AbortController | null>(null);
  const jobMutation = useRef<AbortController | null>(null);
  const loadedNeighborhoods = useRef(new Set<string>());
  const inspectorScroll = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const lastSourceRequest = useRef<{ selection: SourceSelection; expected?: SourceEvidence } | null>(null);
  indexRef.current = index;
  const sessionFailure = useCallback((error: unknown) => { if (error instanceof RepositoryRequestError && [401, 403].includes(error.status)) onSessionChanged(); }, [onSessionChanged]);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300); return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const { data } = await repositoryRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/jobs`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const result = data.job === null ? null : parseImportJob(data.job);
        if (result && result.repositoryId !== repositoryId) throw new Error('The import status belongs to another repository.');
        setJob(result); setJobError(null); setJobUncertain(false);
        if (result?.status === 'complete' && completion.current !== result.id) { completion.current = result.id; if (indexRef.current?.snapshot.snapshotId !== result.snapshotId) setMapRefresh(value => value + 1); }
        timer = setTimeout(() => void poll(), result?.status === 'running' || result?.status === 'queued' ? 3_000 : 20_000);
      } catch (error) {
        if (controller.signal.aborted) return;
        setJobError(messageOf(error)); sessionFailure(error); timer = setTimeout(() => void poll(), 15_000);
      }
    }
    void poll(); return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [repositoryId, jobRefresh, sessionFailure]);

  const pendingJobId = job?.canCancel && (job.status === 'queued' || job.status === 'running') ? job.id : null;
  useEffect(() => {
    if (!pendingJobId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function advance() {
      try {
        const { data } = await repositoryRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/jobs`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'advance' }), signal: controller.signal,
        }, 120_000);
        if (controller.signal.aborted) return;
        const result = data.job === null ? null : parseImportJob(data.job);
        if (result && (result.repositoryId !== repositoryId || result.id !== pendingJobId)) { setJobRefresh(value => value + 1); return; }
        setJob(result);
        if (result?.status === 'complete') {
          if (completion.current !== result.id) { completion.current = result.id; setMapRefresh(value => value + 1); }
          return;
        }
        if (!result || !['queued', 'running'].includes(result.status)) return;
        timer = setTimeout(() => void advance(), 3_000);
      } catch (error) {
        if (controller.signal.aborted) return;
        setJobError(messageOf(error));
        if (error instanceof RepositoryRequestError && error.status === 403) return;
        sessionFailure(error);
        timer = setTimeout(() => void advance(), 15_000);
      }
    }
    void advance();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [repositoryId, pendingJobId, sessionFailure]);

  useEffect(() => {
    const controller = new AbortController(); pageAbort.current?.abort(); pageAbort.current = null; expansionAbort.current?.abort(); expansionAbort.current = null; setPageBusy(false); setExpansionBusy(null); setExpansionError(null); setMapBusy(true); setMapError(null);
    const params = new URLSearchParams({ limit: '120' }); if (folder) params.set('folder', folder); if (query) params.set('query', query);
    repositoryRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/map?${params}`, { signal: controller.signal }).then(({ response, data }) => {
      if (controller.signal.aborted) return;
      if (response.status === 202) { setMapBusy(false); return; }
      const result = readRepositoryGraphPage(data.index, repositoryId, account);
      if (indexRef.current?.snapshot.snapshotId !== result.snapshot.snapshotId || indexRef.current?.scope.permissionRevision !== result.scope.permissionRevision) {
        sourceAbort.current?.abort(); sourceAbort.current = null; questionAbort.current?.abort(); questionAbort.current = null; lastSourceRequest.current = null; loadedNeighborhoods.current.clear();
        setSource(null); setSourceBusy(false); setSourceError(null); setSelectedNode(null); setAnswer(null); setAnswerBusy(false); setAnswerError(null); setExpandedPaths(new Set());
      }
      setIndex(result); setMapBusy(false);
    }).catch(error => { if (!controller.signal.aborted) { setMapError(messageOf(error)); setMapBusy(false); sessionFailure(error); } });
    return () => controller.abort();
  }, [repositoryId, account, folder, query, mapRefresh, sessionFailure]);

  useEffect(() => () => { sourceAbort.current?.abort(); questionAbort.current?.abort(); pageAbort.current?.abort(); expansionAbort.current?.abort(); jobMutation.current?.abort(); }, []);
  useEffect(() => {
    function shortcut(event: globalThis.KeyboardEvent) {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName))) return;
      event.preventDefault(); setMobilePanel('explorer'); requestAnimationFrame(() => searchRef.current?.focus());
    }
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => { inspectorScroll.current?.scrollTo({ top: 0 }); }, [source, inspectorTab, answer, answerBusy]);
  useEffect(() => { if (mobilePanel === 'inspector' && window.matchMedia('(max-width: 1080px)').matches) inspectorRef.current?.focus(); }, [mobilePanel]);

  const lookup = useMemo(() => {
    const nodes = new Map(index?.nodes.map(node => [node.id, node]) ?? []);
    const evidence = new Map(index?.evidence.map(item => [item.id, item]) ?? []);
    const symbols = new Map<string, GraphNode[]>();
    for (const node of index?.nodes ?? []) if (node.kind === 'symbol') { const path = nodePath(node)!; const group = symbols.get(path) ?? []; group.push(node); symbols.set(path, group); }
    return { nodes, evidence, symbols };
  }, [index]);
  const fileNodes = index?.nodes.filter(node => node.kind === 'file') ?? [];
  const symbolNodes = index?.nodes.filter(node => node.kind === 'symbol') ?? [];
  const packageNodes = index?.nodes.filter(node => node.kind === 'package' && node.localId !== `package:${index.packageName}@${index.version}`) ?? [];
  const childFolders = useMemo(() => (index?.folders ?? []).filter(item => item.path && item.path !== '.' && (folder ? item.path.startsWith(`${folder}/`) && !item.path.slice(folder.length + 1).includes('/') : !item.path.includes('/'))).slice(0, 120), [index, folder]);
  const selectedDependency = selectedNode?.kind === 'package' ? index?.dependencies.find(item => selectedNode.localId === `package:${item.packageName}@${item.version ?? 'unresolved'}`) : null;
  const layoutStyle = { '--explorer-width': `${leftWidth}px`, '--inspector-width': `${rightWidth}px` } as CSSProperties;

  async function openSource(selection: SourceSelection, expected?: SourceEvidence) {
    const pinned = indexRef.current; if (!pinned) return;
    lastSourceRequest.current = { selection, ...(expected ? { expected } : {}) };
    sourceAbort.current?.abort(); const controller = new AbortController(); sourceAbort.current = controller;
    setSource(null); setSourceError(null); setSourceBusy(true); setInspectorTab('source'); setMobilePanel('inspector');
    try {
      const params = new URLSearchParams({ snapshotId: pinned.snapshot.snapshotId, path: selection.path, startLine: String(selection.startLine), endLine: String(selection.endLine) });
      const { data } = await repositoryRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/source?${params}`, { signal: controller.signal });
      const checked = readRepositoryCitation(data.evidence, pinned);
      const expectedText = expected?.original.replace(/\r\n/g, '\n').split('\n').slice(selection.startLine - expected.source.startLine, selection.endLine - expected.source.startLine + 1).join('\n');
      if (checked.source.path !== selection.path || checked.source.startLine !== selection.startLine || checked.source.endLine !== selection.endLine || expected && checked.original !== expectedText) throw new Error('The source response does not match the requested citation and lines.');
      if (!controller.signal.aborted) setSource(checked);
    } catch (error) { if (!controller.signal.aborted) { setSourceError(messageOf(error)); sessionFailure(error); } }
    finally { if (!controller.signal.aborted) { setSourceBusy(false); sourceAbort.current = null; } }
  }

  function openCitation(citation: SourceEvidence) {
    if (!index) return;
    try { const checked = readRepositoryCitation(citation, index); setSelectedNode(index.nodes.find(node => node.kind === 'file' && node.localId === checked.source.path) ?? null); void openSource({ ...checked.source, endLine: Math.min(checked.source.endLine, checked.source.startLine + SOURCE_PAGE_LINES - 1) }, checked); }
    catch (error) { setSource(null); setSourceError(messageOf(error)); setInspectorTab('source'); setMobilePanel('inspector'); }
  }

  async function loadNeighborhood(node: GraphNode) {
    const pinned = indexRef.current; if (!pinned || !lookup.nodes.has(node.id)) return;
    const key = expansionKey(node);
    setExpandedPaths(current => new Set(current).add(key));
    if (loadedNeighborhoods.current.has(key) && lookup.symbols.has(nodePath(node) ?? '')) return;
    expansionAbort.current?.abort(); const controller = new AbortController(); expansionAbort.current = controller; setExpansionBusy(node.id); setExpansionError(null);
    try {
      const params = new URLSearchParams({ snapshotId: pinned.snapshot.snapshotId, nodeId: node.id, limit: '120' });
      const { data } = await repositoryRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/map?${params}`, { signal: controller.signal });
      const result = readRepositoryGraphPage(data.index, repositoryId, account, pinned.snapshot.snapshotId);
      if (!controller.signal.aborted) { setIndex(current => current ? { ...mergeRepositoryGraphPages(current, result), page: current.page, folders: current.folders } : result); loadedNeighborhoods.current.add(key); }
    } catch (error) { if (!controller.signal.aborted) { setExpansionError(messageOf(error)); sessionFailure(error); } }
    finally { if (!controller.signal.aborted) { setExpansionBusy(null); expansionAbort.current = null; } }
  }

  function selectNode(node: GraphNode) {
    if (!index || !lookup.nodes.has(node.id)) return;
    setSelectedNode(node); setSourceError(null); setSource(null); setInspectorTab('source'); setMobilePanel('inspector');
    if (node.kind === 'package') { sourceAbort.current?.abort(); setSourceBusy(false); return; }
    const path = nodePath(node)!; const file = index.files.find(item => item.path === path);
    const origin = node.kind === 'symbol' ? index.edges.find(edge => edge.to === node.id && (edge.relation === 'exports' || String(edge.relation) === 'declares')) : null;
    const citation = origin ? lookup.evidence.get(origin.evidenceId) : undefined;
    const startLine = citation?.source.startLine ?? (node.kind === 'symbol' ? Number(node.localId.match(/@(\d+):\d+$/)?.[1] ?? 1) : 1);
    void openSource({ path, startLine, endLine: Math.min(citation?.source.endLine ?? file?.lineCount ?? startLine + 49, startLine + SOURCE_PAGE_LINES - 1) }, citation);
    if (node.kind === 'file') void loadNeighborhood(node); else setExpandedPaths(current => new Set(current).add(expansionKey(node)));
  }

  function selectEdge(edge: ParsedEdge) {
    const citation = lookup.evidence.get(edge.evidenceId);
    if (citation) openCitation(citation); else { setSource(null); setSourceError('Origin evidence is unavailable for this relationship.'); setInspectorTab('source'); setMobilePanel('inspector'); }
  }

  async function loadMore() {
    const pinned = indexRef.current; if (!pinned || pinned.page.nextCursor === null || pageAbort.current || pinned.nodes.length >= BROWSER_NODE_LIMIT) return;
    const controller = new AbortController(); pageAbort.current = controller; setPageBusy(true); setMapError(null);
    try {
      const params = new URLSearchParams({ snapshotId: pinned.snapshot.snapshotId, cursor: String(pinned.page.nextCursor), limit: '120' }); if (folder) params.set('folder', folder); if (query) params.set('query', query);
      const { data } = await repositoryRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/map?${params}`, { signal: controller.signal });
      const result = readRepositoryGraphPage(data.index, repositoryId, account, pinned.snapshot.snapshotId);
      if (!controller.signal.aborted) setIndex(current => current ? mergeRepositoryGraphPages(current, result) : result);
    } catch (error) { if (!controller.signal.aborted) { setMapError(messageOf(error)); sessionFailure(error); } }
    finally { if (!controller.signal.aborted) { pageAbort.current = null; setPageBusy(false); } }
  }

  async function importAction(action: 'cancel' | 'retry') {
    if (!job || jobMutation.current || jobUncertain) return;
    const controller = new AbortController(); jobMutation.current = controller; setJobBusy(true); setJobError(null);
    try {
      const { data } = await repositoryRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, jobId: job.id }), signal: controller.signal });
      const result = parseImportJob(data.job); if (result.repositoryId !== repositoryId) throw new Error('The import response belongs to another repository.');
      if (!controller.signal.aborted) { setJob(result); setJobRefresh(value => value + 1); }
    } catch (error) { if (!controller.signal.aborted) { setJobError(messageOf(error)); setJobUncertain(!(error instanceof RepositoryRequestError) || error.status === 409); sessionFailure(error); } }
    finally { if (!controller.signal.aborted) { jobMutation.current = null; setJobBusy(false); } }
  }

  async function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!index || !question.trim() || questionAbort.current || answerBusy) return;
    const pinned = index; const controller = new AbortController(); questionAbort.current = controller;
    setAnswerBusy(true); setAnswer(null); setAnswerError(null); setInspectorTab('evidence'); setMobilePanel('inspector');
    try {
      const { data } = await repositoryRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/questions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: question.trim(), snapshotId: pinned.snapshot.snapshotId }), signal: controller.signal });
      const result = readRepositoryAnswer(data.answer, pinned); if (!controller.signal.aborted) setAnswer(result);
    } catch (error) { if (!controller.signal.aborted) { setAnswerError(messageOf(error)); sessionFailure(error); } }
    finally { if (!controller.signal.aborted) { questionAbort.current = null; setAnswerBusy(false); } }
  }

  const title = index?.packageName && index.version ? `${index.packageName} / ${index.version}` : 'Repository source';
  const pending = job?.status === 'running' || job?.status === 'queued';
  return <main id="main" className="workspace" style={layoutStyle}>
    <header className="workspace-header"><div className="repository-selector repository-title"><GitBranch size={17} /><strong title={title}>{title}</strong>{index && <code title={index.snapshot.revision}>{index.snapshot.revision.slice(0, 7)}</code>}</div><span className="status-tag">Git snapshot</span><div className="header-right"><span className="job-status" role="status">{mapBusy ? <><LoaderCircle size={13} className="spin" />Loading map</> : index ? <><span className="status-dot" />Snapshot ready</> : pending ? 'Import in progress' : 'Map unavailable'}</span><Link className="text-button" href="/app/repositories">Repositories <ArrowRight size={13} /></Link></div></header>
    <ImportProgress job={job} error={jobError} busy={jobBusy} uncertain={jobUncertain} hasMap={!!index} onAction={action => void importAction(action)} onRefresh={() => setJobRefresh(value => value + 1)} />
    <nav className="mobile-panels" aria-label="Workspace panels">{(['explorer', 'map', 'inspector'] as const).map(panel => <button key={panel} className={mobilePanel === panel ? 'active' : ''} aria-pressed={mobilePanel === panel} onClick={() => setMobilePanel(panel)}>{panel === 'explorer' ? <Folder size={15} /> : panel === 'map' ? <Network size={15} /> : <BookOpen size={15} />}{panel === 'explorer' ? 'Repository' : panel === 'map' ? 'Map' : 'Evidence'}</button>)}</nav>
    <div className="workspace-panels" data-mobile-panel={mobilePanel}>
      <aside className="repository-panel" aria-label="Repository explorer"><div className="panel-heading"><h2>Repository</h2><span className="quiet-label">{index?.page.totalFiles ?? '—'} files</span></div><div className="search-field"><Search size={14} /><input ref={searchRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Find files or symbols" aria-label="Search files and symbols" disabled={!index} /><kbd>/</kbd>{search && <button className="icon-button" onClick={() => setSearch('')} aria-label="Clear search"><X size={13} /></button>}</div><div className="explorer-scroll">
        {folder && <button className="folder-up text-button" onClick={() => setFolder(folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '')}><ArrowLeft size={13} />{folder}</button>}
        {index && <>{childFolders.map(item => <button className="tree-select folder-choice" key={item.path} onClick={() => setFolder(item.path)}><Folder size={14} /><span>{item.path.slice(folder.length ? folder.length + 1 : 0)}</span><small>{item.fileCount}</small></button>)}{fileNodes.map(node => { const symbols = lookup.symbols.get(node.localId) ?? []; const expanded = expandedPaths.has(expansionKey(node)); return <div className="tree-file" key={node.id}><div className={`tree-row ${selectedNode?.id === node.id ? 'selected' : ''}`}><button className="tree-expander" disabled={expansionBusy === node.id} onClick={() => { if (expanded) setExpandedPaths(current => { const next = new Set(current); next.delete(expansionKey(node)); return next; }); else void loadNeighborhood(node); }} aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.localId} symbols`}>{expansionBusy === node.id ? <LoaderCircle className="spin" size={12} /> : expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button><button className="tree-select" onClick={() => selectNode(node)} title={node.localId}><FileCode2 size={14} /><span>{node.label}</span></button></div>{expanded && symbols.map(symbol => <button className={`tree-symbol ${selectedNode?.id === symbol.id ? 'selected' : ''}`} key={symbol.id} onClick={() => selectNode(symbol)}><Braces size={12} /><span>{symbol.label}</span></button>)}</div>; })}{query && symbolNodes.length > 0 && <><div className="section-label">Matching symbols</div>{symbolNodes.map(node => <button className="tree-symbol search-result" key={node.id} onClick={() => selectNode(node)}><Braces size={12} /><span>{node.label}<small>{nodePath(node)}</small></span></button>)}</>}{packageNodes.length > 0 && <><div className="section-label">External dependencies</div>{packageNodes.map(node => <button className={`dependency-row ${selectedNode?.id === node.id ? 'selected' : ''}`} key={node.id} onClick={() => selectNode(node)}><Box size={14} /><span>{node.label}</span></button>)}</>}{!mapBusy && query && index.nodes.length === 0 && <div className="empty-search"><Search size={20} /><p>No files or symbols match “{query}”.</p><button className="text-button" onClick={() => setSearch('')}>Clear search</button></div>}{index.page.nextCursor !== null && <div className="load-more"><button className="button secondary" disabled={pageBusy || mapBusy || index.nodes.length >= BROWSER_NODE_LIMIT} onClick={() => void loadMore()}>{pageBusy && <LoaderCircle className="spin" size={13} />}Load more files</button>{index.nodes.length >= BROWSER_NODE_LIMIT && <p>Choose a folder or search to load another part of this repository.</p>}</div>}</>}
        {mapBusy && <div className="explorer-loading" role="status"><LoaderCircle className="spin" size={15} />Loading map…</div>}{expansionError && <p className="inline-error" role="alert">{expansionError}</p>}
      </div><div className="snapshot-info"><span>{index ? 'Immutable Git snapshot' : 'Awaiting completed snapshot'}</span>{index && <code title={index.snapshot.revision}>{index.snapshot.revision}</code>}</div></aside>
      <ResizeHandle label="Resize repository explorer" value={leftWidth} minimum={184} maximum={360} onChange={setLeftWidth} />
      <section className="map-panel" aria-label="Codebase map"><div className="map-toolbar"><div><h2>Codebase map</h2><span>{index ? `${index.nodes.length} loaded nodes · ${index.edges.length} loaded relationships` : 'Repository source relationships'}</span></div><div className="map-toolbar-actions"><button className="icon-button" aria-label="Refresh map" disabled={mapBusy} onClick={() => setMapRefresh(value => value + 1)}><RefreshCw size={14} /></button><div className="segmented-control" aria-label="Map view"><button aria-pressed={graphView === 'map'} className={graphView === 'map' ? 'active' : ''} onClick={() => setGraphView('map')}><Network size={14} /><span>Map</span></button><button aria-pressed={graphView === 'list'} className={graphView === 'list' ? 'active' : ''} onClick={() => setGraphView('list')}><List size={14} /><span>List</span></button></div></div></div>
        {mapError && index && <div className="stale-banner" role="alert"><CircleAlert size={14} /><span>{mapError} The loaded snapshot remains available.</span></div>}
        <div className="map-body">{!index ? <div className={`canvas-state ${mapError ? 'error' : ''}`} role={mapError ? 'alert' : 'status'}>{mapBusy || pending ? <LoaderCircle className="spin" size={26} /> : <CircleAlert size={26} />}<h2>{mapError ? 'Map unavailable' : mapBusy ? 'Loading repository map' : pending ? 'Import in progress' : 'No completed snapshot'}</h2><p>{mapError ?? (pending ? 'Committed import progress is shown above. The map opens after indexing completes.' : 'No completed source map is available for this repository.')}</p>{!mapBusy && <button className="button secondary" onClick={() => { setMapRefresh(value => value + 1); setJobRefresh(value => value + 1); }}>Refresh snapshot</button>}</div> : index.nodes.length === 0 ? <div className="canvas-state"><Folder size={26} /><h2>{query ? 'No matching source' : 'No graph nodes in this selection'}</h2><p>Choose another folder or clear the search.</p></div> : graphView === 'map' ? <GraphCanvas key={index.snapshot.snapshotId} index={index} expandedPaths={expandedPaths} selectedId={selectedNode?.id ?? null} highlightedEdges={answer?.edgeIds ?? []} onSelect={selectNode} onEdgeSelect={selectEdge} /> : <div className="graph-list"><div className="section-label">Loaded nodes · select to inspect</div>{index.nodes.map(node => <button className={`graph-list-node ${selectedNode?.id === node.id ? 'selected' : ''}`} key={node.id} onClick={() => selectNode(node)}>{node.kind === 'file' ? <FileCode2 size={15} /> : node.kind === 'symbol' ? <Braces size={15} /> : <Box size={15} />}<span><strong>{node.label}</strong><small>{node.kind} · {index.snapshot.revision.slice(0, 7)}</small></span><ArrowRight size={13} /></button>)}<div className="section-label">Parsed relationships · inspect origin</div>{index.edges.map(edge => <button className="relationship-row" key={edge.id} onClick={() => selectEdge(edge)}><span>{lookup.nodes.get(edge.from)?.label}<small>{edge.relation} → {lookup.nodes.get(edge.to)?.label}</small></span><ArrowRight size={13} /></button>)}</div>}</div><div className="map-note"><GitBranch size={12} /><span>Static relationships show potential impact. Runtime behavior is not verified.</span></div><form className="question-composer" onSubmit={event => void submitQuestion(event)}><label htmlFor="repository-question">Ask this codebase</label><div className="composer-input"><textarea id="repository-question" rows={2} value={question} maxLength={2000} onChange={event => setQuestion(event.target.value)} placeholder="Which source handles failed jobs?" disabled={!index || answerBusy} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button className="send-button" type="submit" aria-label="Retrieve source evidence" disabled={!question.trim() || !index || answerBusy}>{answerBusy ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}</button></div><div className="composer-meta"><span>Source extraction · commit {index?.snapshot.revision.slice(0, 7) ?? 'unavailable'}</span><span className="composer-shortcut">Ctrl / ⌘ + Enter</span></div></form></section>
      <ResizeHandle label="Resize evidence inspector" value={rightWidth} minimum={280} maximum={520} onChange={setRightWidth} reverse />
      <aside className="inspector-panel" aria-label="Source and evidence inspector" ref={inspectorRef} tabIndex={-1}>
        <div className="inspector-tabs"><button className={inspectorTab === 'source' ? 'active' : ''} aria-pressed={inspectorTab === 'source'} onClick={() => setInspectorTab('source')}><FileCode2 size={14} />Source</button><button className={inspectorTab === 'evidence' ? 'active' : ''} aria-pressed={inspectorTab === 'evidence'} onClick={() => setInspectorTab('evidence')}><BookOpen size={14} />Evidence{answer && <span>{answer.citations.length}</span>}</button></div>
        <div className="inspector-scroll" ref={inspectorScroll}>{inspectorTab === 'evidence' ? <AnswerView answer={answer} busy={answerBusy} error={answerError} onCitation={openCitation} /> : index ? selectedNode?.kind === 'package' ? <div className="package-inspector"><span className="node-type"><Box size={14} />Package reference</span><h2>{selectedNode.label}</h2><dl><div><dt>Version status</dt><dd>{selectedDependency?.status ?? 'Parsed package reference'}</dd></div><div><dt>Origin</dt><dd>{selectedDependency?.sourcePath ?? 'Repository package identity'}</dd></div><div><dt>External source</dt><dd>Not loaded</dd></div></dl>{selectedDependency?.reason && <p>{selectedDependency.reason}</p>}<Link className="text-button" href={selectedDependency?.version?'/app/providers?'+new URLSearchParams({packageName:selectedDependency.packageName,version:selectedDependency.version}):'/app/providers'}>Find a provider <ArrowRight size={13} /></Link></div> : <SourceView index={index} source={source} busy={sourceBusy} error={sourceError} onRange={selection => void openSource(selection)} onRetry={() => { const last = lastSourceRequest.current; if (last) void openSource(last.selection, last.expected); }} /> : <div className="panel-state"><BookOpen size={27} /><h3>Awaiting source</h3><p>Source appears after authorization and indexing complete.</p></div>}{index && <details className="index-limitations"><summary>Analysis limitations</summary><ul>{[...index.limitations, ...index.unresolved].map((item, i) => <li key={i}>{item}</li>)}</ul></details>}</div>
      </aside>
    </div><footer className="workspace-status"><span>{index ? 'Authorized Git source' : 'Awaiting completed source'}</span><span>{index ? `${index.files.length} loaded files · ${index.edges.length} loaded relationships` : 'No source delivered'}</span><Link href="/app/repositories">Repositories <ArrowRight size={11} /></Link></footer>
  </main>;
}

export function RepositoryWorkspace({ repositoryId }: { repositoryId: string }) {
  const [account, setAccount] = useState<RepositoryAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const refreshAccount = useCallback(() => { setAccount(null); setRefresh(value => value + 1); }, []);
  useEffect(() => {
    const controller = new AbortController(); setAccount(null); setError(null); setNeedsSignIn(false);
    repositoryRequest('/api/account', { signal: controller.signal }).then(({ data }) => { const result = readRepositoryAccount(data); if (!controller.signal.aborted) setAccount(result); }).catch(error => { if (!controller.signal.aborted) { setError(messageOf(error)); setNeedsSignIn(error instanceof RepositoryRequestError && error.status === 401); } });
    return () => controller.abort();
  }, [refresh, repositoryId]);
  if (account) return <RepositorySessionBoundary principalId={account.principalId} onSessionChanged={refreshAccount}><GitWorkspace key={`${account.principalId}:${repositoryId}`} repositoryId={repositoryId} account={account} onSessionChanged={refreshAccount} /></RepositorySessionBoundary>;
  return <main id="main" className="content-page"><header className="page-header"><div><h1>Repository workspace</h1></div><Link className="button secondary" href="/app/repositories">Repositories <ArrowRight size={14} /></Link></header>{error ? <div className="unavailable-state" role="alert"><CircleAlert size={22} /><h2>{needsSignIn ? 'Sign in to open repository source' : 'Workspace unavailable'}</h2><p>{error}</p>{needsSignIn ? <Link className="button primary" href="/sign-in">Sign in</Link> : <button className="button secondary" onClick={refreshAccount}>Retry account request</button>}</div> : <div className="empty-card" role="status"><LoaderCircle className="spin" size={22} /><p>Verifying your account…</p></div>}</main>;
}
