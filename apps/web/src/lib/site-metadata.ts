import type { Metadata, MetadataRoute } from 'next';

export const SITE_NAME = 'Chronos Atlas';
export const SITE_TITLE = 'Chronos Atlas · Codebase maps and source evidence';
export const SITE_DESCRIPTION = 'Explore immutable GitHub codebase maps, inspect original source lines, and retrieve version-specific evidence from independent knowledge providers.';
export const PUBLIC_PATHS = ['/', '/privacy', '/terms'] as const;
type PublicPath = typeof PUBLIC_PATHS[number];
type SiteEnvironment = Readonly<Record<string, string | undefined>>;
const LOCAL_ORIGINS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']);
const TEMPORARY_HOST_SUFFIXES = ['trycloudflare.com', 'vercel.app', 'ngrok.io', 'ngrok-free.app', 'ngrok.app', 'loca.lt', 'localhost.run'];

export const PRIVATE_ROBOTS: Metadata['robots'] = {
  index: false,
  follow: false,
  nocache: true,
  googleBot: { index: false, follow: false, noimageindex: true, nosnippet: true },
};

/** Only the operator's exact origin is authority; request/forwarded hosts are never used. */
export function siteConfiguration(env: SiteEnvironment = process.env): { origin: URL | null; indexingEnabled: boolean } {
  const value = env.APP_ORIGIN;
  if (!value) {
    return { origin: env.NODE_ENV === 'production' ? null : new URL('http://localhost:3000'), indexingEnabled: false };
  }
  if (env.NODE_ENV !== 'production' && LOCAL_ORIGINS.has(value)) return { origin: new URL(value), indexingEnabled: false };
  let origin: URL;
  try { origin = new URL(value); } catch { return { origin: null, indexingEnabled: false }; }
  const host = origin.hostname;
  const permanentHost = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)
    && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)
    && !/(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/.test(host)
    && !TEMPORARY_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  if (origin.protocol !== 'https:' || origin.origin !== value || origin.username || origin.password || origin.port || !permanentHost) {
    return { origin: null, indexingEnabled: false };
  }
  const production = env.NODE_ENV === 'production';
  const approvedDeployment = env.VERCEL_ENV === 'production' || !env.VERCEL_ENV;
  return { origin, indexingEnabled: production && approvedDeployment && env.ATLAS_SEARCH_INDEXING_ENABLED === 'true' };
}

function publicRobots(indexingEnabled: boolean): Metadata['robots'] {
  return indexingEnabled ? { index: true, follow: true, googleBot: { index: true, follow: true } } : PRIVATE_ROBOTS;
}

export function rootMetadata(env: SiteEnvironment = process.env): Metadata {
  const { origin, indexingEnabled } = siteConfiguration(env);
  return {
    ...(origin ? { metadataBase: origin } : {}),
    title: { default: SITE_TITLE, template: `%s | ${SITE_NAME}` },
    description: SITE_DESCRIPTION,
    applicationName: SITE_NAME,
    robots: publicRobots(indexingEnabled),
    openGraph: { type: 'website', locale: 'en_US', siteName: SITE_NAME, title: SITE_TITLE, description: SITE_DESCRIPTION },
    twitter: { card: 'summary_large_image', title: SITE_TITLE, description: SITE_DESCRIPTION, ...(origin ? { images: [new URL('/opengraph-image', origin).href] } : {}) },
  };
}

export function publicPageMetadata(path: PublicPath, title: string, description: string, env: SiteEnvironment = process.env): Metadata {
  const { origin, indexingEnabled } = siteConfiguration(env);
  const canonical = origin ? new URL(path, origin).href : undefined;
  return {
    title: path === '/' ? { absolute: title } : title,
    description,
    ...(canonical ? { alternates: { canonical } } : {}),
    robots: publicRobots(indexingEnabled),
    openGraph: { type: 'website', locale: 'en_US', siteName: SITE_NAME, title: path === '/' ? title : `${title} | ${SITE_NAME}`, description, ...(canonical ? { url: canonical } : {}) },
    twitter: { card: 'summary_large_image', title: path === '/' ? title : `${title} | ${SITE_NAME}`, description, ...(origin ? { images: [new URL('/opengraph-image', origin).href] } : {}) },
  };
}

export function privatePageMetadata(title: string): Metadata {
  return { title, robots: PRIVATE_ROBOTS };
}

export function publicSitemap(env: SiteEnvironment = process.env): MetadataRoute.Sitemap {
  const { origin, indexingEnabled } = siteConfiguration(env);
  return origin && indexingEnabled ? PUBLIC_PATHS.map(path => ({ url: new URL(path, origin).href })) : [];
}

export function searchRobots(env: SiteEnvironment = process.env): MetadataRoute.Robots {
  const { origin, indexingEnabled } = siteConfiguration(env);
  if (!origin || !indexingEnabled) return { rules: { userAgent: '*', disallow: '/' } };
  return {
    rules: {
      userAgent: '*',
      allow: ['/$', '/privacy$', '/terms$', '/_next/', '/favicon.ico', '/opengraph-image', '/manifest.webmanifest'],
      disallow: '/',
    },
    sitemap: new URL('/sitemap.xml', origin).href,
  };
}
