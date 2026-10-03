import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, requireNode, walk } from './lib.mjs';
requireNode();
const tests = walk(join(ROOT,'tests')).filter(p=>p.endsWith('.test.mjs'));
if (!tests.length) throw new Error('No tests discovered.');
const r=spawnSync(process.execPath,['--experimental-strip-types','--test',...tests],{cwd:ROOT,stdio:'inherit'});
if(r.error) throw r.error;
process.exitCode=r.status ?? 1;
