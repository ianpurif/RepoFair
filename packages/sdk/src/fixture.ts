import { parseFixtureId, parseQuestion } from '@atlas/contracts';
import type { FixtureId, LocalIndex, LocalAnswer, SourceEvidence } from '@atlas/contracts';
import { validateLocalIndex, validateLocalAnswer, lookupSource } from '@atlas/core/local';
import { checkSourcePassage } from '@atlas/core';

/** Explicit loopback-only fixture client. No private source or signing capability. */
export class AtlasFixtureClient {
  readonly origin: string;
  constructor(origin = 'http://localhost:3000') {
    const url = new URL(origin);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:'
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an explicit loopback fixture origin');
    this.origin = url.origin;
  }
  async #request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(this.origin + path, { redirect: 'error', signal: AbortSignal.timeout(20000),
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!response.ok || response.headers.get('x-atlas-mode') !== 'fixture') throw new Error(`Fixture service unavailable (${response.status})`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('Empty response');
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 8_000_000) { await reader.cancel(); throw new Error('Response exceeds bounds'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  async index(id: FixtureId): Promise<LocalIndex> {
    const value = await this.#request(`/api/fixtures?id=${encodeURIComponent(parseFixtureId(id))}`);
    validateLocalIndex(value);
    const result = value as LocalIndex;
    if (result.snapshot.snapshotId !== id) throw new Error('Snapshot mismatch');
    return result;
  }
  async question(id: FixtureId, question: string): Promise<LocalAnswer> {
    const index = await this.index(id);
    const value = await this.#request('/api/questions', { fixtureId: id, question: parseQuestion(question) }) as LocalAnswer;
    validateLocalAnswer(value, index);
    for (const citation of value.citations) this.#validateCitation(index, citation);
    if (value.nodeIds.some(id => !index.nodes.some(n => n.id === id)) || value.edgeIds.some(id => !index.edges.some(e => e.id === id))) throw new Error('Unknown answer graph identity');
    return value;
  }
  #validateCitation(index: LocalIndex, citation: SourceEvidence): void {
    if (citation.source.snapshotId !== index.snapshot.snapshotId || citation.source.revision !== index.snapshot.revision
      || citation.source.repositoryId !== index.snapshot.repositoryId) throw new Error('Citation snapshot mismatch');
    const file = index.files.find(file => file.path === citation.source.path); if (!file) throw new Error('Unknown source file');
    checkSourcePassage(citation, index.scope, file.text);
  }
  async source(id: FixtureId, path: string, startLine: number, endLine: number): Promise<SourceEvidence> {
    const index = await this.index(id);
    const params = new URLSearchParams({ fixtureId: id, path, startLine: String(startLine), endLine: String(endLine) });
    const value = await this.#request(`/api/source?${params}`) as SourceEvidence;
    this.#validateCitation(index, value);
    const expected = lookupSource(index, path, startLine, endLine);
    if (JSON.stringify(value.source) !== JSON.stringify(expected.source) || value.id !== expected.id
      || value.providerId !== null || value.provenance !== 'parsed-source') throw new Error('Source response differs from requested location');
    return value;
  }
}
