import test from 'node:test';import assert from 'node:assert/strict';
import {ChronosAtlasClient} from '../packages/sdk/src/index.ts';
test('SDK requires HTTPS for remote services',()=>assert.throws(()=>new ChronosAtlasClient('http://example.com')));
test('SDK only permits localhost with an explicit option',()=>{assert.throws(()=>new ChronosAtlasClient('http://localhost:3000'));assert.doesNotThrow(()=>new ChronosAtlasClient('http://localhost:3000',{allowLocalDevelopment:true}));});
test('SDK rejects credential-bearing URLs',()=>assert.throws(()=>new ChronosAtlasClient('https://name:secret@example.com')));
test('SDK rejects misleading origin URL paths',()=>assert.throws(()=>new ChronosAtlasClient('https://example.com/private')));
test('SDK accepts a clean HTTPS origin',()=>assert.doesNotThrow(()=>new ChronosAtlasClient('https://example.com')));

test('SDK validates complete response fields before returning',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({product:'Chronos Atlas',stage:'starter'}));
 await assert.rejects(new ChronosAtlasClient('https://example.com').capabilities(),/Unsupported capability response/);
});
test('SDK preserves actual unavailable status',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('{}',{status:503}));
 await assert.rejects(new ChronosAtlasClient('https://example.com').capabilities(),/503/);
});
test('SDK rejects oversized provider response',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('x'.repeat(65537)));
 await assert.rejects(new ChronosAtlasClient('https://example.com').capabilities(),/permitted size/);
});
test('SDK accepts a fully validated starter capability response',async t=>{
 const value={product:'Chronos Atlas',stage:'starter',mode:'fixture',livePayments:false,capabilities:{mcp:'not-implemented'},limitations:['starter']};
 t.mock.method(globalThis,'fetch',async()=>Response.json(value));
 assert.deepEqual(await new ChronosAtlasClient('https://example.com').capabilities(),value);
});
