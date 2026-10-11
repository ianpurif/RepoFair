import 'server-only';
import { auth } from '@clerk/nextjs/server';
import { workspaceDatabase } from './database';
import { createPublicationService, PublicationServiceError } from '@atlas/worker/publications';
import { readBounded } from '../app/api/fixture-boundary';
import { privateHeaders, repositoryFailure } from './repositories';

let service: Promise<ReturnType<typeof createPublicationService>> | undefined;
export async function publicationContext() {
  const { userId, sessionId } = await auth();
  if (!userId || !sessionId) throw new Error('AUTHENTICATION_REQUIRED');
  service ??= workspaceDatabase().then(database => createPublicationService(database, process.env)).catch(error => { service = undefined; throw error; });
  return { principalId: userId, service: await service };
}
export function publicationFailure(error: unknown) {
  if (error instanceof PublicationServiceError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: privateHeaders });
  return repositoryFailure(error);
}
export async function publicationBody(request: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new PublicationServiceError('invalid-body', 'Expected a JSON request object', 400);
  let value: unknown;
  try { value = JSON.parse(await readBounded(request, 65_536)); }
  catch (error) {
    if (error instanceof Error && error.message === 'Request too large') throw new PublicationServiceError('body-limit', 'Request exceeds 65536 bytes', 413);
    throw new PublicationServiceError('invalid-body', 'Expected a valid JSON request object', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new PublicationServiceError('invalid-body', 'Request contains invalid or unsupported fields', 400);
  return value as Record<string, unknown>;
}
