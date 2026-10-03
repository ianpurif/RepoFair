import { fixtureRequest } from '../fixture-boundary';
export const runtime = 'nodejs';
export const POST = (request: Request) => fixtureRequest(request, 'question');
