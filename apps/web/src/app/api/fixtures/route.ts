import { fixtureRequest } from '../fixture-boundary';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => fixtureRequest(request, 'index');
