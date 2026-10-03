import { spawnSync } from 'node:child_process';
import { ROOT, requireNode } from './lib.mjs';
requireNode();
for (const script of ['scripts/check-hygiene.mjs','scripts/run-tests.mjs']) {
  const r=spawnSync(process.execPath,[script],{cwd:ROOT,stdio:'inherit'});
  if (r.error) throw r.error;
  if(r.status !== 0) {process.exit(r.status ?? 1);}
}
console.log('\nPASS starter verification. Not a product, browser, database, payment or authenticated-agent verification.');
