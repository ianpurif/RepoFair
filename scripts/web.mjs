import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { ROOT } from './lib.mjs';
const localEnvPath=join(ROOT,'.env.local');
const runtimeEnv={...(existsSync(localEnvPath)?parseEnv(readFileSync(localEnvPath,'utf8')):{}),...process.env};
const action=process.argv[2];
if(!['dev','build','start'].includes(action))throw new Error('Use dev, build, or start.');
const next=[join(ROOT,'apps/web/node_modules/next/dist/bin/next'),join(ROOT,'node_modules/next/dist/bin/next')].find(existsSync);
if(!next){console.error('Next.js dependencies are not installed. Complete START.md P0 / bootstrap first.');process.exit(1);}
if(action!=='build'){
  await new Promise((resolve,reject)=>{
    const probe=createServer();
    probe.once('error',()=>reject(new Error('Port 3000 is unavailable. Do not silently start another server; inspect the existing process.')));
    probe.listen(3000,'127.0.0.1',()=>probe.close(resolve));
  }).catch(e=>{console.error(e.message);process.exit(1);});
}
const args=[next,action,...(action==='build'?[]:['--hostname','localhost','--port','3000'])];
const child=spawn(process.execPath,args,{cwd:join(ROOT,'apps/web'),stdio:'inherit',env:{...runtimeEnv,ATLAS_LOOPBACK_SERVER:action==='build'?'false':'true'}});
child.once('error',e=>{console.error(e.message);process.exitCode=1;});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>child.kill(sig));
child.once('exit',(code)=>{process.exitCode=code ?? 1;});
