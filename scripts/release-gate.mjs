import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { ROOT, readJson } from './lib.mjs';
const state=readJson('docs/STATE.json'), evidence=readJson('docs/release-evidence.json');
const issues=[];
if(state.stage==='starter')issues.push('Product stage is still starter.');
for(const milestone of state.milestones){
 if(milestone.status!=='complete'||!milestone.acceptanceEvidence.length)issues.push(`${milestone.id}: acceptance evidence missing.`);
}
for(const item of evidence.checks){
 if(item.status!=='passed'||!item.command||!item.recordedAt||!item.evidencePaths.length)issues.push(`${item.id}: not verified.`);
 for(const path of item.evidencePaths){
  if(isAbsolute(path)||normalize(path).startsWith('..')||!existsSync(join(ROOT,path)))issues.push(`${item.id}: missing/unsafe evidence file.`);
  else if(readFileSync(join(ROOT,path)).length===0)issues.push(`${item.id}: empty evidence.`);
 }
}
if(!existsSync(join(ROOT,'bun.lock')))issues.push('Real bun.lock not present.');
if(issues.length){console.error('RELEASE BLOCKED\n'+issues.map(s=>'- '+s).join('\n'));process.exitCode=1;}
else console.log('Release evidence is structurally complete. Independently inspect the referenced results; this is not proof they are true.');
