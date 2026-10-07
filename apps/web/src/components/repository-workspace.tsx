'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, KeyboardEvent, PointerEvent } from 'react';
import type { GraphNode, LocalAnswer, ParsedEdge, RepositoryIndex, SourceEvidence } from '@atlas/contracts';
import { ArrowRight, ArrowUp, BookOpen, Box, Braces, Check, ChevronDown, ChevronRight, CircleAlert, FileCode2, Folder, GitBranch, List, LoaderCircle, Network, Search, X } from 'lucide-react';
import { expansionKey, GraphCanvas, nodePath } from './graph-canvas';
import { objectValue, readRepositoryAccount, repositoryRequest, RepositoryRequestError, RepositorySessionBoundary, type RepositoryAccount } from './repository-browser';

type MobilePanel = 'explorer' | 'map' | 'inspector';
type SourceSelection = { path: string; startLine: number; endLine: number; evidence: SourceEvidence | null };
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';
const sourceLines = (text: string) => text.replace(/\r\n/g, '\n').split('\n');
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

/** Browser checks preserve the delivered snapshot boundary; the server authorizes every request. */
function readGitIndex(value: unknown, repositoryId: string, account: RepositoryAccount): RepositoryIndex {
  const row = objectValue(value); const scope = objectValue(row.scope); const snapshot = objectValue(row.snapshot);
  if (row.schemaVersion !== 1 || row.mode !== 'git' || snapshot.kind !== 'git' || snapshot.repositoryId !== repositoryId || typeof snapshot.snapshotId !== 'string' || !/^[0-9a-f]{40}$/i.test(String(snapshot.revision)) || scope.principalId !== account.principalId || !account.workspaces.some(item => item.id === scope.tenantId) || typeof scope.permissionRevision !== 'string' || typeof row.packageName !== 'string' || typeof row.version !== 'string' || !Array.isArray(row.files) || !Array.isArray(row.nodes) || !Array.isArray(row.edges) || !Array.isArray(row.evidence) || !Array.isArray(row.dependencies) || !stringList(row.unresolved) || !stringList(row.limitations)) throw new Error('The repository response does not match the authorized Git snapshot.');
  const files = new Map<string, string>();
  for (const value of row.files) {
    const file = objectValue(value);
    if (typeof file.path !== 'string' || typeof file.text !== 'string' || !Number.isSafeInteger(file.lineCount) || file.lineCount !== sourceLines(file.text).length || files.has(file.path)) throw new Error('The repository returned an invalid source file.');
    files.set(file.path, file.text);
  }
  const nodeIds = new Set<string>();
  for (const value of row.nodes) {
    const node = objectValue(value);
    if (typeof node.id !== 'string' || nodeIds.has(node.id) || typeof node.localId !== 'string' || typeof node.label !== 'string' || !['file', 'symbol', 'package'].includes(String(node.kind)) || node.repositoryId !== repositoryId || node.snapshotId !== snapshot.snapshotId || (node.kind === 'file' && !files.has(node.localId))) throw new Error('The repository returned an invalid graph node.');
    nodeIds.add(node.id);
  }
  const index = row as unknown as RepositoryIndex;
  const evidenceIds = new Set<string>();
  for (const value of row.evidence) {
    const citation = readCitation(value, index);
    if (evidenceIds.has(citation.id)) throw new Error('The repository returned duplicate source evidence.');
    evidenceIds.add(citation.id);
  }
  const edgeIds = new Set<string>();
  for (const value of row.edges) {
    const edge = objectValue(value);
    if (typeof edge.id !== 'string' || edgeIds.has(edge.id) || !nodeIds.has(String(edge.from)) || !nodeIds.has(String(edge.to)) || !evidenceIds.has(String(edge.evidenceId)) || edge.provenance !== 'parsed-source' || !['imports', 'exports', 'references', 'resolved-call', 'package-binding'].includes(String(edge.relation)) || !['ts-morph-import', 'ts-morph-export', 'ts-morph-reference', 'ts-morph-call', 'explicit-release-export'].includes(String(edge.extractionMethod))) throw new Error('The repository returned a relationship without valid source origin.');
    edgeIds.add(edge.id);
  }
  for (const value of row.dependencies) {
    const binding = objectValue(value);
    if (typeof binding.packageName !== 'string' || (binding.version !== null && typeof binding.version !== 'string') || typeof binding.sourcePath !== 'string' || !stringList(binding.importedNames) || !['exact', 'unresolved'].includes(String(binding.status)) || (binding.reason !== null && typeof binding.reason !== 'string')) throw new Error('The repository returned an invalid dependency binding.');
  }
  return index;
}

function readCitation(value: unknown, index: RepositoryIndex): SourceEvidence {
  const citation = objectValue(value); const source = objectValue(citation.source); const scope = objectValue(citation.scope);
  const file = index.files.find(item => item.path === source.path);
  if (typeof citation.id !== 'string' || typeof citation.original !== 'string' || typeof citation.observedAt !== 'string' || citation.providerId !== null || citation.provenance !== 'parsed-source' || source.kind !== 'git' || source.repositoryId !== index.snapshot.repositoryId || source.snapshotId !== index.snapshot.snapshotId || source.revision !== index.snapshot.revision || scope.tenantId !== index.scope.tenantId || scope.principalId !== index.scope.principalId || scope.permissionRevision !== index.scope.permissionRevision || !file || !Number.isSafeInteger(source.startLine) || !Number.isSafeInteger(source.endLine)) throw new Error('Source evidence does not belong to this authorized snapshot.');
  const startLine = Number(source.startLine); const endLine = Number(source.endLine);
  if (startLine < 1 || endLine < startLine || endLine > file.lineCount || citation.original !== sourceLines(file.text).slice(startLine - 1, endLine).join('\n')) throw new Error('The cited line range does not match the original source.');
  return citation as unknown as SourceEvidence;
}

function readAnswer(value: unknown, index: RepositoryIndex): LocalAnswer {
  const row = objectValue(value);
  if (row.schemaVersion !== 1 || row.mode !== 'extractive' || !['evidence_ready', 'abstained'].includes(String(row.status)) || typeof row.answer !== 'string' || !Array.isArray(row.citations) || !stringList(row.nodeIds) || !stringList(row.edgeIds) || !stringList(row.missingEvidence) || !Array.isArray(row.activities)) throw new Error('The server returned an invalid source retrieval response.');
  row.citations.forEach(citation => readCitation(citation, index));
  if (row.status === 'evidence_ready' && row.citations.length === 0) throw new Error('The response claims evidence without a supporting source range.');
  if (row.nodeIds.some(id => !index.nodes.some(node => node.id === id)) || row.edgeIds.some(id => !index.edges.some(edge => edge.id === id))) throw new Error('The answer references a different graph snapshot.');
  for (const value of row.activities) {
    const activity = objectValue(value);
    if (typeof activity.id !== 'string' || typeof activity.operation !== 'string' || typeof activity.startedAt !== 'string' || typeof activity.durationMs !== 'number' || !Number.isFinite(activity.durationMs) || activity.durationMs < 0 || !['complete', 'failed'].includes(String(activity.status)) || typeof activity.detail !== 'string') throw new Error('The server returned invalid retrieval operation details.');
  }
  return row as unknown as LocalAnswer;
}

function ResizeHandle({ label, value, minimum, maximum, onChange, reverse = false }: { label: string; value: number; minimum: number; maximum: number; onChange: (value: number) => void; reverse?: boolean }) {
  const drag = useRef<{ x: number; value: number } | null>(null);
  const clamp = (value: number) => Math.max(minimum, Math.min(maximum, value));
  function key(event: KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0;
    if (!delta && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    onChange(event.key === 'Home' ? minimum : event.key === 'End' ? maximum : clamp(value + delta * (reverse ? -1 : 1)));
  }
  function move(event: PointerEvent<HTMLDivElement>) { if (drag.current) onChange(clamp(drag.current.value + (event.clientX - drag.current.x) * (reverse ? -1 : 1))); }
  return <div className="resize-handle" role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)} pixels. Use left and right arrow keys to resize.`} onKeyDown={key} onPointerDown={event => { drag.current = { x: event.clientX, value }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={move} onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = null; }}><span /></div>;
}

function SourceView({ index, selection, error, onFullFile }: { index: RepositoryIndex; selection: SourceSelection | null; error: string | null; onFullFile: () => void }) {
  if (error) return <div className="panel-state error" role="alert"><CircleAlert size={22} /><h3>Source unavailable</h3><p>{error}</p></div>;
  if (!selection) return <div className="panel-state"><BookOpen size={27} /><h3>Follow the source</h3><p>Select a file, symbol, or relationship to inspect the original Git source.</p></div>;
  const file = index.files.find(item => item.path === selection.path);
  if (!file) return <div className="panel-state error" role="alert"><h3>Source unavailable</h3><p>The selected file is not in this snapshot.</p></div>;
  const lines = sourceLines(file.text).slice(selection.startLine - 1, selection.endLine);
  return <div className="source-view"><div className="source-file-heading"><FileCode2 size={15} /><strong>{file.path}</strong><span>L{selection.startLine}–{selection.endLine}</span></div><div className="code-block" tabIndex={0} role="region" aria-label={`${file.path}, lines ${selection.startLine} through ${selection.endLine}. Scroll horizontally to read source.`}><pre>{lines.map((line, offset) => <div className="code-line" key={offset}><span className="line-number" aria-hidden="true">{selection.startLine + offset}</span><code>{line || ' '}</code></div>)}</pre></div>{(selection.startLine !== 1 || selection.endLine !== file.lineCount) && <button className="text-button full-source" onClick={onFullFile}>Open full file <ArrowRight size={13} /></button>}<div className="provenance-card"><h3>Source provenance</h3><dl><div><dt>Repository</dt><dd>{index.snapshot.repositoryId}</dd></div><div><dt>Snapshot</dt><dd>{index.snapshot.snapshotId}</dd></div><div><dt>Origin</dt><dd>{selection.evidence?.provenance ?? 'Git snapshot file'}</dd></div><div><dt>Provider</dt><dd>Authorized repository source</dd></div></dl><details><summary>Immutable Git commit</summary><code>{index.snapshot.revision}</code></details>{selection.evidence && <details><summary>Source evidence identifier</summary><code>{selection.evidence.id}</code></details>}</div></div>;
}

function AnswerView({ answer, busy, error, onCitation }: { answer: LocalAnswer | null; busy: boolean; error: string | null; onCitation: (citation: SourceEvidence) => void }) {
  if (busy) return <div className="panel-state" role="status"><LoaderCircle className="spin" size={22} /><h3>Retrieving source evidence</h3><p>Searching this snapshot and its parsed relationships.</p></div>;
  if (error) return <div className="panel-state error" role="alert"><CircleAlert size={22} /><h3>Lookup failed</h3><p>{error}</p></div>;
  if (!answer) return <div className="panel-state"><Search size={27} /><h3>Ask the codebase</h3><p>Use the question composer to find context from the imported source.</p><span className="quiet-label">Extractive retrieval · no generation model</span></div>;
  return <div className="answer-view"><div className="answer-heading"><span className={`status-tag ${answer.status === 'abstained' ? 'unavailable' : 'available'}`}>{answer.status === 'abstained' ? 'Insufficient evidence' : 'Evidence retrieved'}</span><span className="quiet-label">Extractive</span></div><p className="answer-text">{answer.answer}</p><section className="answer-citations"><h3>Original sources <span>{answer.citations.length}</span></h3>{answer.citations.length === 0 ? <p className="quiet-label">No supporting source range was returned.</p> : answer.citations.map((citation, i) => <button className="citation" key={`${citation.id}:${i}`} onClick={() => onCitation(citation)}><span className="citation-number">{i + 1}</span><span><strong>{citation.source.path}</strong><small>{citation.source.snapshotId} · L{citation.source.startLine}–{citation.source.endLine}</small></span><ArrowRight size={14} /></button>)}</section>{answer.missingEvidence.length > 0 && <section className="limitations"><h3><CircleAlert size={14} /> Missing evidence</h3><ul>{answer.missingEvidence.map((item, i) => <li key={i}>{item}</li>)}</ul></section>}<p className="extractive-note">Retrieved source passages show static relationships. They do not establish runtime behavior or confirmed breakage.</p>{answer.activities.length > 0 && <details className="retrieval-details"><summary>Actual retrieval operations</summary><ul>{answer.activities.map((activity, i) => <li key={`${activity.id}:${i}`}><span>{activity.operation}</span><span>{activity.status} · {activity.durationMs} ms</span></li>)}</ul></details>}</div>;
}

function GitWorkspace({ repositoryId, account, onSessionChanged }: { repositoryId: string; account: RepositoryAccount; onSessionChanged: () => void }) {
  const [index, setIndex] = useState<RepositoryIndex | null>(null);
  const [indexBusy, setIndexBusy] = useState(true);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<'queued' | 'running' | null>(null);
  const [pollPaused, setPollPaused] = useState(false);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set());
  const [source, setSource] = useState<SourceSelection | null>(null);
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
  const searchRef = useRef<HTMLInputElement>(null);
  const inspectorScroll = useRef<HTMLDivElement>(null);
  const questionAbort = useRef<AbortController | null>(null);
  const accountRef = useRef(account);
  accountRef.current = account;

  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    questionAbort.current?.abort(); questionAbort.current = null;
    setIndex(null); setIndexBusy(true); setIndexError(null); setJobStatus(null); setPollPaused(false); setSelectedNode(null); setSource(null); setSourceError(null); setAnswer(null); setAnswerError(null); setAnswerBusy(false); setExpandedPaths(new Set()); setSearch(''); setQuestion('');
    const deadline = Date.now() + 120_000;
    async function load() {
      try {
        const { response, data } = await repositoryRequest(`/api/repositories/${encodeURIComponent(repositoryId)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 202) {
          if (data.status !== 'queued' && data.status !== 'running') throw new Error('The server returned an unsupported indexing job state.');
          setJobStatus(data.status);
          if (Date.now() >= deadline) { setIndexBusy(false); setPollPaused(true); }
          else timer = setTimeout(() => void load(), 3_000);
          return;
        }
        const result = readGitIndex(data.index, repositoryId, accountRef.current);
        setIndex(result); setIndexBusy(false); setJobStatus(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setIndex(null); setIndexError(messageOf(error)); setIndexBusy(false); setJobStatus(null);
        if (error instanceof RepositoryRequestError && error.status === 401) onSessionChanged();
      }
    }
    void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); questionAbort.current?.abort(); };
  }, [repositoryId, reload, onSessionChanged]);

  useEffect(() => {
    function shortcut(event: globalThis.KeyboardEvent) {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)))) return;
      event.preventDefault(); setMobilePanel('explorer'); requestAnimationFrame(() => searchRef.current?.focus());
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => { inspectorScroll.current?.scrollTo({ top: 0 }); }, [source, inspectorTab, answer, answerBusy]);

  const matchingNodes = useMemo(() => index?.nodes.filter(node => `${node.label} ${node.localId}`.toLowerCase().includes(search.toLowerCase())) ?? [], [index, search]);
  const fileNodes = matchingNodes.filter(node => node.kind === 'file');
  const symbolNodes = matchingNodes.filter(node => node.kind === 'symbol');
  const packageNodes = matchingNodes.filter(node => node.kind === 'package' && node.localId !== `package:${index?.packageName}@${index?.version}`);
  const selectedDependency = selectedNode?.kind === 'package' ? index?.dependencies.find(item => selectedNode.localId === `package:${item.packageName}@${item.version ?? 'unresolved'}`) : null;
  const layoutStyle = { '--explorer-width': `${leftWidth}px`, '--inspector-width': `${rightWidth}px` } as CSSProperties;

  const openCitation = useCallback((citation: SourceEvidence) => {
    if (!index) return;
    try {
      const checked = readCitation(citation, index);
      setSelectedNode(index.nodes.find(node => node.kind === 'file' && node.localId === checked.source.path) ?? null);
      setSource({ path: checked.source.path, startLine: checked.source.startLine, endLine: checked.source.endLine, evidence: checked }); setSourceError(null);
    } catch (error) { setSource(null); setSourceError(messageOf(error)); }
    setInspectorTab('source'); setMobilePanel('inspector');
  }, [index]);

  function selectNode(node: GraphNode) {
    if (!index || !index.nodes.some(item => item.id === node.id)) return;
    setSelectedNode(node); setSource(null); setSourceError(null); setInspectorTab('source'); setMobilePanel('inspector');
    const path = nodePath(node); const file = index.files.find(item => item.path === path);
    if (!path || node.kind === 'package') return;
    if (!file) { setSourceError('Source for this node is not present in the snapshot.'); return; }
    const evidence = node.kind === 'symbol' ? index.evidence.find(item => index.edges.some(edge => edge.to === node.id && edge.relation === 'exports' && edge.evidenceId === item.id)) : null;
    const startLine = evidence?.source.startLine ?? (node.kind === 'symbol' ? Number(node.localId.match(/@(\d+):\d+$/)?.[1] ?? 1) : 1);
    const endLine = evidence?.source.endLine ?? (node.kind === 'symbol' ? Math.min(startLine + 24, file.lineCount) : file.lineCount);
    setSource({ path, startLine, endLine, evidence: evidence ?? null });
    if (node.kind === 'symbol') setExpandedPaths(current => new Set(current).add(expansionKey(node)));
  }

  function selectEdge(edge: ParsedEdge) {
    const evidence = index?.evidence.find(item => item.id === edge.evidenceId);
    if (evidence) openCitation(evidence);
    else { setSelectedNode(null); setSource(null); setSourceError('Origin evidence is unavailable for this relationship.'); setInspectorTab('source'); setMobilePanel('inspector'); }
  }

  function expandFile(node: GraphNode) {
    setExpandedPaths(current => { const next = new Set(current); const key = expansionKey(node); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }

  async function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!index || !question.trim() || questionAbort.current || answerBusy) return;
    const controller = new AbortController(); questionAbort.current = controller;
    setAnswerBusy(true); setAnswer(null); setAnswerError(null); setInspectorTab('evidence'); setMobilePanel('inspector');
    try {
      const { data } = await repositoryRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/questions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: question.trim() }), signal: controller.signal });
      if (controller.signal.aborted) return;
      const result = readAnswer(data.answer, index);
      setAnswer(result);
      setExpandedPaths(current => { const next = new Set(current); for (const node of index.nodes) if (node.kind === 'symbol' && result.nodeIds.includes(node.id)) next.add(expansionKey(node)); return next; });
    } catch (error) {
      if (controller.signal.aborted) return;
      setAnswerError(messageOf(error));
      if (error instanceof RepositoryRequestError && error.status === 401) onSessionChanged();
    } finally { if (!controller.signal.aborted) { questionAbort.current = null; setAnswerBusy(false); } }
  }

  function retryIndex() { setIndex(null); setSource(null); setAnswer(null); setIndexBusy(true); setIndexError(null); setPollPaused(false); setReload(value => value + 1); }
  const pendingLabel = jobStatus === 'queued' ? 'Import queued' : jobStatus === 'running' ? 'Indexing repository' : 'Loading authorized source';

  return <main id="main" className="workspace" style={layoutStyle}>
    <header className="workspace-header"><div className="repository-selector" style={{ minWidth: 0, maxWidth: '55%' }}><GitBranch size={17} /><strong style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={index ? `${index.packageName} / ${index.version}` : repositoryId}>{index ? `${index.packageName} / ${index.version}` : 'Repository source'}</strong></div><span className="status-tag">Git snapshot</span><div className="header-right"><span className="job-status" role="status">{indexBusy ? <><LoaderCircle size={13} className="spin" />{pendingLabel}</> : pollPaused ? <><CircleAlert size={13} />Checks paused</> : indexError ? <><CircleAlert size={13} />Source unavailable</> : <><span className="status-dot" />Snapshot ready</>}</span><Link className="text-button" href="/app/repositories">Repositories <ArrowRight size={13} /></Link></div></header>
    <nav className="mobile-panels" aria-label="Workspace panels">{(['explorer', 'map', 'inspector'] as const).map(panel => <button key={panel} className={mobilePanel === panel ? 'active' : ''} aria-pressed={mobilePanel === panel} onClick={() => setMobilePanel(panel)}>{panel === 'explorer' ? <Folder size={15} /> : panel === 'map' ? <Network size={15} /> : <BookOpen size={15} />}{panel === 'explorer' ? 'Repository' : panel === 'map' ? 'Map' : 'Evidence'}</button>)}</nav>
    <div className="workspace-panels" data-mobile-panel={mobilePanel}>
      <aside className="repository-panel" aria-label="Repository explorer"><div className="panel-heading"><h2>Repository</h2><span className="quiet-label">{index?.snapshot.revision.slice(0, 7) ?? '—'}</span></div><div className="search-field"><Search size={14} /><input ref={searchRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Find files or symbols" aria-label="Search files and symbols" disabled={!index} /><kbd>/</kbd>{search && <button className="icon-button" onClick={() => setSearch('')} aria-label="Clear search"><X size={13} /></button>}</div><div className="explorer-scroll">{indexBusy ? <div className="explorer-loading"><LoaderCircle className="spin" size={15} />{pendingLabel}…</div> : indexError ? <p className="inline-error" role="alert">{indexError}</p> : pollPaused ? <div className="panel-state"><h3>Source is not ready yet</h3><p>The last reported job state is {jobStatus}.</p><button className="button secondary" onClick={retryIndex}>Resume status checks</button></div> : index && <><div className="tree-group-heading"><Folder size={14} /><span>{index.packageName}</span><span>{index.files.length}</span></div>{fileNodes.map(node => { const symbols = index.nodes.filter(item => item.kind === 'symbol' && nodePath(item) === node.localId); return <div className="tree-file" key={node.id}><div className={`tree-row ${selectedNode?.id === node.id ? 'selected' : ''}`}>{symbols.length > 0 ? <button className="tree-expander" onClick={() => expandFile(node)} aria-expanded={expandedPaths.has(expansionKey(node))} aria-label={`${expandedPaths.has(expansionKey(node)) ? 'Collapse' : 'Expand'} ${node.localId} symbols`}>{expandedPaths.has(expansionKey(node)) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button> : <span className="tree-spacer" />}<button className="tree-select" onClick={() => selectNode(node)} title={node.localId}><FileCode2 size={14} /><span>{node.label}</span></button></div>{expandedPaths.has(expansionKey(node)) && symbols.map(symbol => <button className={`tree-symbol ${selectedNode?.id === symbol.id ? 'selected' : ''}`} key={symbol.id} onClick={() => selectNode(symbol)}><Braces size={12} /><span>{symbol.label}</span></button>)}</div>; })}{search && symbolNodes.length > 0 && <><div className="section-label">Matching symbols</div>{symbolNodes.map(node => <button className="tree-symbol search-result" key={node.id} onClick={() => selectNode(node)}><Braces size={12} /><span>{node.label}<small>{nodePath(node)}</small></span></button>)}</>}{packageNodes.length > 0 && <><div className="section-label">External dependencies</div>{packageNodes.map(node => <button className={`dependency-row ${selectedNode?.id === node.id ? 'selected' : ''}`} key={node.id} onClick={() => selectNode(node)}><Box size={14} /><span>{node.label}</span></button>)}<p className="explorer-hint">Dependency references come from this snapshot. External source has not been loaded.</p></>}{search && matchingNodes.length === 0 && <div className="empty-search"><Search size={20} /><p>No files or symbols match “{search}”.</p><button className="text-button" onClick={() => setSearch('')}>Clear search</button></div>}</>}</div><div className="snapshot-info"><span><Check size={12} />{index ? 'Immutable Git snapshot' : 'Awaiting authorized snapshot'}</span>{index && <code title={index.snapshot.revision}>{index.snapshot.revision}</code>}</div></aside>
      <ResizeHandle label="Resize repository explorer" value={leftWidth} minimum={184} maximum={360} onChange={setLeftWidth} />
      <section className="map-panel" aria-label="Codebase map"><div className="map-toolbar"><div><h2>Codebase map</h2><span>{index ? `${index.nodes.length} nodes · ${index.edges.length} relationships` : 'Repository source relationships'}</span></div><div className="segmented-control" aria-label="Map view"><button aria-pressed={graphView === 'map'} className={graphView === 'map' ? 'active' : ''} onClick={() => setGraphView('map')}><Network size={14} /><span>Map</span></button><button aria-pressed={graphView === 'list'} className={graphView === 'list' ? 'active' : ''} onClick={() => setGraphView('list')}><List size={14} /><span>List</span></button></div></div><div className="map-body">{indexBusy ? <div className="canvas-state" role="status"><LoaderCircle className="spin" size={26} /><h2>{pendingLabel}</h2><p>{jobStatus ? 'The server reports this indexing state. Status checks continue for up to two minutes.' : 'Verifying access and loading an immutable source snapshot.'}</p></div> : indexError ? <div className="canvas-state error" role="alert"><CircleAlert size={26} /><h2>Unable to load source</h2><p>{indexError}</p><button className="button secondary" onClick={retryIndex}>Retry snapshot request</button></div> : pollPaused ? <div className="canvas-state"><CircleAlert size={26} /><h2>Status checks paused</h2><p>The server last reported {jobStatus}. You can resume checking the same import job.</p><button className="button secondary" onClick={retryIndex}>Resume status checks</button></div> : index && index.nodes.length === 0 ? <div className="canvas-state"><Folder size={26} /><h2>No graph nodes found</h2><p>This imported snapshot has no parsed graph nodes.</p></div> : index && graphView === 'map' ? <GraphCanvas key={index.snapshot.snapshotId} index={index} expandedPaths={expandedPaths} selectedId={selectedNode?.id ?? null} highlightedEdges={answer?.edgeIds ?? []} onSelect={selectNode} onEdgeSelect={selectEdge} /> : index && <div className="graph-list"><div className="section-label">Nodes · select to inspect</div>{matchingNodes.map(node => <button className={`graph-list-node ${selectedNode?.id === node.id ? 'selected' : ''}`} key={node.id} onClick={() => selectNode(node)}>{node.kind === 'file' ? <FileCode2 size={15} /> : node.kind === 'symbol' ? <Braces size={15} /> : <Box size={15} />}<span><strong>{node.label}</strong><small>{node.kind} · Git source · {node.snapshotId}</small></span><ArrowRight size={13} /></button>)}{matchingNodes.length === 0 && <p className="quiet-label">No matching nodes. Clear the repository search to show all source.</p>}<div className="section-label">Parsed relationships · inspect origin</div>{index.edges.map(edge => <button className="relationship-row" key={edge.id} onClick={() => selectEdge(edge)}><span>{index.nodes.find(node => node.id === edge.from)?.label}<small>{edge.relation} → {index.nodes.find(node => node.id === edge.to)?.label}</small></span><ArrowRight size={13} /></button>)}</div>}</div><div className="map-note"><GitBranch size={12} /><span>Static relationships show potential impact. Runtime behavior is not verified.</span></div><form className="question-composer" onSubmit={event => void submitQuestion(event)}><label htmlFor="repository-question">Ask this codebase</label><div className="composer-input"><textarea id="repository-question" rows={2} value={question} maxLength={2000} onChange={event => setQuestion(event.target.value)} placeholder="Which source handles failed jobs?" disabled={!index || indexBusy || answerBusy} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button className="send-button" type="submit" aria-label="Retrieve source evidence" disabled={!question.trim() || !index || answerBusy}>{answerBusy ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}</button></div><div className="composer-meta"><span>Extractive retrieval · source stays on this server and in your browser</span><span className="composer-shortcut">Ctrl / ⌘ + Enter</span></div></form></section>
      <ResizeHandle label="Resize evidence inspector" value={rightWidth} minimum={280} maximum={520} onChange={setRightWidth} reverse />
      <aside className="inspector-panel" aria-label="Source and evidence inspector"><div className="inspector-tabs"><button className={inspectorTab === 'source' ? 'active' : ''} aria-pressed={inspectorTab === 'source'} onClick={() => setInspectorTab('source')}><FileCode2 size={14} />Source</button><button className={inspectorTab === 'evidence' ? 'active' : ''} aria-pressed={inspectorTab === 'evidence'} onClick={() => setInspectorTab('evidence')}><BookOpen size={14} />Evidence{answer && <span>{answer.citations.length}</span>}</button></div><div className="inspector-scroll" ref={inspectorScroll}>{inspectorTab === 'evidence' ? <AnswerView answer={answer} busy={answerBusy} error={answerError} onCitation={openCitation} /> : index ? selectedNode?.kind === 'package' ? <div className="package-inspector"><span className="node-type"><Box size={14} />Package reference</span><h2>{selectedNode.label}</h2><dl><div><dt>Version status</dt><dd>{selectedDependency?.status ?? 'Parsed package reference'}</dd></div><div><dt>Origin</dt><dd>{selectedDependency?.sourcePath ?? 'Repository package identity'}</dd></div><div><dt>External source</dt><dd>Not loaded</dd></div></dl>{selectedDependency?.reason && <p>{selectedDependency.reason}</p>}<div className="limitations"><h3>Source boundary</h3><p>This reference comes from the imported repository. External implementation and runtime behavior have not been verified.</p></div></div> : <SourceView index={index} selection={source} error={sourceError} onFullFile={() => { const file = index.files.find(item => item.path === source?.path); if (file) setSource({ path: file.path, startLine: 1, endLine: file.lineCount, evidence: null }); }} /> : <div className="panel-state"><BookOpen size={27} /><h3>Awaiting source</h3><p>Source appears after authorization and indexing complete.</p></div>}{selectedNode?.kind === 'file' && inspectorTab === 'source' && index?.nodes.some(node => node.kind === 'symbol' && nodePath(node) === selectedNode.localId) && <div className="inspector-actions"><button className="button secondary" onClick={() => { expandFile(selectedNode); setMobilePanel('map'); }}><Braces size={14} />{expandedPaths.has(expansionKey(selectedNode)) ? 'Collapse symbols in map' : 'Expand symbols in map'}</button></div>}{index && <details className="index-limitations"><summary>Analysis limitations</summary><ul>{[...index.limitations, ...index.unresolved].map((item, i) => <li key={i}>{item}</li>)}</ul></details>}</div></aside>
    </div><footer className="workspace-status"><span>{index && <span className="status-dot" />}{index ? 'Authorized Git source' : jobStatus ? `Indexing job: ${jobStatus}` : 'Repository source unavailable'}</span><span>{answer?.activities.at(-1) ? `${answer.activities.at(-1)?.operation} · ${answer.activities.at(-1)?.status}` : index ? `${index.files.length} source files` : 'No source delivered'}</span><Link href="/app/repositories">Repositories <ArrowRight size={11} /></Link></footer>
  </main>;
}

export function RepositoryWorkspace({ repositoryId }: { repositoryId: string }) {
  const [account, setAccount] = useState<RepositoryAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const refreshAccount = useCallback(() => { setAccount(null); setRefresh(value => value + 1); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setAccount(null); setError(null); setNeedsSignIn(false);
    repositoryRequest('/api/account', { signal: controller.signal }).then(({ data }) => { const result = readRepositoryAccount(data); if (!controller.signal.aborted) setAccount(result); }).catch(error => { if (!controller.signal.aborted) { setError(messageOf(error)); setNeedsSignIn(error instanceof RepositoryRequestError && error.status === 401); } });
    return () => controller.abort();
  }, [refresh, repositoryId]);
  if (account) return <RepositorySessionBoundary principalId={account.principalId} onSessionChanged={refreshAccount}><GitWorkspace key={`${account.principalId}:${repositoryId}`} repositoryId={repositoryId} account={account} onSessionChanged={refreshAccount} /></RepositorySessionBoundary>;
  return <main id="main" className="content-page"><header className="page-header"><div><span className="eyebrow">Authenticated Git source</span><h1>Repository workspace</h1></div><Link className="button secondary" href="/app/repositories">Repositories <ArrowRight size={14} /></Link></header>{error ? <div className="unavailable-state" role="alert"><CircleAlert size={22} /><h2>{needsSignIn ? 'Sign in to open repository source' : 'Workspace unavailable'}</h2><p>{error}</p>{needsSignIn ? <Link className="button primary" href="/sign-in">Sign in</Link> : <button className="button secondary" onClick={refreshAccount}>Retry account request</button>}</div> : <div className="empty-card" role="status"><LoaderCircle className="spin" size={22} /><p>Verifying your account before loading repository source…</p></div>}</main>;
}
