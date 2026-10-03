import test from 'node:test';import assert from 'node:assert/strict';
import {nodeId,validateGraph,neighborhood} from '../../packages/core/src/graph.ts';
import {resolveRelease,isExactVersion} from '../../packages/core/src/versions.ts';
const make=(r,s,l)=>({id:nodeId(r,s,l),repositoryId:r,snapshotId:s,localId:l,kind:'symbol',label:l});
const a=make('a','v1','run'),b=make('b','v1','run'),c=make('b','v2','run');
const edges=[{id:'ab',from:a.id,to:b.id,relation:'package-binding',provenance:'provider-reported',evidenceId:'e1'},{id:'bc',from:b.id,to:c.id,relation:'references',provenance:'parsed-source',evidenceId:'e2'}];
test('symbol IDs differ across repositories',()=>assert.notEqual(a.id,b.id));
test('symbol IDs differ across snapshots',()=>assert.notEqual(b.id,c.id));
test('tuple ID cannot collide through separator injection',()=>assert.notEqual(nodeId('a:b','c','d'),nodeId('a','b:c','d')));
test('duplicate nodes fail',()=>assert.throws(()=>validateGraph([a,a],[]),{code:'DUPLICATE_NODE'}));
test('unmapped endpoints fail',()=>assert.throws(()=>validateGraph([a],edges),{code:'DANGLING_EDGE'}));
test('edge without evidence fails',()=>assert.throws(()=>validateGraph([a,b],[{...edges[0],evidenceId:''}]),{code:'INVALID_EDGE'}));
test('bounded graph expansion is potential relationship, not breakage',()=>{
 const out=neighborhood([a,b,c],edges,a.id,2,2);assert.equal(out.nodeIds.length,2);assert.equal(out.truncated,true);assert.equal(out.interpretation,'potential-relationship');
});
test('unknown start node fails closed',()=>assert.throws(()=>neighborhood([a,b],[], 'none'),{code:'UNKNOWN_NODE'}));
test('depth and size are bounded',()=>assert.throws(()=>neighborhood([a],[],a.id,9),{code:'INVALID_LIMIT'}));
const releases=[{packageName:'retry',version:'1.0.0',repositoryId:'r',snapshotId:'s1',exports:{'.':'src/index.ts'}},{packageName:'retry',version:'2.0.0',repositoryId:'r',snapshotId:'s2',exports:{'.':'src/index.ts'}}];
test('exact release resolution',()=>assert.equal(resolveRelease(releases,'retry','1.0.0').snapshotId,'s1'));
for(const version of ['latest','^1.0.0','~1.0.0','1.x','*'])test(`no fuzzy release selection ${version}`,()=>assert.throws(()=>resolveRelease(releases,'retry',version),{code:'EXACT_VERSION_REQUIRED'}));
test('missing version never falls back to latest',()=>assert.throws(()=>resolveRelease(releases,'retry','9.0.0'),{code:'UNSUPPORTED_VERSION'}));
test('package mismatch fails',()=>assert.throws(()=>resolveRelease(releases,'other','1.0.0'),{code:'UNSUPPORTED_VERSION'}));
test('ambiguous provider mapping fails',()=>assert.throws(()=>resolveRelease([releases[0],releases[0]],'retry','1.0.0'),{code:'AMBIGUOUS_RELEASE'}));
test('exact prerelease identifiers can be represented',()=>assert.equal(isExactVersion('2.0.0-beta.1'),true));

test('depth-limited graph declares omitted relationships',()=>{const out=neighborhood([a,b,c],edges,a.id,0,10);assert.deepEqual(out.nodeIds,[a.id]);assert.equal(out.truncated,true);});
