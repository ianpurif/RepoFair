import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createIndependentProvider } from './runtime.ts';

try {
  const provider = await createIndependentProvider(process.env); const port = Number(process.env.ATLAS_PROVIDER_PORT ?? '4311');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid provider port');
  const server = createServer(async (incoming,outgoing) => {
    try {
      const headers = new Headers(); for (const [name,value] of Object.entries(incoming.headers)) {if(typeof value==='string')headers.set(name,value);}
      const request = new Request(new URL(incoming.url ?? '/',process.env.ATLAS_PROVIDER_ORIGIN),{method:incoming.method,headers,
        ...(incoming.method==='GET'||incoming.method==='HEAD'?{}:{body:Readable.toWeb(incoming) as ReadableStream<Uint8Array>,duplex:'half'})} as RequestInit);
      const response = await provider.handle(request); const responseHeaders:Record<string,string>={};response.headers.forEach((value,name)=>{responseHeaders[name]=value;});outgoing.writeHead(response.status,responseHeaders);
      if (response.body) for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) outgoing.write(part);outgoing.end();
    } catch {outgoing.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});outgoing.end(JSON.stringify({error:'Independent provider unavailable',mode:'tempo-testnet'}));}
  });
  server.once('error',() => {console.error('Provider listener unavailable; check the configured port');process.exitCode=1;void provider.close();});
  server.listen(port,'127.0.0.1',() => console.log(JSON.stringify({service:'atlas-provider',port,mode:'tempo-testnet',status:'configured'})));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,() => server.close(() => {void provider.close();}));
} catch {console.error('Provider configuration unavailable: configure its own database, signed source export, issuer key, MPP secret, HTTPS origin and Moderato RPC');process.exitCode=1;}
