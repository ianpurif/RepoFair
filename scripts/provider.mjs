import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { ROOT, command } from './lib.mjs';
import { loadProviderEnvironment, parseProviderArguments, providerBuildArguments, providerEntry, providerOperatingEnvironment, providerPreparationEnvironment, ProviderConfigurationError } from './provider-configuration.mjs';

try {
  if (process.versions.bun) throw new ProviderConfigurationError('Run the independent provider launcher with Node.js.');
  const options = parseProviderArguments(process.argv.slice(2));
  // Validate explicit settings before bundling. --build reads no application env file.
  const configuredEnvironment = options.mode === 'build' ? undefined : loadProviderEnvironment({ root: ROOT, envFile: options.envFile });
  const runtimeEnvironment = options.mode === 'prepare' ? providerPreparationEnvironment(configuredEnvironment) : configuredEnvironment;
  const entry = providerEntry(options.mode);
  const output = join(ROOT, 'apps/provider/.atlas', entry.output);
  mkdirSync(join(ROOT, 'apps/provider/.atlas'), { recursive: true });
  const build = command('bun', providerBuildArguments(join(ROOT, 'apps/provider/src', entry.source), output));
  const result = spawnSync(build.bin, build.args, { cwd: ROOT, env: providerOperatingEnvironment(), stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) {
    if (result.error) console.error('Independent provider bundle could not start.');
    process.exitCode = result.status ?? 1;
  } else if (options.mode !== 'build') {
    const child = spawn(process.execPath, [output, ...(options.mode === 'install' ? [options.artifact] : [])], { cwd: ROOT, env: runtimeEnvironment, stdio: 'inherit', windowsHide: true });
    child.once('error', () => { console.error('Independent provider could not start.'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
    child.once('exit', code => { process.exitCode = code ?? 1; });
  }
} catch (error) {
  console.error(error instanceof ProviderConfigurationError ? error.message : 'Independent provider launcher unavailable; check its configuration and installed build tools.');
  process.exitCode = 1;
}
