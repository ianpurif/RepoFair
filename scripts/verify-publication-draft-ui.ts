import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Page, type Response as BrowserResponse } from '@playwright/test';
import type { PublicationDraft, RepositoryIndex } from '../packages/contracts/src/index.ts';

/** Opt-in real private draft acceptance. Only its own new draft/session are changed. */
const root = new URL('../', import.meta.url);
const envPath = new URL('.env.local', root);
const env = { ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}), ...process.env };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const report: Record<string, unknown> = {
  checkedAt: new Date().toISOString(),
  scope: 'Real authorized private repository draft create, explicit exposure selection, save, reload and revoke through the application UI. No publication, endpoint probing, payment, AI, or existing draft mutations.',
  command: 'bun scripts/verify-publication-draft-ui.ts --allow-test-session --allow-private-draft',
  browser: { engine: process.platform === 'win32' ? 'Edge' : 'Chromium', freshContext: true, savedAuthState: false, screenshotsOrTracesSaved: false },
  sources: ['https://clerk.com/docs/reference/backend/sign-in-tokens/create-sign-in-token', 'https://clerk.com/docs/nextjs/reference/objects/sign-in', 'https://clerk.com/docs/reference/backend/sign-in-tokens/revoke-sign-in-token', 'https://clerk.com/docs/reference/backend/sessions/revoke-session'],
  credentialsOrIdentifiersPersistedByVerifier: false, privateSourceOrPathsPersistedByVerifier: false,
  session: { status: 'unverified' }, create: { status: 'unverified' }, save: { status: 'unverified' }, reload: { status: 'unverified' }, revoke: { status: 'unverified' }, negativeRoutes: { status: 'unverified' }, accessibility: { status: 'unverified' }, cleanup: { status: 'not-required' },
};
class CheckFailure extends Error { constructor(readonly code: string) { super(code); } }
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new CheckFailure(code); }
async function clerk(path: string, method = 'GET', body?: Record<string, unknown>) {
  check(path.startsWith('/') && !path.startsWith('//'), 'INVALID_CLERK_PATH');
  const response = await fetch(`https://api.clerk.com/v1${path}`, { method, headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(20_000) });
  return { response, data: await response.json().catch(() => null) as unknown };
}
async function application(page: Page, path: string, method = 'GET', body?: string) {
  check(path.startsWith('/api/') && !path.startsWith('//'), 'INVALID_APPLICATION_PATH');
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000), ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }) });
    return { status: response.status, noStore: response.headers.get('cache-control')?.includes('no-store') === true, data: await response.json().catch(() => null) as unknown };
  }, { path, method, body });
}
function bindDraft(value: unknown): PublicationDraft {
  const draft = record(value);
  check(typeof draft.id === 'string' && /^[a-f0-9-]{36}$/i.test(draft.id) && draft.workspaceId === workspaceId && draft.repositoryId === repositoryId && draft.snapshotId === snapshotId && draft.commitSha === commitSha && Number.isSafeInteger(draft.revision) && Number(draft.revision) >= 1, 'DRAFT_BOUNDARY_MISMATCH');
  check(draft.state === 'draft' || draft.state === 'revoked', 'DRAFT_STATE_INVALID');
  check(draft.published === false && draft.approval === null && draft.endpointProof === 'unverified' && draft.payment === 'disabled' && draft.accuracy === 'unverified' && record(draft.administration).status === 'verified', 'DRAFT_FALSE_APPROVAL');
  return draft as unknown as PublicationDraft;
}
function uiResponse(page: Page, method: string, path: string): Promise<BrowserResponse | null> {
  return page.waitForResponse(response => response.request().method() === method && new URL(response.url()).origin === 'http://localhost:3000' && new URL(response.url()).pathname === path, { timeout: 40_000 }).catch(() => null);
}
async function responseDraft(response: BrowserResponse | null, status: number): Promise<PublicationDraft> {
  check(response && response.status() === status && response.headers()['cache-control']?.includes('no-store'), 'DRAFT_UI_HTTP_FAILURE');
  return bindDraft(record(await response.json() as unknown).draft);
}

let browser: Browser | undefined; let context: BrowserContext | undefined; let page: Page | undefined;
let principalId: string | undefined; let repositoryId: string | undefined; let snapshotId: string | undefined; let commitSha: string | undefined; let workspaceId: string | undefined;
let ownedSessionId: string | undefined; let ownedTicketId: string | undefined; let ownedDraftId: string | undefined;
let pendingCreate: Promise<BrowserResponse | null> | undefined;
let ticketConsumed = false; const originalSessionIds = new Set<string>(); const originalDrafts = new Map<string, string>();
let pageErrors = 0; let expectedHttpErrors = 0; let unexpectedConsoleErrors = 0; let aiRequests = 0; let externalBearerRequests = 0; let paymentRequests = 0;
let stage = 'configuration';
try {
  check(process.argv.includes('--allow-test-session') && process.argv.includes('--allow-private-draft'), 'EXPLICIT_SESSION_AND_DRAFT_FLAGS_REQUIRED');
  check(env.CLERK_SECRET_KEY?.startsWith('sk_test_') && env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_'), 'DEVELOPMENT_CLERK_REQUIRED');
  const identity = record(JSON.parse(readFileSync(new URL('.atlas/live-principal.json', root), 'utf8')) as unknown);
  const imported = record(JSON.parse(readFileSync(new URL('.atlas/live-import.json', root), 'utf8')) as unknown);
  check(typeof identity.principalId === 'string' && /^user_[A-Za-z0-9]+$/.test(identity.principalId), 'AUTHORIZED_PRINCIPAL_MISSING');
  check(typeof imported.repositoryId === 'string' && /^[a-f0-9-]{36}$/i.test(imported.repositoryId) && typeof imported.snapshotId === 'string' && typeof imported.commitSha === 'string' && /^[a-f0-9]{40}$/i.test(imported.commitSha), 'AUTHORIZED_IMPORT_MISSING');
  principalId = identity.principalId; repositoryId = imported.repositoryId; snapshotId = imported.snapshotId; commitSha = imported.commitSha;
  stage = 'development-instance';
  const instance = await clerk('/instance'); check(instance.response.ok && record(instance.data).environment_type === 'development', 'DEVELOPMENT_INSTANCE_NOT_VERIFIED');
  const sessions = await clerk(`/sessions?user_id=${encodeURIComponent(principalId)}`); check(sessions.response.ok && Array.isArray(sessions.data), 'EXISTING_SESSIONS_NOT_VERIFIED');
  for (const value of sessions.data) { const session = record(value); if (session.user_id === principalId && typeof session.id === 'string') originalSessionIds.add(session.id); }
  const anonymous = await fetch('http://localhost:3000/api/publications?workspaceId=00000000-0000-4000-8000-000000000000', { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  report.anonymous = { status: anonymous.status, denied: anonymous.status === 401 }; check(anonymous.status === 401, 'ANONYMOUS_PUBLICATIONS_NOT_DENIED');

  stage = 'fresh-browser';
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', locale: 'en-US' }); page = await context.newPage();
  page.on('pageerror', () => { pageErrors++; });
  page.on('console', value => { if (value.type() !== 'error') return; if (/^Failed to load resource: the server responded with a status of (400|403|409|413)\b/.test(value.text())) expectedHttpErrors++; else unexpectedConsoleErrors++; });
  page.on('request', request => { const url = new URL(request.url()); if (['api.voyageai.com', 'api.deepseek.com'].includes(url.hostname) || (url.origin === 'http://localhost:3000' && /^\/api\/(?:ai|providers)(?:\/|$)/.test(url.pathname))) aiRequests++; if (url.origin !== 'http://localhost:3000' && request.headers().authorization?.startsWith('Bearer ')) externalBearerRequests++; if (/^\/api\/(?:payments|purchases)(?:\/|$)/.test(url.pathname)) paymentRequests++; });
  const signIn = await page.goto('http://localhost:3000/sign-in', { waitUntil: 'domcontentloaded' }); check(signIn?.status() === 200, 'SIGN_IN_ROUTE_FAILED');
  await page.locator('input[name="identifier"]').waitFor({ state: 'visible', timeout: 35_000 });
  await page.waitForFunction(() => !!(window as unknown as { Clerk?: { loaded?: boolean } }).Clerk?.loaded, undefined, { timeout: 30_000 });
  check(await page.evaluate(() => (window as unknown as { Clerk?: { session?: { id?: string } } }).Clerk?.session?.id ?? null) === null, 'BROWSER_NOT_FRESH');
  const issued = await clerk('/sign_in_tokens', 'POST', { user_id: principalId, expires_in_seconds: 120 }); const ticket = record(issued.data);
  if (issued.response.ok && typeof ticket.id === 'string' && /^sit_[A-Za-z0-9]+$/.test(ticket.id)) ownedTicketId = ticket.id;
  check(issued.response.ok && ownedTicketId && typeof ticket.token === 'string' && ticket.user_id === principalId, 'SIGN_IN_TICKET_NOT_ISSUED');
  const signed = await page.evaluate(async ticket => { const clerk = (window as unknown as { Clerk?: { client?: { signIn?: { create(input: { strategy: 'ticket'; ticket: string }): Promise<{ status: string; createdSessionId: string | null }> } } } }).Clerk; if (!clerk?.client?.signIn?.create) return { status: 'unsupported', sessionId: null }; const result = await clerk.client.signIn.create({ strategy: 'ticket', ticket }); return { status: result.status, sessionId: result.createdSessionId }; }, ticket.token);
  check(signed.status === 'complete' && typeof signed.sessionId === 'string' && /^sess_[A-Za-z0-9]+$/.test(signed.sessionId), 'TICKET_SIGN_IN_INCOMPLETE');
  ticketConsumed = true; ownedSessionId = signed.sessionId; check(!originalSessionIds.has(ownedSessionId), 'TEST_SESSION_IS_NOT_NEW');
  await page.evaluate(async session => { await (window as unknown as { Clerk: { setActive(input: { session: string }): Promise<void> } }).Clerk.setActive({ session }); }, ownedSessionId);
  await page.waitForFunction(expected => { const clerk = (window as unknown as { Clerk?: { user?: { id?: string }; session?: { id?: string } } }).Clerk; return clerk?.user?.id === expected.principalId && clerk?.session?.id === expected.sessionId; }, { principalId, sessionId: ownedSessionId }, { timeout: 30_000 });
  report.session = { status: 'verified', newSessionOnly: true, ticketSingleUse: true, ticketTtlSeconds: 120, principalMatches: true };

  stage = 'authorized-snapshot';
  const account = await application(page, '/api/account'); check(account.status === 200 && record(account.data).principalId === principalId && Array.isArray(record(account.data).workspaces), 'ACCOUNT_NOT_VERIFIED');
  const indexed = await application(page, `/api/repositories/${repositoryId}`); check(indexed.status === 200 && indexed.noStore, 'PRIVATE_INDEX_NOT_READY');
  const index = record(indexed.data).index as RepositoryIndex;
  check(index?.mode === 'git' && index.scope.principalId === principalId && index.snapshot.repositoryId === repositoryId && index.snapshot.snapshotId === snapshotId && index.snapshot.revision === commitSha && index.files.length > 0, 'PRIVATE_SNAPSHOT_BOUNDARY_INVALID'); workspaceId = index.scope.tenantId;
  check((record(account.data).workspaces as unknown[]).some(value => record(value).id === workspaceId && ['owner', 'admin'].includes(String(record(value).role))), 'WORKSPACE_ADMIN_NOT_VERIFIED');
  const before = await application(page, `/api/publications?workspaceId=${workspaceId}`); check(before.status === 200 && before.noStore && Array.isArray(record(before.data).drafts), 'DRAFT_ADMIN_CATALOG_NOT_VERIFIED');
  for (const value of record(before.data).drafts as unknown[]) { const draft = record(value); check(typeof draft.id === 'string', 'EXISTING_DRAFT_INVALID'); originalDrafts.set(draft.id, JSON.stringify([draft.revision, draft.state, draft.termsDigest])); }

  stage = 'create-private-draft-ui';
  const navigation = await page.goto('http://localhost:3000/app/publish', { waitUntil: 'domcontentloaded' }); check(navigation?.status() === 200, 'PUBLICATION_PAGE_FAILED');
  await page.getByRole('heading', { name: 'Prepare a knowledge service', exact: true }).waitFor();
  stage = 'select-publication-workspace';
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(workspaceId);
  stage = 'select-indexed-repository';
  await page.getByRole('combobox', { name: 'Indexed repository', exact: true }).selectOption(repositoryId);
  const create = page.getByRole('button', { name: 'Create private draft', exact: true }); await create.waitFor();
  await page.waitForFunction(() => !(document.querySelector('form[aria-label="Create private publication draft"] button[type="submit"]') as HTMLButtonElement | null)?.disabled, undefined, { timeout: 30_000 });
  stage = 'create-private-draft-ui';
  pendingCreate = uiResponse(page, 'POST', '/api/publications'); await create.click();
  const createdResponse = await pendingCreate;
  if (createdResponse?.status() === 201) { const candidate = record(record(await createdResponse.json() as unknown).draft); if (typeof candidate.id === 'string' && /^[a-f0-9-]{36}$/i.test(candidate.id) && !originalDrafts.has(candidate.id) && candidate.workspaceId === workspaceId && candidate.repositoryId === repositoryId) ownedDraftId = candidate.id; }
  const created = await responseDraft(createdResponse, 201); check(ownedDraftId === created.id && created.state === 'draft' && created.revision === 1, 'CREATED_DRAFT_NOT_OWNED');
  check(created.proposal.accessPolicy === 'private' && created.proposal.exposedPaths.length === 0 && Object.keys(created.proposal.exports).length === 0 && created.proposal.rightsStatement === '' && created.proposal.proposedEndpoint === null && created.proposal.testnetTerms === null && created.preview.fileCount === 0 && created.preview.totalBytes === 0, 'PRIVATE_EMPTY_DEFAULTS_FAILED');
  report.create = { status: 'transport-verified-ui-unverified', httpStatus: 201, privateDefault: true, emptyExposure: true, immutableSnapshotBound: true };
  stage = 'created-draft-details-ui';
  const details = page.getByRole('region', { name: 'Selected publication draft', exact: true });
  await details.waitFor({ state: 'visible', timeout: 30_000 });
  stage = 'authorized-source-choices-ui';
  const choices = details.getByRole('group', { name: 'Source paths', exact: true }); await choices.waitFor({ state: 'visible', timeout: 35_000 });
  const checkboxes = choices.getByRole('checkbox'); check(await checkboxes.count() === index.files.length, 'SOURCE_CHOICES_COUNT_MISMATCH');
  check(await checkboxes.evaluateAll(nodes => nodes.every(node => !(node as HTMLInputElement).checked)), 'SOURCE_PRESELECTED');
  stage = 'private-default-policy-ui';
  check(await details.getByRole('combobox', { name: 'Proposed access policy', exact: true }).inputValue() === 'private', 'PRIVATE_DEFAULT_POLICY_FAILED');
  stage = 'private-default-save-state-ui';
  check(await details.getByRole('button', { name: 'Save private draft', exact: true }).isDisabled(), 'PRIVATE_DEFAULT_SAVE_STATE_FAILED');
  report.create = { status: 'verified', httpStatus: 201, privateDefault: true, emptyExposure: true, emptyExports: true, nullEndpointAndTerms: true, sourceChoiceCount: index.files.length, noPreselectedSource: true, savedRevision: 1, immutableSnapshotBound: true, administrationVerified: true, rightsNotDeclared: true, accuracyUnverified: true, published: false, approval: null, endpointProof: 'unverified', payment: 'disabled' };

  stage = 'explicit-selection-and-save';
  const selectedFile = [...index.files].sort((a, b) => a.path.localeCompare(b.path))[0]; check(selectedFile, 'NO_SOURCE_PATH');
  const selectedBox = checkboxes.first(); await selectedBox.focus(); await selectedBox.press('Space'); check(await selectedBox.isChecked(), 'KEYBOARD_EXPOSURE_SELECTION_FAILED');
  await details.getByRole('textbox', { name: 'Rights statement', exact: true }).fill('Private verification draft. No publication or legal rights approval is asserted.');
  const savedResponsePromise = uiResponse(page, 'PATCH', `/api/publications/${ownedDraftId}`); await details.getByRole('button', { name: 'Save private draft', exact: true }).click(); const saved = await responseDraft(await savedResponsePromise, 200);
  check(saved.revision === 2 && saved.termsDigest !== created.termsDigest && saved.proposal.exposedPaths.length === 1 && saved.proposal.exposedPaths[0] === selectedFile.path && saved.proposal.accessPolicy === 'private' && saved.rights === 'declared' && saved.preview.fileCount === 1 && saved.preview.files[0]?.path === selectedFile.path && saved.preview.files[0]?.lines === selectedFile.lineCount && saved.preview.totalBytes === Buffer.byteLength(selectedFile.text, 'utf8') && saved.preview.files[0]?.sourceDigest === createHash('sha256').update(selectedFile.text).digest('hex'), 'SAVED_PREVIEW_SOURCE_OR_TERMS_MISMATCH');
  await details.getByText('Draft saved. The preview reflects this saved revision.', { exact: true }).waitFor();
  const preview = details.getByRole('region', { name: 'Saved exposure preview', exact: true }); check(await preview.getByText(selectedFile.path, { exact: true }).count() === 1, 'EXPLICIT_PREVIEW_NOT_RENDERED');
  for (const status of ['Repository administration verified', 'Rights declared', 'Endpoint unverified', 'Accuracy unverified', 'Publication unavailable', 'Payment disabled']) check(await details.getByText(status, { exact: true }).count() === 1, 'SEPARATE_STATUS_MISSING');
  report.save = { status: 'verified', httpStatus: 200, revision: 2, selectedFiles: 1, exactSelectedPath: true, exactLinesBytesAndSourceDigest: true, termsDigestChanged: true, immutableSnapshotBound: true, separateAuthorityRightsAccuracyEndpointPublicationPaymentStates: true, noPublicationOrPayment: true };

  stage = 'reload-ui';
  const reloadPromise = uiResponse(page, 'GET', `/api/publications/${ownedDraftId}`); await details.getByRole('button', { name: 'Reload saved draft', exact: true }).click(); const reloaded = await responseDraft(await reloadPromise, 200);
  check(reloaded.revision === saved.revision && reloaded.termsDigest === saved.termsDigest && JSON.stringify(reloaded.proposal) === JSON.stringify(saved.proposal), 'DRAFT_RELOAD_NOT_PERSISTED');
  await details.getByText('Saved draft reloaded.', { exact: true }).waitFor(); check(await selectedBox.isChecked() && await details.getByRole('button', { name: 'Save private draft', exact: true }).isDisabled(), 'RELOADED_SELECTION_NOT_RENDERED');
  report.reload = { status: 'verified', httpStatus: 200, persistedProposalAndDigest: true, selectionRestored: true, noUnsavedChanges: true };

  stage = 'negative-real-routes';
  const path = `/api/publications/${ownedDraftId}`;
  const malformed = await application(page, path, 'PATCH', '{'); check(malformed.status === 400, 'MALFORMED_JSON_NOT_400');
  const oversized = await application(page, path, 'PATCH', JSON.stringify({ padding: 'x'.repeat(65_537) })); check(oversized.status === 413, 'OVERSIZED_BODY_NOT_413');
  const stale = await application(page, path, 'PATCH', JSON.stringify({ expectedRevision: 1, proposal: saved.proposal })); check(stale.status === 409, 'STALE_REVISION_NOT_409');
  const crossOrigin = await context.request.patch(`http://localhost:3000${path}`, { headers: { Origin: 'http://localhost:3001', 'Content-Type': 'application/json' }, data: { expectedRevision: saved.revision, proposal: saved.proposal } }); check(crossOrigin.status() === 403, 'CROSS_ORIGIN_NOT_403');
  const unchanged = await application(page, path); const afterNegative = bindDraft(record(unchanged.data).draft); check(unchanged.status === 200 && afterNegative.revision === saved.revision && afterNegative.termsDigest === saved.termsDigest, 'NEGATIVE_ROUTE_MUTATED_DRAFT');
  report.negativeRoutes = { status: 'verified', malformedJson: malformed.status, oversizedBody: oversized.status, staleRevision: stale.status, crossOrigin: crossOrigin.status(), recordUnchanged: true, actualBrowserSessionCookies: true };

  stage = 'narrow-accessibility';
  await page.setViewportSize({ width: 390, height: 844 });
  await details.getByRole('textbox', { name: 'Rights statement', exact: true }).focus(); check(await details.getByRole('textbox', { name: 'Rights statement', exact: true }).evaluate(node => node === document.activeElement), 'KEYBOARD_EDITOR_FOCUS_FAILED');
  const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches })); check(geometry.scrollWidth <= geometry.width && geometry.reducedMotion, 'NARROW_LAYOUT_OVERFLOW_OR_MOTION');
  report.accessibility = { status: 'verified', keyboardPathCheckbox: true, labelledEditorFocus: true, narrowWidth: geometry.width, noHorizontalPageOverflow: true, reducedMotionEnabled: true };

  stage = 'revoke-owned-draft-ui';
  await details.getByRole('button', { name: 'Revoke draft', exact: true }).click(); await details.getByRole('alertdialog', { name: 'Confirm draft revocation', exact: true }).waitFor();
  const revokePromise = uiResponse(page, 'DELETE', `/api/publications/${ownedDraftId}`); await details.getByRole('button', { name: 'Confirm revoke draft', exact: true }).click(); const revoked = await responseDraft(await revokePromise, 200);
  check(revoked.state === 'revoked' && revoked.revision === saved.revision + 1 && revoked.published === false && revoked.approval === null && revoked.payment === 'disabled', 'DRAFT_REVOKE_NOT_PERSISTED');
  await details.getByText('Draft revoked. Publication remains unavailable.', { exact: true }).waitFor(); check(await details.getByRole('button', { name: 'Save private draft', exact: true }).isDisabled() && await details.getByRole('textbox', { name: 'Rights statement', exact: true }).isDisabled(), 'REVOKED_DRAFT_NOT_READ_ONLY');
  report.revoke = { status: 'verified', httpStatus: 200, state: 'revoked', revision: 3, readOnlyUi: true, savedRecordRetainedForAudit: true, published: false, approval: null, payment: 'disabled' };
  check(pageErrors === 0 && unexpectedConsoleErrors === 0 && aiRequests === 0 && externalBearerRequests === 0 && paymentRequests === 0, 'BROWSER_ERROR_OR_UNEXPECTED_EGRESS'); report.status = 'verified';
} catch (error) {
  report.status = 'failed'; report.failure = { stage, code: error instanceof CheckFailure ? error.code : 'UNEXPECTED_CHECK_FAILURE' };
  if (page && new URL(page.url()).origin === 'http://localhost:3000') {
    const knownErrors = ['The server returned an invalid private draft.', 'The draft proposal is invalid.', 'An export is not bound to an explicitly selected path.', 'The proposed testnet terms are invalid.', 'The exposure preview does not match this snapshot.', 'The server returned an invalid exposure preview.', 'The preview does not include exactly the selected source paths.', 'The source choices do not belong to this authorized draft snapshot.', 'The source path list is invalid.', 'The result of the draft change is uncertain. Reload the saved draft before trying another change.', 'The create result is uncertain. Refresh the draft catalog before creating another draft.', 'The operation was aborted due to timeout'];
    const errors = await page.locator('main .inline-error, main .unavailable-state p').allTextContents().catch(() => []);
    report.uiDiagnostic = { expectedPathname: new URL(page.url()).pathname === '/app/publish', selectedDraftRegionCount: await page.locator('section[aria-label="Selected publication draft"]').count(), sourceGroupCount: await page.locator('[role="group"][aria-label="Source paths"]').count(), errorElementCount: errors.length, knownErrorIndices: errors.map(value => knownErrors.indexOf(value)), sessionCheckingCount: await page.getByRole('heading', { name: 'Checking your session', exact: true }).count() };
  }
  if (!(error instanceof CheckFailure)) { const message = error instanceof Error ? error.message : ''; report.exceptionDiagnostic = { name: error instanceof Error && ['TimeoutError', 'TypeError', 'Error'].includes(error.name) ? error.name : 'unrecognized', category: /strict mode violation/.test(message) ? 'locator-strictness' : /not a <select>/.test(message) ? 'non-select-locator' : /Timeout/.test(message) ? 'timeout' : /Target page, context or browser has been closed/.test(message) ? 'target-closed' : 'unknown', operation: /locator\.click/.test(message) ? 'click' : /locator\.fill/.test(message) ? 'fill' : /selectOption/.test(message) ? 'select' : /waitFor/.test(message) ? 'wait' : 'unknown' }; }
  process.exitCode = 1;
} finally {
  const cleanup: Record<string, unknown> = { status: 'verified', existingSessionsRevokedByTest: 0, existingDraftsMutatedByTest: 0 };
  function cleanupFailed(error: unknown) { cleanup.status = 'failed'; cleanup.code = error instanceof CheckFailure ? error.code : 'CLEANUP_REQUEST_FAILED'; report.status = 'failed'; process.exitCode = 1; }
  try {
    if (!ownedDraftId && pendingCreate) { const response = await pendingCreate; if (response?.status() === 201) { const candidate = record(record(await response.json() as unknown).draft); if (typeof candidate.id === 'string' && /^[a-f0-9-]{36}$/i.test(candidate.id) && !originalDrafts.has(candidate.id) && candidate.workspaceId === workspaceId && candidate.repositoryId === repositoryId) ownedDraftId = candidate.id; } }
    if (ownedDraftId && page) {
      check(!originalDrafts.has(ownedDraftId), 'CLEANUP_DRAFT_OWNERSHIP_UNSAFE'); const current = await application(page, `/api/publications/${ownedDraftId}`); check(current.status === 200, 'CLEANUP_DRAFT_NOT_READABLE'); const draft = bindDraft(record(current.data).draft); check(draft.id === ownedDraftId, 'CLEANUP_DRAFT_ID_MISMATCH');
      if (draft.state !== 'revoked') { const revoked = await application(page, `/api/publications/${ownedDraftId}`, 'DELETE', JSON.stringify({ expectedRevision: draft.revision })); cleanup.draftRevokeHttpStatus = revoked.status; check(revoked.status === 200 && bindDraft(record(revoked.data).draft).state === 'revoked', 'OWNED_DRAFT_NOT_REVOKED'); } else cleanup.draftAlreadyRevokedByUi = true;
      const confirmed = await application(page, `/api/publications/${ownedDraftId}`); check(confirmed.status === 200 && bindDraft(record(confirmed.data).draft).state === 'revoked', 'OWNED_DRAFT_REVOCATION_NOT_CONFIRMED'); cleanup.ownedDraftRevoked = true; cleanup.revokedAuditRecordRetained = true;
      const catalog = await application(page, `/api/publications?workspaceId=${workspaceId}`); check(catalog.status === 200 && Array.isArray(record(catalog.data).drafts), 'CLEANUP_CATALOG_NOT_READABLE');
      const after = new Map((record(catalog.data).drafts as unknown[]).map(value => { const draft = record(value); return [String(draft.id), JSON.stringify([draft.revision, draft.state, draft.termsDigest])]; }));
      check([...originalDrafts].every(([id, value]) => after.get(id) === value), 'EXISTING_DRAFT_CHANGED_DURING_CHECK'); cleanup.existingDraftsUnchanged = true;
    } else { cleanup.createdDraftIdObserved = false; cleanup.creationAttempted = pendingCreate !== undefined; }
  } catch (error) { cleanupFailed(error); }
  try {
    if (!ownedSessionId && page && principalId) { const candidate = await page.evaluate(() => { const clerk = (window as unknown as { Clerk?: { session?: { id?: string }; user?: { id?: string } } }).Clerk; return { id: clerk?.session?.id, principal: clerk?.user?.id }; }).catch(() => null); if (candidate?.principal === principalId && candidate.id && !originalSessionIds.has(candidate.id)) ownedSessionId = candidate.id; }
    if (ownedSessionId) { check(!originalSessionIds.has(ownedSessionId) && /^sess_[A-Za-z0-9]+$/.test(ownedSessionId), 'CLEANUP_SESSION_OWNERSHIP_UNSAFE'); const session = await clerk(`/sessions/${ownedSessionId}`); check(session.response.ok && record(session.data).id === ownedSessionId && record(session.data).user_id === principalId, 'CLEANUP_SESSION_PRINCIPAL_UNVERIFIED'); const revoked = await clerk(`/sessions/${ownedSessionId}/revoke`, 'POST', {}); cleanup.sessionRevokeHttpStatus = revoked.response.status; check(revoked.response.ok && record(revoked.data).status === 'revoked', 'NEW_TEST_SESSION_NOT_REVOKED'); cleanup.newSessionRevoked = true; }
    if (ownedTicketId && !ticketConsumed) { const revoked = await clerk(`/sign_in_tokens/${ownedTicketId}/revoke`, 'POST', {}); check(revoked.response.ok && record(revoked.data).status === 'revoked', 'UNUSED_TICKET_NOT_REVOKED'); cleanup.unusedTicketRevoked = true; } else if (ownedTicketId) cleanup.ticketConsumedSingleUse = true;
  } catch (error) { cleanupFailed(error); }
  await context?.close().catch(() => undefined); await browser?.close().catch(() => undefined);
  report.cleanup = cleanup; Object.assign(record(report.browser), { pageErrors, expectedHttpErrors, unexpectedConsoleErrors, aiRequests, externalBearerRequests, paymentRequests }); report.completedAt = new Date().toISOString();
  writeFileSync(new URL('docs/evidence/publication-draft.json', root), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, failure: report.failure ?? null, create: record(report.create).status, save: record(report.save).status, reload: record(report.reload).status, revoke: record(report.revoke).status, cleanup: cleanup.status, pageErrors, unexpectedConsoleErrors, aiRequests, paymentRequests }));
}
