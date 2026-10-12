import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Exact runtime settings; a prefix match could admit future central credentials. */
export const PROVIDER_VARIABLES = Object.freeze([
  'ATLAS_PROVIDER_DATABASE_URL', 'ATLAS_PROVIDER_DATABASE_SSL_CA_FILE',
  'ATLAS_PROVIDER_ID', 'ATLAS_PROVIDER_ORIGIN', 'ATLAS_PROVIDER_AUTHORIZATION_ISSUER',
  'ATLAS_PROVIDER_ISSUER_PUBLIC_KEY_FILE', 'ATLAS_PROVIDER_MPP_SECRET_FILE',
  'ATLAS_PROVIDER_RECIPIENT', 'ATLAS_PROVIDER_PRICE_UNITS', 'ATLAS_PROVIDER_REALM',
  'ATLAS_PROVIDER_PORT', 'TEMPO_RPC_URL', 'TEMPO_CHAIN_ID', 'TEMPO_TOKEN_ADDRESS',
]);
const providerVariables = new Set(PROVIDER_VARIABLES);
const operatingSystemVariables = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
]);
export class ProviderConfigurationError extends Error {
  constructor(message) { super(message); this.name = 'ProviderConfigurationError'; }
}

export function parseProviderArguments(args) {
  let mode = 'runtime', artifact, envFile;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--build' || flag === '--prepare') {
      if (mode !== 'runtime') throw new ProviderConfigurationError('Choose one of --build, --install or --prepare.');
      mode = flag === '--build' ? 'build' : 'prepare';
    } else if (flag === '--install') {
      if (mode !== 'runtime') throw new ProviderConfigurationError('Choose one of --build, --install or --prepare.');
      artifact = args[++index];
      if (!artifact || artifact.startsWith('--')) throw new ProviderConfigurationError('--install requires an owner-approved artifact file.');
      mode = 'install';
    } else if (flag === '--env-file') {
      if (envFile !== undefined) throw new ProviderConfigurationError('Supply --env-file once.');
      const file = args[++index];
      if (!file || !isAbsolute(file)) throw new ProviderConfigurationError('--env-file requires an absolute provider-only environment file path.');
      envFile = resolve(file);
    } else throw new ProviderConfigurationError('Use --build, --prepare, --install ARTIFACT, or an optional --env-file ABSOLUTE_PATH.');
  }
  if (mode === 'build' && envFile !== undefined) throw new ProviderConfigurationError('--build uses no provider credentials; --env-file is for runtime or install.');
  return { mode, ...(artifact !== undefined ? { artifact } : {}), ...(envFile !== undefined ? { envFile } : {}) };
}

/** Drop Node/Bun preloads, proxy/TLS overrides and all unrelated application settings. */
export function providerOperatingEnvironment(inherited = process.env) {
  const env = { NODE_ENV: 'production' };
  for (const variable of operatingSystemVariables) {
    // Windows environment names are case-insensitive. Emit one canonical name.
    const key = Object.keys(inherited).find(name => name.toUpperCase() === variable);
    if (key !== undefined && typeof inherited[key] === 'string') env[variable] = inherited[key];
  }
  return env;
}
/** Preparation has no database, keys, publication identity, RPC or payment settings. */
export function providerPreparationEnvironment(configured) {
  return { ...providerOperatingEnvironment(configured), ...(typeof configured.ATLAS_PROVIDER_PORT === 'string' ? { ATLAS_PROVIDER_PORT: configured.ATLAS_PROVIDER_PORT } : {}) };
}
function selectedProviderSettings(settings) {
  const env = {};
  for (const variable of PROVIDER_VARIABLES) if (typeof settings[variable] === 'string') env[variable] = settings[variable];
  return env;
}
function readEnvironmentFile(file, explicit) {
  let settings;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 65_536) throw new Error('bounded regular environment file required');
    const contents = readFileSync(file, 'utf8');
    if (Buffer.byteLength(contents) > 65_536) throw new Error('environment file grew beyond its bound');
    settings = parseEnv(contents);
  } catch { throw new ProviderConfigurationError('Provider environment file is unavailable, invalid or exceeds 64 KiB.'); }
  if (explicit) {
    const rejected = Object.keys(settings).filter(field => !providerVariables.has(field));
    if (rejected.length) {
      const fields = rejected.slice(0, 12).map(field => /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(field) ? field : 'unrecognized-field');
      throw new ProviderConfigurationError(`Provider environment contains unsupported fields: ${fields.join(', ')}${rejected.length > 12 ? ', additional fields omitted' : ''}.`);
    }
  }
  return selectedProviderSettings(settings);
}

/** Explicit files stand alone; root defaults are read only when no file was chosen. */
export function loadProviderEnvironment({ root, envFile, inherited = process.env }) {
  const operating = providerOperatingEnvironment(inherited);
  if (envFile !== undefined) {
    if (!isAbsolute(envFile)) throw new ProviderConfigurationError('--env-file requires an absolute provider-only environment file path.');
    return { ...operating, ...readEnvironmentFile(envFile, true) };
  }
  const file = join(root, '.env.local');
  const defaults = existsSync(file) ? readEnvironmentFile(file, false) : {};
  return { ...operating, ...defaults, ...selectedProviderSettings(inherited) };
}

/** Bun must not rediscover central .env files or inline runtime credentials. */
export function providerBuildArguments(entry, output) {
  return ['build', entry, '--target=node', '--packages=external', '--no-env-file', '--env=disable', `--outfile=${output}`];
}
/** Separate entry prevents the bundler hoisting normal provider dependencies into readiness. */
export function providerEntry(mode) {
  if (mode === 'prepare') return { source: 'prepare-main.ts', output: 'provider-preparation.mjs' };
  if (mode === 'install') return { source: 'install.ts', output: 'install.mjs' };
  if (mode === 'runtime' || mode === 'build') return { source: 'main.ts', output: 'provider.mjs' };
  throw new ProviderConfigurationError('Unsupported provider entry mode.');
}
