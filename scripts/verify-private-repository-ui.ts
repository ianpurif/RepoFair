import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { LocalAnswer, RepositoryIndex } from '../packages/contracts/src/index.ts';

/** Opt-in acceptance against the already authorized human/import. No saved browser state or source. */
const root = new URL('../', import.meta.url);
const envPath = new URL('.env.local', root);
const env = { ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}), ...process.env };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const report: Record<string, unknown> = {
  checkedAt: new Date().toISOString(),
  scope: 'Real connected human account; existing private import; desktop and narrow browser source/graph/extractive retrieval. No import/workspace writes, provider purchases, AI calls, or private source egress.',
  command: 'bun scripts/verify-private-repository-ui.ts --allow-test-session --wait-ready',
  browser: { engine: process.platform === 'win32' ? 'Edge' : 'Chromium', freshContext: true, savedAuthState: false, screenshotsOrTracesSaved: false },
  sources: [
    'https://clerk.com/docs/reference/backend/sign-in-tokens/create-sign-in-token',
    'https://clerk.com/docs/nextjs/reference/objects/sign-in',
    'https://clerk.com/docs/reference/backend/sign-in-tokens/revoke-sign-in-token',
    'https://clerk.com/docs/reference/backend/sessions/revoke-session',
  ],
  credentialsOrIdentifiersPersistedByVerifier: false, privateSourcePersistedByVerifier: false,
  session: { status: 'unverified' }, catalog: { status: 'unverified' }, index: { status: 'unverified' },
  source: { status: 'unverified' }, graph: { status: 'unverified' }, question: { status: 'unverified' },
  negativeRoutes: { status: 'unverified' },
  accessibility: { status: 'unverified' }, cleanup: { status: 'not-required' },
};
class CheckFailure extends Error { constructor(readonly code: string) { super(code); } }
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new CheckFailure(code); }
function safeCode(value: unknown): string | null { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null; }
async function clerk(path: string, method = 'GET', body?: Record<string, unknown>) {
  check(path.startsWith('/') && !path.startsWith('//'), 'INVALID_CLERK_PATH');
  const response = await fetch(`https://api.clerk.com/v1${path}`, { method, headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(20_000) });
  const data: unknown = await response.json().catch(() => null);
  return { response, data };
}
async function application(page: Page, path: string) {
  return page.evaluate(async path => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(25_000) });
    return { status: response.status, noStore: response.headers.get('cache-control')?.includes('no-store') === true, data: await response.json().catch(() => null) as unknown };
  }, path);
}
async function waitFor(page: Page, selector: string, code: string) {
  try { await page.locator(selector).waitFor({ state: 'visible', timeout: 35_000 }); }
  catch {
    if (code === 'REAL_SOURCE_GRAPH_NOT_RENDERED') {
      const knownErrors = [
        'The repository response does not match the authorized Git snapshot.',
        'The repository returned an invalid source file.',
        'The repository returned an invalid graph node.',
        'Source evidence does not belong to this authorized snapshot.',
        'The cited line range does not match the original source.',
        'The repository returned duplicate source evidence.',
        'The repository returned a relationship without valid source origin.',
        'The repository returned an invalid dependency binding.',
        'The operation was aborted due to timeout',
      ];
      const errorText = await page.locator('.canvas-state.error p').textContent({ timeout: 1_000 }).catch(() => null);
      const index = errorText === null ? -1 : knownErrors.indexOf(errorText);
      const url = new URL(page.url());
      const mainHeading = await page.locator('main h1').first().textContent({ timeout: 1_000 }).catch(() => null);
      const allowedHeadings = ['Your repositories', 'Repository workspace', '404', 'Sign in', 'Sign in to Atlas'];
      const accountStatus = url.origin === 'http://localhost:3000' ? await application(page, '/api/account').then(value => value.status).catch(() => null) : null;
      report.uiDiagnostic = {
        workspaceRendered: await page.locator('.workspace').count() === 1,
        graphElementCount: await page.locator('.graph-canvas').count(),
        loadingPanelCount: await page.locator('.canvas-state[role="status"]').count(),
        errorPanelCount: await page.locator('.canvas-state.error').count(),
        accountUnavailableCount: await page.locator('.unavailable-state').count(),
        pathnameMatchesExpected: url.origin === 'http://localhost:3000' && url.pathname === expectedRepositoryPath,
        notFoundHeading: await page.getByRole('heading', { name: '404', exact: true }).count() > 0,
        signInWidget: await page.locator('input[name="identifier"]').count() > 0,
        sessionBoundaryChecking: await page.getByRole('heading', { name: 'Checking your session', exact: true }).count() > 0,
        knownMainHeading: mainHeading !== null && allowedHeadings.includes(mainHeading) ? mainHeading : 'unrecognized-or-absent',
        accountHttpStatus: accountStatus,
        pageFailedRequestCount,
        errorCategory: index >= 0 ? ['snapshot-scope', 'source-file', 'graph-node', 'evidence-scope', 'source-range', 'duplicate-evidence', 'edge-origin', 'dependency-binding', 'timeout'][index] : 'unknown-or-no-error',
      };
    }
    throw new CheckFailure(code);
  }
}

let browser: Browser | undefined; let context: BrowserContext | undefined; let page: Page | undefined;
let principalId: string | undefined; let ownedSessionId: string | undefined; let ownedTicketId: string | undefined;
let expectedRepositoryPath: string | undefined;
let ticketConsumed = false; const originalSessionIds = new Set<string>();
let pageErrors = 0; let consoleErrors = 0; let expectedIndexHttpErrors = 0; let expectedNegativeRouteHttpErrors = 0; let unexpectedConsoleErrors = 0; let aiRequests = 0; let bearerAtExternalOrigin = 0;
let pageFailedRequestCount = 0;
let stage = 'configuration';
try {
  check(process.argv.includes('--allow-test-session'), 'EXPLICIT_TEST_SESSION_FLAG_REQUIRED');
  check(env.CLERK_SECRET_KEY?.startsWith('sk_test_') && env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_'), 'DEVELOPMENT_CLERK_REQUIRED');
  const identity = record(JSON.parse(readFileSync(new URL('.atlas/live-principal.json', root), 'utf8')) as unknown);
  const imported = record(JSON.parse(readFileSync(new URL('.atlas/live-import.json', root), 'utf8')) as unknown);
  check(typeof identity.principalId === 'string' && /^user_[A-Za-z0-9]+$/.test(identity.principalId), 'AUTHORIZED_PRINCIPAL_NOT_CONFIGURED');
  check(typeof imported.repositoryId === 'string' && /^[a-f0-9-]{36}$/i.test(imported.repositoryId) && typeof imported.snapshotId === 'string' && typeof imported.commitSha === 'string' && /^[a-f0-9]{40}$/i.test(imported.commitSha), 'AUTHORIZED_IMPORT_NOT_CONFIGURED');
  principalId = identity.principalId; const repositoryId = imported.repositoryId;
  expectedRepositoryPath = `/app/repositories/${repositoryId}`;

  stage = 'development-instance';
  const instance = await clerk('/instance');
  check(instance.response.ok && record(instance.data).environment_type === 'development', 'DEVELOPMENT_INSTANCE_NOT_VERIFIED');
  stage = 'existing-sessions';
  const existing = await clerk(`/sessions?user_id=${encodeURIComponent(principalId)}`);
  check(existing.response.ok && Array.isArray(existing.data), 'EXISTING_SESSIONS_NOT_VERIFIED');
  for (const value of existing.data) { const session = record(value); if (session.user_id === principalId && typeof session.id === 'string') originalSessionIds.add(session.id); }

  stage = 'anonymous-boundary';
  const anonymous = await fetch(`http://localhost:3000/api/repositories/${encodeURIComponent(repositoryId)}`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  report.anonymousRepository = { httpStatus: anonymous.status, denied: anonymous.status === 401 };
  check(anonymous.status === 401, 'ANONYMOUS_REPOSITORY_NOT_DENIED');

  stage = 'fresh-browser';
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', locale: 'en-US' });
  page = await context.newPage();
  page.on('pageerror', () => { pageErrors++; });
  page.on('requestfailed', () => { pageFailedRequestCount++; });
  page.on('console', value => {
    if (value.type() !== 'error') return;
    consoleErrors++;
    if (/^Failed to load resource: the server responded with a status of (422|503)\b/.test(value.text())) expectedIndexHttpErrors++;
    else if (/^Failed to load resource: the server responded with a status of (400|413)\b/.test(value.text())) expectedNegativeRouteHttpErrors++;
    else unexpectedConsoleErrors++;
  });
  page.on('request', request => {
    const url = new URL(request.url());
    if (['api.voyageai.com', 'api.deepseek.com'].includes(url.hostname) || (url.origin === 'http://localhost:3000' && /^\/api\/(?:ai|providers)(?:\/|$)/.test(url.pathname))) aiRequests++;
    if (url.origin !== 'http://localhost:3000' && request.headers().authorization?.startsWith('Bearer ')) bearerAtExternalOrigin++;
  });
  const navigation = await page.goto('http://localhost:3000/sign-in', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  check(navigation?.status() === 200, 'SIGN_IN_ROUTE_FAILED');
  await waitFor(page, 'input[name="identifier"]', 'REAL_CLERK_WIDGET_NOT_RENDERED');
  await page.waitForFunction(() => !!(window as unknown as { Clerk?: { loaded?: boolean; client?: unknown } }).Clerk?.loaded, undefined, { timeout: 30_000 });
  const priorBrowserSession = await page.evaluate(() => (window as unknown as { Clerk?: { session?: { id?: string } } }).Clerk?.session?.id ?? null);
  check(priorBrowserSession === null, 'BROWSER_CONTEXT_NOT_FRESH');

  stage = 'test-ticket';
  const issued = await clerk('/sign_in_tokens', 'POST', { user_id: principalId, expires_in_seconds: 120 });
  const ticket = record(issued.data);
  if (issued.response.ok && typeof ticket.id === 'string' && /^sit_[A-Za-z0-9]+$/.test(ticket.id)) ownedTicketId = ticket.id;
  check(issued.response.ok && typeof ticket.id === 'string' && /^sit_[A-Za-z0-9]+$/.test(ticket.id) && typeof ticket.token === 'string' && ticket.user_id === principalId, 'SIGN_IN_TICKET_NOT_ISSUED');
  stage = 'ticket-sign-in';
  const signed = await page.evaluate(async ticket => {
    const clerk = (window as unknown as { Clerk?: { client?: { signIn?: { create(input: { strategy: 'ticket'; ticket: string }): Promise<{ status: string; createdSessionId: string | null }> } } } }).Clerk;
    if (!clerk?.client?.signIn?.create) return { status: 'unsupported', sessionId: null };
    const result = await clerk.client.signIn.create({ strategy: 'ticket', ticket });
    return { status: result.status, sessionId: result.createdSessionId };
  }, ticket.token);
  check(signed.status === 'complete' && typeof signed.sessionId === 'string' && /^sess_[A-Za-z0-9]+$/.test(signed.sessionId), 'TICKET_SIGN_IN_INCOMPLETE');
  ticketConsumed = true; ownedSessionId = signed.sessionId;
  check(!originalSessionIds.has(ownedSessionId), 'CREATED_SESSION_IS_NOT_NEW');
  await page.evaluate(async session => {
    const clerk = (window as unknown as { Clerk: { setActive(input: { session: string }): Promise<void> } }).Clerk;
    await clerk.setActive({ session });
  }, ownedSessionId);
  await page.waitForFunction(expected => {
    const clerk = (window as unknown as { Clerk?: { user?: { id?: string }; session?: { id?: string } } }).Clerk;
    return clerk?.user?.id === expected.principalId && clerk?.session?.id === expected.sessionId;
  }, { principalId, sessionId: ownedSessionId }, { timeout: 30_000 });
  report.session = { status: 'verified', ticketSingleUse: true, ticketTtlSeconds: 120, principalMatches: true, newlyCreatedSession: true, existingSessionReused: false };

  stage = 'account-and-catalog';
  const accountResponse = await application(page, '/api/account'); const account = record(accountResponse.data);
  check(accountResponse.status === 200 && accountResponse.noStore && account.authenticated === true && account.principalId === principalId && Array.isArray(account.workspaces), 'ACCOUNT_NOT_VERIFIED');
  let workspaceId: string | undefined; let repositoryStatus: string | undefined; let repositoryVisibility: string | undefined;
  for (const value of account.workspaces) {
    const workspace = record(value); if (typeof workspace.id !== 'string') continue;
    const response = await application(page, `/api/repositories?workspaceId=${encodeURIComponent(workspace.id)}`); const data = record(response.data);
    check(response.status === 200 && response.noStore && Array.isArray(data.repositories), 'CATALOG_API_NOT_VERIFIED');
    const repository = data.repositories.map(record).find(item => item.id === repositoryId);
    if (repository) { workspaceId = workspace.id; repositoryStatus = String(repository.status); repositoryVisibility = String(repository.visibility); break; }
  }
  check(workspaceId && repositoryVisibility === 'private', 'PRIVATE_IMPORT_MISSING_FROM_AUTHORIZED_CATALOG');
  await page.goto('http://localhost:3000/app/repositories', { waitUntil: 'domcontentloaded' });
  await waitFor(page, '#repository-workspace', 'CATALOG_WORKSPACE_SELECTOR_NOT_RENDERED');
  await page.locator('#repository-workspace').selectOption(workspaceId);
  await waitFor(page, `a[href="/app/repositories/${repositoryId}"]`, 'PRIVATE_CATALOG_ROW_NOT_RENDERED');
  const repositoryRow = page.locator('li').filter({ has: page.locator(`a[href="/app/repositories/${repositoryId}"]`) });
  check(await repositoryRow.count() === 1 && await repositoryRow.getByText('private', { exact: true }).count() === 1, 'CATALOG_PRIVATE_STATE_NOT_RENDERED');
  check(await repositoryRow.getByText(repositoryStatus!, { exact: true }).count() === 1, 'CATALOG_JOB_STATE_NOT_RENDERED');
  check(await page.getByRole('button', { name: 'GitHub account settings', exact: true }).isEnabled(), 'GITHUB_ACCOUNT_CONTROL_UNAVAILABLE');
  report.catalog = { status: 'verified', accountHttpStatus: 200, principalMatches: true, privateRepositoryVisible: true, actualImportStatusRendered: true, importStatus: safeCode(repositoryStatus), connectionControlEnabled: true };

  stage = 'authenticated-negative-route-checks';
  const questionPath = `/api/repositories/${encodeURIComponent(repositoryId)}/questions`;
  const invalidRequests = [
    { name: 'malformedQuestionJson', path: questionPath, body: '{', contentType: 'application/json', expected: 400 },
    { name: 'oversizedQuestionBody', path: questionPath, body: JSON.stringify({ question: 'x'.repeat(8_500) }), contentType: 'application/json', expected: 413 },
    { name: 'emptyQuestion', path: questionPath, body: JSON.stringify({ question: '   ' }), contentType: 'application/json', expected: 400 },
    { name: 'nonObjectQuestion', path: questionPath, body: '[]', contentType: 'application/json', expected: 400 },
    { name: 'wrongQuestionContentType', path: questionPath, body: JSON.stringify({ question: 'Where is source authorization checked?' }), contentType: 'text/plain', expected: 400 },
    { name: 'malformedImportJson', path: '/api/repositories', body: '{', contentType: 'application/json', expected: 400 },
  ];
  const negativeResults: Record<string, number> = {};
  for (const invalid of invalidRequests) {
    const status = await page.evaluate(async input => {
      const response = await fetch(input.path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': input.contentType }, body: input.body, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      return response.status;
    }, invalid);
    negativeResults[invalid.name] = status;
    check(status === invalid.expected, `NEGATIVE_ROUTE_${invalid.name.toUpperCase()}_EXPECTED_${invalid.expected}`);
  }
  // The APIRequestContext shares this fresh browser's real cookies. The only
  // destination remains localhost; the foreign Origin header exercises CSRF denial.
  const crossOrigin = await context.request.post(`http://localhost:3000${questionPath}`, { headers: { Origin: 'http://localhost:3001', 'Content-Type': 'application/json' }, data: { question: 'Where is source authorization checked?' }, timeout: 20_000 });
  negativeResults.crossOriginQuestion = crossOrigin.status();
  check(crossOrigin.status() === 403, 'AUTHENTICATED_CROSS_ORIGIN_EXPECTED_403');
  report.negativeRoutes = { status: 'verified', realAuthenticatedCookies: true, importWritesPerformed: false, ...negativeResults };

  stage = 'initial-index-state';
  const route = `/api/repositories/${encodeURIComponent(repositoryId)}`;
  let indexResponse = await application(page, route);
  await repositoryRow.getByRole('link', { name: 'Open', exact: false }).click();
  const immediateRouteMatched = new URL(page.url()).pathname === expectedRepositoryPath;
  try { await page.waitForURL(url => url.origin === 'http://localhost:3000' && url.pathname === expectedRepositoryPath, { timeout: 20_000 }); }
  catch { throw new CheckFailure('PRIVATE_REPOSITORY_LINK_NAVIGATION_NOT_VERIFIED'); }
  try {
    await page.waitForFunction(() => document.querySelector('main.workspace') !== null || document.querySelector('main h1')?.textContent === 'Repository workspace' || Array.from(document.querySelectorAll('h3')).some(node => node.textContent === 'Checking your session'), undefined, { timeout: 20_000 });
  } catch { throw new CheckFailure('PRIVATE_REPOSITORY_ROUTE_NOT_MOUNTED'); }
  report.navigation = { status: 'verified', immediateRouteMatched, pathnameMatchesExpectedAfterRouterSettled: true };
  if (indexResponse.status === 422 || indexResponse.status === 503) {
    await waitFor(page, '.canvas-state.error', 'REAL_FAILED_INDEX_STATE_NOT_RENDERED');
    check(await page.getByRole('button', { name: 'Retry snapshot request', exact: true }).isEnabled() && await page.locator('.graph-canvas').count() === 0, 'FAILED_INDEX_RETRY_OR_NO_GRAPH_NOT_VERIFIED');
    report.initialIndexState = { httpStatus: indexResponse.status, code: safeCode(record(indexResponse.data).code), failureRendered: true, retryAvailable: true, sourceGraphAbsent: true };
  } else if (indexResponse.status === 202) {
    await waitFor(page, '.canvas-state[role="status"]', 'REAL_PENDING_INDEX_STATE_NOT_RENDERED');
    report.initialIndexState = { httpStatus: 202, jobStatus: safeCode(record(indexResponse.data).status), pendingRendered: true, sourceGraphAbsent: await page.locator('.graph-canvas').count() === 0 };
  } else { check(indexResponse.status === 200, 'INDEX_REQUEST_UNEXPECTED_STATUS'); report.initialIndexState = { httpStatus: 200, ready: true }; }
  console.log(JSON.stringify({ stage: 'initial-index-state', httpStatus: indexResponse.status, stateVerified: true }));

  stage = 'wait-index-ready';
  if (process.argv.includes('--wait-ready')) {
    const deadline = Date.now() + 180_000; let progressAt = Date.now();
    while (indexResponse.status === 202 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 6_000));
      indexResponse = await application(page, route);
      if (Date.now() - progressAt >= 45_000) { console.log(JSON.stringify({ stage: 'wait-index-ready', httpStatus: indexResponse.status, code: safeCode(record(indexResponse.data).code) })); progressAt = Date.now(); }
    }
  }
  if (indexResponse.status !== 200) {
    if (indexResponse.status === 422 || indexResponse.status === 503) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitFor(page, '.canvas-state.error', 'TERMINAL_FAILED_INDEX_STATE_NOT_RENDERED');
      check(await page.getByRole('button', { name: 'Retry snapshot request', exact: true }).isEnabled() && await page.locator('.graph-canvas').count() === 0, 'TERMINAL_FAILED_INDEX_RETRY_OR_NO_GRAPH_NOT_VERIFIED');
      report.failedIndexState = { httpStatus: indexResponse.status, code: safeCode(record(indexResponse.data).code), failureRendered: true, retryAvailable: true, sourceGraphAbsent: true };
    }
    report.index = { status: 'blocked', httpStatus: indexResponse.status, code: safeCode(record(indexResponse.data).code), initialStateRendered: true };
    throw new CheckFailure('PRIVATE_IMPORT_NOT_READY');
  }
  const index = record(indexResponse.data).index as RepositoryIndex;
  check(indexResponse.noStore && index?.mode === 'git' && index.snapshot.kind === 'git' && index.snapshot.repositoryId === repositoryId && index.snapshot.snapshotId === imported.snapshotId && index.snapshot.revision === imported.commitSha && index.scope.principalId === principalId && index.scope.tenantId === workspaceId && Array.isArray(index.files) && Array.isArray(index.nodes) && Array.isArray(index.edges) && Array.isArray(index.evidence), 'PRIVATE_INDEX_IDENTITY_NOT_VERIFIED');
  report.index = { status: 'verified', httpStatus: 200, noStore: true, mode: 'git', principalMatches: true, workspaceMatches: true, immutableCommitMatchesQueuedImport: true, fileCount: index.files.length, nodeCount: index.nodes.length, edgeCount: index.edges.length };
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(page, '.graph-canvas', 'REAL_SOURCE_GRAPH_NOT_RENDERED');

  stage = 'desktop-source-and-expansion';
  const symbol = index.nodes.find(node => node.kind === 'symbol' && node.label.length >= 3);
  const path = symbol?.localId.split('#')[0] ?? index.files.find(file => /\.[cm]?[jt]sx?$/.test(file.path))?.path ?? index.files[0]?.path;
  const file = index.files.find(item => item.path === path);
  check(file, 'INDEX_HAS_NO_SELECTABLE_SOURCE_FILE');
  const fileButton = page.getByRole('button', { name: file.path, exact: true });
  check(await fileButton.count() === 1, 'REAL_SOURCE_FILE_BUTTON_NOT_UNIQUE');
  await fileButton.click();
  await waitFor(page, '.source-view', 'SOURCE_INSPECTOR_NOT_RENDERED');
  const displayed = await page.locator('.code-line code').allTextContents();
  const expected = file.text.replace(/\r\n/g, '\n').split('\n');
  check(displayed.length === expected.length && displayed.every((line, offset) => line === (expected[offset] || ' ')), 'DISPLAYED_FULL_SOURCE_DIFFERS_FROM_GIT_INDEX');
  report.source = { status: 'verified', fullFileMatchesExactGitSource: true, displayedLineCount: displayed.length, provenanceVisible: await page.getByRole('heading', { name: 'Source provenance', exact: true }).isVisible() };
  const positions = await page.locator('.react-flow__node').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.getAttribute('data-id') ?? '', (node as HTMLElement).style.transform])));
  const beforeExpansion = await page.locator('.react-flow__node').count();
  const expandButton = page.getByRole('button', { name: `Expand ${file.path} symbols`, exact: true });
  let expansionVerified = false;
  if (await expandButton.count()) {
    await expandButton.click();
    await page.waitForFunction(before => document.querySelectorAll('.react-flow__node').length > before, beforeExpansion, { timeout: 15_000 });
    const after = await page.locator('.react-flow__node').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.getAttribute('data-id') ?? '', (node as HTMLElement).style.transform])));
    check(Object.entries(positions).every(([id, position]) => after[id] === position), 'GRAPH_EXPANSION_MOVED_EXISTING_NODES');
    expansionVerified = true;
  }
  check(expansionVerified || !symbol, 'REAL_SYMBOL_EXPANSION_NOT_VERIFIED');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  check(await page.locator('.graph-list-node').count() === index.nodes.length && await page.locator('.relationship-row').count() === index.edges.length, 'ACCESSIBLE_GRAPH_LIST_DIFFERS_FROM_REAL_INDEX');
  if (index.edges.length) {
    const edge = index.edges[0]!; const citation = index.evidence.find(item => item.id === edge.evidenceId);
    check(citation, 'REAL_EDGE_ORIGIN_MISSING');
    await page.locator('.relationship-row').first().click();
    const selected = await page.locator('.code-line code').allTextContents(); const origin = citation.original.split('\n');
    check(selected.length === origin.length && selected.every((line, offset) => line === (origin[offset] || ' ')), 'GRAPH_EDGE_INSPECTOR_DIFFERS_FROM_ORIGIN');
  }
  report.graph = { status: 'verified', progressiveExpansion: expansionVerified, existingNodePositionsPreserved: expansionVerified, accessibleListMatchesNodeAndEdgeCounts: true, relationshipOriginChecked: index.edges.length > 0 };

  stage = 'extractive-question';
  check(symbol, 'NO_REAL_SYMBOL_AVAILABLE_FOR_RETRIEVAL_CHECK');
  stage = 'question-composer-fill';
  report.questionComposer = { textareaCount: await page.locator('#repository-question').count(), textareaEnabled: await page.locator('#repository-question').isEnabled(), submitButtonCount: await page.getByRole('button', { name: 'Retrieve source evidence', exact: true }).count() };
  await page.locator('#repository-question').fill(`Where is ${symbol.label} declared and referenced?`);
  report.composerAfterFill = await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('#repository-question');
    const button = document.querySelector<HTMLButtonElement>('.send-button');
    const box = button?.getBoundingClientRect();
    const top = box ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null;
    return { inputHasValue: (input?.value.length ?? 0) > 0, buttonEnabled: button?.disabled === false, buttonAtCenter: !!button && !!top && button.contains(top), buttonBox: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null, viewport: { width: innerWidth, height: innerHeight } };
  });
  try { await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.send-button')?.disabled === false, undefined, { timeout: 15_000 }); }
  catch { throw new CheckFailure('QUESTION_COMPOSER_DID_NOT_ENABLE'); }
  stage = 'question-composer-submit';
  const answered = page.waitForResponse(response => new URL(response.url()).origin === 'http://localhost:3000' && new URL(response.url()).pathname === `${route}/questions` && response.request().method() === 'POST', { timeout: 30_000 }).catch(() => null);
  await page.locator('.send-button').click({ timeout: 15_000 });
  stage = 'question-api-response';
  const answerResponse = await answered;
  check(answerResponse, 'QUESTION_RESPONSE_NOT_RECEIVED');
  const questionBody = record(await answerResponse.json() as unknown).answer as LocalAnswer | undefined;
  report.questionApi = { httpStatus: answerResponse.status(), modeMatches: questionBody?.mode === 'extractive', citationCount: Array.isArray(questionBody?.citations) ? questionBody.citations.length : 0 };
  check(answerResponse.status() === 200 && questionBody?.mode === 'extractive' && questionBody.status === 'evidence_ready' && Array.isArray(questionBody.citations) && questionBody.citations.length > 0, 'EXTRACTIVE_RETRIEVAL_NOT_VERIFIED');
  stage = 'question-citation-validation';
  for (const citation of questionBody.citations) {
    const file = index.files.find(item => item.path === citation.source.path);
    check(file && citation.source.snapshotId === index.snapshot.snapshotId && citation.source.revision === index.snapshot.revision && citation.scope.principalId === principalId && citation.scope.tenantId === workspaceId && citation.scope.permissionRevision === index.scope.permissionRevision && citation.original === file.text.replace(/\r\n/g, '\n').split('\n').slice(citation.source.startLine - 1, citation.source.endLine).join('\n'), 'ANSWER_CITATION_DIFFERS_FROM_AUTHORIZED_GIT_SOURCE');
  }
  stage = 'question-ui-response';
  await waitFor(page, '.answer-view', 'REAL_EXTRACTIVE_ANSWER_NOT_RENDERED');
  check(await page.locator('.citation').count() === questionBody.citations.length, 'CITATION_CONTROLS_NOT_RENDERED');
  stage = 'question-citation-navigation';
  await page.locator('.citation').first().click();
  const citationLines = await page.locator('.code-line code').allTextContents(); const citationExpected = questionBody.citations[0]!.original.split('\n');
  check(citationLines.length === citationExpected.length && citationLines.every((line, offset) => line === (citationExpected[offset] || ' ')), 'ANSWER_CITATION_NAVIGATION_DIFFERS_FROM_SOURCE');
  report.question = { status: 'verified', httpStatus: 200, mode: 'extractive', questionDerivedFromRealSymbol: true, answerStatus: questionBody.status, citationCount: questionBody.citations.length, allCitationsCommitPrincipalWorkspaceAndSourceBound: true, citationNavigationMatchesSource: true, privateSourceSentToAi: false };

  stage = 'keyboard-and-narrow-layout';
  const separator = page.getByRole('separator', { name: 'Resize repository explorer', exact: true });
  const widthBefore = Number(await separator.getAttribute('aria-valuenow'));
  await separator.focus(); await page.keyboard.press('ArrowRight');
  check(Number(await separator.getAttribute('aria-valuenow')) === widthBefore + 16, 'KEYBOARD_RESIZE_NOT_VERIFIED');
  await page.keyboard.press('/');
  check(await page.locator('.search-field input').evaluate(node => node === document.activeElement), 'KEYBOARD_SEARCH_SHORTCUT_NOT_VERIFIED');
  await page.setViewportSize({ width: 390, height: 844 });
  const panels = page.getByRole('navigation', { name: 'Workspace panels', exact: true });
  await panels.getByRole('button', { name: 'Repository', exact: true }).click();
  check(await fileButton.isVisible(), 'NARROW_REPOSITORY_PANEL_NOT_VERIFIED');
  await fileButton.click();
  check(await page.locator('.source-view').isVisible(), 'NARROW_SOURCE_PANEL_NOT_VERIFIED');
  await panels.getByRole('button', { name: 'Map', exact: true }).click();
  check(await page.locator('.graph-list').isVisible(), 'NARROW_GRAPH_LIST_NOT_VERIFIED');
  const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }));
  check(geometry.scrollWidth <= geometry.width && geometry.reducedMotion, 'NARROW_LAYOUT_OVERFLOW_OR_MOTION_FAILURE');
  report.accessibility = { status: 'verified', keyboardPanelResize: true, keyboardSearchShortcut: true, narrowWidth: geometry.width, noHorizontalPageOverflow: true, narrowRepositorySourceAndListPanels: true, reducedMotionEnabled: true };
  check(pageErrors === 0 && unexpectedConsoleErrors === 0 && aiRequests === 0 && bearerAtExternalOrigin === 0, 'BROWSER_ERRORS_OR_UNEXPECTED_EGRESS');
  report.status = 'verified';
} catch (error) {
  report.status = error instanceof CheckFailure && error.code === 'PRIVATE_IMPORT_NOT_READY' ? 'blocked' : 'failed';
  report.failure = { stage, code: error instanceof CheckFailure ? error.code : 'UNEXPECTED_CHECK_FAILURE' };
  if (!(error instanceof CheckFailure)) {
    const message = error instanceof Error ? error.message : '';
    report.exceptionDiagnostic = {
      name: error instanceof Error && ['TimeoutError', 'TypeError', 'Error'].includes(error.name) ? error.name : 'unrecognized',
      locatorOperation: /locator\.fill/i.test(message) ? 'fill' : /locator\.click/i.test(message) ? 'click' : /waitForResponse/i.test(message) ? 'response-wait' : 'unknown',
      category: /strict mode violation/.test(message) ? 'locator-strictness' : /not editable|to be editable/.test(message) ? 'not-editable' : /Timeout/.test(message) ? 'timeout' : /Target page, context or browser has been closed/.test(message) ? 'target-closed' : /Cannot read properties/.test(message) ? 'undefined-property' : 'unknown',
    };
  }
  process.exitCode = 1;
} finally {
  const cleanup: Record<string, unknown> = { status: 'verified', existingSessionsRevokedByTest: 0 };
  try {
    if (!ownedSessionId && page && principalId) {
      const candidate = await page.evaluate(() => { const clerk = (window as unknown as { Clerk?: { session?: { id?: string }; user?: { id?: string } } }).Clerk; return { id: clerk?.session?.id, principal: clerk?.user?.id }; }).catch(() => null);
      if (candidate?.principal === principalId && candidate.id && !originalSessionIds.has(candidate.id)) ownedSessionId = candidate.id;
    }
    if (ownedSessionId) {
      check(!originalSessionIds.has(ownedSessionId) && /^sess_[A-Za-z0-9]+$/.test(ownedSessionId), 'CLEANUP_SESSION_OWNERSHIP_UNSAFE');
      const session = await clerk(`/sessions/${encodeURIComponent(ownedSessionId)}`);
      check(session.response.ok && record(session.data).id === ownedSessionId && record(session.data).user_id === principalId, 'CLEANUP_SESSION_PRINCIPAL_NOT_VERIFIED');
      const revoked = await clerk(`/sessions/${encodeURIComponent(ownedSessionId)}/revoke`, 'POST', {});
      cleanup.sessionRevokeHttpStatus = revoked.response.status;
      check(revoked.response.ok && record(revoked.data).status === 'revoked', 'NEW_TEST_SESSION_NOT_REVOKED');
      cleanup.newSessionRevoked = true;
    } else cleanup.newSessionCreated = false;
    if (ownedTicketId && !ticketConsumed) {
      const revoked = await clerk(`/sign_in_tokens/${encodeURIComponent(ownedTicketId)}/revoke`, 'POST', {});
      cleanup.ticketRevokeHttpStatus = revoked.response.status;
      check(revoked.response.ok && record(revoked.data).status === 'revoked', 'UNUSED_TEST_TICKET_NOT_REVOKED');
      cleanup.unusedTicketRevoked = true;
    } else if (ownedTicketId) cleanup.ticketConsumedSingleUse = true;
  } catch (error) {
    cleanup.status = 'failed'; cleanup.code = error instanceof CheckFailure ? error.code : 'CLEANUP_REQUEST_FAILED';
    report.status = 'failed'; process.exitCode = 1;
  }
  await context?.close().catch(() => undefined); await browser?.close().catch(() => undefined);
  report.cleanup = cleanup;
  Object.assign(record(report.browser), { pageErrors, consoleErrors, expectedIndexHttpErrors, expectedNegativeRouteHttpErrors, unexpectedConsoleErrors, pageFailedRequestCount, aiRequests, bearerRequestsAtExternalOrigins: bearerAtExternalOrigin });
  report.completedAt = new Date().toISOString();
  writeFileSync(new URL('docs/evidence/private-repository-ui.json', root), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, failure: report.failure ?? null, catalog: record(report.catalog).status, index: record(report.index).status, source: record(report.source).status, graph: record(report.graph).status, question: record(report.question).status, cleanup: cleanup.status, pageErrors, consoleErrors, aiRequests }));
}
