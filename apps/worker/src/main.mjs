import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const launcher=fileURLToPath(new URL('../../../scripts/worker.mjs',import.meta.url));
const args=process.argv.slice(2).map(value=>value==='--check'?'--build':value);
const child=spawn(process.execPath,[launcher,...args],{stdio:'inherit',windowsHide:true});
child.once('error',()=>{console.error('Worker launcher unavailable');process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.once('exit',code=>{process.exitCode=code??1;});
