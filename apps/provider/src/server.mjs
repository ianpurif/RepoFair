import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
export function createProviderBoundary(identity = 'fixture-provider') {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(identity)) throw new Error('Invalid fixture identity.');
  return createServer((req,res)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method==='GET' && path==='/health') {
      res.writeHead(200);res.end(JSON.stringify({providerId:identity,process:'running',mode:'fixture',ready:false,payments:'not-implemented',contextRetrieval:'not-implemented',mcp:'not-implemented'}));return;
    }
    if (path==='/context/retrieve' || path==='/mcp' || path==='/.well-known/atlas-provider.json') {
      res.writeHead(503);res.end(JSON.stringify({status:'unavailable',code:'STARTER_NOT_IMPLEMENTED',providerId:identity,charged:false}));return;
    }
    res.writeHead(404);res.end(JSON.stringify({status:'not_found'}));
  });
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const value=(flag,fallback)=>{const i=process.argv.indexOf(flag);return i<0?fallback:process.argv[i+1];};
  const port=Number(value('--port','4311'));const identity=value('--identity','fixture-provider');
  if((process.env.ATLAS_MODE ?? 'fixture')!=='fixture')throw new Error('Only fixture health mode is implemented.');
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid port.');
  const server=createProviderBoundary(identity);
  server.once('error',e=>{console.error(e.message);process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`${identity}: http://localhost:${port}/health (not ready for paid requests)`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
}
