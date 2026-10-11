import { parseFixtureId, parseQuestion } from '@atlas/contracts';
import { indexFixture } from '@atlas/worker/fixtures';
import { answerLocal, lookupSource } from '@atlas/core/local';

/** This public demonstration boundary cannot select private repositories. */
export function fixturesEnabled(env: Readonly<Record<string,string | undefined>> = process.env): boolean {
  return env.ATLAS_FIXTURES_ENABLED === 'true' && env.NODE_ENV !== 'production';
}
export async function fixtureRequest(request: Request, operation: 'index' | 'question' | 'source'): Promise<Response> {
  try {
    if (!fixturesEnabled() || (process.env.ATLAS_MODE ?? 'fixture') !== 'fixture') return Response.json({ error: 'Fixture APIs require explicit development/test enablement' }, { status: 503 });
    const url = new URL(request.url);
    let input: Record<string, unknown> = {};
    if (operation === 'question') {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return Response.json({ error: 'Cross-origin request denied' }, { status: 403 });
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Expected JSON');
      const bytes = await readBounded(request, 8192);
      const parsed: unknown = JSON.parse(bytes);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected request object');
      input = parsed as Record<string, unknown>;
    }
    const fixtureId = parseFixtureId(operation === 'question' ? input.fixtureId : url.searchParams.get(operation === 'index' ? 'id' : 'fixtureId'));
    const question = operation === 'question' ? parseQuestion(input.question) : null;
    const index = await indexFixture(fixtureId);
    const result = operation === 'index' ? index : operation === 'question' ? answerLocal(index, question!) : lookupSource(index, url.searchParams.get('path') ?? '', Number(url.searchParams.get('startLine')), Number(url.searchParams.get('endLine')));
    return Response.json(result, { headers: { 'Cache-Control': 'no-store', 'X-Atlas-Mode': 'fixture' } });
  } catch (error) {
    // Do not return filesystem paths, stack traces, secrets or source from failures.
    const message = error instanceof Error ? error.message : '';
    const safe = ['Unsupported fixture snapshot', 'Question must contain 1–2000 characters', 'Expected JSON', 'Expected request object', 'Request too large'].includes(message);
    return Response.json({ error: safe ? message : 'Fixture request could not be completed. Verify snapshot and source range.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
}
export async function readBounded(request: Request, limit: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Expected JSON');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Request too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
