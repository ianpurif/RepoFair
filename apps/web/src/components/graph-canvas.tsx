'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow } from '@xyflow/react';
import type { Edge, Node, NodeProps, ReactFlowInstance } from '@xyflow/react';
import type { GraphEdge,GraphNode, SourceIndex, ParsedEdge } from '@atlas/contracts';
import { Box, Braces, FileCode2 } from 'lucide-react';

type SourceNode = Node<{ label: string; kind: GraphNode['kind']; caption: string; related: boolean }, 'source'>;
function SourceGraphNode({ data, selected }: NodeProps<SourceNode>) {
  const Icon = data.kind === 'file' ? FileCode2 : data.kind === 'symbol' ? Braces : Box;
  return <div className={`source-node ${data.kind} ${selected ? 'selected' : ''} ${data.related ? 'related' : ''}`}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <div className="source-node-heading"><span className="node-icon"><Icon size={17} strokeWidth={1.6} /></span><span>{data.label}</span></div>
    <span className="node-caption">{data.caption}</span>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
}
const nodeTypes = { source: SourceGraphNode };
const emptyProviderMetadata: Readonly<Record<string, string>> = Object.freeze({});
export function nodePath(node: GraphNode): string | null {
  if (node.kind === 'file') return node.localId;
  if (node.kind === 'symbol') return node.localId.slice(0, node.localId.lastIndexOf('#')) || null;
  return null;
}
export function expansionKey(node: GraphNode): string { return `${node.snapshotId}:${nodePath(node) ?? node.localId}`; }
const MAX_RENDERED_NODES = 160;
type GraphData<TEdge extends GraphEdge> = Pick<SourceIndex, 'nodes' | 'packageName' | 'version'> & {edges:readonly TEdge[]};

export function GraphCanvas<TEdge extends GraphEdge=ParsedEdge>({ index, expandedPaths, selectedId, highlightedEdges, onSelect, onEdgeSelect, providerOrigins = emptyProviderMetadata, providerBindings = emptyProviderMetadata }: {
  index: GraphData<TEdge>; expandedPaths: ReadonlySet<string>; selectedId: string | null; highlightedEdges: readonly string[];
  onSelect: (node: GraphNode) => void; onEdgeSelect: (edge: TEdge) => void;
  providerOrigins?: Readonly<Record<string, string>>;
  providerBindings?: Readonly<Record<string, string>>;
}) {
  const instance = useRef<ReactFlowInstance<SourceNode, Edge> | null>(null);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const slots = useRef(new Map<string, Map<string, number>>());
  const snapshotSlots = useRef(new Map<string, number>());
  const lookup = useMemo(() => {
    const nodeById = new Map(index.nodes.map(node => [node.id, node]));
    const edgeById = new Map(index.edges.map(edge => [edge.id, edge]));
    const adjacent = new Map<string, Set<string>>();
    const pairs = new Map<string, TEdge[]>();
    for (const edge of index.edges) {
      for (const [from, to] of [[edge.from, edge.to], [edge.to, edge.from]]) {
        const neighbors = adjacent.get(from!) ?? new Set<string>(); neighbors.add(to!); adjacent.set(from!, neighbors);
      }
      const key = JSON.stringify([edge.from, edge.to]); const shared = pairs.get(key) ?? []; shared.push(edge); pairs.set(key, shared);
    }
    return { nodeById, edgeById, adjacent, pairs };
  }, [index.nodes, index.edges]);
  const eligible = useMemo(() => index.nodes.filter(node => node.kind !== 'symbol' || expandedPaths.has(expansionKey(node)) || node.id === selectedId), [index.nodes, expandedPaths, selectedId]);
  const visible = useMemo(() => {
    const selected = eligible.find(node => node.id === selectedId);
    return selected ? [selected, ...eligible.filter(node => node.id !== selectedId)].slice(0, MAX_RENDERED_NODES) : eligible.slice(0, MAX_RENDERED_NODES);
  }, [eligible, selectedId]);
  const visibleIds = useMemo(() => new Set(visible.map(node => node.id)), [visible]);
  const relatedIds = useMemo(() => selectedId ? new Set([selectedId, ...(lookup.adjacent.get(selectedId) ?? [])]) : new Set<string>(), [lookup, selectedId]);
  const mapped = useMemo<SourceNode[]>(() => visible.map(node => {
    if (!snapshotSlots.current.has(node.snapshotId)) snapshotSlots.current.set(node.snapshotId, snapshotSlots.current.size);
    const groupX = snapshotSlots.current.get(node.snapshotId)! * 1020;
    function rank(group: string, id: string) {
      const rows = slots.current.get(group) ?? new Map<string, number>();
      if (!rows.has(id)) rows.set(id, rows.size);
      slots.current.set(group, rows); return rows.get(id)!;
    }
    let position = positions.current.get(node.id);
    if (!position) {
      if (node.kind === 'file') position = { x: groupX + 30, y: rank(`${node.snapshotId}:files`, node.localId) * 175 + 30 };
      else if (node.kind === 'package') position = { x: groupX + 630, y: rank(`${node.snapshotId}:packages`, node.id) * 165 + 100 };
      else {
        const path = nodePath(node) ?? node.localId;
        position = { x: groupX + 330, y: rank(`${node.snapshotId}:files`, path) * 175 + rank(`${node.snapshotId}:symbols:${path}`, node.id) * 82 + 30 };
      }
      positions.current.set(node.id, position);
    }
    return { id: node.id, type: 'source', position, selected: node.id === selectedId, data: {
      label: node.label, kind: node.kind, caption: providerOrigins[node.snapshotId] ? `${providerOrigins[node.snapshotId]} · ${node.snapshotId}` : node.kind === 'package' ? (providerBindings[node.localId] ? `Source delivered · ${providerBindings[node.localId]}` : node.localId === `package:${index.packageName}@${index.version}` ? 'Local package · release exports' : 'External dependency · source not loaded') : node.kind === 'symbol' ? `Symbol · ${nodePath(node)}` : 'Local source · parsed', related: relatedIds.has(node.id),
    }, ariaLabel: `${node.kind}: ${node.label}. Select to inspect source.`, deletable: false, connectable: false };
  }), [visible, selectedId, relatedIds, index.packageName, index.version, providerOrigins, providerBindings]);
  const [nodes, setNodes] = useState<SourceNode[]>(mapped);
  useEffect(() => {
    setNodes(mapped);
    if (positions.current.size > 1000) for (const id of positions.current.keys()) { if (!visibleIds.has(id)) positions.current.delete(id); if (positions.current.size <= 1000) break; }
  }, [mapped, visibleIds]);
  const edges = useMemo<Edge[]>(() => {
    const highlighted = new Set(highlightedEdges);
    return index.edges.filter(edge => visibleIds.has(edge.from) && visibleIds.has(edge.to)).slice(0, 400).map(edge => {
    const emphasized = edge.from === selectedId || edge.to === selectedId || highlighted.has(edge.id);
    const shared = lookup.pairs.get(JSON.stringify([edge.from, edge.to])) ?? [];
    const label = shared[0]?.id === edge.id ? [...new Set(shared.map(item => item.relation))].join(' · ') : '';
    return { id: edge.id, source: edge.from, target: edge.to, label, type: 'smoothstep', animated: false,
      style: { stroke: emphasized ? 'var(--accent)' : 'var(--graph-line)', strokeWidth: emphasized ? 1.7 : 1.1 },
      labelStyle: { fill: 'var(--muted)', fontSize: 10 }, labelBgStyle: { fill: 'var(--surface)' }, markerEnd: { type: MarkerType.ArrowClosed, color: emphasized ? 'var(--accent)' : 'var(--graph-line)', width: 14, height: 14 },
      ariaLabel: `${edge.relation}, ${edge.provenance}. Select to open origin evidence.`, deletable: false, focusable: true,
    };
    });
  }, [index.edges, lookup, visibleIds, selectedId, highlightedEdges]);
  return <div className="graph-canvas" aria-label="Parsed source relationship graph" onKeyDownCapture={event => {
    if (event.key !== 'Enter' && event.key !== ' ' || !(event.target instanceof Element)) return;
    const nodeElement = event.target.closest('.react-flow__node');
    const edgeElement = event.target.closest('.react-flow__edge');
    const node = nodeElement ? lookup.nodeById.get(nodeElement.getAttribute('data-id') ?? '') : undefined;
    const edge = edgeElement ? lookup.edgeById.get(edgeElement.getAttribute('data-id') ?? '') : undefined;
    if (node || edge) { event.preventDefault(); event.stopPropagation(); if (node) onSelect(node); else if (edge) onEdgeSelect(edge); }
  }}>
    <ReactFlow<SourceNode, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      onInit={flow => { instance.current = flow; }}
      onNodesChange={changes => { setNodes(current => applyNodeChanges(changes, current)); for (const change of changes) { if (change.type === 'position' && change.position) positions.current.set(change.id, change.position); } }}
      onNodeClick={(_, node) => { const original = lookup.nodeById.get(node.id); if (original) onSelect(original); }}
      onEdgeClick={(_, edge) => { const original = lookup.edgeById.get(edge.id); if (original) onEdgeSelect(original); }}
      fitView fitViewOptions={{ padding: 0.25 }} minZoom={0.25} maxZoom={1.8} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
      colorMode="system" onlyRenderVisibleElements>
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--dot)" />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
    {eligible.length > MAX_RENDERED_NODES && <p className="graph-limit" role="status">Showing {MAX_RENDERED_NODES} nodes. Use a folder, search, or List to narrow the map.</p>}
    <div className="graph-legend"><span><i className="legend-local" /> Local source</span><span><i className="legend-external" /> External reference</span></div>
  </div>;
}
