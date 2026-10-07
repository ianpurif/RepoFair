import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';

/** Opt-in hosted development verification. Creates and removes exactly one test user. */
const envPath = new URL('../.env.local', import.meta.url);
const env = { ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}), ...process.env };
const reportPath = new URL('../docs/evidence/clerk-session.json', import.meta.url);
const nonce = randomUUID();
const externalId = `atlas-auth-verification-${nonce}`;
const identifier = `atlas-${nonce}+clerk_test@example.com`;
const password = `A9!${randomBytes(24).toString('base64url')}`;
const asRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const report: Record<string, unknown> = {
  checkedAt: new Date().toISOString(),
  scope: 'Hosted Clerk development password sign-in through the real widget; account GET and Supabase REST JWT validation. No workspace mutations, invitations, email links, AI calls, or payments.',
  mode: 'development-test-account',
  sources: [
    'https://clerk.com/docs/reference/backend/user/create-user',
    'https://clerk.com/docs/guides/development/testing/test-emails-and-phones',
    'https://clerk.com/docs/reference/backend/user/delete-user',
    'https://clerk.com/docs/reference/backend/sessions/revoke-session',
    'https://supabase.com/docs/guides/auth/third-party/clerk',
  ],
  credentialPersistence: false,
  temporaryUserCreated: false,
  browser: { engine: process.platform === 'win32' ? 'Edge' : 'Chromium', widgetRendered: false, passwordSubmitted: false },
  account: { status: 'unverified' },
  supabase: { status: 'unverified', legacyJwtTemplateUsed: false },
  cleanup: { status: 'not-required' },
};

class VerificationFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new VerificationFailure(code);
}

async function clerkRequest(path: string, method = 'GET', body?: Record<string, unknown>) {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  return { response, data: await response.json().catch(() => null) as unknown };
}

function safeApiCode(data: unknown): string {
  const errors = asRecord(data).errors;
  const first = Array.isArray(errors) ? asRecord(errors[0]).code : null;
  return typeof first === 'string' && /^[a-z_]{1,80}$/.test(first) ? first : 'request-rejected';
}

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let ownedUserId: string | undefined;
let ownedSessionId: string | undefined;
let creationAttempted = false;
let creationOutcome: 'not-attempted' | 'unknown' | 'confirmed' | 'rejected' = 'not-attempted';
let pageErrors = 0;
let consoleErrors = 0;
let stage = 'configuration';

try {
  requireCondition(process.argv.includes('--allow-temporary-user'), 'EXPLICIT_TEMPORARY_USER_FLAG_REQUIRED');
  requireCondition(env.CLERK_SECRET_KEY?.startsWith('sk_test_'), 'DEVELOPMENT_SECRET_REQUIRED');
  requireCondition(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_'), 'DEVELOPMENT_PUBLISHABLE_KEY_REQUIRED');
  requireCondition(env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'SUPABASE_CONFIGURATION_MISSING');
  const supabaseUrl = new URL(env.NEXT_PUBLIC_SUPABASE_URL);
  requireCondition(supabaseUrl.protocol === 'https:' && supabaseUrl.hostname.endsWith('.supabase.co') && !supabaseUrl.username && !supabaseUrl.password, 'HOSTED_SUPABASE_URL_REQUIRED');

  stage = 'development-instance';
  const instance = await clerkRequest('/instance');
  report.instance = { httpStatus: instance.response.status, development: asRecord(instance.data).environment_type === 'development' };
  requireCondition(instance.response.ok && asRecord(instance.data).environment_type === 'development', 'DEVELOPMENT_INSTANCE_REQUIRED');

  stage = 'anonymous-account';
  const anonymous = await fetch('http://localhost:3000/api/account', { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  report.anonymousAccount = { httpStatus: anonymous.status, denied: anonymous.status === 401 };
  requireCondition(anonymous.status === 401, 'ANONYMOUS_ACCOUNT_NOT_DENIED');

  stage = 'widget';
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', () => { pageErrors++; });
  page.on('console', message => { if (message.type() === 'error') consoleErrors++; });
  const navigation = await page.goto('http://localhost:3000/sign-in', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  requireCondition(navigation?.status() === 200, 'SIGN_IN_ROUTE_FAILED');
  const identifierInput = page.locator('input[name="identifier"]');
  await identifierInput.waitFor({ state: 'visible', timeout: 30_000 });
  asRecord(report.browser).widgetRendered = true;

  stage = 'temporary-user-create';
  creationAttempted = true;
  creationOutcome = 'unknown';
  const created = await clerkRequest('/users', 'POST', {
    email_address: [identifier], email_address_identification_status: ['reserved'], password,
    external_id: externalId, private_metadata: { atlas_auth_verification_nonce: nonce },
  });
  report.userCreationHttpStatus = created.response.status;
  creationOutcome = created.response.ok ? 'confirmed' : 'rejected';
  if (!created.response.ok) throw new VerificationFailure(`USER_CREATE_${safeApiCode(created.data)}`);
  const user = asRecord(created.data);
  requireCondition(typeof user.id === 'string' && /^user_[A-Za-z0-9]+$/.test(user.id), 'USER_ID_INVALID');
  ownedUserId = user.id;
  requireCondition(user.external_id === externalId, 'USER_OWNERSHIP_NOT_CONFIRMED');
  report.temporaryUserCreated = true;

  stage = 'password-sign-in';
  await identifierInput.fill(identifier);
  const passwordInput = page.locator('input[name="password"]');
  if (!await passwordInput.isVisible()) await page.getByRole('button', { name: /^Continue$/ }).click();
  await passwordInput.waitFor({ state: 'visible', timeout: 20_000 });
  await passwordInput.fill(password);
  await page.getByRole('button', { name: /^Continue$/ }).click();
  asRecord(report.browser).passwordSubmitted = true;
  await page.waitForFunction(() => !!(window as unknown as { Clerk?: { session?: { id?: string }; user?: { id?: string } } }).Clerk?.session?.id, undefined, { timeout: 30_000 });

  stage = 'session';
  const session = await page.evaluate(async () => {
    const clerk = (window as unknown as { Clerk?: { user?: { id?: string }; session?: { id?: string; getToken(): Promise<string | null> } } }).Clerk;
    return { userId: clerk?.user?.id ?? null, sessionId: clerk?.session?.id ?? null, token: await clerk?.session?.getToken() ?? null };
  });
  requireCondition(session.userId === ownedUserId, 'SESSION_PRINCIPAL_MISMATCH');
  requireCondition(typeof session.sessionId === 'string' && /^sess_[A-Za-z0-9]+$/.test(session.sessionId), 'SESSION_ID_INVALID');
  ownedSessionId = session.sessionId;
  requireCondition(typeof session.token === 'string' && session.token.split('.').length === 3, 'SESSION_TOKEN_UNAVAILABLE');
  report.session = { status: 'verified', principalMatchesTemporaryUser: true, tokenIssued: true };

  stage = 'authenticated-account';
  const account = await page.evaluate(async expectedUserId => {
    const response = await fetch('/api/account', { credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json() as { authenticated?: unknown; principalId?: unknown };
    return { httpStatus: response.status, authenticated: body.authenticated === true, principalMatches: body.principalId === expectedUserId, noStore: response.headers.get('cache-control')?.includes('no-store') === true };
  }, ownedUserId);
  report.account = { status: account.httpStatus === 200 && account.authenticated && account.principalMatches ? 'verified' : 'failed', ...account };
  requireCondition(account.httpStatus === 200 && account.authenticated && account.principalMatches && account.noStore, 'ACCOUNT_SESSION_NOT_VERIFIED');

  stage = 'supabase-session-jwt';
  const claims = asRecord(JSON.parse(Buffer.from(session.token.split('.')[1]!, 'base64url').toString('utf8')) as unknown);
  // The REST root serves OpenAPI and may require a secret key. A nonexistent
  // table yields a known schema-cache error only after JWT validation succeeds.
  const restUrl = new URL('/rest/v1/atlas_auth_probe_nonexistent?select=id&limit=0', supabaseUrl);
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const [validToken, invalidToken, anonymousKey] = await Promise.all([
    fetch(restUrl, { headers: { apikey: key, Authorization: `Bearer ${session.token}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) }),
    fetch(restUrl, { headers: { apikey: key, Authorization: 'Bearer atlas-auth-verification-invalid-token' }, redirect: 'error', signal: AbortSignal.timeout(20_000) }),
    fetch(restUrl, { headers: { apikey: key, Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) }),
  ]);
  const rejection = asRecord(await validToken.json().catch(() => null) as unknown);
  const publicKeyBody = asRecord(await anonymousKey.json().catch(() => null) as unknown);
  const rejectionCode = typeof rejection.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(rejection.code) ? rejection.code : null;
  const rejectionText = [rejection.message, rejection.error].filter(value => typeof value === 'string').join(' ').toLowerCase();
  const sessionTokenAccepted = validToken.status === 404 && rejection.code === 'PGRST205';
  const publicKeyAccepted = anonymousKey.status === 404 && publicKeyBody.code === 'PGRST205';
  const rejectionCategory = sessionTokenAccepted ? null : /jwt|jwks|issuer|signature|signing/.test(rejectionText) ? 'jwt-validation' : /api.?key/.test(rejectionText) ? 'api-key' : 'authentication-rejected';
  const jwtRolePresent = Object.hasOwn(claims, 'role');
  const accepted = sessionTokenAccepted && invalidToken.status === 401 && publicKeyAccepted && jwtRolePresent && claims.role === 'authenticated';
  report.supabase = { status: accepted ? 'verified' : 'failed', probe: 'Nonexistent public table, limit=0; schema-cache error proves token validation but not data access.', httpStatus: validToken.status, responseCode: rejectionCode, rejectionCategory, invalidTokenHttpStatus: invalidToken.status, publishableKeyControlHttpStatus: anonymousKey.status, publishableKeyControlCode: publicKeyBody.code === 'PGRST205' ? 'PGRST205' : null, sessionTokenAccepted, jwtVerificationBlockedByApiKey: !publicKeyAccepted, jwtRolePresent, jwtRoleIsAuthenticated: claims.role === 'authenticated', legacyJwtTemplateUsed: false, dataAuthorizationVerified: false };
  requireCondition(publicKeyAccepted, 'SUPABASE_PUBLISHABLE_KEY_NOT_VERIFIED');
  requireCondition(accepted, 'SUPABASE_SESSION_TOKEN_REJECTED');
  requireCondition(pageErrors === 0, 'BROWSER_RUNTIME_ERRORS');
  report.status = 'verified';
} catch (error) {
  report.status = 'failed';
  report.failure = { stage, code: error instanceof VerificationFailure ? error.code : 'VERIFICATION_REQUEST_OR_BROWSER_FAILED' };
  process.exitCode = 1;
} finally {
  const cleanup: Record<string, unknown> = { status: 'not-required' };
  try {
    // Reconcile an ambiguous POST by its unique external ID; never retry creating a user.
    if (!ownedUserId && creationAttempted) {
      const found = await clerkRequest(`/users?external_id=${encodeURIComponent(externalId)}&limit=2`);
      const entries = Array.isArray(found.data) ? found.data : asRecord(found.data).data;
      if (found.response.ok && Array.isArray(entries)) {
        const owned = entries.map(asRecord).filter(user => user.external_id === externalId && asRecord(user.private_metadata).atlas_auth_verification_nonce === nonce);
        if (owned.length === 1 && typeof owned[0]!.id === 'string') ownedUserId = owned[0]!.id;
      }
    }
    if (ownedUserId) {
      cleanup.status = 'running';
      const ownership = await clerkRequest(`/users/${ownedUserId}`);
      const user = asRecord(ownership.data);
      requireCondition(ownership.response.ok && user.external_id === externalId && asRecord(user.private_metadata).atlas_auth_verification_nonce === nonce, 'CLEANUP_OWNERSHIP_MISMATCH');
      if (ownedSessionId) {
        try {
          const session = await clerkRequest(`/sessions/${ownedSessionId}`);
          requireCondition(session.response.ok && asRecord(session.data).user_id === ownedUserId, 'CLEANUP_SESSION_OWNERSHIP_MISMATCH');
          const revoked = await clerkRequest(`/sessions/${ownedSessionId}/revoke`, 'POST');
          cleanup.sessionRevokeHttpStatus = revoked.response.status;
          cleanup.sessionRevoked = revoked.response.ok;
        } catch { cleanup.sessionRevoked = false; }
      }
      const deleted = await clerkRequest(`/users/${ownedUserId}`, 'DELETE');
      cleanup.userDeleteHttpStatus = deleted.response.status;
      requireCondition(deleted.response.ok, 'CLEANUP_DELETE_FAILED');
      const absent = await clerkRequest(`/users/${ownedUserId}`);
      cleanup.userAbsenceHttpStatus = absent.response.status;
      cleanup.userDeleted = absent.response.status === 404;
      requireCondition(absent.response.status === 404, 'CLEANUP_USER_STILL_PRESENT');
      requireCondition(!ownedSessionId || cleanup.sessionRevoked === true, 'CLEANUP_SESSION_REVOKE_UNVERIFIED');
      cleanup.status = 'verified';
    } else {
      requireCondition(creationOutcome === 'not-attempted' || creationOutcome === 'rejected', 'CLEANUP_USER_ID_UNAVAILABLE');
    }
  } catch (error) {
    cleanup.status = 'failed';
    cleanup.code = error instanceof VerificationFailure ? error.code : 'CLEANUP_REQUEST_FAILED';
    if (ownedUserId) cleanup.ownedTemporaryUserId = ownedUserId;
    report.status = 'failed';
    process.exitCode = 1;
  }
  report.cleanup = cleanup;
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  asRecord(report.browser).pageErrors = pageErrors;
  asRecord(report.browser).consoleErrors = consoleErrors;
  report.completedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
