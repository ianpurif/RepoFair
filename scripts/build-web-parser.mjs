import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, command } from './lib.mjs';

mkdirSync(join(ROOT, 'apps/web/.atlas'), { recursive: true });
const args = ['build', join(ROOT, 'apps/worker/src/repository-parser-child.ts'), '--target=node', '--packages=bundle', '--no-env-file', '--env=disable', '--outfile=' + join(ROOT, 'apps/web/.atlas/repository-parser-child.mjs')];
let executable;
try { executable = command('bun', args); }
catch { executable = command('npm', ['exec', '--yes', '--package=bun@1.4.1', '--', 'bun', ...args]); }
const result = spawnSync(executable.bin, executable.args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
