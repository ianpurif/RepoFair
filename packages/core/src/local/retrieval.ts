import type { Activity, LocalAnswer, SourceEvidence, SourceIndex } from '../../../contracts/src/index.ts';
import { parseQuestion } from '../../../contracts/src/local.ts';
import { LOCAL_LIMITS } from './limits.ts';
import { validateSourceIndex } from './validation.ts';

const STOP = new Set('a an and are as at be by can code could did do does for from how i if in into is it me of on or our should that the their them these they this to us was what when where which who why will with would you your'.split(' '));
function terms(text: string): string[] {
  return [...new Set(text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter(term => term.length > 1 && !STOP.has(term)).map(term => term.replace(/ies$/, 'y').replace(/(?:ing|ed|s)$/, ''));
}
function score(evidence: SourceEvidence, query: readonly string[]): number {
  const content = terms(`${evidence.source.path} ${evidence.original}`);
  return query.reduce((sum, term) => sum + (content.includes(term) ? 1 : 0), 0);
}
export function sourceQuestionLimitation(index: SourceIndex, question: string): string | null {
  if (/\b(prove|guarantee|certify)\b/i.test(question) && /\b(production|runtime|always|never|ever|all|no)\b/i.test(question)) {
    return 'Static source cannot establish that runtime or production guarantee. Independent execution evidence is unavailable.';
  }
  const releases = [{ packageName: index.packageName, version: index.version }, ...index.dependencies];
  for (const release of releases) {
    if (!release.packageName) continue;
    const shortName = release.packageName.split('/').at(-1)!;
    const escaped = shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mentioned = new RegExp(`${escaped}\\s*(?:@|version\\s*)?\\s*(\\d+\\.\\d+\\.\\d+(?:-[\\w.-]+)?)`, 'i').exec(question);
    if (mentioned && mentioned[1] !== release.version) return `${release.packageName}@${mentioned[1]} has no exact source mapping in this snapshot (bound version: ${release.version ?? 'unresolved'}).`;
  }
  return null;
}

/** Bounded lexical retrieval + a real parsed graph neighborhood. No model call. */
export function answerLocal(index: SourceIndex, rawQuestion: string): LocalAnswer {
  const activities: Activity[] = [];
  function timed<T>(operation: string, detail: (value: T) => string, work: () => T): T {
    const started = Date.now(); const value = work();
    activities.push({ id: `${operation}:${started}:${activities.length}`, operation, startedAt: new Date(started).toISOString(),
      durationMs: Math.max(0, Date.now() - started), status: 'complete', detail: detail(value) }); return value;
  }
  timed('validate-index', () => `Checked ${index.files.length} files, ${index.evidence.length} original source passages and graph endpoints.`, () => validateSourceIndex(index));
  const question = parseQuestion(rawQuestion);
  const query = terms(question);
  function abstain(reason: string): LocalAnswer {
    return { schemaVersion: 1, mode: 'extractive', status: 'abstained', answer: reason, citations: [], nodeIds: [], edgeIds: [], missingEvidence: [reason], activities };
  }
  const conflict = sourceQuestionLimitation(index, question); if (conflict) return abstain(conflict);
  const ranked = timed('lexical-source-search', value => `Searched ${index.evidence.length} passages; selected ${value.length} bounded candidates.`, () => {
    const candidates = index.evidence.map(item => ({ item, score: score(item, query) }))
      .filter(candidate => candidate.score > 0 && /\.(?:[cm]?ts|tsx|[cm]?js|jsx|py|go|rs|java|rb|php|c|h|cpp|hpp|cs|swift|kt|vue|svelte|sql)$/.test(candidate.item.source.path))
      .sort((a, b) => b.score - a.score || (a.item.source.endLine - a.item.source.startLine) - (b.item.source.endLine - b.item.source.startLine)
        || a.item.id.localeCompare(b.item.id));
    const result: SourceEvidence[] = [];
    for (const candidate of candidates) {
      if (result.some(item => item.source.path === candidate.item.source.path
        && item.source.startLine <= candidate.item.source.endLine && candidate.item.source.startLine <= item.source.endLine)) continue;
      result.push(candidate.item); if (result.length === LOCAL_LIMITS.candidates) break;
    }
    return result;
  });
  if (!ranked.length) return abstain(`No matching original source evidence was found in this ${index.mode === 'git' ? 'Git commit' : 'fixture snapshot'}.`);
  const selectedEvidence = new Map(ranked.map(item => [item.id, item]));
  const selectedNodes = new Set<string>(); const selectedEdges = new Set<string>();
  const filePaths = new Set(ranked.map(item => item.source.path));
  for (const node of index.nodes) if (node.kind === 'file' && filePaths.has(node.localId)) selectedNodes.add(node.id);
  for (const edge of index.edges) if (selectedEvidence.has(edge.evidenceId)) {
    if (!selectedNodes.has(edge.from) && selectedNodes.size < LOCAL_LIMITS.graphNodes) selectedNodes.add(edge.from);
    if (!selectedNodes.has(edge.to) && selectedNodes.size < LOCAL_LIMITS.graphNodes) selectedNodes.add(edge.to);
    if (selectedNodes.size >= LOCAL_LIMITS.graphNodes) break;
  }
  timed('expand-parsed-graph', () => `Expanded ${selectedNodes.size} nodes and ${selectedEdges.size} parsed edges to depth ${LOCAL_LIMITS.graphDepth}.`, () => {
    let layer = [...selectedNodes];
    for (let depth = 0; depth < LOCAL_LIMITS.graphDepth && layer.length; depth++) {
      const next: string[] = [];
      for (const current of layer) for (const edge of index.edges) {
        if (selectedEdges.size >= LOCAL_LIMITS.answerEdges) break;
        if (edge.from !== current && edge.to !== current) continue;
        const other = edge.from === current ? edge.to : edge.from;
        if (!selectedNodes.has(other)) {
          if (selectedNodes.size >= LOCAL_LIMITS.graphNodes) continue;
          selectedNodes.add(other); next.push(other);
        }
        selectedEdges.add(edge.id);
      }
      layer = next;
    }
  });
  const missing = new Set<string>();
  for (const dependency of index.dependencies) {
    if (!filePaths.has(dependency.sourcePath)) continue;
    missing.add(dependency.status === 'exact' ? `${dependency.packageName}@${dependency.version}: external source/export evidence is unavailable locally.`
      : `${dependency.packageName}: ${dependency.reason}`);
  }
  for (const item of index.unresolved) if ([...filePaths].some(path => item.startsWith(`${path}:`))) missing.add(item);
  if (selectedNodes.size >= LOCAL_LIMITS.graphNodes) missing.add('Graph expansion reached its node limit.');
  if (selectedEdges.size >= LOCAL_LIMITS.answerEdges) missing.add('Graph expansion reached its edge limit.');
  for (const edge of index.edges) if (selectedEdges.has(edge.id) && !selectedEvidence.has(edge.evidenceId)
    && selectedEvidence.size < LOCAL_LIMITS.candidates) selectedEvidence.set(edge.evidenceId, index.evidence.find(item => item.id === edge.evidenceId)!);
  const citations: SourceEvidence[] = [];
  let body = `Extractive source evidence for ${index.packageName && index.version ? `${index.packageName}@${index.version}` : 'this repository'} (${index.snapshot.revision}).\nStatic relationships show potential impact; they do not establish runtime outcomes.\n`;
  for (const item of selectedEvidence.values()) {
    const excerpt = `\n${item.source.path}:${item.source.startLine}–${item.source.endLine}\n${item.original}\n`;
    if (body.length + excerpt.length > LOCAL_LIMITS.answerCharacters) { missing.add('The source context character limit omitted additional passages.'); continue; }
    citations.push(item); body += excerpt;
  }
  if (!citations.length) return abstain('Matching source exceeded the bounded response size; use exact source navigation.');
  timed('validate-citations', () => `Validated ${citations.length} citations against this exact ${index.mode === 'git' ? 'Git commit' : 'fixture snapshot'}.`, () => {
    for (const item of citations) if (!index.evidence.some(original => original.id === item.id && original.original === item.original)) throw new Error('Citation is outside indexed evidence');
  });
  return { schemaVersion: 1, mode: 'extractive', status: 'evidence_ready', answer: body, citations,
    nodeIds: [...selectedNodes], edgeIds: [...selectedEdges], missingEvidence: [...missing], activities };
}
