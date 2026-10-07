import { test, expect } from '@playwright/test';
import type { LocalIndex } from '@atlas/contracts';

test('AI disclosure is bound to the edited question and consumed; generated citations open real source', async ({ page }) => {
  const index = await (await page.request.get('/api/fixtures?id=jobboard-app%401.0.0')).json() as LocalIndex;
  const citation = index.evidence.find(item => item.source.path.endsWith('.ts'))!;
  let calls = 0;
  await page.route('**/api/ai/questions', async route => {
    calls++;
    expect(route.request().postDataJSON()).toMatchObject({ fixtureId: 'jobboard-app@1.0.0', approveAiDisclosure: true, question: 'Explain retry behavior.' });
    await route.fulfill({ json: { schemaVersion: 1, mode: 'voyage-deepseek', models: { embedding: 'voyage-code-3', reranking: 'rerank-2.5', generation: 'deepseek-flash' },
      status: 'evidence_ready', answer: 'Mocked browser transport answer [1]', citations: [citation], nodeIds: [], edgeIds: [], missingEvidence: [], activities: [] } });
  });
  await page.goto('/demo'); await expect(page.getByText('Snapshot ready', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'AI answer with Voyage + DeepSeek' }).check();
  const send = page.getByRole('button', { name: 'Generate DeepSeek answer' });
  const consent = page.getByRole('checkbox', { name: /^I approve sending this question/ });
  await expect(send).toBeDisabled(); expect(calls).toBe(0);
  await consent.check(); await expect(send).toBeEnabled();
  await page.locator('#code-question').fill('Explain retry behavior.');
  await expect(consent).not.toBeChecked(); await expect(send).toBeDisabled();
  await consent.check(); await send.click();
  await expect(page.locator('.answer-text')).toContainText('Mocked browser transport answer');
  await expect(page.locator('.answer-heading')).toContainText('DeepSeek · Voyage retrieval');
  await expect(consent).not.toBeChecked(); await expect(send).toBeDisabled(); expect(calls).toBe(1);
  await page.locator('.answer-citations .citation').first().click();
  await expect(page.locator('.source-file-heading strong')).toHaveText(citation.source.path);
});

test('AI failure stays visible and never triggers local extraction as a fallback', async ({ page }) => {
  let localQuestions = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/questions') localQuestions++; });
  await page.route('**/api/ai/questions', route => route.fulfill({ status: 503, json: { error: 'Voyage AI + DeepSeek request unavailable.' } }));
  await page.goto('/demo'); await expect(page.getByText('Snapshot ready', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'AI answer with Voyage + DeepSeek' }).check();
  await page.getByRole('checkbox', { name: /^I approve sending this question/ }).check();
  await page.getByRole('button', { name: 'Generate DeepSeek answer' }).click();
  await expect(page.locator('.panel-state[role="alert"]')).toContainText('Voyage AI + DeepSeek request unavailable.');
  await expect(page.locator('.answer-text')).toHaveCount(0); expect(localQuestions).toBe(0);
});
