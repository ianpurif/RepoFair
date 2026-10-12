import 'server-only';
import { auth } from '@clerk/nextjs/server';
import { workspaceDatabase } from './database';
import { createRepositoryService, RepositoryServiceError } from '@atlas/worker/repositories';
import { readBounded } from '../app/api/fixture-boundary';
import { isAllowedRequestOrigin } from './request-origin';
let service: Promise<ReturnType<typeof createRepositoryService>> | undefined;
export const privateHeaders = { 'Cache-Control': 'no-store', Vary: 'Cookie, Authorization' };
export async function repositoryContext() {
  const { userId, sessionId } = await auth();
  if (!userId || !sessionId) throw new Error('AUTHENTICATION_REQUIRED');
  service ??= workspaceDatabase().then(db => createRepositoryService(db, process.env)).catch(error => { service = undefined; throw error; });
  return { principalId: userId, service: await service };
}
export function repositoryFailure(error: unknown): Response {
  if (error instanceof RepositoryServiceError) {
    if (error.status === 202) return Response.json({ status: 'running', code: error.code }, { status: 202, headers: privateHeaders });
    return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: privateHeaders });
  }
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unavailable';
  if (error instanceof Error && error.message === 'AUTHENTICATION_REQUIRED') return Response.json({ error: 'Sign in required.' }, { status: 401, headers: privateHeaders });
  const status = ['unauthorized','permission','denied'].includes(code) ? 403 : ['invalid','input'].includes(code) ? 400 : 503;
  return Response.json({ error: 'Repository operation unavailable. Check workspace access, your linked GitHub account, App installation, supported source limits, and worker status.', code }, { status, headers: privateHeaders });
}
export function requireSameOrigin(request: Request) {
  if (!isAllowedRequestOrigin(request, process.env.APP_ORIGIN)) throw new RepositoryServiceError('denied','Cross-origin request denied',403);
}
export async function readRepositoryBody(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new RepositoryServiceError('invalid-body', 'Expected a JSON request object', 400);
  try {
    const body: unknown = JSON.parse(await readBounded(request, 8192));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid object');
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === 'Request too large') throw new RepositoryServiceError('body-limit', 'Request exceeds 8192 bytes', 413);
    throw new RepositoryServiceError('invalid-body', 'Expected a valid JSON request object', 400);
  }
}
