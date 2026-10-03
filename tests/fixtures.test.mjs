import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {ROOT,readJson} from '../scripts/lib.mjs';
const catalog=readJson('fixtures/catalog.json');
test('five real source snapshots represent one application and two provider repos',()=>{assert.equal(catalog.snapshots.length,5);assert.equal(new Set(catalog.snapshots.map(x=>x.repositoryId)).size,3);});
for(const s of catalog.snapshots)test(`fixture digest is actual content: ${s.snapshotId}`,()=>{
 const h=createHash('sha256');for(const p of [...s.files].sort()){const data=readFileSync(join(ROOT,s.root,p));h.update(p);h.update('\0');h.update(data);h.update('\0');}assert.equal(s.revision,'sha256:'+h.digest('hex'));assert.equal(s.kind,'fixture');
});
test('two provider configs really have different endpoints and identities',()=>{const {providers}=readJson('fixtures/providers.example.json');assert.notEqual(providers[0].endpoint,providers[1].endpoint);assert.notEqual(providers[0].providerId,providers[1].providerId);assert.equal(providers[0].recipient,null);assert.equal(providers[1].recipient,null);});
test('the application really imports both provider packages',()=>{const src=readFileSync(join(ROOT,'fixtures/repos/jobboard-app/src/run-job.ts'),'utf8');assert.match(src,/@atlas-fixture\/retry-kit/);assert.match(src,/@atlas-fixture\/event-log/);});
test('version change exists in source, not only a canned answer',()=>{const a=readFileSync(join(ROOT,'fixtures/repos/retry-kit/v1/src/index.ts'),'utf8');const b=readFileSync(join(ROOT,'fixtures/repos/retry-kit/v2/src/index.ts'),'utf8');assert.doesNotMatch(a,/if \(error.permanent/);assert.match(b,/if \(error.permanent === true\) return false/);});
test('fixture lockfile resolves local dependencies and contains no install scripts',()=>{const lock=readJson('fixtures/repos/jobboard-app/package-lock.json');assert.equal(lock.lockfileVersion,3);assert.equal(lock.packages['../retry-kit/v1'].version,'1.0.0');assert.equal(lock.packages['../event-log/v1'].version,'1.0.0');assert.equal(readJson('fixtures/repos/jobboard-app/package.json').scripts,undefined);});
test('reviewed fixture target files really exist',()=>{for(const q of readJson('fixtures/questions.json').cases)for(const path of q.expectedSources)assert.ok(existsSync(join(ROOT,'fixtures/repos',path)),path);});
