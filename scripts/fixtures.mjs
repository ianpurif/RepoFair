import {spawn} from 'node:child_process';
import {ROOT,command} from './lib.mjs';
const operation=process.argv[2];if(process.env.NODE_ENV==='production'||process.argv.length!==3||!['provider-a','provider-b','mcp'].includes(operation))throw new Error('Fixtures are available only through explicit development commands');
const args=operation==='mcp'?['packages/sdk/src/mcp.ts']:['apps/provider/src/fixture-server.ts','--identity',operation==='provider-a'?'fixture-retry':'fixture-events','--publish'];
const spec=command('bun',args);const child=spawn(spec.bin,spec.args,{cwd:ROOT,stdio:'inherit',windowsHide:true,env:{...process.env,ATLAS_MODE:'fixture',ATLAS_FIXTURES_ENABLED:'true'}});
child.once('error',()=>{console.error('Fixture process unavailable');process.exitCode=1;});for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));child.once('exit',code=>{process.exitCode=code??1;});
