/** Limits apply before parsing and again when accepting a serialized index. */
export const LOCAL_LIMITS = Object.freeze({
  files: 64, fileCharacters: 256_000, totalCharacters: 2_000_000,
  linesPerFile: 4_000, nodes: 4_000, edges: 12_000, evidence: 12_000,
  astNodes: 100_000, parseMs: 10_000, passageLines: 120,
  candidates: 8, graphDepth: 2, graphNodes: 40, answerEdges: 160, answerCharacters: 12_000,
});
export function assertLocal(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function sourceLines(text: string): string[] { return text.replace(/\r\n/g, '\n').split('\n'); }
