import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, command } from './lib.mjs';
try {
  const local=join(ROOT,'node_modules/typescript/bin/tsc');
  const configurations=process.argv.includes('--core-only')?['tsconfig.core.json']:['tsconfig.core.json','apps/web/tsconfig.json'];
  for(const config of configurations){
    const spec=existsSync(local)?{bin:process.execPath,args:[local,'--project',config]}:command('tsc',['--project',config]);
    const r=spawnSync(spec.bin,spec.args,{cwd:ROOT,stdio:'inherit'});
    if(r.error)throw r.error;
    if(r.status!==0)throw new Error(`Typecheck failed for ${config}. Bootstrap dependencies first when missing.`);
  }
}catch(e){console.error(e.message);process.exitCode=1;}
