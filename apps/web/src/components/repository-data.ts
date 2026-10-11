import type { LocalAnswer, RepositoryGraphPage, SourceEvidence } from '@atlas/contracts';
import { objectValue, type RepositoryAccount } from './repository-browser';

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
export const safeSourcePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !value.startsWith('/') && !/[\\\0]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
export const BROWSER_NODE_LIMIT = 480;
const sourceLines = (text: string) => text.replace(/\r\n/g, '\n').split('\n');

/** The server authorizes source. These checks reject mixed or malformed snapshot responses. */
export function readRepositoryCitation(value: unknown, index: Pick<RepositoryGraphPage, 'scope' | 'snapshot'>): SourceEvidence {
  const citation = objectValue(value); const source = objectValue(citation.source); const scope = objectValue(citation.scope);
  if (typeof citation.id !== 'string' || !citation.id || typeof citation.original !== 'string' || citation.original.length > 1_048_576 || typeof citation.observedAt !== 'string' || !Number.isFinite(Date.parse(citation.observedAt)) || citation.providerId !== null || citation.provenance !== 'parsed-source' || source.kind !== 'git' || source.repositoryId !== index.snapshot.repositoryId || source.snapshotId !== index.snapshot.snapshotId || source.revision !== index.snapshot.revision || scope.tenantId !== index.scope.tenantId || scope.principalId !== index.scope.principalId || scope.permissionRevision !== index.scope.permissionRevision || !safeSourcePath(source.path) || !integer(source.startLine) || !integer(source.endLine) || source.startLine < 1 || source.endLine < source.startLine || sourceLines(citation.original).length !== source.endLine - source.startLine + 1) throw new Error('Source evidence does not match the authorized snapshot and line range.');
  return citation as unknown as SourceEvidence;
}

export function readRepositoryGraphPage(value: unknown, repositoryId: string, account: RepositoryAccount, expectedSnapshotId?: string): RepositoryGraphPage {
  const row = objectValue(value); const scope = objectValue(row.scope); const snapshot = objectValue(row.snapshot); const page = objectValue(row.page);
  if (row.schemaVersion !== 1 || row.mode !== 'git' || snapshot.kind !== 'git' || snapshot.repositoryId !== repositoryId || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId || expectedSnapshotId && snapshot.snapshotId !== expectedSnapshotId || !/^[0-9a-f]{40}$/i.test(String(snapshot.revision)) || scope.principalId !== account.principalId || !account.workspaces.some(item => item.id === scope.tenantId) || typeof scope.permissionRevision !== 'string' || !scope.permissionRevision || !(row.packageName === null || typeof row.packageName === 'string') || !(row.version === null || typeof row.version === 'string') || !Array.isArray(row.files) || row.files.length > 160 || !Array.isArray(row.nodes) || row.nodes.length > 160 || !Array.isArray(row.edges) || row.edges.length > 400 || !Array.isArray(row.evidence) || row.evidence.length > 400 || !Array.isArray(row.dependencies) || !Array.isArray(row.folders) || !strings(row.unresolved) || !strings(row.limitations) || !integer(page.cursor) || !(page.nextCursor === null || integer(page.nextCursor) && page.nextCursor > page.cursor) || !integer(page.totalNodes) || !integer(page.totalFiles) || !integer(page.limit) || page.limit < 1 || page.limit > 160) throw new Error('The map response does not match the authorized Git snapshot or page limits.');
  const files = new Set<string>();
  for (const value of row.files) {
    const file = objectValue(value);
    if (!safeSourcePath(file.path) || files.has(file.path) || !integer(file.lineCount) || file.lineCount < 1 || !integer(file.bytes) || 'text' in file) throw new Error('The map returned invalid file metadata.');
    files.add(file.path);
  }
  const nodeIds = new Set<string>();
  for (const value of row.nodes) {
    const node = objectValue(value);
    if (typeof node.id !== 'string' || nodeIds.has(node.id) || typeof node.localId !== 'string' || typeof node.label !== 'string' || !['file', 'symbol', 'package'].includes(String(node.kind)) || node.repositoryId !== repositoryId || node.snapshotId !== snapshot.snapshotId || node.id !== JSON.stringify([repositoryId, snapshot.snapshotId, node.localId]) || node.kind === 'file' && !files.has(node.localId)) throw new Error('The map returned an invalid graph identity.');
    nodeIds.add(node.id);
  }
  const index = row as unknown as RepositoryGraphPage;
  const evidenceIds = new Set<string>();
  for (const value of row.evidence) {
    const citation = readRepositoryCitation(value, index);
    if (evidenceIds.has(citation.id)) throw new Error('The map returned duplicate source evidence.');
    evidenceIds.add(citation.id);
  }
  const edgeIds = new Set<string>();
  for (const value of row.edges) {
    const edge = objectValue(value);
    if (typeof edge.id !== 'string' || edgeIds.has(edge.id) || !nodeIds.has(String(edge.from)) || !nodeIds.has(String(edge.to)) || !evidenceIds.has(String(edge.evidenceId)) || edge.provenance !== 'parsed-source' || !['imports', 'exports', 'references', 'resolved-call', 'package-binding', 'declares'].includes(String(edge.relation)) || !['ts-morph-import', 'ts-morph-export', 'ts-morph-reference', 'ts-morph-call', 'explicit-release-export', 'python-ast-import', 'python-ast-declaration'].includes(String(edge.extractionMethod))) throw new Error('The map returned a relationship without valid source origin.');
    edgeIds.add(edge.id);
  }
  for (const value of row.dependencies) {
    const binding = objectValue(value);
    if (typeof binding.packageName !== 'string' || !(binding.version === null || typeof binding.version === 'string') || !safeSourcePath(binding.sourcePath) || !strings(binding.importedNames) || !['exact', 'unresolved'].includes(String(binding.status)) || !(binding.reason === null || typeof binding.reason === 'string')) throw new Error('The map returned an invalid dependency binding.');
  }
  for (const value of row.folders) {
    const folder = objectValue(value);
    if (!(folder.path === '' || folder.path === '.' || safeSourcePath(folder.path)) || !integer(folder.fileCount)) throw new Error('The map returned an invalid folder.');
  }
  return index;
}

export function mergeRepositoryGraphPages(current: RepositoryGraphPage, incoming: RepositoryGraphPage): RepositoryGraphPage {
  if (current.snapshot.snapshotId !== incoming.snapshot.snapshotId || current.snapshot.revision !== incoming.snapshot.revision || current.scope.permissionRevision !== incoming.scope.permissionRevision) throw new Error('The map changed during loading. Refresh the snapshot before expanding it.');
  const unique = <T,>(items: readonly T[], key: (item: T) => string) => [...new Map(items.map(item => [key(item), item])).values()];
  const incomingIds = new Set(incoming.nodes.map(node => node.id));
  const retained = current.nodes.filter(node => !incomingIds.has(node.id)).slice(-(BROWSER_NODE_LIMIT - incoming.nodes.length));
  const nodes = unique([...retained, ...incoming.nodes], item => item.id);
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = unique([...current.edges, ...incoming.edges], item => item.id).filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to)).slice(-1200);
  const evidenceIds = new Set(edges.map(edge => edge.evidenceId));
  const evidence = unique([...current.evidence, ...incoming.evidence], item => item.id).filter(item => evidenceIds.has(item.id));
  const paths = new Set(nodes.flatMap(node => node.kind === 'file' ? [node.localId] : node.kind === 'symbol' ? [node.localId.slice(0, node.localId.lastIndexOf('#'))] : []));
  return { ...incoming, nodes, edges, evidence, files: unique([...current.files, ...incoming.files], item => item.path).filter(file => paths.has(file.path)), dependencies: unique([...current.dependencies, ...incoming.dependencies], item => `${item.packageName}:${item.version}:${item.sourcePath}`).slice(-1000), unresolved: [...new Set([...current.unresolved, ...incoming.unresolved])].slice(-1000), limitations: [...new Set([...current.limitations, ...incoming.limitations])].slice(-100) };
}

export function readRepositoryAnswer(value: unknown, index: RepositoryGraphPage): LocalAnswer {
  const row = objectValue(value);
  if (row.schemaVersion !== 1 || row.mode !== 'extractive' || !['evidence_ready', 'abstained'].includes(String(row.status)) || typeof row.answer !== 'string' || !Array.isArray(row.citations) || row.citations.length > 40 || !strings(row.nodeIds) || !strings(row.edgeIds) || !strings(row.missingEvidence) || !Array.isArray(row.activities)) throw new Error('The server returned an invalid source retrieval response.');
  row.citations.forEach(value => readRepositoryCitation(value, index));
  if (row.status === 'evidence_ready' && row.citations.length === 0) throw new Error('The response claims evidence without a supporting source range.');
  for (const id of row.nodeIds) {
    let identity: unknown; try { identity = JSON.parse(id); } catch { throw new Error('The answer returned an invalid graph identity.'); }
    if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== index.snapshot.repositoryId || identity[1] !== index.snapshot.snapshotId) throw new Error('The answer references another repository snapshot.');
  }
  for (const value of row.activities) {
    const activity = objectValue(value);
    if (typeof activity.id !== 'string' || typeof activity.operation !== 'string' || typeof activity.startedAt !== 'string' || !integer(activity.durationMs) || !['complete', 'failed'].includes(String(activity.status)) || typeof activity.detail !== 'string') throw new Error('The server returned invalid retrieval operation details.');
  }
  return row as unknown as LocalAnswer;
}
