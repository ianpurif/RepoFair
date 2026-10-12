import { discoverFixtureProviders } from '@atlas/worker/federation';
import { fixturesEnabled } from '../fixture-boundary';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  if (!fixturesEnabled() || (process.env.ATLAS_MODE ?? 'fixture') !== 'fixture') return Response.json({ error: 'Fixture discovery disabled' }, { status: 503 });
  return Response.json(await discoverFixtureProviders(), { headers: { 'Cache-Control': 'no-store', 'X-Atlas-Mode': 'fixture' } });
}
