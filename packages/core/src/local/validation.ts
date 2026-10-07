import type { LocalIndex, SourceEvidence, SourceIndex } from '../../../contracts/src/index.ts';
import { checkSourcePassage, isSafeRelativePath, sameScope } from '../evidence.ts';
import { nodeId, validateGraph } from '../graph.ts';
import { isExactVersion } from '../versions.ts';
import { assertLocal, LOCAL_LIMITS, record, sourceLines } from './limits.ts';

export function evidenceId(index: Pick<SourceIndex, 'snapshot'>, path: string, start: number, end: number): string {
  return JSON.stringify([index.snapshot.repositoryId, index.snapshot.snapshotId, index.snapshot.revision, path, start, end]);
}
function string(value: unknown, max = 2_000): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function validScope(value: unknown): boolean {
  return record(value) && string(value.tenantId) && string(value.principalId) && string(value.permissionRevision);
}
/** Structural/source validation is not authentication or a semantic truth check. */
export function validateLocalIndex(value: unknown): asserts value is LocalIndex {
  assertLocal(record(value) && value.schemaVersion === 1 && value.mode === 'fixture', 'Unsupported local index');
  validateSourceIndex(value);
}
/** Supports real Git indexes without accepting fixture/Git identity substitution. */
export function validateSourceIndex(value: unknown): asserts value is SourceIndex {
  assertLocal(record(value) && value.schemaVersion === 1 && (value.mode === 'fixture' || value.mode === 'git'), 'Unsupported source index');
  assertLocal(validScope(value.scope) && record(value.snapshot), 'Invalid index identity');
  const snapshot = value.snapshot;
  assertLocal(string(snapshot.repositoryId) && string(snapshot.snapshotId) && snapshot.kind === value.mode
    && typeof snapshot.revision === 'string' && (value.mode === 'fixture' ? /^sha256:[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/).test(snapshot.revision), `Invalid immutable ${value.mode} snapshot`);
  assertLocal(string(value.packageName) && typeof value.version === 'string' && isExactVersion(value.version), 'Invalid package identity');
  for (const field of ['files', 'nodes', 'edges', 'evidence', 'dependencies', 'unresolved', 'limitations']) {
    assertLocal(Array.isArray(value[field]), `Invalid ${field}`);
  }
  const index = value as unknown as SourceIndex;
  assertLocal(index.files.length > 0 && index.files.length <= LOCAL_LIMITS.files && index.nodes.length <= LOCAL_LIMITS.nodes
    && index.edges.length <= LOCAL_LIMITS.edges && index.evidence.length <= LOCAL_LIMITS.evidence
    && index.dependencies.length <= LOCAL_LIMITS.edges, 'Index exceeds limits');
  const files = new Map<string, string>(); let characters = 0;
  for (const file of index.files) {
    assertLocal(record(file) && string(file.path) && isSafeRelativePath(file.path) && !files.has(file.path)
      && typeof file.text === 'string' && file.text.length <= LOCAL_LIMITS.fileCharacters, 'Invalid source file');
    assertLocal(file.lineCount === sourceLines(file.text).length && file.lineCount <= LOCAL_LIMITS.linesPerFile, 'Invalid source line count');
    characters += file.text.length; files.set(file.path, file.text);
  }
  assertLocal(characters <= LOCAL_LIMITS.totalCharacters, 'Index source exceeds limits');
  if (index.mode === 'git') {
    const text = files.get('package.json'); assertLocal(text !== undefined, 'Git index requires a root package.json manifest');
    let manifest: unknown;
    try { manifest = JSON.parse(text); } catch { throw new Error('Invalid Git package.json manifest'); }
    assertLocal(record(manifest) && typeof manifest.version === 'string' && isExactVersion(manifest.version)
      && manifest.name === index.packageName && manifest.version === index.version, 'Git package identity differs from its source manifest');
  }
  for (const node of index.nodes) {
    assertLocal(record(node) && string(node.id, 10_000) && string(node.localId) && string(node.label)
      && node.repositoryId === index.snapshot.repositoryId && node.snapshotId === index.snapshot.snapshotId
      && ['file', 'symbol', 'package'].includes(node.kind), 'Invalid graph node');
    if (node.kind === 'file') assertLocal(files.has(node.localId) && node.label === node.localId, 'File node is outside snapshot');
    if (node.kind === 'symbol') {
      const match = /^(.*?)#[^#]+@(\d+):(\d+)$/.exec(node.localId);
      assertLocal(match && files.has(match[1]!) && Number(match[2]) >= 1
        && Number(match[2]) <= sourceLines(files.get(match[1]!)!).length, 'Symbol node is outside snapshot');
    }
  }
  validateGraph(index.nodes, index.edges);
  const evidence = new Map<string, SourceEvidence>();
  for (const passage of index.evidence) {
    assertLocal(record(passage) && record(passage.source) && validScope(passage.scope)
      && string(passage.id, 10_000) && typeof passage.original === 'string' && typeof passage.observedAt === 'string'
      && passage.providerId === null && passage.provenance === 'parsed-source', 'Invalid source evidence');
    assertLocal(passage.source.repositoryId === index.snapshot.repositoryId && passage.source.snapshotId === index.snapshot.snapshotId
      && passage.source.kind === index.snapshot.kind && passage.source.revision === index.snapshot.revision
      && sameScope(passage.scope, index.scope), 'Evidence belongs to another snapshot or scope');
    assertLocal(passage.source.endLine - passage.source.startLine < LOCAL_LIMITS.passageLines
      && passage.id === evidenceId(index, passage.source.path, passage.source.startLine, passage.source.endLine)
      && !evidence.has(passage.id), 'Invalid evidence identity or limit');
    const text = files.get(passage.source.path); assertLocal(text !== undefined, 'Evidence source is absent');
    checkSourcePassage(passage, index.scope, text); evidence.set(passage.id, passage);
  }
  const methods = { imports: 'ts-morph-import', exports: 'ts-morph-export', references: 'ts-morph-reference',
    'resolved-call': 'ts-morph-call', 'package-binding': 'ts-morph-import' };
  for (const edge of index.edges) {
    assertLocal(record(edge) && edge.provenance === 'parsed-source' && evidence.has(edge.evidenceId)
      && Object.hasOwn(methods, edge.relation) && typeof edge.extractionMethod === 'string'
      && (methods[edge.relation] === edge.extractionMethod
        || (edge.relation === 'exports' && edge.extractionMethod === 'explicit-release-export')), 'Invalid edge extraction or source');
  }
  for (const binding of index.dependencies) {
    assertLocal(record(binding) && string(binding.packageName) && files.has(binding.sourcePath)
      && binding.packageName !== '__proto__'
      && Array.isArray(binding.importedNames) && binding.importedNames.length <= 100
      && binding.importedNames.every(name => string(name)), 'Invalid dependency binding');
    assertLocal(binding.status === 'exact' ? typeof binding.version === 'string' && isExactVersion(binding.version) && binding.reason === null
      : binding.status === 'unresolved' && binding.version === null && string(binding.reason), 'Invalid exact dependency version');
    assertLocal(index.nodes.some(node => node.kind === 'package' && node.id === nodeId(index.snapshot.repositoryId,
      index.snapshot.snapshotId, `package:${binding.packageName}@${binding.version ?? 'unresolved'}`)), 'Missing dependency package node');
  }
  assertLocal(index.unresolved.length <= LOCAL_LIMITS.edges && index.limitations.length <= 100
    && [...index.unresolved, ...index.limitations].every(item => string(item, 4_000)), 'Invalid index limitations');
}

export function lookupSource(index: SourceIndex, path: string, startLine: number, endLine: number): SourceEvidence {
  validateSourceIndex(index);
  assertLocal(typeof path === 'string' && isSafeRelativePath(path), 'Invalid source path');
  assertLocal(Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine) && startLine >= 1 && endLine >= startLine
    && endLine - startLine < LOCAL_LIMITS.passageLines, 'Invalid or oversized source range');
  const file = index.files.find(candidate => candidate.path === path);
  assertLocal(file && endLine <= file.lineCount, 'Source range is unavailable in this snapshot');
  const existing = index.evidence.find(item => item.source.path === path && item.source.startLine === startLine && item.source.endLine === endLine);
  const passage: SourceEvidence = existing ?? {
    id: evidenceId(index, path, startLine, endLine), scope: index.scope,
    source: { ...index.snapshot, path, startLine, endLine },
    original: sourceLines(file.text).slice(startLine - 1, endLine).join('\n'),
    providerId: null, observedAt: index.evidence[0]?.observedAt ?? new Date(0).toISOString(), provenance: 'parsed-source',
  };
  checkSourcePassage(passage, index.scope, file.text); return passage;
}
