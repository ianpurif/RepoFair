import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
export default {
  agentRules: false,
  devIndicators: false,
  outputFileTracingRoot: root,
  outputFileTracingIncludes: { '/api/repositories/*/jobs': ['./.atlas/repository-parser-child.mjs'] },
  transpilePackages: ['@atlas/core', '@atlas/contracts', '@atlas/worker'],
  serverExternalPackages: ['ts-morph'],
  turbopack: { root },
  async headers() {
    const common = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ...(process.env.VERCEL_ENV === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }] : []),
    ];
    return [
      { source: '/:path*', headers: common },
      { source: '/app/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' }, { key: 'Cache-Control', value: 'private, no-store' }] },
      { source: '/api/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' }, { key: 'Cache-Control', value: 'private, no-store' }] },
      { source: '/sign-in/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
      { source: '/sign-up/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
    ];
  },
};
