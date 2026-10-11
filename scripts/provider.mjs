import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {join} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {ROOT,command} from './lib.mjs';
const args=process.argv.slice(2);const install=args[0]==='--install';
if(!((install&&args.length===2)||args.length===0||args.length===1&&args[0]==='--build'))throw new Error('Use --build or --install <owner-approved artifact.json>');
const output=join(ROOT,'apps/provider/.atlas',install?'install.mjs':'provider.mjs');mkdirSync(join(ROOT,'apps/provider/.atlas'),{recursive:true});
const build=command('bun',['build',join(ROOT,'apps/provider/src',install?'install.ts':'main.ts'),'--target=node','--packages=external','--outfile='+output]);
const result=spawnSync(build.bin,build.args,{cwd:ROOT,stdio:'inherit',windowsHide:true});if(result.status!==0)process.exit(result.status??1);
if(!args.includes('--build')) {
  const file=join(ROOT,'.env.local');const env={...(existsSync(file)?parseEnv(readFileSync(file,'utf8')):{}),...process.env};
  const child=spawn(process.execPath,[output,...(install?[args[1]]:[])],{cwd:ROOT,env,stdio:'inherit',windowsHide:true});
  child.on('error',()=>{console.error('Independent provider could not start');process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));child.once('exit',code=>{process.exitCode=code??1;});
}
