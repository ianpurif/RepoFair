import { test, expect } from '@playwright/test';
import type { CatalogProvider } from '../../packages/contracts/src/index.ts';
import { developmentTest } from './development-auth';
// Live-session cases must not retain tickets, cookies or private account details in traces.
developmentTest.use({trace:'off',screenshot:'off'});

const provider: CatalogProvider = {
  id: '00000000-0000-4000-8000-000000000002', packageName: 'transport-fixture', version: '1.2.3',
  endpoint: 'https://provider.example/context', realm: 'Transport fixture', accessPolicy: 'authenticated',
  network: 'eip155:42431', token: '0x20c0000000000000000000000000000000000000', tokenDecimals: 6,
  recipient: '0x1111111111111111111111111111111111111111', atomicPrice: '25000',
  commitSha: 'a'.repeat(40), snapshotId: 'snapshot-transport-fixture', publicationDigest: 'b'.repeat(64),
  rightsStatement: 'Synthetic catalog transport fixture for browser tests only.',
};

test('real anonymous product workspace requires authentication and does not load fixture source', async ({ page }) => {
  const fixtureRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/fixtures') fixtureRequests.push(request.url()); });
  await page.goto('/app');
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Repository snapshot' })).toHaveCount(0);
  await expect(page.locator('.graph-canvas')).toHaveCount(0);
  expect(fixtureRequests).toEqual([]);
  expect((await page.request.get('/api/account')).status()).toBe(401);
});

test('catalog transport mock shows honest loading, empty, failure and recovery states', async ({ page }) => {
  let state: 'empty' | 'unavailable' | 'ready' = 'empty';
  await page.route('**/api/catalog', route => state === 'unavailable' ? route.fulfill({ status: 503, json: { error: 'Injected catalog transport unavailable.' } }) : route.fulfill({ json: { providers: state === 'ready' ? [provider] : [] } }));
  await page.goto('/app/providers');
  await expect(page.getByRole('heading', { name: 'No published providers yet' })).toBeVisible();
  await expect(page.locator('.provider-cards article')).toHaveCount(0);
  await expect(page.getByText('fixture-retry', { exact: true })).toHaveCount(0);
  state = 'unavailable'; await page.getByRole('button', { name: 'Refresh providers' }).click();
  await expect(page.locator('.provider-directory [role="alert"]')).toContainText('Injected catalog transport unavailable.');
  await expect(page.locator('.provider-cards article')).toHaveCount(0);
  state = 'ready'; await page.getByRole('button', { name: 'Refresh providers' }).click();
  await expect(page.getByRole('heading', { name: 'transport-fixture@1.2.3' })).toBeVisible();
  await expect(page.locator('.provider-cards article')).toContainText('0.025 PathUSD · 25000 atomic units');
  await expect(page.locator('.provider-cards article')).toContainText(provider.recipient);
});

test('catalog transport mock rejects mainnet terms before displaying purchase controls', async ({ page }) => {
  await page.route('**/api/catalog', route => route.fulfill({ json: { providers: [{ ...provider, network: 'eip155:4217' }] } }));
  await page.goto(`/app/providers/${provider.id}`);
  await expect(page.getByRole('heading', { name: 'Provider catalog unavailable' })).toBeVisible();
  await expect(page.locator('.provider-directory [role="alert"]')).toContainText('invalid testnet terms');
  await expect(page.locator('.provider-cards article')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Purchase/ })).toHaveCount(0);
});

test('catalog transport mock shows exact service terms and no signing at narrow width', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const purchaseRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/purchases' && request.method() === 'POST') purchaseRequests.push(request.url()); });
  await page.route('**/api/catalog', route => route.fulfill({ json: { providers: [provider] } }));
  await page.goto(`/app/providers/${provider.id}`);
  await expect(page.getByRole('heading', { name: 'transport-fixture@1.2.3' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Purchase signing unavailable' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Sign in to review your workspace allowance' })).toBeVisible();
  await expect(page.locator('.provider-cards article')).toContainText('Tempo Moderato testnet · 42431');
  await expect(page.locator('.provider-cards article')).toContainText('context.retrieve');
  expect(purchaseRequests).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const screenshot = info.outputPath('narrow-catalog-transport-mock.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach('narrow-catalog-transport-mock', { path: screenshot, contentType: 'image/png' });
});

test('explicit fixture graph keyboard opens source and keeps dragged positions during expansion', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/demo');
  await expect(page.getByText('Snapshot ready', { exact: true })).toBeVisible();
  const file = page.getByLabel('file: src/run-job.ts. Select to inspect source.', { exact: true });
  await file.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.source-view')).toContainText('export function planFailure');
  const box = await file.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 45, box!.y + 25); await page.mouse.down();
  await page.mouse.move(box!.x + 78, box!.y + 45, { steps: 5 }); await page.mouse.up();
  const position = await file.getAttribute('style');
  await page.getByRole('button', { name: 'Expand src/policy.ts symbols', exact: true }).click();
  await expect(file).toHaveAttribute('style', position!);
  expect(await page.locator('.react-flow__node').count()).toBeLessThanOrEqual(160);
  const screenshot = info.outputPath('desktop-explicit-fixture-source.png');
  await page.screenshot({ path: screenshot });
  await info.attach('desktop-explicit-fixture-source', { path: screenshot, contentType: 'image/png' });
});

developmentTest.describe('opt-in real Clerk session with explicit commerce transport fixtures',()=>{
developmentTest.skip(process.env.ATLAS_BROWSER_TEST_SESSION!=='true','Set ATLAS_BROWSER_TEST_SESSION=true to use a fresh development session; no live signing or payment.');

developmentTest('reader with a pending import polls status without advancing work or refreshing the account', async ({page,developmentPrincipal}) => {
  const repositoryId='00000000-0000-4000-8000-000000000011'; let polls=0; let advances=0; let accounts=0;
  const job={schemaVersion:1,id:'00000000-0000-4000-8000-000000000012',repositoryId,snapshotId:'00000000-0000-4000-8000-000000000013',commitSha:'a'.repeat(40),requestedRef:null,status:'queued',phase:'discovering',progress:{discovered:0,eligible:null,downloaded:0,reused:0,parsed:0,skipped:0,bytesTotal:null,bytesProcessed:0},attempts:0,nextAttemptAt:null,updatedAt:'2026-10-13T00:00:00Z',startedAt:null,finishedAt:null,error:null,canCancel:false,canRetry:false};
  await page.route('**/api/account',route=>{accounts++;return route.fulfill({json:{authenticated:true,principalId:developmentPrincipal,workspaces:[{id:'00000000-0000-4000-8000-000000000014',name:'Reader transport test',role:'reader'}]}});});
  await page.route(`**/api/repositories/${repositoryId}/jobs`,route=>{if(route.request().method()==='POST'){advances++;return route.fulfill({status:403,json:{error:'Reader cannot advance.'}});}polls++;return route.fulfill({json:{job}});});
  await page.route(`**/api/repositories/${repositoryId}/map?*`,route=>route.fulfill({status:202,json:{status:'pending'}}));
  await page.goto(`/app/repositories/${repositoryId}`);
  await expect(page.locator('.import-progress')).toContainText('Import queued');
  const initialAccounts=accounts;
  await expect.poll(()=>polls,{timeout:10000}).toBeGreaterThanOrEqual(2);
  expect(advances).toBe(0);expect(accounts).toBe(initialAccounts);
  await expect(page.getByRole('button',{name:'Cancel import'})).toHaveCount(0);
});

developmentTest('browser wallet on mainnet cannot connect, approve or sign a purchase', async ({ page,developmentPrincipal }) => {
  await page.addInitScript(() => {
    const target=window as Window&{ethereum?:{request:(input:{method:string})=>Promise<unknown>};walletCalls?:string[]};
    target.walletCalls=[];
    target.ethereum={request:async ({method})=>{target.walletCalls!.push(method);if(method==='eth_chainId')return '0x1079';throw new Error('No account or signing operation permitted in this negative test.');}};
  });
  await page.route('**/api/account',route=>route.fulfill({json:{authenticated:true,principalId:developmentPrincipal,workspaces:[{id:'00000000-0000-4000-8000-000000000003',name:'Transport test workspace',role:'owner'}]}}));
  await page.route('**/api/catalog',route=>route.fulfill({json:{providers:[provider]}}));
  await page.route('**/api/purchases?*',route=>route.fulfill({json:{purchases:[],budgets:[]}}));
  const submissions:string[]=[];
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/purchases'&&request.method()==='POST')submissions.push(request.url());});
  await page.goto(`/app/providers/${provider.id}`);
  await page.getByRole('button',{name:'Connect Tempo wallet'}).click();
  await expect(page.locator('.provider-purchase-state [role="alert"]')).toContainText('Select Tempo Moderato (42431)');
  expect(await page.evaluate(()=>(window as Window&{walletCalls?:string[]}).walletCalls)).toEqual(['eth_chainId']);
  expect(submissions).toEqual([]);
  await expect(page.getByRole('button',{name:'Approve and sign testnet purchase'})).toHaveCount(0);
});

developmentTest('purchase history recovery posts only to the recorded resume endpoint', async ({ page,developmentPrincipal }) => {
  const purchase={id:'00000000-0000-4000-8000-000000000004',providerId:provider.id,packageName:provider.packageName,version:provider.version,network:provider.network,token:provider.token,recipient:provider.recipient,atomicAmount:provider.atomicPrice,paymentState:'unknown',deliveryState:'awaiting-payment',receiptReference:null,createdAt:'2026-10-11T00:00:00Z',updatedAt:'2026-10-11T00:00:00Z'};
  await page.route('**/api/account',route=>route.fulfill({json:{authenticated:true,principalId:developmentPrincipal,workspaces:[{id:'00000000-0000-4000-8000-000000000003',name:'Transport test workspace',role:'owner'}]}}));
  await page.route('**/api/purchases?*',route=>route.fulfill({json:{purchases:[purchase],budgets:[]}}));
  let recoveredBody:unknown;
  await page.route(`**/api/purchases/${purchase.id}/resume`,route=>{recoveredBody=route.request().postDataJSON();return route.fulfill({status:409,json:{code:'settlement-unresolved'}});});
  const approvals:string[]=[];page.on('request',request=>{if(new URL(request.url()).pathname==='/api/purchases'&&request.method()==='POST')approvals.push(request.url());});
  await page.goto('/app/activity');
  await page.getByRole('button',{name:'Resume payment and delivery'}).click();
  await expect(page.locator('.activity-list [role="alert"]')).toContainText('409, settlement-unresolved');
  expect(recoveredBody).toEqual({});expect(approvals).toEqual([]);
  await expect(page.getByRole('button',{name:'Cancel unsigned reservation'})).toHaveCount(0);
});
});
