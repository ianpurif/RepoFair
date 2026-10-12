import { expect } from '@playwright/test';
import { developmentTest } from './development-auth';

// Real deployed HTTP, Clerk session, GitHub import and database. No route mocks,
// saved sessions, source screenshots, AI calls, wallet signatures or payments.
developmentTest.use({ trace: 'off', screenshot: 'off' });
developmentTest.skip(process.env.REPOFAIR_LIVE_IMPORT_VERIFICATION !== 'true', 'Explicit live RepoFair import verification is required.');

developmentTest('live RepoFair signs in, imports the owned GitHub repository, and renders original source evidence', async ({ page, request, developmentPrincipal }) => {
  developmentTest.setTimeout(600_000);
  expect(developmentPrincipal).toMatch(/^user_/);
  const anonymous = await request.get('/api/repositories');
  expect(anonymous.status()).toBe(401);
  await page.goto('/app/repositories');
  await expect(page.getByRole('heading', { name: 'Your repositories', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Install RepoFair GitHub App/ })).toHaveAttribute('href', 'https://github.com/apps/repofair/installations/new');
  await page.getByLabel('GitHub repository URL', { exact: true }).fill('https://github.com/ianpurif/RepoFair');
  await page.getByRole('button', { name: 'Import repository', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/repositories\/[a-f0-9-]{36}$/, { timeout: 30_000 });
  // The live 323-file import advanced normally beyond the original four-minute
  // deadline. Keep the actual completion assertion and a bounded larger budget.
  await expect(page.locator('.import-progress')).toContainText('Import complete', { timeout: 480_000 });
  await expect(page.locator('.graph-canvas')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('textbox', { name: 'Search files and symbols', exact: true }).fill('repository-service.ts');
  const file = page.getByRole('complementary', { name: 'Repository explorer' }).getByRole('button', { name: 'apps/worker/src/repository-service.ts', exact: true });
  await expect(file).toBeVisible();
  await file.click();
  await expect(page.locator('.source-view')).toBeVisible();
  await page.getByLabel('Ask this codebase', { exact: true }).fill('Where is processOne defined?');
  await page.getByRole('button', { name: 'Retrieve source evidence', exact: true }).click();
  await expect(page.locator('.answer-citations .citation').first()).toBeVisible({ timeout: 30_000 });
  await page.locator('.answer-citations .citation').first().click();
  await expect(page.locator('.source-view')).toBeVisible();
  const capability = await page.request.get('/api/capabilities');
  expect(capability.status()).toBe(200);
  expect(await capability.json()).toMatchObject({ product: 'RepoFair', stage: 'application', mode: 'tempo-testnet', livePayments: false });
  const denied = await page.request.post('/api/repositories', { headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, data: '{}' });
  expect(denied.status()).toBe(403);
  const fixtures = await request.get('/api/fixtures');
  expect(fixtures.status()).toBe(503);
});

developmentTest('live authenticated publishing and purchase interfaces read real records without exporting or spending', async ({ page, developmentPrincipal }) => {
  developmentTest.setTimeout(120_000);
  const accountResponse = await page.request.get('/api/account');
  expect(accountResponse.status()).toBe(200);
  const account = await accountResponse.json();
  expect(account.principalId).toBe(developmentPrincipal);
  const workspace = account.workspaces.find((entry: { role: string }) => entry.role === 'owner');
  expect(workspace?.id).toMatch(/^[a-f0-9-]{36}$/);
  for (const [path, fields] of [
    [`/api/publications?workspaceId=${workspace.id}`, ['drafts']],
    ['/api/catalog', ['providers']],
    [`/api/purchases?workspaceId=${workspace.id}`, ['purchases', 'budgets']],
  ] as const) {
    const response = await page.request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-store');
    const body = await response.json();
    for (const field of fields) expect(Array.isArray(body[field])).toBe(true);
  }
  for (const [path, heading] of [
    ['/app/publish', 'Prepare a knowledge service'],
    ['/app/providers', 'Knowledge providers'],
    ['/app/activity', 'Purchases'],
    ['/app/settings', 'Settings'],
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
});
