import type { Scope, SourceEvidence } from '../../contracts/src/index.ts';
import { AtlasError, requireCondition } from './errors.ts';

export function sameScope(a: Scope, b: Scope): boolean {
  return a.tenantId.length > 0 && a.principalId.length > 0 && a.permissionRevision.length > 0
    && a.tenantId === b.tenantId && a.principalId === b.principalId
    && a.permissionRevision === b.permissionRevision;
}
/** Pure validation. Call only after trusted authentication and authorization. */
export function validateEvidence(e: SourceEvidence, scope: Scope): void {
  requireCondition(sameScope(e.scope, scope), 'DENIED', 'Evidence is unavailable to this scope.');
  const s = e.source;
  requireCondition(e.id.length > 0 && s.repositoryId.length > 0 && s.snapshotId.length > 0,
    'INVALID_SOURCE', 'Missing source identity.');
  requireCondition(isSafeRelativePath(s.path), 'INVALID_PATH', 'Source paths must stay repository-relative.');
  requireCondition(Number.isSafeInteger(s.startLine) && Number.isSafeInteger(s.endLine)
    && s.startLine > 0 && s.endLine >= s.startLine, 'INVALID_LINES', 'Invalid source line range.');
  const validRevision = s.kind === 'git' ? /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(s.revision)
    : s.kind === 'fixture' && /^sha256:[a-f0-9]{64}$/.test(s.revision);
  requireCondition(validRevision, 'INVALID_REVISION', 'Use an immutable revision; fixtures are not Git commits.');
  requireCondition(Number.isFinite(Date.parse(e.observedAt)), 'INVALID_TIME', 'Invalid observation time.');
}
export function isSafeRelativePath(path: string): boolean {
  // eslint-disable-next-line no-control-regex -- reject control characters in untrusted paths
  if (!path || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
/** Validate the claimed passage against actual authorized snapshot content. No semantic-truth claim. */
export function checkSourcePassage(e: SourceEvidence, scope: Scope, sourceText: string): void {
  validateEvidence(e, scope);
  const lines = sourceText.replace(/\r\n/g, '\n').split('\n');
  if (e.source.endLine > lines.length) throw new AtlasError('INVALID_LINES', 'Passage exceeds the source.');
  const actual = lines.slice(e.source.startLine - 1, e.source.endLine).join('\n');
  requireCondition(actual === e.original, 'SOURCE_MISMATCH', 'Passage does not match this snapshot.');
}
