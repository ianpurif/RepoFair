import type { GraphNode, GraphEdge } from '../../contracts/src/index.ts';
import { AtlasError, requireCondition } from './errors.ts';
/** Collision-safe tuple identity; equal symbol names in different repos do not merge. */
export function nodeId(repositoryId: string, snapshotId: string, localId: string): string {
  requireCondition([repositoryId, snapshotId, localId].every(Boolean), 'INVALID_NODE', 'Missing node identity.');
  return JSON.stringify([repositoryId, snapshotId, localId]);
}
export function validateGraph(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): void {
  const known = new Set<string>();
  for (const node of nodes) {
    requireCondition(node.id === nodeId(node.repositoryId, node.snapshotId, node.localId), 'INVALID_NODE', 'Invalid scoped node ID.');
    requireCondition(!known.has(node.id), 'DUPLICATE_NODE', 'Duplicate graph identity.');
    known.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    requireCondition(known.has(edge.from) && known.has(edge.to), 'DANGLING_EDGE', 'Unmapped graph endpoint.');
    requireCondition(Boolean(edge.id) && !edgeIds.has(edge.id) && Boolean(edge.evidenceId), 'INVALID_EDGE', 'Missing/duplicate edge evidence.');
    edgeIds.add(edge.id);
  }
}
/** Traverses an already authorized graph. It does not prove runtime effects. */
export function neighborhood(nodes: readonly GraphNode[], edges: readonly GraphEdge[], start: string,
  maxDepth = 2, maxNodes = 100): { nodeIds: string[]; truncated: boolean; interpretation: 'potential-relationship' } {
  validateGraph(nodes, edges);
  requireCondition(Number.isInteger(maxDepth) && maxDepth >= 0 && maxDepth <= 5, 'INVALID_LIMIT', 'Invalid graph depth.');
  requireCondition(Number.isInteger(maxNodes) && maxNodes >= 1 && maxNodes <= 500, 'INVALID_LIMIT', 'Invalid graph size.');
  if (!nodes.some(node => node.id === start)) throw new AtlasError('UNKNOWN_NODE', 'Node is unavailable.');
  const visited = new Set([start]);
  let layer = [start];
  let truncated = false;
  for (let depth = 0; depth < maxDepth && layer.length; depth++) {
    const next: string[] = [];
    for (const current of layer) for (const edge of edges) {
      const adjacent = edge.from === current ? edge.to : edge.to === current ? edge.from : null;
      if (adjacent === null || visited.has(adjacent)) continue;
      if (visited.size >= maxNodes) { truncated = true; continue; }
      visited.add(adjacent); next.push(adjacent);
    }
    layer = next;
  }
  // A depth bound can omit reachable nodes even when the size bound was not hit.
  if (edges.some(edge => visited.has(edge.from) !== visited.has(edge.to))) truncated = true;
  return { nodeIds: [...visited], truncated, interpretation: 'potential-relationship' };
}
