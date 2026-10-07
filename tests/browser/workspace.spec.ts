import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { FederationResult, FixtureId, LocalAnswer, LocalIndex, SourceEvidence } from '@atlas/contracts';

type BrowserMessages = { pageErrors: string[]; consoleErrors: string[]; consoleWarnings: string[] };
const fixtureDirectories: Record<FixtureId, string> = {
  'jobboard-app@1.0.0': 'jobboard-app', 'jobboard-app@2.0.0': 'jobboard-app-v2',
  'retry-kit@1.0.0': 'retry-kit/v1', 'retry-kit@2.0.0': 'retry-kit/v2', 'event-log@1.0.0': 'event-log/v1',
};
const browserTest = test.extend<{ browserMessages: BrowserMessages }>({
  browserMessages: [async ({ page }, use) => {
    const messages: BrowserMessages = { pageErrors: [], consoleErrors: [], consoleWarnings: [] };
    page.on('pageerror', error => messages.pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') messages.consoleErrors.push(message.text());
      if (message.type() === 'warning') messages.consoleWarnings.push(message.text());
    });
    await use(messages);
  }, { auto: true }],
});
browserTest.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }); });
browserTest.afterEach(async ({ browserMessages }, info) => {
  await info.attach('browser-console', { body: JSON.stringify(browserMessages, null, 2), contentType: 'application/json' });
  expect(browserMessages.pageErrors, 'Unexpected browser JavaScript exceptions').toEqual([]);
});

async function openWorkspace(page: Page, id: FixtureId = 'jobboard-app@1.0.0'): Promise<LocalIndex> {
  const response = page.waitForResponse(response => response.url().includes('/api/fixtures?') && response.status() === 200);
  await page.goto('/app');
  let index = await (await response).json() as LocalIndex;
  if (id !== 'jobboard-app@1.0.0') {
    const changed = page.waitForResponse(response => response.url().includes('/api/fixtures?') && response.status() === 200);
    await page.getByRole('combobox', { name: 'Repository snapshot' }).selectOption(id);
    index = await (await changed).json() as LocalIndex;
  }
  await expect(page.getByText('Snapshot ready', { exact: true })).toBeVisible();
  return index;
}
async function originalLines(id: FixtureId, path: string, startLine: number, endLine: number): Promise<string> {
  const root = resolve('fixtures/repos', fixtureDirectories[id]);
  const file = resolve(root, path);
  expect(file.startsWith(root + sep), 'Citation path must stay in its fixture repository').toBe(true);
  return (await readFile(file, 'utf8')).replace(/\r\n/g, '\n').split('\n').slice(startLine - 1, endLine).join('\n');
}
async function assertSourceView(page: Page, source: SourceEvidence): Promise<void> {
  const region = page.getByRole('region', { name: `${source.source.path}, lines ${source.source.startLine} through ${source.source.endLine}. Scroll horizontally to read source.` });
  await expect(region).toBeVisible();
  const text = await region.locator('code').allTextContents();
  const original = await originalLines(source.source.snapshotId as FixtureId, source.source.path, source.source.startLine, source.source.endLine);
  expect(source.original.replace(/\n$/, '')).toBe(original.replace(/\n$/, ''));
  expect(text.map(line => line.trim() ? line : '').join('\n')).toBe(original.replace(/\n$/, ''));
  await expect(page.locator('.provenance-card')).toContainText(source.source.snapshotId);
  await page.getByText('Immutable revision', { exact: true }).click();
  await expect(page.locator('.provenance-card details code')).toHaveText(source.source.revision);
}
async function ask(page: Page, question: string): Promise<LocalAnswer> {
  await page.getByRole('textbox', { name: 'Ask this codebase' }).fill(question);
  const response = page.waitForResponse(response => response.url().endsWith('/api/questions') && response.status() === 200);
  await page.getByRole('button', { name: 'Retrieve source evidence' }).click();
  const answer = await (await response).json() as LocalAnswer;
  await expect(page.locator('.answer-text')).toHaveText(answer.answer);
  return answer;
}
async function approveProviders(page: Page, ids: string[], question: string): Promise<FederationResult> {
  for (const id of ids) await page.getByRole('checkbox', { name: new RegExp(id) }).check();
  await page.getByRole('textbox', { name: 'Question to send to selected providers' }).fill(question);
  const response = page.waitForResponse(response => response.url().endsWith('/api/federation') && response.status() === 200);
  await page.getByRole('button', { name: `Approve ${ids.length} fixture request${ids.length === 1 ? '' : 's'}`, exact: true }).click();
  const result = await (await response).json() as FederationResult;
  await expect(page.locator('.provider-tree-label')).toHaveCount(ids.length);
  return result;
}

browserTest('parsed graph selection and list relationships open actual immutable source', async ({ page }) => {
  const index = await openWorkspace(page);
  await expect(page.getByText('Fixture mode', { exact: true })).toBeVisible();
  await expect(page.locator('.map-toolbar')).toContainText(`${index.nodes.length} nodes · ${index.edges.length} relationships`);
  const sourceResponse = page.waitForResponse(response => response.url().includes('/api/source?') && response.status() === 200);
  await page.getByLabel('file: src/run-job.ts. Select to inspect source.', { exact: true }).click();
  const source = await (await sourceResponse).json() as SourceEvidence;
  expect(source.source.revision).toBe(index.snapshot.revision);
  await assertSourceView(page, source);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.locator('.graph-list-node')).toHaveCount(index.nodes.length);
  await expect(page.locator('.relationship-row')).toHaveCount(index.edges.length);
  const edgeOffset = index.edges.findIndex(edge => edge.relation === 'imports' && index.evidence.find(item => item.id === edge.evidenceId)?.original.includes('shouldRetry'));
  expect(edgeOffset).toBeGreaterThanOrEqual(0);
  const edge = index.edges[edgeOffset]!;
  const expectedOrigin = index.evidence.find(item => item.id === edge.evidenceId)!;
  const relationship = page.locator('.relationship-row').nth(edgeOffset);
  await expect(relationship).toContainText(index.nodes.find(node => node.id === edge.to)!.label);
  const origin = page.waitForResponse(response => response.url().includes('/api/source?') && response.status() === 200);
  await relationship.click();
  const evidence = await (await origin).json() as SourceEvidence;
  expect(evidence.source).toEqual(expectedOrigin.source);
  await assertSourceView(page, evidence);
});

browserTest('local question citations match original files and exact selected lines', async ({ page }) => {
  const index = await openWorkspace(page);
  const answer = await ask(page, 'How does this application retry failed jobs?');
  expect(answer.status).toBe('evidence_ready'); expect(answer.mode).toBe('extractive');
  expect(answer.citations.length).toBeGreaterThan(0);
  for (const citation of answer.citations) {
    expect(citation.source.snapshotId).toBe(index.snapshot.snapshotId);
    expect(citation.source.revision).toBe(index.snapshot.revision);
    expect(citation.original).toBe(await originalLines('jobboard-app@1.0.0', citation.source.path, citation.source.startLine, citation.source.endLine));
  }
  await expect(page.locator('.answer-citations .citation')).toHaveCount(answer.citations.length);
  const sourceResponse = page.waitForResponse(response => response.url().includes('/api/source?') && response.status() === 200);
  await page.locator('.answer-citations .citation').first().click();
  const source = await (await sourceResponse).json() as SourceEvidence;
  expect(source.source).toEqual(answer.citations[0]!.source);
  await assertSourceView(page, source);
});

browserTest('unanswerable runtime guarantees and unsupported versions abstain without citations', async ({ page }) => {
  await openWorkspace(page);
  for (const question of ['Prove no job ever fails in production.', 'Explain retry-kit 9.0.0 behavior.', 'zebrafish ocean migration']) {
    const answer = await ask(page, question);
    expect(answer.status, question).toBe('abstained'); expect(answer.citations).toEqual([]);
    await expect(page.getByText('Insufficient evidence', { exact: true })).toBeVisible();
    await expect(page.locator('.answer-citations .citation')).toHaveCount(0);
    await expect(page.locator('.limitations')).toContainText(answer.missingEvidence[0]!);
  }
});

browserTest('search shortcut, empty state, and keyboard resizing remain usable', async ({ page }) => {
  await openWorkspace(page);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  const search = page.getByRole('textbox', { name: 'Search files and symbols' });
  await expect(search).toBeFocused(); await search.fill('noSuchFixtureSymbolXYZ');
  await expect(page.getByText(/No files or symbols match/)).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).first().click();
  await search.fill('planFailure');
  const symbol = page.getByRole('button', { name: 'planFailure src/run-job.ts', exact: true });
  await expect(symbol).toBeVisible(); await symbol.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.source-view')).toContainText('export function planFailure');
  const left = page.getByRole('separator', { name: 'Resize repository explorer' });
  await left.focus(); const initial = Number(await left.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowRight'); await expect(left).toHaveAttribute('aria-valuenow', String(initial + 16));
  await page.keyboard.press('Home'); await expect(left).toHaveAttribute('aria-valuenow', '184');
  await page.keyboard.press('End'); await expect(left).toHaveAttribute('aria-valuenow', '360');
  const right = page.getByRole('separator', { name: 'Resize evidence inspector' });
  await right.focus(); const before = Number(await right.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowLeft'); await expect(right).toHaveAttribute('aria-valuenow', String(before + 16));
  await expect(right).toBeFocused();
});

browserTest('provider approval explicitly discloses a separate bounded outbound question', async ({ page }) => {
  await openWorkspace(page);
  const federationRequests: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/federation')) federationRequests.push(request.postData() ?? ''); });
  const localQuestion = 'How does planFailure retry? private-local-marker-147';
  await ask(page, localQuestion);
  await expect(page.getByRole('textbox', { name: 'Question to send to selected providers' })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Approve fixture requests', exact: true })).toBeDisabled();
  await expect(page.locator('.disclosure-preview')).toContainText('Only this external question, the selected package identity, and its exact version leave the workspace.');
  await expect(page.locator('.disclosure-preview')).toContainText('payment disabled · recipient: none');
  await page.getByRole('checkbox', { name: /fixture-retry/ }).check();
  await expect(page.getByRole('button', { name: 'Approve 1 fixture request', exact: true })).toBeDisabled();
  expect(federationRequests).toEqual([]);
  await page.getByRole('checkbox', { name: /fixture-retry/ }).uncheck();
  const externalQuestion = 'How do retry delays work?';
  const result = await approveProviders(page, ['fixture-retry'], externalQuestion);
  expect(result.providers.map(provider => provider.providerId)).toEqual(['fixture-retry']);
  expect(federationRequests).toHaveLength(1);
  expect(JSON.parse(federationRequests[0]!)).toEqual({ fixtureId: 'jobboard-app@1.0.0', approvedProviderIds: ['fixture-retry'], externalQuestion });
  expect(federationRequests[0]).not.toContain(localQuestion); expect(federationRequests[0]).not.toContain('import {');
  expect(result.payment).toBe('not-attempted');
});

browserTest('two real providers extend graph with distinct exact-version provenance and clickable source', async ({ page }) => {
  const local = await openWorkspace(page);
  const result = await approveProviders(page, ['fixture-retry', 'fixture-events'], 'How are retries recorded and delayed?');
  expect(result.providers.map(provider => provider.providerId)).toEqual(['fixture-retry', 'fixture-events']);
  expect(result.providers.every(provider => provider.payment === 'not-attempted')).toBe(true);
  expect(new Set(result.nodes.map(node => node.id)).size).toBe(result.nodes.length);
  expect(result.edges.filter(edge => edge.id.includes('fixture-join'))).toHaveLength(2);
  expect(result.nodes.length).toBeGreaterThan(local.nodes.length);
  await expect(page.locator('.map-toolbar')).toContainText(`${result.nodes.length} nodes · ${result.edges.length} relationships`);
  await page.getByRole('button', { name: 'Evidence', exact: true }).click();
  await expect(page.locator('.federation-evidence article')).toHaveCount(2);
  await expect(page.locator('.federation-evidence')).toContainText('fixture-retry');
  await expect(page.locator('.federation-evidence')).toContainText('fixture-events');
  const citation = result.citations[0]!;
  const sourceResponse = page.waitForResponse(response => response.url().includes('/api/source?') && response.status() === 200);
  await page.locator('.federation-evidence .citation').first().click();
  const source = await (await sourceResponse).json() as SourceEvidence;
  expect(source.source).toEqual(citation.source); await assertSourceView(page, source);
  await expect(page.locator('.provenance-card')).toContainText(citation.providerId!);
});

browserTest('buyer version change clears stale provider context, approval, question and source', async ({ page }) => {
  await openWorkspace(page); await ask(page, 'How does the application retry jobs?');
  await approveProviders(page, ['fixture-retry', 'fixture-events'], 'How do retries work?');
  const changed = page.waitForResponse(response => response.url().includes('/api/fixtures?') && response.status() === 200);
  await page.getByRole('combobox', { name: 'Repository snapshot' }).selectOption('jobboard-app@2.0.0');
  await changed; await expect(page.getByText('Snapshot ready', { exact: true })).toBeVisible();
  await expect(page.locator('.stale-banner')).toContainText('Evidence from jobboard-app@1.0.0 is inapplicable to jobboard-app@2.0.0.');
  await expect(page.locator('.provider-tree-label')).toHaveCount(0);
  await expect(page.locator('.source-view')).toHaveCount(0);
  await expect(page.locator('.answer-view')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /fixture-retry/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /fixture-events/ })).not.toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Question to send to selected providers' })).toHaveValue('');
  await expect(page.locator('.provider-choice').filter({ hasText: 'fixture-retry' })).toContainText('2.0.0');
  const result = await approveProviders(page, ['fixture-retry'], 'What happens for permanent errors?');
  expect(result.providers[0]!.index.version).toBe('2.0.0');
  expect(result.nodes.some(node => node.snapshotId === 'retry-kit@1.0.0')).toBe(false);
  await page.getByRole('button', { name: 'Evidence', exact: true }).click();
  await expect(page.locator('.federation-evidence')).toContainText('if (error.permanent === true) return false;');
  await expect(page.locator('.federation-evidence')).not.toContainText('retry-kit@1.0.0');
});

browserTest('mobile panels, keyboard evidence navigation and reduced motion fit the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWorkspace(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const panels = page.getByRole('navigation', { name: 'Workspace panels' });
  await expect(panels).toBeVisible();
  await panels.getByRole('button', { name: 'Repository', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Repository explorer' })).toBeVisible();
  const file = page.getByRole('button', { name: 'src/run-job.ts', exact: true });
  await file.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.source-view')).toContainText('export function planFailure');
  await expect(panels.getByRole('button', { name: 'Evidence', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await panels.getByRole('button', { name: 'Map', exact: true }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.locator('.graph-list-node').first()).toBeVisible();
  const geometry = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: innerWidth,
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    transition: getComputedStyle(document.querySelector('.graph-list-node')!).transitionDuration,
    animation: getComputedStyle(document.querySelector('.graph-list-node')!).animationName }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width); expect(geometry.reduced).toBe(true);
  expect(geometry.transition).toBe('0s'); expect(geometry.animation).toBe('none');
});

browserTest('publishing remains gated and configured Clerk sign-in offers real authentication', async ({ page }) => {
  await page.goto('/app/publish');
  await expect(page.getByText('Private drafts are available; publication is unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in to manage drafts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create private draft' })).toHaveCount(0);
  expect((await page.request.post('/api/publications', { data: {} })).status()).toBe(401);
  await page.goto('/sign-in');
  await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeEnabled();
  const account = await page.request.get('/api/account');
  expect(account.status()).toBe(401);
  await page.getByRole('link', { name: 'Explore the public fixtures' }).click();
  await expect(page.getByText('Snapshot ready', { exact: true })).toBeVisible();
});

browserTest('activity records actual index/source/retrieval/provider operations and can be cleared', async ({ page }) => {
  await page.goto('/app/activity'); await expect(page.getByText('No activity in this session', { exact: true })).toBeVisible();
  await openWorkspace(page);
  await page.getByRole('button', { name: 'src/run-job.ts', exact: true }).click();
  await expect(page.locator('.source-view')).toBeVisible(); await ask(page, 'How does planFailure work?');
  await approveProviders(page, ['fixture-retry'], 'How do retries work?');
  await page.getByRole('navigation', { name: 'Application' }).getByRole('link', { name: 'Activity', exact: true }).click();
  const history = page.locator('.activity-list');
  for (const operation of ['fixture.index', 'source.lookup', 'lexical-source-search', 'validate-citations', 'provider.context']) await expect(history).toContainText(operation);
  await expect(history).toContainText('Payment not attempted.');
  await expect(history).not.toContainText('0x');
  await page.getByRole('button', { name: 'Clear history' }).click();
  await expect(page.getByText('No activity in this session', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear history' })).toBeDisabled();
});

browserTest('invalid snapshot, private path and cross-origin HTTP operations fail closed', async ({ page }) => {
  await openWorkspace(page);
  const denied = await page.request.get('/api/fixtures?id=private-tenant-repository');
  expect(denied.status()).toBe(400); expect(await denied.json()).toEqual({ error: 'Unsupported fixture snapshot' });
  const source = await page.request.get('/api/source', { params: { fixtureId: 'jobboard-app@1.0.0', path: '../../.env', startLine: '1', endLine: '2' } });
  expect(source.status()).toBe(400); expect(JSON.stringify(await source.json())).not.toContain('import {');
  const question = await page.request.post('/api/questions', { headers: { Origin: 'https://untrusted.example' }, data: { fixtureId: 'jobboard-app@1.0.0', question: 'retry' } });
  expect(question.status()).toBe(403); expect(await question.json()).toEqual({ error: 'Cross-origin request denied' });
  const federation = await page.request.post('/api/federation', { headers: { Origin: 'https://untrusted.example' }, data: { fixtureId: 'jobboard-app@1.0.0', approvedProviderIds: ['fixture-retry'], externalQuestion: 'retry' } });
  expect(federation.status()).toBe(403);
  const unsupported = await page.request.post('/api/federation', { data: { fixtureId: 'jobboard-app@1.0.0', approvedProviderIds: ['http://169.254.169.254'], externalQuestion: 'retry' } });
  expect(unsupported.status()).toBe(400); expect(await unsupported.json()).toMatchObject({ error: expect.stringContaining('No payment was attempted.') });
});

browserTest('injected indexing transport failure shows retry and records failed then actual recovered operation', async ({ page }) => {
  await page.route('**/api/fixtures?*', route => route.abort('failed'), { times: 1 });
  await page.goto('/app');
  await expect(page.getByRole('heading', { name: 'Unable to load this snapshot' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retrieve source evidence' })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry source indexing' }).click();
  await expect(page.getByText('Snapshot ready', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Application' }).getByRole('link', { name: 'Activity', exact: true }).click();
  const entries = page.locator('.activity-list li').filter({ hasText: 'fixture.index' });
  await expect(entries).toHaveCount(2); await expect(entries.first()).toContainText('complete'); await expect(entries.last()).toContainText('failed');
});
