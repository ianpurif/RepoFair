import { expect } from '@playwright/test';
import { developmentTest } from './development-auth';

// Real deployed HTTP, Clerk session, GitHub import and database. No route mocks,
// saved sessions, source screenshots, AI calls, wallet signatures or payments.
developmentTest.use({ trace: 'off', screenshot: 'off' });
developmentTest.skip(process.env.REPOFAIR_LIVE_IMPORT_VERIFICATION !== 'true', 'Explicit live RepoFair import verification is required.');

developmentTest('live RepoFair signs in, imports the owned GitHub repository, and renders original source evidence', async ({ page, request, developmentPrincipal }) => {
  developmentTest.setTimeout(300_000);
  expect(developmentPrincipal).toMatch(/^user_/);
  const anonymous = await request.get('/api/repositories');
  expect(anonymous.status()).toBe(401);
  await page.goto('/app/repositories');
  await expect(page.getByRole('heading', { name: 'Your repositories', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Install RepoFair GitHub App/ })).toHaveAttribute('href', 'https://github.com/apps/repofair/installations/new');
  await page.getByLabel('GitHub repository URL', { exact: true }).fill('https://github.com/ianpurif/RepoFair');
  await page.getByRole('button', { name: 'Import repository', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/repositories\/[a-f0-9-]{36}$/, { timeout: 30_000 });
  await expect(page.locator('.import-progress')).toContainText('Import complete', { timeout: 240_000 });
  await expect(page.locator('.graph-canvas')).toBeVisible({ timeout: 30_000 });
  const file = page.getByRole('button', { name: /^file: / }).first();
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
  const fixtures = await request.post('/api/fixtures', { data: { fixtureId: 'jobboard-app@1.0.0' } });
  expect(fixtures.status()).toBe(503);
});
