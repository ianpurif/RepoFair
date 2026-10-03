import test from 'node:test';import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createProviderBoundary} from '../apps/provider/src/server.mjs';
import {starterCapabilities} from '../packages/core/src/capabilities.ts';
async function withProvider(run){const s=createProviderBoundary('test-provider');s.listen(0,'127.0.0.1');await once(s,'listening');const base=`http://127.0.0.1:${s.address().port}`;try{await run(base);}finally{await new Promise(r=>s.close(r));}}
test('health never claims paid context readiness',async()=>withProvider(async base=>{const r=await fetch(base+'/health');assert.equal(r.status,200);const body=await r.json();assert.equal(body.ready,false);assert.equal(body.payments,'not-implemented');assert.equal(body.providerId,'test-provider');}));
for(const path of ['/context/retrieve','/mcp','/.well-known/atlas-provider.json'])test(`${path} is unavailable rather than a fake service`,async()=>withProvider(async base=>{const r=await fetch(base+path);assert.equal(r.status,503);assert.equal(r.headers.get('payment-receipt'),null);assert.equal((await r.json()).charged,false);}));
test('starter capability state is fail-closed',()=>{const caps=starterCapabilities();assert.equal(caps.livePayments,false);assert.equal(caps.capabilities['tempo-settlement'],'disabled');assert.equal(caps.capabilities['mcp'],'not-implemented');});
test('invalid provider identity cannot become response metadata',()=>assert.throws(()=>createProviderBoundary('secret\nheader')));
