/** Limits apply before parsing and again when accepting a serialized index. */
export const LOCAL_LIMITS = Object.freeze({
  files: 192, fileCharacters: 256_000, totalCharacters: 2_000_000,
  linesPerFile: 4_000, nodes: 4_000, edges: 12_000, evidence: 12_000,
  astNodes: 200_000, parseMs: 10_000, passageLines: 120,
  candidates: 8, graphDepth: 2, graphNodes: 40, answerEdges: 160, answerCharacters: 12_000,
});
/** Larger repository budgets remain bounded; fixture limits cannot be broadened by caller input. */
export const GIT_LIMITS = Object.freeze({ ...LOCAL_LIMITS,
  files: 5_000, fileCharacters: 262_144, totalCharacters: 30_000_000, linesPerFile: 20_000,
  nodes: 50_000, edges: 150_000, evidence: 150_000, astNodes: 2_000_000, parseMs: 60_000,
});
export function sourceLimits(mode: 'fixture' | 'git') { return mode === 'git' ? GIT_LIMITS : LOCAL_LIMITS; }
export function assertLocal(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function sourceLines(text: string): string[] { return text.replace(/\r\n/g, '\n').split('\n'); }
