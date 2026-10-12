import { federateFixture } from '@atlas/worker/federation';
import { parseFixtureId, parseQuestion } from '@atlas/contracts';
import { readBounded, fixturesEnabled } from '../fixture-boundary';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  if (!fixturesEnabled() || (process.env.ATLAS_MODE ?? 'fixture') !== 'fixture') return Response.json({ error: 'Fixture federation disabled' }, { status: 503 });
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Cross-origin request denied' }, { status: 403 });
  try {
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Expected JSON');
    const input: unknown = JSON.parse(await readBounded(request, 8192));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected object');
    const data = input as Record<string, unknown>;
    if (!Array.isArray(data.approvedProviderIds) || data.approvedProviderIds.some(id => typeof id !== 'string')) throw new Error('Invalid provider approval');
    const result = await federateFixture(parseFixtureId(data.fixtureId), data.approvedProviderIds as string[], parseQuestion(data.externalQuestion));
    return Response.json(result, { headers: { 'Cache-Control': 'no-store', 'X-Atlas-Mode': 'fixture' } });
  } catch { return Response.json({ error: 'Fixture federation unavailable. Check selected exact versions, approvals, and provider processes. No payment was attempted.' }, { status: 400 }); }
}
