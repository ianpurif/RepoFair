'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow } from '@xyflow/react';
import type { Edge, Node, NodeProps, ReactFlowInstance } from '@xyflow/react';
import type { GraphNode, LocalIndex, ParsedEdge } from '@atlas/contracts';
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
export function nodePath(node: GraphNode): string | null {
  if (node.kind === 'file') return node.localId;
  if (node.kind === 'symbol') return node.localId.split('#')[0] ?? null;
  return null;
}
export function expansionKey(node: GraphNode): string { return `${node.snapshotId}:${nodePath(node) ?? node.localId}`; }

export function GraphCanvas({ index, expandedPaths, selectedId, highlightedEdges, onSelect, onEdgeSelect, providerOrigins = {}, providerBindings = {} }: {
  index: LocalIndex; expandedPaths: ReadonlySet<string>; selectedId: string | null; highlightedEdges: readonly string[];
  onSelect: (node: GraphNode) => void; onEdgeSelect: (edge: ParsedEdge) => void;
  providerOrigins?: Readonly<Record<string, string>>;
  providerBindings?: Readonly<Record<string, string>>;
}) {
  const instance = useRef<ReactFlowInstance<SourceNode, Edge> | null>(null);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const files = useMemo(() => index.nodes.filter(node => node.kind === 'file').sort((a, b) => a.localId.localeCompare(b.localId)), [index]);
  const packages = useMemo(() => index.nodes.filter(node => node.kind === 'package').sort((a, b) => a.localId.localeCompare(b.localId)), [index]);
  const visible = useMemo(() => index.nodes.filter(node => node.kind === 'symbol' ? expandedPaths.has(expansionKey(node)) || node.id === selectedId : node.kind === 'file' ? /\.[cm]?[jt]sx?$/.test(node.localId) || node.id === selectedId : true), [index, expandedPaths, selectedId]);
  const visibleIds = useMemo(() => new Set(visible.map(node => node.id)), [visible]);
  const relatedIds = useMemo(() => new Set(index.edges.filter(edge => edge.from === selectedId || edge.to === selectedId).flatMap(edge => [edge.from, edge.to])), [index, selectedId]);
  const mapped = useMemo<SourceNode[]>(() => visible.map(node => {
    const snapshots = [...new Set(index.nodes.map(item => item.snapshotId))];
    const groupX = Math.max(0, snapshots.indexOf(node.snapshotId)) * 1020;
    const groupFiles = files.filter(file => file.snapshotId === node.snapshotId).sort((a, b) => Number(!/\.[cm]?[jt]sx?$/.test(a.localId)) - Number(!/\.[cm]?[jt]sx?$/.test(b.localId)) || a.localId.localeCompare(b.localId));
    const groupPackages = packages.filter(item => item.snapshotId === node.snapshotId);
    let position = positions.current.get(node.id);
    if (!position) {
      if (node.kind === 'file') position = { x: groupX + 30, y: groupFiles.findIndex(file => file.id === node.id) * 175 + 30 };
      else if (node.kind === 'package') position = { x: groupX + 630, y: groupPackages.findIndex(item => item.id === node.id) * 165 + 100 };
      else {
        const path = nodePath(node);
        const fileIndex = Math.max(0, groupFiles.findIndex(file => file.localId === path));
        const siblings = index.nodes.filter(item => item.kind === 'symbol' && item.snapshotId === node.snapshotId && nodePath(item) === path);
        position = { x: groupX + 330, y: fileIndex * 175 + siblings.findIndex(item => item.id === node.id) * 82 + 30 };
      }
      positions.current.set(node.id, position);
    }
    return { id: node.id, type: 'source', position, selected: node.id === selectedId, data: {
      label: node.label, kind: node.kind, caption: providerOrigins[node.snapshotId] ? `${providerOrigins[node.snapshotId]} · ${node.snapshotId}` : node.kind === 'package' ? (providerBindings[node.localId] ? `Source delivered · ${providerBindings[node.localId]}` : node.localId === `package:${index.packageName}@${index.version}` ? 'Local package · release exports' : 'External dependency · source not loaded') : node.kind === 'symbol' ? `Symbol · ${nodePath(node)}` : 'Local source · parsed', related: relatedIds.has(node.id),
    }, ariaLabel: `${node.kind}: ${node.label}. Select to inspect source.`, deletable: false, connectable: false };
  }), [visible, selectedId, relatedIds, files, packages, index, providerOrigins, providerBindings]);
  const [nodes, setNodes] = useState<SourceNode[]>(mapped);
  useEffect(() => { setNodes(mapped); }, [mapped]);
  const edges = useMemo<Edge[]>(() => index.edges.filter(edge => visibleIds.has(edge.from) && visibleIds.has(edge.to)).map(edge => {
    const emphasized = edge.from === selectedId || edge.to === selectedId || highlightedEdges.includes(edge.id);
    const shared = index.edges.filter(item => item.from === edge.from && item.to === edge.to);
    const label = shared[0]?.id === edge.id ? [...new Set(shared.map(item => item.relation))].join(' · ') : '';
    return { id: edge.id, source: edge.from, target: edge.to, label, type: 'smoothstep', animated: false,
      style: { stroke: emphasized ? 'var(--accent)' : 'var(--graph-line)', strokeWidth: emphasized ? 1.7 : 1.1 },
      labelStyle: { fill: 'var(--muted)', fontSize: 10 }, labelBgStyle: { fill: 'var(--surface)' }, markerEnd: { type: MarkerType.ArrowClosed, color: emphasized ? 'var(--accent)' : 'var(--graph-line)', width: 14, height: 14 },
      ariaLabel: `${edge.relation}, ${edge.provenance}. Select to open origin evidence.`, deletable: false, focusable: true,
    };
  }), [index, visibleIds, selectedId, highlightedEdges]);
  return <div className="graph-canvas" aria-label="Parsed source relationship graph">
    <ReactFlow<SourceNode, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      onInit={flow => { instance.current = flow; }}
      onNodesChange={changes => { setNodes(current => applyNodeChanges(changes, current)); for (const change of changes) { if (change.type === 'position' && change.position) positions.current.set(change.id, change.position); } }}
      onNodeClick={(_, node) => { const original = index.nodes.find(item => item.id === node.id); if (original) onSelect(original); }}
      onEdgeClick={(_, edge) => { const original = index.edges.find(item => item.id === edge.id); if (original) onEdgeSelect(original); }}
      fitView fitViewOptions={{ padding: 0.25 }} minZoom={0.25} maxZoom={1.8} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
      colorMode="system" onlyRenderVisibleElements={false}>
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--dot)" />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
    <div className="graph-legend"><span><i className="legend-local" /> Local source</span><span><i className="legend-external" /> External reference</span></div>
  </div>;
}
