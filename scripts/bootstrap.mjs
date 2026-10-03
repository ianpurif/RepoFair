import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, command, requireNode, readJson } from './lib.mjs';
requireNode();
const install=process.argv.includes('--install');
const plan=readJson('scripts/setup-plan.json');
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan,null,2)); process.exit(0); }
try {
  // Check Bun up front; never auto-install a global tool or leave half-resolved manifests.
  const bun=command('bun',['--version']);
  const bv=spawnSync(bun.bin,bun.args,{cwd:ROOT,encoding:'utf8',timeout:5000});
  if(bv.status!==0 || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(bv.stdout.trim())) throw new Error('Could not determine Bun version.');
  const updates=new Map(), resolved=[];
  const exact=v=>typeof v==='string' && /^\d+\.\d+\.\d+$/.test(v);
  for(const item of plan.packages){
    if(!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(item.name) || !/^[\d.]+$/.test(item.range)) throw new Error('Unexpected setup package specification.');
    const manifest=updates.get(item.manifest) ?? readJson(item.manifest);
    const section=manifest[item.section] ?? {};
    if(exact(section[item.name])) {resolved.push({name:item.name,version:section[item.name],source:'existing pin'}); continue;}
    const spec=command('npm',['view',`${item.name}@${item.range}`,'version','--json','--registry=https://registry.npmjs.org','--fetch-retries=0','--fetch-timeout=15000']);
    const result=spawnSync(spec.bin,spec.args,{cwd:ROOT,encoding:'utf8',timeout:20000});
    if(result.status!==0) throw new Error(`Registry resolution failed for ${item.name}; no manifests were changed. ${result.stderr?.trim() ?? ''}`);
    const value=JSON.parse(result.stdout); const versions=(Array.isArray(value)?value:[value]).filter(exact);
    versions.sort((a,b)=>{const av=a.split('.').map(Number),bv=b.split('.').map(Number);for(let i=0;i<3;i++){if(av[i]!==bv[i])return av[i]-bv[i];}return 0;});
    const version=versions.at(-1); if(!version)throw new Error(`No exact stable version for ${item.name}.`);
    section[item.name]=version;manifest[item.section]=section;updates.set(item.manifest,manifest);
    resolved.push({name:item.name,version,source:'npm publisher registry'});
  }
  const root=updates.get('package.json') ?? readJson('package.json');
  root.packageManager=`bun@${bv.stdout.trim()}`;updates.set('package.json',root);
  const changed=[...updates].some(([path, value])=>JSON.stringify(readJson(path))!==JSON.stringify(value)) || !existsSync(join(ROOT,'bun.lock'));
  for(const [path,manifest] of updates){const full=join(ROOT,path),temp=full+'.atlas-tmp';writeFileSync(temp,JSON.stringify(manifest,null,2)+'\n');renameSync(temp,full);}
  mkdirSync(join(ROOT,'.atlas'),{recursive:true});
  writeFileSync(join(ROOT,'.atlas/bootstrap-resolution.json'),JSON.stringify({observedAt:new Date().toISOString(),resolved,peerCompatibility:'not established by version resolution',installed:false},null,2)+'\n');
  console.log('Resolved exact tooling pins. This does not establish peer compatibility or a successful build.');
  if(install){
    const spec=command('bun',changed?['install']:['install','--frozen-lockfile']);
    const r=spawnSync(spec.bin,spec.args,{cwd:ROOT,stdio:'inherit'});
    if(r.error)throw r.error;
    if(r.status!==0)throw new Error('Dependency install failed. Preserve errors and do not fabricate bun.lock.');
    writeFileSync(join(ROOT,'.atlas/bootstrap-resolution.json'),JSON.stringify({observedAt:new Date().toISOString(),resolved,peerCompatibility:'not established by installation alone',installed:true},null,2)+'\n');
    console.log('Install completed. Run full typecheck/build; add remaining milestone dependencies after their official API review.');
  } else console.log('Pass --install to perform the project-local Bun install.');
} catch(e){console.error(e.message);process.exitCode=1;}
