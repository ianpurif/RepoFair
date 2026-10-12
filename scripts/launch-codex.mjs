import { spawnSync } from 'node:child_process';
import { ROOT, command, requireNode, readJson } from './lib.mjs';
requireNode();
const p = readJson('.codex/agent-policy.json');
const args = [
  '-C', ROOT, '-m', p.lead.model,
  '-c', `model_reasoning_effort=${JSON.stringify(p.lead.effort)}`,
  '-c', 'agents.enabled=true',
  '-c', `agents.max_concurrent_threads_per_session=${p.maxConcurrentSubagents}`,
  '-c', `agents.default_subagent_model=${JSON.stringify(p.lead.model)}`,
  '-c', `agents.default_subagent_reasoning_effort=${JSON.stringify(p.lead.effort)}`,
  'Read and execute START.md.',
];
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({command:'codex',arguments:args,executed:false},null,2));
} else {
  try {
    const spec = command('codex', args);
    console.log('Starting Codex with gpt-6.1-sol max for the lead and every subagent; no fallbacks.');
    console.log('Approve login/project trust/network access in the client when required.');
    const r = spawnSync(spec.bin, spec.args, {cwd:ROOT,stdio:'inherit'});
    if (r.error) throw r.error;
    process.exitCode = r.status ?? 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
