import type { GraphEdge, GraphNode, Scope, Snapshot, SourceEvidence } from './index.ts';

/** Public fixtures only. A caller-supplied scope is never authentication. */
export type FixtureId = 'jobboard-app@1.0.0' | 'jobboard-app@2.0.0' | 'retry-kit@1.0.0' | 'retry-kit@2.0.0' | 'event-log@1.0.0';
export type SourceFile = Readonly<{ path: string; text: string; lineCount: number }>;
export type DependencyBinding = Readonly<{
  packageName: string; version: string | null; importedNames: readonly string[];
  sourcePath: string; status: 'exact' | 'unresolved'; reason: string | null;
}>;
export type ParsedEdge = GraphEdge & Readonly<{
  extractionMethod: 'ts-morph-import' | 'ts-morph-export' | 'ts-morph-reference' | 'ts-morph-call' | 'explicit-release-export';
}>;
export type LocalIndex = Readonly<{
  schemaVersion: 1; mode: 'fixture'; scope: Scope; snapshot: Snapshot;
  packageName: string; version: string; files: readonly SourceFile[];
  nodes: readonly GraphNode[]; edges: readonly ParsedEdge[];
  evidence: readonly SourceEvidence[]; dependencies: readonly DependencyBinding[];
  unresolved: readonly string[]; limitations: readonly string[];
}>;
export type Activity = Readonly<{
  id: string; operation: string; startedAt: string; durationMs: number;
  status: 'complete' | 'failed'; detail: string;
}>;
export type LocalAnswer = Readonly<{
  schemaVersion: 1; mode: 'extractive'; status: 'evidence_ready' | 'abstained';
  answer: string; citations: readonly SourceEvidence[];
  nodeIds: readonly string[]; edgeIds: readonly string[];
  missingEvidence: readonly string[]; activities: readonly Activity[];
}>;
export type AiAnswer = Omit<LocalAnswer, 'mode'> & Readonly<{
  mode: 'voyage-deepseek';
  models: Readonly<{ embedding: string; reranking: string; generation: string }>;
}>;
export type WorkspaceAnswer = LocalAnswer | AiAnswer;
export const FIXTURE_IDS: readonly FixtureId[] = [
  'jobboard-app@1.0.0', 'jobboard-app@2.0.0', 'retry-kit@1.0.0', 'retry-kit@2.0.0', 'event-log@1.0.0',
];
export function parseFixtureId(value: unknown): FixtureId {
  if (typeof value !== 'string' || !FIXTURE_IDS.includes(value as FixtureId)) throw new Error('Unsupported fixture snapshot');
  return value as FixtureId;
}
export function parseQuestion(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error('Question must contain 1–2000 characters');
  return value.trim();
}
