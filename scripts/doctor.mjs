import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, command, requireNode, readJson } from './lib.mjs';
let failed = false;
try { requireNode(); console.log(`OK Node ${process.versions.node}`); }
catch (e) { console.log(`BLOCKED ${e.message}`); failed = true; }
for (const name of ['git','bun','codex']) {
  try {
    const spec = command(name,['--version']);
    const r = spawnSync(spec.bin,spec.args,{cwd:ROOT,encoding:'utf8',timeout:5000});
    console.log(r.status === 0 ? `FOUND ${name}: ${r.stdout.trim().split('\n')[0]}` : `UNVERIFIED ${name} version check failed`);
  } catch { console.log(`MISSING ${name}: ${name === 'codex' ? 'CLI optional when using the Codex app/IDE.' : 'Required for the corresponding build step.'}`); }
}
const policy = readJson('.codex/agent-policy.json');
console.log(`REQUESTED lead=${policy.lead.model}/${policy.lead.effort}; max subagents=${policy.maxConcurrentSubagents}`);
console.log('NOT CHECKED: signed-in model access, active client overrides, project trust, real delegation.');
console.log(existsSync(join(ROOT,'bun.lock')) ? 'FOUND bun.lock (contents not validated here).' : 'MISSING bun.lock: P0 must generate it through a real Bun install.');
console.log(existsSync(join(ROOT,'node_modules')) ? 'FOUND node_modules (not proof of successful build).' : 'MISSING node_modules: source scaffold is not installed.');
console.log('Integration functionality requires separate live verification; this prerequisite check does not inspect secret values or prove service access.');
process.exitCode = failed ? 1 : 0;
