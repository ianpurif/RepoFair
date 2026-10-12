import { pathToFileURL } from 'node:url';

const exactOrigin = (value) => {
  try {
    const url = new URL(value);
    const host = url.hostname;
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === '/' && !url.port
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)
      && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)
      && !['localhost', 'local', 'internal', 'invalid', 'test', 'example'].some(suffix => host === suffix || host.endsWith(`.${suffix}`))
      && !['trycloudflare.com', 'vercel.app', 'ngrok.io', 'ngrok-free.app', 'ngrok.app', 'loca.lt', 'localhost.run'].some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch { return false; }
};

const secureEndpoint = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && !url.hostname.endsWith('.trycloudflare.com') && url.hostname !== 'localhost';
  } catch { return false; }
};

const oneSource = (environment, first, second) => Boolean(environment[first]?.trim()) !== Boolean(environment[second]?.trim());

export function checkProductionEnvironment(environment) {
  if (environment.VERCEL_ENV !== 'production') return [];
  const issues = [];
  const required = (key) => { if (!environment[key]?.trim()) issues.push(`${key} is required`); };
  const equal = (key, expected) => { if (environment[key] !== expected) issues.push(`${key} must be ${expected}`); };
  required('APP_ORIGIN');
  if (environment.APP_ORIGIN && !exactOrigin(environment.APP_ORIGIN)) issues.push('APP_ORIGIN must be a permanent exact HTTPS origin');
  if (environment.ATLAS_PUBLIC_ORIGIN !== environment.APP_ORIGIN) issues.push('ATLAS_PUBLIC_ORIGIN must exactly match APP_ORIGIN');
  equal('ATLAS_MODE', 'tempo-testnet');
  equal('NEXT_PUBLIC_ATLAS_MODE', 'tempo-testnet');
  equal('ATLAS_FIXTURES_ENABLED', 'false');
  equal('TEMPO_CHAIN_ID', '42431');
  equal('TEMPO_TOKEN_ADDRESS', '0x20c0000000000000000000000000000000000000');
  required('TEMPO_RPC_URL');
  if (environment.TEMPO_RPC_URL && !secureEndpoint(environment.TEMPO_RPC_URL)) issues.push('TEMPO_RPC_URL must be HTTPS');
  required('DATABASE_URL');
  if (environment.DATABASE_URL && !/^postgres(?:ql)?:\/\//.test(environment.DATABASE_URL)) issues.push('DATABASE_URL must be PostgreSQL');
  if (!oneSource(environment, 'DATABASE_SSL_CA', 'DATABASE_SSL_CA_FILE')) issues.push('Choose exactly one database CA source');
  if (environment.DATABASE_SSL_CA_FILE?.trim()) issues.push('Vercel requires inline DATABASE_SSL_CA; local paths are unavailable');
  required('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
  required('CLERK_SECRET_KEY');
  if (environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && !/^pk_live_[A-Za-z0-9+/=]+$/.test(environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)) issues.push('Production requires a Clerk live publishable key');
  if (environment.CLERK_SECRET_KEY && !/^sk_live_[A-Za-z0-9]{10,}$/.test(environment.CLERK_SECRET_KEY)) issues.push('Production requires a Clerk live secret key');
  if (environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_live_')) {
    const encoded = environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.slice('pk_live_'.length);
    const hostname = Buffer.from(encoded, 'base64').toString('utf8');
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}\$$/i.test(hostname)) issues.push('Clerk publishable key contains an invalid frontend domain');
  }
  required('GITHUB_APP_ID');
  if (environment.GITHUB_APP_ID && !/^\d{1,18}$/.test(environment.GITHUB_APP_ID)) issues.push('GITHUB_APP_ID must be numeric');
  if (!oneSource(environment, 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_FILE')) issues.push('Choose exactly one GitHub App key source');
  if (environment.GITHUB_APP_PRIVATE_KEY_FILE?.trim()) issues.push('Vercel requires inline GITHUB_APP_PRIVATE_KEY; local paths are unavailable');
  required('GITHUB_WEBHOOK_SECRET');
  if (environment.GITHUB_WEBHOOK_SECRET && (environment.GITHUB_WEBHOOK_SECRET.length < 16 || environment.GITHUB_WEBHOOK_SECRET.length > 4096)) issues.push('GITHUB_WEBHOOK_SECRET has an invalid length');
  if (!oneSource(environment, 'ATLAS_PUBLICATION_SIGNING_KEY', 'ATLAS_PUBLICATION_SIGNING_KEY_FILE')) issues.push('Choose exactly one publication signing key source');
  if (environment.ATLAS_PUBLICATION_SIGNING_KEY_FILE?.trim()) issues.push('Vercel requires inline ATLAS_PUBLICATION_SIGNING_KEY; local paths are unavailable');
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = checkProductionEnvironment(process.env);
  if (problems.length) { console.error(`Production configuration blocked: ${problems.join('; ')}`); process.exitCode = 1; }
  else console.log(process.env.VERCEL_ENV === 'production' ? 'Production configuration fields passed structural checks. Live integrations remain to be verified.' : 'Skipped production-only configuration checks outside Vercel production.');
}
