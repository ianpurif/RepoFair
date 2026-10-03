import { fixtureRequest } from '../fixture-boundary';
export const runtime = 'nodejs';
export const GET = (request: Request) => fixtureRequest(request, 'source');
