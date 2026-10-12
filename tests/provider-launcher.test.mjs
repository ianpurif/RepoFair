import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { command } from '../scripts/lib.mjs';
import { loadProviderEnvironment, parseProviderArguments, providerBuildArguments, providerEntry, providerOperatingEnvironment, providerPreparationEnvironment, PROVIDER_VARIABLES } from '../scripts/provider-configuration.mjs';

// Genuine Node children and installed Bun execute against synthetic env files.
// No real application env, database, key, endpoint, signing or spending is used.
const privateMarker = 'SYNTHETIC_CENTRAL_PRIVATE_SENTINEL';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const centralVariables = [
  'DATABASE_URL', 'DATABASE_SSL_CA_FILE', 'CLERK_SECRET_KEY', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_WEBHOOK_SECRET',
  'VOYAGE_API_KEY', 'DEEPSEEK_API_KEY', 'LANGSMITH_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'ATLAS_PUBLICATION_SIGNING_KEY_FILE', 'ATLAS_SESSION_TOKEN_FILE', 'ATLAS_API_ORIGIN',
  'PRIVATE_KEY', 'WALLET_PRIVATE_KEY', 'BUYER_PRIVATE_KEY', 'TEMPO_PRIVATE_KEY',
  'ATLAS_PROVIDER_ISSUER_PRIVATE_KEY_FILE',
];
const injectionVariables = [
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'BUN_OPTIONS', 'BUN_PRELOAD', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'PGSSLMODE',
];
function withDirectory(run) {
  const root = mkdtempSync(join(tmpdir(), 'atlas-provider-launcher-'));
  const files = [];
  const write = (name, contents) => { const file = join(root, name); writeFileSync(file, contents, { flag: 'wx' }); files.push(file); return file; };
  try { return run({ root, write, files }); }
  finally { for (const file of files) unlinkSync(file); rmdirSync(root); }
}
function contaminatedEnvironment() {
  const inherited = { ...providerOperatingEnvironment(), ATLAS_PROVIDER_ID: 'synthetic-inherited-provider', ATLAS_PROVIDER_DATABASE_URL: 'synthetic-inherited-provider-db', TEMPO_CHAIN_ID: '1' };
  for (const variable of [...centralVariables, ...injectionVariables]) inherited[variable] = privateMarker;
  // If forwarded, this valid Node preload option makes the real child fail.
  inherited.NODE_OPTIONS = '--require=DO_NOT_EXECUTE_SYNTHETIC_MISSING_PRELOAD';
  inherited.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return inherited;
}
function inspectChild(env, cwd) {
  const code = `const forbidden=${JSON.stringify([...centralVariables, ...injectionVariables])};
const provider=${JSON.stringify(PROVIDER_VARIABLES)};
console.log(JSON.stringify({provider:Object.fromEntries(provider.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])),
forbiddenPresent:forbidden.filter(key=>process.env[key]!==undefined),privateMarkerPresent:Object.values(process.env).some(value=>value.includes(${JSON.stringify(privateMarker)})),nodeEnv:process.env.NODE_ENV}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(child.status, 0, 'Real child must start without inherited preload or proxy/TLS overrides.');
  assert.equal(child.stderr, '');
  return JSON.parse(child.stdout);
}

test('runtime/install/build argument forms remain supported without shell interpolation', () => {
  const file = resolve(tmpdir(), 'synthetic-provider.env');
  assert.deepEqual(parseProviderArguments([]), { mode: 'runtime' });
  assert.deepEqual(parseProviderArguments(['--build']), { mode: 'build' });
  assert.deepEqual(parseProviderArguments(['--prepare']), { mode: 'prepare' });
  assert.deepEqual(parseProviderArguments(['--prepare', '--env-file', file]), { mode: 'prepare', envFile: file });
  assert.deepEqual(parseProviderArguments(['--install', 'reviewed source.json']), { mode: 'install', artifact: 'reviewed source.json' });
  assert.deepEqual(parseProviderArguments(['--env-file', file]), { mode: 'runtime', envFile: file });
  assert.deepEqual(parseProviderArguments(['--install', 'reviewed source.json', '--env-file', file]), { mode: 'install', artifact: 'reviewed source.json', envFile: file });
  assert.deepEqual(parseProviderArguments(['--env-file', file, '--install', 'reviewed source.json']), { mode: 'install', artifact: 'reviewed source.json', envFile: file });
  assert.deepEqual(providerEntry('prepare'), { source: 'prepare-main.ts', output: 'provider-preparation.mjs' });
  assert.deepEqual(providerEntry('runtime'), { source: 'main.ts', output: 'provider.mjs' });
  assert.deepEqual(providerEntry('install'), { source: 'install.ts', output: 'install.mjs' });
});
test('invalid modes/files fail with safe instructions rather than echoing supplied values', () => {
  for (const args of [['--build', '--install', privateMarker], ['--prepare', '--build'], ['--build', '--prepare'], ['--prepare', '--install', privateMarker], ['--install', privateMarker, '--prepare'], ['--prepare', '--prepare'], ['--install'], ['--env-file', privateMarker], ['--env-file'], ['--build', '--build'], ['--build', '--env-file', resolve(tmpdir(), 'synthetic-provider.env')], ['--unknown', privateMarker]]) {
    assert.throws(() => parseProviderArguments(args), error => !error.message.includes(privateMarker));
  }
});
test('preparation child receives only its listener port and OS settings, no publication/payment/database settings', () => withDirectory(({ root }) => {
  const configured = { ...contaminatedEnvironment(), ATLAS_PROVIDER_PORT: '4311', ATLAS_PROVIDER_MPP_SECRET_FILE: privateMarker, ATLAS_PROVIDER_ISSUER_PUBLIC_KEY_FILE: privateMarker, ATLAS_PROVIDER_RECIPIENT: privateMarker, TEMPO_RPC_URL: privateMarker };
  const child = inspectChild(providerPreparationEnvironment(configured), root);
  assert.deepEqual(child.provider, { ATLAS_PROVIDER_PORT: '4311' });
  assert.deepEqual(child.forbiddenPresent, []); assert.equal(child.privateMarkerPresent, false);
}));
test('explicit provider file has precedence and does not read central root defaults or inherited provider settings', () => withDirectory(({ root, write }) => {
  // Reading this root file would fail its bound. The explicit path must bypass it.
  write('.env.local', 'x'.repeat(65_537));
  const envFile = write('provider.env', 'ATLAS_PROVIDER_ID=synthetic-file-provider\nATLAS_PROVIDER_DATABASE_URL=synthetic-file-provider-db\nTEMPO_CHAIN_ID=42431\n');
  const env = loadProviderEnvironment({ root, envFile, inherited: contaminatedEnvironment() });
  const child = inspectChild(env, root);
  assert.deepEqual(child.provider, { ATLAS_PROVIDER_ID: 'synthetic-file-provider', ATLAS_PROVIDER_DATABASE_URL: 'synthetic-file-provider-db', TEMPO_CHAIN_ID: '42431' });
  assert.deepEqual(child.forbiddenPresent, []); assert.equal(child.privateMarkerPresent, false); assert.equal(child.nodeEnv, 'production');
}));
test('default settings retain only exact provider/TEMPO keys and legitimate provider overrides in a real child', () => withDirectory(({ root, write }) => {
  write('.env.local', `ATLAS_PROVIDER_ID=synthetic-default-provider\nATLAS_PROVIDER_PORT=4311\nTEMPO_CHAIN_ID=42431\nDATABASE_URL=${privateMarker}\nCLERK_SECRET_KEY=${privateMarker}\nVOYAGE_API_KEY=${privateMarker}\nNODE_OPTIONS=${privateMarker}\n`);
  const env = loadProviderEnvironment({ root, inherited: contaminatedEnvironment() });
  const child = inspectChild(env, root);
  assert.deepEqual(child.provider, { ATLAS_PROVIDER_ID: 'synthetic-inherited-provider', ATLAS_PROVIDER_DATABASE_URL: 'synthetic-inherited-provider-db', ATLAS_PROVIDER_PORT: '4311', TEMPO_CHAIN_ID: '1' });
  assert.deepEqual(child.forbiddenPresent, []); assert.equal(child.privateMarkerPresent, false);
  // The provider runtime, rather than the launcher, rejects non-Moderato terms.
}));
test('each central credential and unsafe runtime field is rejected in an explicit file, including blank settings', () => withDirectory(({ root, write }) => {
  for (const [index, field] of [...centralVariables, ...injectionVariables].entries()) {
    const envFile = write(`rejected-${index}.env`, `ATLAS_PROVIDER_ID=synthetic-provider\n${field}=${index % 2 ? '' : privateMarker}\n`);
    assert.throws(() => loadProviderEnvironment({ root, envFile, inherited: {} }), error => error.message.includes(field) && !error.message.includes(privateMarker));
  }
}));
test('explicit files do not admit arbitrary provider/TEMPO prefix extensions', () => withDirectory(({ root, write }) => {
  const envFile = write('unknown-provider.env', `ATLAS_PROVIDER_SESSION_TOKEN=${privateMarker}\nTEMPO_BUYER_PRIVATE_KEY=${privateMarker}\n`);
  assert.throws(() => loadProviderEnvironment({ root, envFile, inherited: {} }), error => error.message.includes('ATLAS_PROVIDER_SESSION_TOKEN') && error.message.includes('TEMPO_BUYER_PRIVATE_KEY') && !error.message.includes(privateMarker));
}));
test('invalid or oversized file errors do not disclose file content or caller paths', () => withDirectory(({ root, write }) => {
  const envFile = write('large-provider.env', privateMarker.repeat(3000));
  for (const file of [envFile, join(root, privateMarker + '.env')]) {
    assert.throws(() => loadProviderEnvironment({ root, envFile: file, inherited: {} }), error => !error.message.includes(privateMarker) && !error.message.includes(root));
  }
}));
test('OS-only build environment excludes provider credentials and normalizes Windows environment-name casing', () => withDirectory(({ root }) => {
  const inherited = { ...contaminatedEnvironment(), Path: 'synthetic-case-path', SystemRoot: 'synthetic-system-root', NODE_ENV: privateMarker };
  delete inherited.PATH;
  delete inherited.SYSTEMROOT;
  const env = providerOperatingEnvironment(inherited);
  assert.equal(env.PATH, 'synthetic-case-path'); assert.equal(env.SYSTEMROOT, 'synthetic-system-root'); assert.equal(env.NODE_ENV, 'production');
  assert.equal(Object.keys(env).some(key => key.startsWith('ATLAS_') || key.startsWith('TEMPO_')), false);
  // Use genuine OS paths for the native child, preserving the same filtering.
  const child = inspectChild(providerOperatingEnvironment(contaminatedEnvironment()), root);
  assert.deepEqual(child.provider, {}); assert.deepEqual(child.forbiddenPresent, []); assert.equal(child.privateMarkerPresent, false);
}));
test('actual launcher rejects unsafe explicit files before bundling and prints field names only', () => withDirectory(({ root, write }) => {
  const envFile = write('rejected-launcher.env', `DATABASE_URL=${privateMarker}\nCLERK_SECRET_KEY=${privateMarker}\nATLAS_PROVIDER_ID=synthetic-provider\n`);
  const child = spawnSync(process.execPath, ['scripts/provider.mjs', '--env-file', envFile], { cwd: repository, env: providerOperatingEnvironment(), encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(child.status, 1); assert.match(child.stderr, /unsupported fields:/); assert.match(child.stderr, /DATABASE_URL/); assert.match(child.stderr, /CLERK_SECRET_KEY/);
  assert.equal(child.stdout, ''); assert.equal(child.stderr.includes(privateMarker), false); assert.equal(child.stderr.includes(root), false);
}));
test('installed Bun accepts isolated build flags and generated bundle/native child omit synthetic central secrets', () => withDirectory(({ root, write, files }) => {
  write('.env.local', `CLERK_SECRET_KEY=${privateMarker}\nDATABASE_URL=${privateMarker}\n`);
  const entry = write('synthetic-build.mjs', 'console.log(JSON.stringify({centralPresent:process.env.CLERK_SECRET_KEY!==undefined,nodeOptionsPresent:process.env.NODE_OPTIONS!==undefined}));\n');
  const output = join(root, 'synthetic-bundle.mjs');
  const args = providerBuildArguments(entry, output);
  assert.ok(args.includes('--no-env-file')); assert.ok(args.includes('--env=disable'));
  const spec = command('bun', args);
  const built = spawnSync(spec.bin, spec.args, { cwd: root, env: providerOperatingEnvironment(contaminatedEnvironment()), encoding: 'utf8', timeout: 20_000, windowsHide: true });
  assert.equal(built.status, 0, 'Installed Bun must support the exact no-env-file/disabled-inlining flags.'); files.push(output);
  assert.equal(readFileSync(output, 'utf8').includes(privateMarker), false);
  const child = spawnSync(process.execPath, [output], { cwd: root, env: providerOperatingEnvironment(contaminatedEnvironment()), encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(child.status, 0); assert.deepEqual(JSON.parse(child.stdout), { centralPresent: false, nodeOptionsPresent: false });
}));

test('real preparation entry builds and starts in native Node with no external packages, then denies all paid/control routes', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'atlas-provider-native-preparation-'));
  const envFile = join(root, '.env.local');
  const output = join(root, providerEntry('prepare').output);
  let child;
  let built = false;
  try {
    writeFileSync(envFile, `CLERK_SECRET_KEY=${privateMarker}\nDATABASE_URL=${privateMarker}\n`, { flag: 'wx' });
    const entry = join(repository, 'apps/provider/src', providerEntry('prepare').source);
    const spec = command('bun', providerBuildArguments(entry, output));
    const result = spawnSync(spec.bin, spec.args, { cwd: root, env: providerOperatingEnvironment(contaminatedEnvironment()), encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    assert.equal(result.status, 0, 'Dedicated preparation entry must build successfully.'); built = true;
    const source = readFileSync(output, 'utf8');
    const imports = [...source.matchAll(/\b(?:from|import)\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
    assert.ok(imports.length > 0); assert.ok(imports.every(name => name.startsWith('node:')), 'Readiness bundle must import only Node builtins.');
    for (const forbidden of ['createIndependentProvider', 'ATLAS_PROVIDER_DATABASE_URL', 'ATLAS_PROVIDER_MPP_SECRET_FILE', 'mppx', 'viem', privateMarker]) assert.equal(source.includes(forbidden), false);
    // Native bundle lives outside the checkout, with no node_modules directory.
    // A hoisted pg/payment dependency therefore fails startup instead of being masked.
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const address = reservation.address(); assert.ok(address && typeof address !== 'string');
    const port = address.port; await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const env = providerPreparationEnvironment({ ...contaminatedEnvironment(), ATLAS_PROVIDER_PORT: String(port) });
    child = spawn(process.execPath, [output], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stderr.on('data', part => { stderr += String(part); });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native preparation bundle did not listen within its deadline.')), 10_000);
      child.stdout.on('data', part => {
        stdout += String(part);
        if (stdout.length > 8192) { clearTimeout(timer); reject(new Error('Preparation startup exceeded output bounds.')); }
        else if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error('Preparation startup did not report bounded readiness.')); } }
      });
      child.once('error', () => { clearTimeout(timer); reject(new Error('Native preparation child could not start.')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Native preparation bundle exited before listening.')); });
    });
    assert.deepEqual(ready, { service: 'atlas-provider', port, mode: 'tempo-testnet', status: 'awaiting-owner-approval', ready: false, payments: 'inactive' });
    for (const path of ['/health', '/context/retrieve', '/context/resume', '/.well-known/atlas-provider.json', '/control', '/unexpected']) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: path === '/health' ? 'GET' : 'POST', signal: controller.signal,
          headers: { Authorization: `Bearer ${privateMarker}`, 'Payment-Authorization': privateMarker }, ...(path === '/health' ? {} : { body: privateMarker }) });
        assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('www-authenticate'), null); assert.equal(response.headers.get('payment-receipt'), null);
        assert.deepEqual(await response.json(), { mode: 'tempo-testnet', ready: false, publication: 'awaiting-owner-approval', payments: 'inactive' });
      } finally { clearTimeout(timer); }
    }
    assert.equal(stdout.includes(privateMarker), false); assert.equal(stderr, '');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    if (built) unlinkSync(output);
    unlinkSync(envFile); rmdirSync(root);
  }
});
