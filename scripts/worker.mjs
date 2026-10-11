import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { ROOT, command } from './lib.mjs';
const args = process.argv.slice(2);
if (process.versions.bun) throw new Error('Run the trusted worker launcher with Node.js');
if (!args.every(arg => ['--once','--build'].includes(arg))) throw new Error('Use --once or --build');
const outputs={ 'repository-parser-child':join(ROOT,'packages/core/.atlas/repository-parser-child.mjs'), 'worker-main':join(ROOT,'apps/worker/.atlas/worker-main.mjs') };
for(const directory of ['packages/core/.atlas','apps/worker/.atlas'])mkdirSync(join(ROOT,directory),{recursive:true});
for (const entry of ['repository-parser-child','worker-main']) {
  const spec = command('bun', ['build', join(ROOT,'apps/worker/src',entry+'.ts'), '--target=node', '--packages=external', '--outfile='+outputs[entry]]);
  const result = spawnSync(spec.bin, spec.args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!args.includes('--build')) {
  // --once advances one durable checkpoint. The normal worker continues until
  // stopped, polling only while no due jobs exist; retries live in PostgreSQL.
  const envFile=join(ROOT,'.env.local');
  const env={...(existsSync(envFile)?parseEnv(readFileSync(envFile,'utf8')):{}),...process.env,ATLAS_PARSER_SCRIPT:outputs['repository-parser-child']};
  const child=spawn(process.execPath,[outputs['worker-main'],...(args.includes('--once')?['--once']:[])],{cwd:ROOT,env,stdio:'inherit',windowsHide:true});
  child.once('error',()=>{console.error('Worker could not start');process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
  child.once('exit',code=>{process.exitCode=code??1;});
}
