import { auth } from '@clerk/nextjs/server';
import { accountWorkspaces, ensurePersonalWorkspace } from '../../../lib/account';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie, Authorization' };
export async function GET(): Promise<Response> {
  try {
    const { userId, sessionId } = await auth();
    if (!userId || !sessionId) return Response.json({ error: 'Sign in required.' }, { status: 401, headers });
    return Response.json({ authenticated: true, principalId: userId, workspaces: await accountWorkspaces(userId) }, { headers });
  } catch { return Response.json({ error: 'Account or database access is unavailable.' }, { status: 503, headers }); }
}
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get('origin') !== url.origin) return Response.json({ error: 'Same-origin request required.' }, { status: 403, headers });
  try {
    const { userId, sessionId } = await auth();
    if (!userId || !sessionId) return Response.json({ error: 'Sign in required.' }, { status: 401, headers });
    const workspaceId = await ensurePersonalWorkspace(userId);
    return Response.json({ workspaceId }, { headers });
  } catch { return Response.json({ error: 'Workspace setup failed. No repository access was granted.' }, { status: 503, headers }); }
}
