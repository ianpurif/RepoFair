'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, KeyboardEvent, PointerEvent } from 'react';
import type { Activity, FederationResult, FixtureId, GraphNode, LocalAnswer, LocalIndex, ParsedEdge, SourceEvidence } from '@atlas/contracts';
import { ArrowRight, ArrowUp, BookOpen, Box, Braces, Check, ChevronDown, ChevronRight, CircleAlert, FileCode2, Folder, GitBranch, List, LoaderCircle, Network, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { expansionKey, GraphCanvas, nodePath } from './graph-canvas';
import { ProviderApproval } from './provider-approval';
import { askLocal, clientActivity, fixtures, loadFixture, loadSource, recordActivities } from '../lib/local-client';

type MobilePanel = 'explorer' | 'map' | 'inspector';
type InspectorTab = 'source' | 'evidence';
const DEFAULT_QUESTION = 'How does this application retry failed jobs, and what could be affected by changing that behavior?';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';

function ResizeHandle({ label, value, minimum, maximum, onChange, reverse = false }: { label: string; value: number; minimum: number; maximum: number; onChange: (value: number) => void; reverse?: boolean }) {
  const drag = useRef<{ x: number; value: number } | null>(null);
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const delta = (event.clientX - drag.current.x) * (reverse ? -1 : 1);
    onChange(Math.max(minimum, Math.min(maximum, drag.current.value + delta)));
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0;
    if (!delta && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    onChange(event.key === 'Home' ? minimum : event.key === 'End' ? maximum : Math.max(minimum, Math.min(maximum, value + delta * (reverse ? -1 : 1))));
  }
  return <div className="resize-handle" role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)} pixels. Use left and right arrow keys to resize.`} onKeyDown={key}
    onPointerDown={event => { drag.current = { x: event.clientX, value }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={move}
    onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = null; }}><span /></div>;
}

function SourceView({ source, busy, error, onFullFile, fullFileAvailable }: { source: SourceEvidence | null; busy: boolean; error: string | null; onFullFile: () => void; fullFileAvailable: boolean }) {
  if (busy) return <div className="panel-state" role="status"><LoaderCircle className="spin" size={22} /><h3>Opening source</h3><p>Retrieving the selected snapshot and line range.</p></div>;
  if (error) return <div className="panel-state error" role="alert"><CircleAlert size={22} /><h3>Source unavailable</h3><p>{error}</p></div>;
  if (!source) return <div className="panel-state"><BookOpen size={27} strokeWidth={1.3} /><h3>Follow the source</h3><p>Select a file, symbol, or relationship to inspect its original source.</p><span className="quiet-label">Every citation belongs to an exact snapshot.</span></div>;
  const lines = source.original.replace(/\n$/, '').split('\n');
  return <div className="source-view"><div className="source-file-heading"><FileCode2 size={15} /><strong>{source.source.path}</strong><span>L{source.source.startLine}–{source.source.endLine}</span></div>
    <div className="code-block" tabIndex={0} role="region" aria-label={`${source.source.path}, lines ${source.source.startLine} through ${source.source.endLine}. Scroll horizontally to read source.`}><pre>{lines.map((line, offset) => <div className="code-line" key={offset}><span className="line-number" aria-hidden="true">{source.source.startLine + offset}</span><code>{line || ' '}</code></div>)}</pre></div>
    {fullFileAvailable && <button className="text-button full-source" onClick={onFullFile}>Open full file <ArrowRight size={13} /></button>}
    <div className="provenance-card"><h3>Source provenance</h3><dl><div><dt>Repository</dt><dd>{source.source.repositoryId}</dd></div><div><dt>Snapshot</dt><dd>{source.source.snapshotId}</dd></div><div><dt>Origin</dt><dd>{source.provenance}</dd></div><div><dt>Provider</dt><dd>{source.providerId ?? 'Local fixture source'}</dd></div></dl><details><summary>Immutable revision</summary><code>{source.source.revision}</code></details></div>
  </div>;
}

function AnswerView({ answer, busy, error, onCitation }: { answer: LocalAnswer | null; busy: boolean; error: string | null; onCitation: (citation: SourceEvidence) => void }) {
  if (busy) return <div className="panel-state" role="status"><LoaderCircle className="spin" size={22} /><h3>Retrieving evidence</h3><p>Searching the current snapshot and its parsed relationships.</p></div>;
  if (error) return <div className="panel-state error" role="alert"><CircleAlert size={22} /><h3>Lookup failed</h3><p>{error}</p></div>;
  if (!answer) return <div className="panel-state"><Search size={27} strokeWidth={1.3} /><h3>Ask the codebase</h3><p>Find source-backed context using the question composer below the map.</p><span className="quiet-label">Extractive retrieval · no generation model</span></div>;
  return <div className="answer-view"><div className="answer-heading"><span className={`status-tag ${answer.status === 'abstained' ? 'unavailable' : 'available'}`}>{answer.status === 'abstained' ? 'Insufficient evidence' : 'Evidence retrieved'}</span><span className="quiet-label">Extractive</span></div><p className="answer-text">{answer.answer}</p>
    <section className="answer-citations"><h3>Original sources <span>{answer.citations.length}</span></h3>{answer.citations.length === 0 ? <p className="quiet-label">No supporting source range was returned.</p> : answer.citations.map((citation, i) => <button className="citation" key={citation.id} onClick={() => onCitation(citation)}><span className="citation-number">{i + 1}</span><span><strong>{citation.source.path}</strong><small>{citation.source.snapshotId} · L{citation.source.startLine}–{citation.source.endLine}</small></span><ArrowRight size={14} /></button>)}</section>
    {answer.missingEvidence.length > 0 && <section className="limitations"><h3><CircleAlert size={14} /> Missing evidence</h3><ul>{answer.missingEvidence.map((item, i) => <li key={i}>{item}</li>)}</ul></section>}
    <p className="extractive-note">These are retrieved source passages. They do not establish runtime behavior or confirmed breakage.</p>
    {answer.activities.length > 0 && <details className="retrieval-details"><summary>Actual retrieval operations</summary><ul>{answer.activities.map(activity => <li key={activity.id}><span>{activity.operation}</span><span>{activity.status} · {activity.durationMs} ms</span></li>)}</ul></details>}
  </div>;
}

function ProviderEvidence({ result, onCitation }: { result: FederationResult; onCitation: (citation: SourceEvidence) => void }) {
  return <section className="federation-evidence"><div className="section-label">Delivered provider context</div>{result.providers.map(provider => <article key={provider.providerId}><div className="provider-result-heading"><Box size={14} /><strong>{provider.providerId}</strong><span className="status-tag fixture">Fixture HTTP</span></div><small>{provider.index.packageName} · {provider.index.version}</small><p>{provider.answer.answer}</p><span className="quiet-label">Snapshot {provider.index.snapshot.snapshotId} · source checked against local fixture</span></article>)}<h3>Provider sources</h3>{result.citations.map((citation, i) => <button className="citation" key={`${citation.providerId}:${citation.id}`} onClick={() => onCitation(citation)}><span className="citation-number">{i + 1}</span><span><strong>{citation.source.path}</strong><small>{citation.providerId} · {citation.source.snapshotId} · L{citation.source.startLine}–{citation.source.endLine}</small></span><ArrowRight size={14} /></button>)}<div className="limitations"><h3>Context limitations</h3><ul>{result.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul></div></section>;
}

export function Workspace({ initialFixture, demo = false }: { initialFixture: FixtureId; demo?: boolean }) {
  const [fixtureId, setFixtureId] = useState<FixtureId>(initialFixture);
  const [index, setIndex] = useState<LocalIndex | null>(null);
  const [indexBusy, setIndexBusy] = useState(true);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set());
  const [source, setSource] = useState<SourceEvidence | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<LocalAnswer | null>(null);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [question, setQuestion] = useState(demo ? DEFAULT_QUESTION : '');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('source');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('map');
  const [graphView, setGraphView] = useState<'map' | 'list'>('map');
  const [leftWidth, setLeftWidth] = useState(232);
  const [rightWidth, setRightWidth] = useState(354);
  const [lastActivity, setLastActivity] = useState<Activity | null>(null);
  const [federation, setFederation] = useState<FederationResult | null>(null);
  const [providerBusy, setProviderBusy] = useState(false);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sourceAbort = useRef<AbortController | null>(null);
  const questionAbort = useRef<AbortController | null>(null);
  const inspectorScroll = useRef<HTMLDivElement>(null);
  useEffect(() => { inspectorScroll.current?.scrollTo({ top: 0 }); }, [source, sourceBusy, inspectorTab]);

  const saveActivity = useCallback((activity: Activity) => { setLastActivity(activity); recordActivities([activity]); }, []);
  useEffect(() => {
    const controller = new AbortController();
    sourceAbort.current?.abort(); questionAbort.current?.abort();
    setIndex(null); setIndexBusy(true); setIndexError(null); setSelectedNode(null); setSource(null); setSourceError(null); setSourceBusy(false); setAnswer(null); setAnswerError(null); setAnswerBusy(false); setExpandedPaths(new Set()); setSearch(''); setFederation(null); setProviderBusy(false);
    const startedAt = new Date().toISOString(); const start = performance.now();
    loadFixture(fixtureId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setIndex(result); setIndexBusy(false);
      saveActivity(clientActivity('fixture.index', startedAt, performance.now() - start, 'complete', `${result.snapshot.snapshotId}: ${result.files.length} files, ${result.nodes.length} nodes, ${result.edges.length} parsed relationships. Browser request duration.`));
    }).catch(error => {
      if (controller.signal.aborted) return;
      setIndexError(errorMessage(error)); setIndexBusy(false);
      saveActivity(clientActivity('fixture.index', startedAt, performance.now() - start, 'failed', errorMessage(error)));
    });
    return () => controller.abort();
  }, [fixtureId, reload, saveActivity]);
  useEffect(() => {
    function shortcut(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && !target.isContentEditable) { event.preventDefault(); setMobilePanel('explorer'); searchRef.current?.focus(); }
    }
    window.addEventListener('keydown', shortcut);
    return () => { window.removeEventListener('keydown', shortcut); sourceAbort.current?.abort(); questionAbort.current?.abort(); };
  }, []);

  const providerOrigins = useMemo(() => Object.fromEntries(federation?.providers.map(provider => [provider.index.snapshot.snapshotId, provider.providerId]) ?? []), [federation]);
  const providerBindings = useMemo(() => Object.fromEntries(federation?.providers.map(provider => [`package:${provider.index.packageName}@${provider.index.version}`, provider.providerId]) ?? []), [federation]);
  const allIndices = useMemo(() => index ? [index, ...(federation?.providers.map(provider => provider.index) ?? [])] : [], [index, federation]);
  const displayIndex = useMemo<LocalIndex | null>(() => index && federation ? { ...index, nodes: federation.nodes, edges: federation.edges, evidence: [...index.evidence, ...federation.providers.flatMap(provider => provider.index.evidence)] } : index, [index, federation]);
  const openSource = useCallback(async (path: string, startLine: number, endLine: number, sourceFixture: FixtureId = fixtureId, providerId: string | null = null) => {
    sourceAbort.current?.abort();
    const controller = new AbortController(); sourceAbort.current = controller;
    setSourceBusy(true); setSourceError(null); setSource(null); setInspectorTab('source'); setMobilePanel('inspector');
    const startedAt = new Date().toISOString(); const start = performance.now();
    try {
      const result = await loadSource(sourceFixture, path, startLine, endLine, controller.signal);
      if (controller.signal.aborted) return;
      setSource(providerId ? { ...result, providerId } : result);
      saveActivity(clientActivity('source.lookup', startedAt, performance.now() - start, 'complete', `${sourceFixture} · ${path}:${startLine}–${endLine}${providerId ? ` · delivered by ${providerId}, original fixture source checked locally` : ''}. Browser request duration.`));
    } catch (error) {
      if (controller.signal.aborted) return;
      setSourceError(errorMessage(error));
      saveActivity(clientActivity('source.lookup', startedAt, performance.now() - start, 'failed', errorMessage(error)));
    } finally { if (!controller.signal.aborted) setSourceBusy(false); }
  }, [fixtureId, saveActivity]);
  const selectNode = useCallback((node: GraphNode) => {
    setSelectedNode(node); setInspectorTab('source'); setMobilePanel('inspector');
    const owner = allIndices.find(item => item.snapshot.snapshotId === node.snapshotId && item.snapshot.repositoryId === node.repositoryId);
    const path = nodePath(node) ?? (owner && node.localId === `package:${owner.packageName}@${owner.version}` ? 'package.json' : null);
    if (!path || !owner) { sourceAbort.current?.abort(); setSource(null); setSourceBusy(false); setSourceError(null); return; }
    const file = owner.files.find(item => item.path === path);
    if (!file) { setSourceError('This node does not have a source file in the selected snapshot.'); return; }
    if (node.kind === 'symbol') {
      const definition = owner.edges.find(edge => edge.relation === 'exports' && edge.to === node.id);
      const evidence = definition ? owner.evidence.find(item => item.id === definition.evidenceId) : undefined;
      const matchedLine = Number(node.localId.match(/@(\d+):\d+$/)?.[1] ?? 1);
      void openSource(path, evidence?.source.startLine ?? matchedLine, evidence?.source.endLine ?? Math.min(matchedLine + 24, file.lineCount), owner.snapshot.snapshotId as FixtureId, providerOrigins[node.snapshotId] ?? null);
    } else { void openSource(path, 1, Math.min(file.lineCount, 160), owner.snapshot.snapshotId as FixtureId, providerOrigins[node.snapshotId] ?? null); }
  }, [allIndices, openSource, providerOrigins]);
  const selectEdge = useCallback((edge: ParsedEdge) => {
    const evidence = displayIndex?.evidence.find(item => item.id === edge.evidenceId);
    if (evidence) void openSource(evidence.source.path, evidence.source.startLine, evidence.source.endLine, evidence.source.snapshotId as FixtureId, providerOrigins[evidence.source.snapshotId] ?? null);
    else { setSourceError('Origin evidence is unavailable for this relationship.'); setInspectorTab('source'); setMobilePanel('inspector'); }
  }, [displayIndex, openSource, providerOrigins]);
  function expandFile(node: GraphNode) {
    const key = expansionKey(node); const expanded = !expandedPaths.has(key);
    setExpandedPaths(current => { const next = new Set(current); if (expanded) next.add(key); else next.delete(key); return next; });
    saveActivity(clientActivity('graph.expand', new Date().toISOString(), 0, 'complete', `${expanded ? 'Expanded' : 'Collapsed'} symbols for ${node.snapshotId} · ${nodePath(node)}. Local display operation.`));
  }
  async function submitQuestion(event: FormEvent) {
    event.preventDefault();
    if (!question.trim() || answerBusy || !index) return;
    questionAbort.current?.abort(); const controller = new AbortController(); questionAbort.current = controller;
    setAnswerBusy(true); setAnswer(null); setAnswerError(null); setInspectorTab('evidence'); setMobilePanel('inspector');
    const startedAt = new Date().toISOString(); const start = performance.now();
    try {
      const result = await askLocal(fixtureId, question.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setAnswer(result); recordActivities(result.activities);
      const last = result.activities.at(-1); if (last) setLastActivity(last);
      setExpandedPaths(current => { const next = new Set(current); for (const node of index.nodes) { if (result.nodeIds.includes(node.id) && node.kind === 'symbol') next.add(expansionKey(node)); } return next; });
      toast(result.status === 'abstained' ? 'No sufficient source evidence found.' : 'Source evidence is ready.');
    } catch (error) {
      if (controller.signal.aborted) return;
      setAnswerError(errorMessage(error)); saveActivity(clientActivity('question.retrieve', startedAt, performance.now() - start, 'failed', errorMessage(error)));
    } finally { if (!controller.signal.aborted) setAnswerBusy(false); }
  }
  function changeFixture(next: FixtureId) {
    if (next === fixtureId) return;
    if (answer || federation || source) setStaleNotice(`Evidence from ${fixtureId} is inapplicable to ${next}. Prior answers, provider approvals, and graph additions have been cleared.`);
    else setStaleNotice(null);
    setFixtureId(next);
  }
  const onFederation = useCallback((result: FederationResult) => {
    if (result.local.snapshot.snapshotId !== fixtureId) return;
    setFederation(result); setInspectorTab('evidence');
    toast('Provider source attached. Use Fit view to see the expanded map.');
  }, [fixtureId]);
  const onFederationActivity = useCallback((status: 'complete' | 'failed', startedAt: string, durationMs: number, detail: string) => { saveActivity(clientActivity('provider.context', startedAt, durationMs, status, detail)); }, [saveActivity]);
  const matchingNodes = useMemo(() => displayIndex?.nodes.filter(node => `${node.label} ${node.localId} ${node.snapshotId}`.toLowerCase().includes(search.toLowerCase())) ?? [], [displayIndex, search]);
  const localMatchingNodes = matchingNodes.filter(node => node.snapshotId === index?.snapshot.snapshotId);
  const fileNodes = localMatchingNodes.filter(node => node.kind === 'file');
  const packageNodes = localMatchingNodes.filter(node => node.kind === 'package' && node.localId !== `package:${index?.packageName}@${index?.version}`);
  const symbolNodes = localMatchingNodes.filter(node => node.kind === 'symbol');
  const sourceFile = source && allIndices.find(item => item.snapshot.snapshotId === source.source.snapshotId)?.files.find(file => file.path === source.source.path);
  const selectedDependency = selectedNode?.kind === 'package' ? index?.dependencies.find(item => selectedNode.localId.includes(item.packageName)) : null;
  const selectedProvider = selectedDependency ? federation?.providers.find(provider => provider.index.packageName === selectedDependency.packageName && provider.index.version === selectedDependency.version) : null;
  const layoutStyle = { '--explorer-width': `${leftWidth}px`, '--inspector-width': `${rightWidth}px` } as CSSProperties;

  return <main id="main" className="workspace" style={layoutStyle}>
    <header className="workspace-header"><div className="repository-selector"><GitBranch size={17} /><label className="sr-only" htmlFor="snapshot-select">Repository snapshot</label><select id="snapshot-select" value={fixtureId} onChange={event => changeFixture(event.target.value as FixtureId)}>{fixtures.map(fixture => <option value={fixture.id} key={fixture.id}>{fixture.name} / {fixture.version}</option>)}</select><ChevronDown size={13} /></div><span className="status-tag fixture">Fixture mode</span><div className="header-right"><span className="job-status" role="status">{indexBusy ? <><LoaderCircle size={13} className="spin" /> Indexing source</> : providerBusy ? <><LoaderCircle size={13} className="spin" /> Requesting providers</> : answerBusy ? <><LoaderCircle size={13} className="spin" /> Retrieving evidence</> : indexError ? <><CircleAlert size={13} /> Index unavailable</> : <><span className="status-dot" /> Snapshot ready</>}</span><Link className="text-button" href="/app/activity">Activity <ArrowRight size={13} /></Link></div></header>
    {demo && <div className="demo-banner"><span>Original local fixtures. Explore the retry behavior across versions.</span><span>External providers and payments are unavailable.</span></div>}
    {staleNotice && <div className="stale-banner" role="status"><CircleAlert size={13} /><span>{staleNotice}</span><button className="icon-button" onClick={() => setStaleNotice(null)} aria-label="Dismiss version change notice"><X size={13} /></button></div>}
    <nav className="mobile-panels" aria-label="Workspace panels">{(['explorer', 'map', 'inspector'] as const).map(panel => <button key={panel} className={mobilePanel === panel ? 'active' : ''} aria-pressed={mobilePanel === panel} onClick={() => setMobilePanel(panel)}>{panel === 'explorer' ? <Folder size={15} /> : panel === 'map' ? <Network size={15} /> : <BookOpen size={15} />}{panel === 'explorer' ? 'Repository' : panel === 'map' ? 'Map' : 'Evidence'}</button>)}</nav>
    <div className="workspace-panels" data-mobile-panel={mobilePanel}>
      <aside className="repository-panel" aria-label="Repository explorer"><div className="panel-heading"><h2>Repository</h2><span className="quiet-label">{index?.version ?? '—'}</span></div><div className="search-field"><Search size={14} /><input ref={searchRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Find files or symbols" aria-label="Search files and symbols" /><kbd>/</kbd>{search && <button className="icon-button" onClick={() => setSearch('')} aria-label="Clear search"><X size={13} /></button>}</div>
        <div className="explorer-scroll">{indexBusy ? <div className="explorer-loading"><LoaderCircle size={15} className="spin" /> Reading fixture source…</div> : indexError ? <p className="inline-error">{indexError}</p> : index && <><div className="tree-group-heading"><Folder size={14} /><span>{index.snapshot.repositoryId}</span><span>{index.files.length}</span></div>{fileNodes.map(node => {
          const symbols = index.nodes.filter(item => item.kind === 'symbol' && nodePath(item) === node.localId);
          return <div key={node.id} className="tree-file"><div className={`tree-row ${selectedNode?.id === node.id ? 'selected' : ''}`}>{symbols.length > 0 ? <button className="tree-expander" onClick={() => expandFile(node)} aria-expanded={expandedPaths.has(expansionKey(node))} aria-label={`${expandedPaths.has(expansionKey(node)) ? 'Collapse' : 'Expand'} ${node.localId} symbols`}>{expandedPaths.has(expansionKey(node)) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button> : <span className="tree-spacer" />}<button className="tree-select" onClick={() => selectNode(node)}><FileCode2 size={14} /><span>{node.label}</span></button></div>{expandedPaths.has(expansionKey(node)) && symbols.map(symbol => <button key={symbol.id} className={`tree-symbol ${selectedNode?.id === symbol.id ? 'selected' : ''}`} onClick={() => selectNode(symbol)}><Braces size={12} /><span>{symbol.label}</span></button>)}</div>;
        })}{search && symbolNodes.length > 0 && <><div className="section-label">Matching symbols</div>{symbolNodes.map(node => <button className="tree-symbol search-result" key={node.id} onClick={() => selectNode(node)}><Braces size={12} /><span>{node.label}<small>{nodePath(node)}</small></span></button>)}</>}{packageNodes.length > 0 && <><div className="section-label">External dependencies</div>{packageNodes.map(node => <button className={`dependency-row ${selectedNode?.id === node.id ? 'selected' : ''}`} key={node.id} onClick={() => selectNode(node)}><Box size={14} /><span>{node.label}</span></button>)}<p className="explorer-hint">{federation ? `${federation.providers.length} exact-version provider source${federation.providers.length === 1 ? '' : 's'} delivered. Provenance is listed below.` : 'References from local source. Provider source has not been loaded.'}</p></>}{search && matchingNodes.length === 0 && <div className="empty-search"><Search size={20} /><p>No files or symbols match “{search}”.</p><button className="text-button" onClick={() => setSearch('')}>Clear search</button></div>}</>}{federation && <><div className="section-label">Delivered provider source</div>{federation.providers.map(provider => <div key={provider.providerId}><div className="provider-tree-label">{provider.providerId} · {provider.index.version}</div>{provider.index.nodes.filter(node => node.kind === 'file').map(node => <div key={node.id}><div className={`tree-row ${selectedNode?.id === node.id ? 'selected' : ''}`}><button className="tree-expander" aria-label={`Expand provider ${node.label} symbols`} aria-expanded={expandedPaths.has(expansionKey(node))} onClick={() => expandFile(node)}>{expandedPaths.has(expansionKey(node)) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button><button className="tree-select" onClick={() => selectNode(node)}><FileCode2 size={14} /><span>{node.label}</span></button></div>{expandedPaths.has(expansionKey(node)) && provider.index.nodes.filter(symbol => symbol.kind === 'symbol' && nodePath(symbol) === node.localId).map(symbol => <button className="tree-symbol" key={symbol.id} onClick={() => selectNode(symbol)}><Braces size={12} />{symbol.label}</button>)}</div>)}</div>)}</>}</div>
        <div className="snapshot-info"><span><Check size={12} /> Immutable fixture snapshot</span><code title={index?.snapshot.revision}>{index ? `${index.snapshot.revision.slice(0, 20)}…` : 'Awaiting source'}</code></div>
      </aside>
      <ResizeHandle label="Resize repository explorer" value={leftWidth} minimum={184} maximum={360} onChange={setLeftWidth} />
      <section className="map-panel" aria-label="Codebase map"><div className="map-toolbar"><div><h2>Codebase map</h2><span>{index ? `${displayIndex?.nodes.length} nodes · ${displayIndex?.edges.length} relationships` : 'Original source relationships'}</span></div><div className="map-toolbar-actions">{index && index.dependencies.length > 0 && <button className="provider-map-button" onClick={() => { setInspectorTab('evidence'); setMobilePanel('inspector'); }}><Box size={13} /> Providers</button>}<div className="segmented-control" aria-label="Map view"><button aria-pressed={graphView === 'map'} className={graphView === 'map' ? 'active' : ''} onClick={() => setGraphView('map')}><Network size={14} /><span>Map</span></button><button aria-pressed={graphView === 'list'} className={graphView === 'list' ? 'active' : ''} onClick={() => setGraphView('list')}><List size={14} /><span>List</span></button></div></div></div>
        <div className="map-body">{indexBusy ? <div className="canvas-state" role="status"><div className="state-icon"><LoaderCircle size={26} className="spin" /></div><h2>Mapping the source</h2><p>Parsing the selected fixture without executing it.</p></div> : indexError ? <div className="canvas-state error" role="alert"><CircleAlert size={27} /><h2>Unable to load this snapshot</h2><p>{indexError}</p><button className="button secondary" onClick={() => setReload(value => value + 1)}>Retry source indexing</button></div> : index && index.nodes.length === 0 ? <div className="canvas-state"><Folder size={27} /><h2>No supported source found</h2><p>This snapshot returned no graph nodes.</p></div> : index && graphView === 'map' ? <GraphCanvas key={fixtureId} index={displayIndex ?? index} providerOrigins={providerOrigins} providerBindings={providerBindings} expandedPaths={expandedPaths} selectedId={selectedNode?.id ?? null} highlightedEdges={answer?.edgeIds ?? []} onSelect={selectNode} onEdgeSelect={selectEdge} /> : index && <div className="graph-list"><div className="section-label">Nodes · select to inspect</div>{matchingNodes.map(node => <button key={node.id} className={`graph-list-node ${selectedNode?.id === node.id ? 'selected' : ''}`} onClick={() => selectNode(node)}>{node.kind === 'file' ? <FileCode2 size={15} /> : node.kind === 'package' ? <Box size={15} /> : <Braces size={15} />}<span><strong>{node.label}</strong><small>{node.kind} · {node.snapshotId} · {providerOrigins[node.snapshotId] ?? 'local source'}</small></span><ArrowRight size={13} /></button>)}{matchingNodes.length === 0 && <p className="quiet-label">No matching nodes. Clear the repository search to show all source.</p>}<div className="section-label">Parsed relationships · select origin evidence</div>{(displayIndex?.edges ?? []).map(edge => <button key={edge.id} className="relationship-row" onClick={() => selectEdge(edge)}><span>{displayIndex?.nodes.find(node => node.id === edge.from)?.label}<small>{edge.relation} → {displayIndex?.nodes.find(node => node.id === edge.to)?.label}</small></span><ArrowRight size={13} /></button>)}</div>}</div>
        <div className="map-note"><GitBranch size={12} /><span>Static relationships show potential impact. Runtime behavior is not verified.</span></div>
        <form className="question-composer" onSubmit={submitQuestion}><label htmlFor="code-question">Ask this codebase</label><div className="composer-input"><textarea id="code-question" rows={2} value={question} maxLength={2000} onChange={event => setQuestion(event.target.value)} placeholder="How does this application retry failed jobs?" disabled={!index || indexBusy} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button className="send-button" type="submit" aria-label="Retrieve source evidence" disabled={!question.trim() || !index || answerBusy}>{answerBusy ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={18} />}</button></div><div className="composer-meta"><span>Extractive source retrieval · no generated answer</span>{!question && <button className="text-button" type="button" onClick={() => setQuestion(DEFAULT_QUESTION)}>Try the fixture question</button>}<span className="composer-shortcut">Ctrl / ⌘ + Enter</span></div></form>
      </section>
      <ResizeHandle label="Resize evidence inspector" value={rightWidth} minimum={280} maximum={520} onChange={setRightWidth} reverse />
      <aside className="inspector-panel" aria-label="Source and evidence inspector"><div className="inspector-tabs"><button className={inspectorTab === 'source' ? 'active' : ''} aria-pressed={inspectorTab === 'source'} onClick={() => setInspectorTab('source')}><FileCode2 size={14} /> Source</button><button className={inspectorTab === 'evidence' ? 'active' : ''} aria-pressed={inspectorTab === 'evidence'} onClick={() => setInspectorTab('evidence')}><BookOpen size={14} /> Evidence{answer && <span>{answer.citations.length}</span>}</button></div>
        <div className="inspector-scroll" ref={inspectorScroll}>{inspectorTab === 'evidence' ? <AnswerView answer={answer} busy={answerBusy} error={answerError} onCitation={citation => { setSelectedNode(displayIndex?.nodes.find(node => node.kind === 'file' && node.snapshotId === citation.source.snapshotId && node.localId === citation.source.path) ?? null); void openSource(citation.source.path, citation.source.startLine, citation.source.endLine, citation.source.snapshotId as FixtureId, citation.providerId); }} /> : selectedNode?.kind === 'package' && !source && !sourceBusy && !sourceError ? <div className="package-inspector"><span className="node-type"><Box size={14} /> External reference</span><h2>{selectedNode.label}</h2><dl><div><dt>Version status</dt><dd>{selectedDependency?.status ?? 'See package binding'}</dd></div><div><dt>Origin</dt><dd>{selectedDependency?.sourcePath ?? 'Parsed source imports'}</dd></div><div><dt>Provider source</dt><dd>{selectedProvider ? `${selectedProvider.providerId} · delivered` : 'Not loaded'}</dd></div></dl>{selectedDependency?.reason && <p>{selectedDependency.reason}</p>}<div className="limitations"><h3>Exact-version source boundary</h3><p>This node comes from the local dependency binding. Review the explicit fixture provider approval below, or inspect the matching dependency snapshot directly. No paid context has been purchased.</p></div></div> : <SourceView source={source} busy={sourceBusy} error={sourceError} onFullFile={() => { if (source && sourceFile) void openSource(sourceFile.path, 1, sourceFile.lineCount, source.source.snapshotId as FixtureId, source.providerId); }} fullFileAvailable={!!sourceFile && !!source && (source.source.startLine !== 1 || source.source.endLine !== sourceFile.lineCount)} />}
          {selectedNode?.kind === 'file' && inspectorTab === 'source' && displayIndex?.nodes.some(node => node.kind === 'symbol' && node.snapshotId === selectedNode.snapshotId && nodePath(node) === selectedNode.localId) && <div className="inspector-actions"><button className="button secondary" onClick={() => { expandFile(selectedNode); setMobilePanel('map'); }}><Braces size={14} /> {expandedPaths.has(expansionKey(selectedNode)) ? 'Collapse symbols in map' : 'Expand symbols in map'}</button></div>}
          {index && inspectorTab === 'source' && <details className="index-limitations"><summary>Analysis limitations</summary><ul>{[...index.limitations, ...index.unresolved].map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
          {federation && inspectorTab === 'evidence' && <ProviderEvidence result={federation} onCitation={citation => { setSelectedNode(displayIndex?.nodes.find(node => node.kind === 'file' && node.snapshotId === citation.source.snapshotId && node.localId === citation.source.path) ?? null); void openSource(citation.source.path, citation.source.startLine, citation.source.endLine, citation.source.snapshotId as FixtureId, citation.providerId); }} />}
          {index && index.dependencies.length > 0 && <ProviderApproval key={fixtureId} fixtureId={fixtureId} index={index} onResult={onFederation} onActivity={onFederationActivity} onBusy={setProviderBusy} />}
        </div>
      </aside>
    </div>
    <footer className="workspace-status"><span><span className="status-dot" /> Local fixtures only</span><span>{lastActivity ? `${lastActivity.operation} · ${lastActivity.status} · ${lastActivity.durationMs} ms` : 'No operations completed yet'}</span><Link href="/app/settings">Live integrations unavailable <ArrowRight size={11} /></Link></footer>
  </main>;
}
