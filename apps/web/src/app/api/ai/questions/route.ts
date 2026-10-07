import { answerFixtureWithAi } from '@atlas/worker/ai';
import { readBounded } from '../../fixture-boundary';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function POST(request: Request): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'X-Atlas-Mode': 'fixture' };
  const url = new URL(request.url);
  // This unauthenticated fixture capability must not become a public paid API.
  if (process.env.ATLAS_LOOPBACK_SERVER !== 'true' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || (request.headers.get('origin') !== null && request.headers.get('origin') !== url.origin)) {
    return Response.json({ error: 'AI fixture requests require the local application origin.' }, { status: 403, headers });
  }
  try {
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Expected JSON');
    const input: unknown = JSON.parse(await readBounded(request, 8192));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected request object');
    const body = input as Record<string, unknown>;
    if (body.approveAiDisclosure !== true) return Response.json({ error: 'Approve sending the question and public fixture source to Voyage AI and DeepSeek.' }, { status: 403, headers });
    const answer = await answerFixtureWithAi(body.fixtureId, body.question, body.approveAiDisclosure, process.env, request.signal);
    return Response.json(answer, { headers });
  } catch {
    return Response.json({ error: 'Voyage AI + DeepSeek request unavailable. Check server enablement, credentials, supported models, and provider status. No alternate provider was called.' }, { status: 503, headers });
  }
}
