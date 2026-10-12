import { test, expect } from '@playwright/test';

// Exercises actual public rendering and anonymous boundaries. No route mocking,
// private sessions, private source reads, or payment activity.
const publicPages = [
  { path: '/', title: 'RepoFair · Codebase maps and source evidence', heading: 'Map your code.' },
  { path: '/privacy', title: 'Privacy and data use | RepoFair', heading: 'Privacy and data use' },
  { path: '/terms', title: 'Use and payment terms | RepoFair', heading: 'Use and payment terms' },
];

test('public SEO, robots, and sitemap agree on the deployment indexing boundary', async ({ page, request }) => {
  let indexed: boolean | undefined;
  const canonicals: string[] = [];
  for (const entry of publicPages) {
    const response = await page.goto(entry.path);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(entry.title);
    await expect(page.getByRole('link', { name: 'RepoFair home' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(entry.heading);
    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toBeTruthy();
    const pageIndexed = !robots!.includes('noindex');
    if (indexed === undefined) indexed = pageIndexed;
    expect(pageIndexed).toBe(indexed);
    const expected = process.env.ATLAS_BROWSER_EXPECT_INDEXING;
    if (expected !== undefined) expect(pageIndexed).toBe(expected === 'true');
    expect((await page.locator('meta[name="description"]').getAttribute('content'))?.length).toBeGreaterThan(40);
    const canonical = page.locator('link[rel="canonical"]');
    if (pageIndexed) await expect(canonical).toHaveCount(1);
    if (await canonical.count()) {
      const value = (await canonical.getAttribute('href'))!;
      const url = new URL(value);
      expect(url.pathname).toBe(entry.path);
      expect(url.search).toBe(''); expect(url.hash).toBe(''); expect(url.username).toBe(''); expect(url.password).toBe('');
      if (pageIndexed) { expect(url.protocol).toBe('https:'); expect(url.hostname).not.toMatch(/localhost|trycloudflare\.com|ngrok|^\d+\./); }
      // Next can serialize the origin without its equivalent trailing slash.
      canonicals.push(url.href);
    }
  }
  const robotsResponse = await request.get('/robots.txt');
  expect(robotsResponse.status()).toBe(200);
  const robotsText = await robotsResponse.text();
  const sitemapResponse = await request.get('/sitemap.xml');
  expect(sitemapResponse.status()).toBe(200);
  const sitemapText = await sitemapResponse.text();
  const urls = [...sitemapText.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  expect(robotsText).toContain('Disallow: /');
  if (indexed) {
    expect(canonicals).toHaveLength(3);
    expect(urls).toEqual(canonicals);
    for (const rule of ['Allow: /$', 'Allow: /privacy$', 'Allow: /terms$']) expect(robotsText).toContain(rule);
    expect(robotsText).toContain(`Sitemap: ${new URL('/sitemap.xml', canonicals[0]).href}`);
  } else {
    expect(urls).toEqual([]);
    expect(robotsText).not.toContain('Allow:');
    expect(robotsText).not.toContain('Sitemap:');
  }
  for (const privatePath of ['/app', '/api/', '/sign-in', '/sign-up', '/demo']) expect(sitemapText).not.toContain(privatePath);
});

test('authentication and workspace metadata stay private without a misleading home canonical', async ({ page, request }) => {
  for (const path of ['/sign-in', '/sign-up', '/app', '/app/repositories', '/app/publish']) {
    await page.goto(path);
    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toContain('noindex'); expect(robots).toContain('nofollow');
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  }
  for (const path of ['/api/account', '/api/catalog', '/api/repositories', '/api/publications', '/api/purchases']) {
    const response = await request.get(path);
    expect([401, 503]).toContain(response.status());
    expect(response.headers()['cache-control']).toContain('no-store');
  }
});

test('public information links, manifest, generated image, and not-found recovery are real', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Public information' }).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
  await expect(page.getByRole('navigation', { name: 'Public information' }).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
  await expect(page.getByRole('link', { name: 'Development fixtures' })).toHaveCount(0);
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestHref).toBe('/manifest.webmanifest');
  const manifestResponse = await request.get(manifestHref!);
  expect(manifestResponse.status()).toBe(200);
  expect(await manifestResponse.json()).toMatchObject({ name: 'RepoFair', short_name: 'RepoFair', start_url: '/', icons: [{ src: '/icon.svg', type: 'image/svg+xml' }] });
  const iconResponse = await request.get('/icon.svg');
  expect(iconResponse.status()).toBe(200);
  expect(iconResponse.headers()['content-type']).toContain('image/svg+xml');
  expect(await iconResponse.text()).toContain('<title>RepoFair</title>');
  const imageUrl = new URL((await page.locator('meta[property="og:image"]').getAttribute('content'))!);
  expect(imageUrl.pathname).toBe('/opengraph-image');
  const imageResponse = await request.get(`${imageUrl.pathname}${imageUrl.search}`);
  expect(imageResponse.status()).toBe(200);
  expect(imageResponse.headers()['content-type']).toContain('image/png');
  expect([...new Uint8Array(await imageResponse.body()).slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const missing = await page.goto('/missing-public-page-for-browser-verification');
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  expect(await page.locator('meta[name="robots"]').first().getAttribute('content')).toContain('noindex');
  await page.getByRole('link', { name: 'Return home' }).click();
  await expect(page).toHaveURL('/');
});

test('public notices stay readable and keyboard accessible at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/privacy', '/terms']) {
    await page.goto(path);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
});
