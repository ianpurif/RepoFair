import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
import {ROOT,readJson} from '../scripts/lib.mjs';
const policy=readJson('.codex/agent-policy.json');
const rootConfig=readFileSync(join(ROOT,'.codex/config.toml'),'utf8');
function value(text,key){const match=text.match(new RegExp(`^${key} = "([^"]+)"$`,'m'));return match?.[1];}
test('lead is exactly Sol max',()=>{assert.equal(value(rootConfig,'model'),'gpt-6.1-sol');assert.equal(value(rootConfig,'model_reasoning_effort'),'max');});
test('two concurrent spawned agents, not two total threads',()=>assert.match(rootConfig,/max_concurrent_threads_per_session = 2/));
test('no full-access/never-approval configuration',()=>{assert.match(rootConfig,/approval_policy = "on-request"/);assert.match(rootConfig,/sandbox_mode = "workspace-write"/);assert.doesNotMatch(rootConfig,/danger-full-access/);});
test('six named custom agents pin requested models and efforts',()=>{
 assert.equal(policy.roles.length,6);
 for(const role of policy.roles){const text=readFileSync(join(ROOT,`.codex/agents/${role.name}.toml`),'utf8');assert.equal(value(text,'name'),role.name);assert.equal(value(text,'model'),role.model);assert.equal(value(text,'model_reasoning_effort'),role.effort);assert.equal(value(text,'sandbox_mode'),role.sandbox);assert.match(text,/developer_instructions = """/);}
});
test('every agent is Sol max with no fallback',()=>{for(const r of [policy.lead,...policy.roles]){assert.equal(r.model,'gpt-6.1-sol');assert.equal(r.effort,'max');}assert.equal(policy.fallbackAllowed,false);assert.equal(policy.silentFallback,false);assert.equal(value(rootConfig,'default_subagent_model'),'gpt-6.1-sol');assert.equal(value(rootConfig,'default_subagent_reasoning_effort'),'max');});
test('full supplied build prompt has all sixteen sections and current scope',()=>{
 const text=readFileSync(join(ROOT,'BUILD.md'),'utf8');for(let i=1;i<=16;i++)assert.match(text,new RegExp(`^## ${i}\\.`,'m'));assert.ok(text.split(/\s+/).length>3000);assert.match(text,/independent providers/i);assert.match(text,/Do not turn it into/);
});
test('entry file directs complete execution rather than a scaffold stop',()=>{const text=readFileSync(join(ROOT,'START.md'),'utf8');assert.match(text,/BUILD.md/);assert.match(text,/P0–P6/);assert.match(text,/Do not stop at a plan/);});
test('optional launcher does not execute in dry-run',()=>{const r=spawnSync(process.execPath,['scripts/launch-codex.mjs','--dry-run'],{cwd:ROOT,encoding:'utf8'});assert.equal(r.status,0,r.stderr);const data=JSON.parse(r.stdout);assert.equal(data.executed,false);assert.ok(data.arguments.includes('Read and execute START.md.'));assert.ok(data.arguments.includes('gpt-6.1-sol'));});
test('release gate rejects the unfinished starter',()=>{if(readJson('docs/STATE.json').stage!=='starter')return;const r=spawnSync(process.execPath,['scripts/release-gate.mjs'],{cwd:ROOT,encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/RELEASE BLOCKED/);});
test('all configured local skills have a skill entry',()=>{for(const name of ['atlas-architecture','atlas-source-graph','atlas-tempo-commerce','atlas-workspace-ui','atlas-verification','atlas-official-research'])assert.ok(existsSync(join(ROOT,`.agents/skills/${name}/SKILL.md`)));});
