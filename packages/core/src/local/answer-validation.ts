import type { LocalAnswer, SourceIndex } from '../../../contracts/src/index.ts';
import { checkSourcePassage, sameScope } from '../evidence.ts';
import { assertLocal, record, LOCAL_LIMITS } from './limits.ts';
import { validateSourceIndex } from './validation.ts';
/** Validate hostile serialized answers. Structural validity is not semantic truth. */
export function validateLocalAnswer(value: unknown, index: SourceIndex): asserts value is LocalAnswer {
  validateSourceIndex(index);
  assertLocal(record(value) && value.schemaVersion === 1 && value.mode === 'extractive'
    && ['evidence_ready','abstained'].includes(String(value.status))
    && typeof value.answer === 'string' && value.answer.length <= LOCAL_LIMITS.answerCharacters, 'Invalid answer');
  const textArray = (v: unknown, max: number, length: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(s => typeof s === 'string' && s.length <= length);
  assertLocal(textArray(value.nodeIds, LOCAL_LIMITS.graphNodes + 2, 10000) && textArray(value.edgeIds, LOCAL_LIMITS.edges, 30000)
    && textArray(value.missingEvidence, LOCAL_LIMITS.edges, 4000), 'Invalid answer graph or limitations');
  assertLocal(value.nodeIds.every(id => index.nodes.some(n => n.id === id)) && value.edgeIds.every(id => index.edges.some(e => e.id === id)), 'Unknown answer graph identity');
  assertLocal(Array.isArray(value.citations) && value.citations.length <= LOCAL_LIMITS.candidates, 'Invalid answer citations');
  for (const citation of value.citations) {
    assertLocal(record(citation) && typeof citation.id === 'string', 'Invalid answer citation');
    const canonical = index.evidence.find(e => e.id === citation.id);
    assertLocal(canonical && record(citation.scope) && sameScope(citation.scope as typeof index.scope, index.scope)
      && JSON.stringify(citation.source) === JSON.stringify(canonical.source) && citation.original === canonical.original
      && citation.provenance === 'parsed-source' && citation.providerId === null && typeof citation.observedAt === 'string'
      && Number.isFinite(Date.parse(citation.observedAt)), 'Noncanonical answer citation');
    checkSourcePassage(canonical, index.scope, index.files.find(f => f.path === canonical.source.path)!.text);
  }
  assertLocal(value.status === 'evidence_ready' ? value.citations.length > 0 : value.citations.length === 0, 'Answer status differs from evidence');
  assertLocal(Array.isArray(value.activities) && value.activities.length <= 20, 'Invalid activity list');
  for (const activity of value.activities) assertLocal(record(activity) && typeof activity.id === 'string' && activity.id.length <= 500
    && typeof activity.operation === 'string' && activity.operation.length <= 100 && typeof activity.detail === 'string' && activity.detail.length <= 4000
    && typeof activity.startedAt === 'string' && Number.isFinite(Date.parse(activity.startedAt))
    && typeof activity.durationMs === 'number' && Number.isSafeInteger(activity.durationMs) && activity.durationMs >= 0 && activity.durationMs <= 60000
    && ['complete','failed'].includes(String(activity.status)), 'Invalid activity record');
}
