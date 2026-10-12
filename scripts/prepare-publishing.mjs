import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadDatabasePoolConfiguration } from '../apps/worker/src/database.ts';

const requireWorker = createRequire(new URL('../apps/worker/src/database.ts', import.meta.url));
const { Pool } = requireWorker('pg');

// Trusted setup only. No public exposure, source export, allowance approval,
// funding, signing, payment, central migration or global installation occurs.
const root = fileURLToPath(new URL('../', import.meta.url));
const flags = process.argv.slice(2);
if (!flags.every(flag => ['--prepare', '--provision-provider-database'].includes(flag)) || new Set(flags).size !== flags.length || !flags.includes('--prepare')) {
  console.error('Use node --experimental-transform-types scripts/prepare-publishing.mjs --prepare [--provision-provider-database]');
  process.exit(1);
}
const userDirectory = process.env.USERPROFILE || process.env.HOME;
if (!userDirectory) { console.error('A private user directory is required.'); process.exit(1); }
const folder = resolve(userDirectory, '.atlas-secrets');
const stateFile = join(folder, 'provider-database.json');
const envFile = join(root, '.env.local');
const providerFile = join(folder, 'provider.env');
const identifier = value => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('invalid-setup-identifier');
  return `"${value}"`;
};
function privateWrite(file, value) {
  writeFileSync(file, value, { flag: 'wx', mode: 0o600 });
}
function saveState(state) {
  // Replace only our checked state file, retaining the previous valid credential
  // record if the process stops before the atomic rename completes.
  const temporary = join(folder, `.provider-state-${randomUUID()}.tmp`);
  if (resolve(temporary, '..') !== folder || resolve(stateFile, '..') !== folder || !existingFile(stateFile)) throw new Error('unsafe-state-replacement');
  privateWrite(temporary, JSON.stringify(state, null, 2) + '\n');
  renameSync(temporary, stateFile);
}
function existingFile(file) {
  if (!existsSync(file)) return false;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe-setup-file');
  return true;
}
function editEnvironment(file, changes) {
  const text = existingFile(file) ? readFileSync(file, 'utf8') : '';
  if (text) {
    const backups = join(folder, 'backups'); mkdirSync(backups, { recursive: true, mode: 0o700 });
    privateWrite(join(backups, `${file === envFile ? 'atlas' : 'provider'}-${randomUUID()}.env`), text);
  }
  const remaining = new Set(Object.keys(changes));
  const lines = text.split(/\r?\n/).map(line => {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (!key || !(key in changes)) return line;
    remaining.delete(key); return `${key}=${changes[key]}`;
  });
  for (const key of remaining) lines.push(`${key}=${changes[key]}`);
  writeFileSync(file, lines.join('\n').replace(/\n+$/, '') + '\n', { mode: 0o600 });
}
function scramVerifier(password) {
  // Hex passwords are ASCII; no SASLprep normalization ambiguity. Only the
  // verifier reaches CREATE ROLE; the raw password is never part of SQL/logs.
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(client).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}
const migrations = ['202610070005_provider_replay.sql', '202610070006_provider_ledger.sql', '202610110003_provider_delivery.sql'];
let stage = 'local-preparation'; let central; let provider;
const report = { mode: 'tempo-testnet', sourceExports: 0, publicDeployments: 0, fundingRequests: 0, payments: 0, centralMigrationsApplied: 0 };
try {
  if (existsSync(folder) && (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory())) throw new Error('unsafe-private-directory');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const privateKey = join(folder, 'issuer-private.pem'); const publicKey = join(folder, 'issuer-public.pem');
  if (!existingFile(privateKey) && !existingFile(publicKey)) {
    const keys = generateKeyPairSync('ed25519');
    privateWrite(privateKey, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    privateWrite(publicKey, keys.publicKey.export({ type: 'spki', format: 'pem' }));
  }
  if (!existingFile(privateKey) || !existingFile(publicKey)) throw new Error('incomplete-issuer-key-pair');
  const issuer = createPrivateKey(readFileSync(privateKey));
  const suppliedPublic = createPublicKey(readFileSync(publicKey));
  if (issuer.asymmetricKeyType !== 'ed25519' || !createPublicKey(issuer).export({ type: 'spki', format: 'der' }).equals(suppliedPublic.export({ type: 'spki', format: 'der' }))) throw new Error('issuer-key-pair-mismatch');
  const mppSecret = join(folder, 'provider-mpp-secret.txt');
  if (!existingFile(mppSecret)) privateWrite(mppSecret, randomBytes(32).toString('hex'));
  if (!/^[a-f0-9]{64}$/.test(readFileSync(mppSecret, 'utf8').trim())) throw new Error('invalid-mpp-secret-file');
  const addresses = {};
  for (const name of ['buyer', 'recipient']) {
    const file = join(folder, `${name}-key.txt`);
    if (!existingFile(file)) privateWrite(file, generatePrivateKey());
    const key = readFileSync(file, 'utf8').trim();
    if (!/^0x[a-f0-9]{64}$/i.test(key)) throw new Error('invalid-test-wallet-file');
    addresses[name] = privateKeyToAccount(key).address;
  }
  const env = { ...parseEnv(readFileSync(envFile, 'utf8')), ...process.env };
  const updates = {
    ATLAS_MODE: 'tempo-testnet', NEXT_PUBLIC_ATLAS_MODE: 'tempo-testnet', ATLAS_FIXTURES_ENABLED: 'false',
    ATLAS_PUBLICATION_SIGNING_KEY_FILE: privateKey.replaceAll('\\', '/'),
    TEMPO_RPC_URL: 'https://rpc.moderato.tempo.xyz', TEMPO_CHAIN_ID: '42431',
    TEMPO_TOKEN_ADDRESS: '0x20c0000000000000000000000000000000000000',
  };
  editEnvironment(envFile, updates);
  const providerUpdates = {
    ATLAS_PROVIDER_ISSUER_PUBLIC_KEY_FILE: publicKey.replaceAll('\\', '/'),
    ATLAS_PROVIDER_MPP_SECRET_FILE: mppSecret.replaceAll('\\', '/'),
    ATLAS_PROVIDER_RECIPIENT: addresses.recipient, ATLAS_PROVIDER_PRICE_UNITS: '10000',
    ATLAS_PROVIDER_REALM: 'atlas-provider', ATLAS_PROVIDER_PORT: '4311',
    TEMPO_RPC_URL: updates.TEMPO_RPC_URL, TEMPO_CHAIN_ID: updates.TEMPO_CHAIN_ID,
  };
  report.issuerKeysVerified = true; report.testWalletsCreatedOrVerified = 2;
  report.recipientAddress = addresses.recipient; report.buyerAddress = addresses.buyer;
  editEnvironment(providerFile, providerUpdates);
  if (flags.includes('--provision-provider-database')) {
    stage = 'central-verified-tls-preflight';
    const centralConfig = await loadDatabasePoolConfiguration(env);
    central = new Pool({ ...centralConfig, max: 1 });
    const target = (await central.query("SELECT current_database() AS database,current_user AS username,rolcreatedb AS create_database,rolcreaterole AS create_role,current_setting('server_version_num')::integer AS version FROM pg_roles WHERE rolname=current_user")).rows[0];
    if (!target?.create_database || !target.create_role) throw new Error('database-provisioning-permission-missing');
    let state;
    if (existingFile(stateFile)) state = JSON.parse(readFileSync(stateFile, 'utf8'));
    else {
      const role = 'atlas_provider_runtime'; const database = 'atlas_provider_payments';
      const clashes = await central.query('SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS role_exists,EXISTS(SELECT 1 FROM pg_database WHERE datname=$2) AS database_exists', [role, database]);
      if (clashes.rows[0]?.role_exists || clashes.rows[0]?.database_exists) throw new Error('unowned-provider-target-exists');
      const url = new URL(env.DATABASE_URL); const rawUser = decodeURIComponent(url.username);
      const dot = rawUser.lastIndexOf('.'); const suffix = dot >= 0 ? rawUser.slice(dot) : '';
      const password = randomBytes(32).toString('hex');
      url.username = role + suffix; url.password = password; url.pathname = '/' + database;
      state = { schemaVersion: 1, role, database, centralDatabase: target.database, url: url.href, password, preparedAt: new Date().toISOString() };
      privateWrite(stateFile, JSON.stringify(state, null, 2) + '\n');
    }
    if (state.schemaVersion !== 1 || state.database === target.database || state.centralDatabase !== target.database) throw new Error('provider-target-not-separate');
    const centralUrl = new URL(env.DATABASE_URL); const providerUrl = new URL(state.url);
    const centralUsername = decodeURIComponent(centralUrl.username);
    const projectSuffix = centralUsername.includes('.') ? centralUsername.slice(centralUsername.lastIndexOf('.')) : '';
    if (providerUrl.protocol !== centralUrl.protocol || providerUrl.hostname !== centralUrl.hostname || providerUrl.port !== centralUrl.port
      || providerUrl.pathname !== '/' + state.database || decodeURIComponent(providerUrl.username) !== state.role + projectSuffix
      || !/^[a-f0-9]{64}$/.test(state.password) || providerUrl.password !== state.password) throw new Error('provider-target-configuration-differs');
    identifier(state.role); identifier(state.database);
    stage = 'provider-role-provisioning';
    const existingRole = (await central.query('SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=$1', [state.role])).rows[0];
    if (!existingRole) await central.query(`CREATE ROLE ${identifier(state.role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD '${scramVerifier(state.password)}'`);
    else if (!existingRole.rolcanlogin || existingRole.rolsuper || existingRole.rolcreatedb || existingRole.rolcreaterole || existingRole.rolbypassrls) throw new Error('provider-role-privileges-differ');
    stage = 'separate-provider-database-provisioning';
    const existingDatabase = (await central.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [state.database])).rows[0];
    if (!existingDatabase) {
      const membership = (await central.query(`SELECT pg_has_role(current_user,$1,'${target.version >= 160000 ? 'SET' : 'MEMBER'}') AS can_set`, [state.role])).rows[0];
      stage = 'provider-role-admin-membership';
      if (!membership?.can_set) await central.query(`GRANT ${identifier(state.role)} TO ${identifier(target.username)}${target.version >= 160000 ? ' WITH SET TRUE' : ''}`);
      stage = 'provider-database-create';
      await central.query(`CREATE DATABASE ${identifier(state.database)} OWNER ${identifier(state.role)}`);
    } else if (existingDatabase.owner !== state.role) throw new Error('provider-database-owner-differs');
    const ca = join(folder, 'provider-ca.pem');
    if (env.DATABASE_SSL_CA_FILE && !existingFile(ca)) privateWrite(ca, readFileSync(env.DATABASE_SSL_CA_FILE));
    const providerEnv = { DATABASE_URL: state.url, DATABASE_SSL_CA_FILE: existingFile(ca) ? ca : undefined };
    stage = 'provider-target-and-role-verification';
    provider = new Pool({ ...await loadDatabasePoolConfiguration(providerEnv), max: 1 });
    const actual = (await provider.query("SELECT current_database() AS database,current_user AS username,pg_has_role(current_user,'service_role','MEMBER') AS central_service_membership,pg_has_role(current_user,'authenticated','MEMBER') AS browser_role_membership")).rows[0];
    if (actual?.database !== state.database || actual.username !== state.role || actual.central_service_membership || actual.browser_role_membership) throw new Error('provider-target-or-authority-mismatch');
    stage = 'provider-only-migrations';
    const client = await provider.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
      await client.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations');
      await client.query('CREATE TABLE IF NOT EXISTS supabase_migrations.atlas_provider_setup(version text PRIMARY KEY,digest text NOT NULL CHECK(length(digest)=64),applied_at timestamptz NOT NULL DEFAULT now())');
      for (const name of migrations) {
        const sql = readFileSync(join(root, 'supabase/migrations', name), 'utf8');
        const digest = createHash('sha256').update(sql).digest('hex');
        const installed = (await client.query('SELECT digest FROM supabase_migrations.atlas_provider_setup WHERE version=$1', [name])).rows[0];
        if (installed && installed.digest !== digest) throw new Error('provider-migration-digest-differs');
        if (!installed) {
          await client.query(sql);
          await client.query('INSERT INTO supabase_migrations.atlas_provider_setup(version,digest) VALUES($1,$2)', [name, digest]);
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    state.verifiedAt = new Date().toISOString(); state.migrations = migrations; saveState(state);
    providerUpdates.ATLAS_PROVIDER_DATABASE_URL = state.url;
    providerUpdates.ATLAS_PROVIDER_DATABASE_SSL_CA_FILE = existingFile(ca) ? ca.replaceAll('\\', '/') : '';
    report.providerDatabaseSeparate = true; report.providerRoleLimited = true; report.providerMigrationsVerified = migrations;
  }
  editEnvironment(providerFile, providerUpdates);
  report.status = 'prepared'; report.providerEnvironmentFile = providerFile;
  report.activation = 'inactive-awaiting-owner-approved-export-and-verified-endpoint-control';
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(JSON.stringify({ status: 'blocked', stage,
    code: /^[a-z][a-z0-9-]+$/.test(error?.message ?? '') ? error.message : 'setup-operation-failed',
    ...(typeof error?.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? { sqlState: error.code } : {}), ...report }));
  process.exitCode = 1;
} finally { await provider?.end(); await central?.end(); }
