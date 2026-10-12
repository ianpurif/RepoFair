import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRIVATE_ROBOTS, privatePageMetadata, publicPageMetadata, publicSitemap, rootMetadata, searchRobots, siteConfiguration } from '../../apps/web/src/lib/site-metadata';
import robots from '../../apps/web/src/app/robots';
import sitemap from '../../apps/web/src/app/sitemap';
import manifest from '../../apps/web/src/app/manifest';

// Configuration-only checks. They do not access a live domain, authentication,
// source, database, provider, or payment service.
const production = { NODE_ENV: 'production', VERCEL_ENV: 'production', APP_ORIGIN: 'https://atlas.example.com', ATLAS_SEARCH_INDEXING_ENABLED: 'true' };
afterEach(() => { vi.unstubAllEnvs(); });

describe('operator-controlled public indexing', () => {
  it('indexes only the three deliberately public pages on a permanent production origin', () => {
    const result = siteConfiguration(production);
    expect(result.indexingEnabled).toBe(true);
    expect(result.origin?.href).toBe('https://atlas.example.com/');
    expect(publicSitemap(production)).toEqual([
      { url: 'https://atlas.example.com/' },
      { url: 'https://atlas.example.com/privacy' },
      { url: 'https://atlas.example.com/terms' },
    ]);
    expect(searchRobots(production)).toEqual({ rules: { userAgent: '*', allow: ['/$', '/privacy$', '/terms$', '/_next/', '/favicon.ico', '/opengraph-image', '/manifest.webmanifest'], disallow: '/' }, sitemap: 'https://atlas.example.com/sitemap.xml' });
  });
  it('permits explicit selfhost production enablement and honors an operator disablement', () => {
    expect(siteConfiguration({ NODE_ENV: 'production', APP_ORIGIN: production.APP_ORIGIN, ATLAS_SEARCH_INDEXING_ENABLED: 'true' }).indexingEnabled).toBe(true);
    expect(siteConfiguration({ NODE_ENV: 'production', APP_ORIGIN: production.APP_ORIGIN }).indexingEnabled).toBe(false);
    expect(siteConfiguration({ ...production, ATLAS_SEARCH_INDEXING_ENABLED: 'false' }).indexingEnabled).toBe(false);
    expect(siteConfiguration({ ...production, ATLAS_SEARCH_INDEXING_ENABLED: undefined }).indexingEnabled).toBe(false);
  });
  it.each([
    { ...production, VERCEL_ENV: 'preview', ATLAS_SEARCH_INDEXING_ENABLED: 'true' },
    { ...production, VERCEL_ENV: 'development', ATLAS_SEARCH_INDEXING_ENABLED: 'true' },
    { ...production, NODE_ENV: 'development', ATLAS_SEARCH_INDEXING_ENABLED: 'true' },
    { ...production, NODE_ENV: 'test', ATLAS_SEARCH_INDEXING_ENABLED: 'true' },
    { ...production, NODE_ENV: undefined, ATLAS_SEARCH_INDEXING_ENABLED: 'true' },
  ])('cannot index a nonproduction environment even with explicit enablement %j', env => {
    expect(siteConfiguration(env).indexingEnabled).toBe(false);
    expect(publicSitemap(env)).toEqual([]);
    expect(searchRobots(env)).toEqual({ rules: { userAgent: '*', disallow: '/' } });
    expect(rootMetadata(env).robots).toEqual(PRIVATE_ROBOTS);
  });
  it.each([
    undefined, '', 'not-a-url', 'https://atlas.example.com/', 'https://atlas.example.com/path',
    'https://atlas.example.com?x=1', 'https://atlas.example.com#fragment',
    'https://user:secret@atlas.example.com', 'http://atlas.example.com', 'https://atlas.example.com:443',
    'https://atlas.example.com:8443', 'https://ATLAS.example.com', ' https://atlas.example.com',
    'https://atlas.example.com\n', 'https://*.example.com', 'https://atlas.example.com,https://foreign.com',
    'https://127.0.0.1', 'https://10.0.0.1', 'https://[::1]', 'https://localhost', 'https://atlas.local',
    'https://atlas.internal', 'https://atlas.test', 'https://atlas.invalid', 'https://atlas.example',
    'https://random.trycloudflare.com', 'https://trycloudflare.com', 'https://random.ngrok-free.app',
    'https://random.ngrok.io', 'https://random.loca.lt', 'http://localhost:3000',
  ])('fails closed for an absent, ambiguous, local, or temporary production origin %j', APP_ORIGIN => {
    const env = { ...production, APP_ORIGIN, ATLAS_SEARCH_INDEXING_ENABLED: 'true' };
    expect(siteConfiguration(env)).toEqual({ origin: null, indexingEnabled: false });
    expect(publicSitemap(env)).toEqual([]);
    expect(searchRobots(env)).toEqual({ rules: { userAgent: '*', disallow: '/' } });
    expect(rootMetadata(env).alternates).toBeUndefined();
    expect(publicPageMetadata('/', 'Atlas', 'Source evidence', env).alternates).toBeUndefined();
  });
  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])('uses %s only for local metadata and never indexes it', APP_ORIGIN => {
    const env = { NODE_ENV: 'development', APP_ORIGIN, ATLAS_SEARCH_INDEXING_ENABLED: 'true' };
    expect(siteConfiguration(env).origin?.origin).toBe(APP_ORIGIN);
    expect(siteConfiguration(env).indexingEnabled).toBe(false);
    expect(publicPageMetadata('/privacy', 'Privacy', 'Data use', env).alternates).toEqual({ canonical: `${APP_ORIGIN}/privacy` });
    expect(publicSitemap(env)).toEqual([]);
  });
  it('never uses Vercel or public issuer hosts as a substitute canonical origin', () => {
    const env = { ...production, APP_ORIGIN: undefined, VERCEL_URL: 'foreign.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'foreign.vercel.app', NEXT_PUBLIC_APP_ORIGIN: 'https://foreign.com', ATLAS_PUBLIC_ORIGIN: 'https://foreign.com' };
    expect(siteConfiguration(env)).toEqual({ origin: null, indexingEnabled: false });
    expect(rootMetadata(env).metadataBase).toBeUndefined();
  });
});

describe('rendered metadata inputs and route defaults', () => {
  it('keeps canonical URLs on public pages rather than inheriting the home URL into private pages', () => {
    const root = rootMetadata(production);
    expect(root.alternates).toBeUndefined();
    expect(root.title).toEqual({ default: 'Chronos Atlas · Codebase maps and source evidence', template: '%s | Chronos Atlas' });
    expect(root.robots).toMatchObject({ index: true, follow: true });
    expect(root.openGraph).toMatchObject({ type: 'website', siteName: 'Chronos Atlas' });
    expect(root.twitter).toMatchObject({ card: 'summary_large_image', images: ['https://atlas.example.com/opengraph-image'] });
    expect(publicPageMetadata('/terms', 'Use and payment terms', 'Source rights', production).alternates).toEqual({ canonical: 'https://atlas.example.com/terms' });
    for (const title of ['Workspace', 'Sign in', 'Create an account']) {
      expect(privatePageMetadata(title)).toEqual({ title, robots: PRIVATE_ROBOTS });
      expect(privatePageMetadata(title).alternates).toBeUndefined();
    }
  });
  it('runs the actual robots and sitemap route functions with the same indexing decision', () => {
    for (const [key, value] of Object.entries(production)) vi.stubEnv(key, value);
    vi.stubEnv('ATLAS_SEARCH_INDEXING_ENABLED', 'true');
    expect(robots()).toEqual(searchRobots(production));
    expect(sitemap()).toEqual(publicSitemap(production));
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect(robots()).toEqual({ rules: { userAgent: '*', disallow: '/' } });
    expect(sitemap()).toEqual([]);
  });
  it('uses real application branding and its local icon without an offline capability claim', () => {
    expect(manifest()).toMatchObject({ name: 'Chronos Atlas', short_name: 'Atlas', lang: 'en', start_url: '/', display: 'minimal-ui', icons: [{ src: '/favicon.ico', type: 'image/x-icon' }] });
    expect(manifest()).not.toHaveProperty('serviceworker');
  });
});
