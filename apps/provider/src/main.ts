import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

/** Strict configured service. Inactive readiness has a separate entry and bundle. */
export async function createProviderServer(args: readonly string[], env: Readonly<Record<string, string | undefined>>) {
  if (args.length !== 0) throw new Error('Configured provider accepts no runtime flags; use the dedicated preparation launcher.');
  const { createIndependentProvider } = await import('./runtime.ts');
  const provider = await createIndependentProvider(env);
  const server = createServer(async (incoming,outgoing) => {
    try {
      const headers = new Headers(); for (const [name,value] of Object.entries(incoming.headers)) {if(typeof value==='string')headers.set(name,value);}
      const request = new Request(new URL(incoming.url ?? '/',env.ATLAS_PROVIDER_ORIGIN),{method:incoming.method,headers,
        ...(incoming.method==='GET'||incoming.method==='HEAD'?{}:{body:Readable.toWeb(incoming) as ReadableStream<Uint8Array>,duplex:'half'})} as RequestInit);
      const response = await provider.handle(request); const responseHeaders:Record<string,string>={};response.headers.forEach((value,name)=>{responseHeaders[name]=value;});outgoing.writeHead(response.status,responseHeaders);
      if (response.body) for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) outgoing.write(part);outgoing.end();
    } catch {outgoing.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});outgoing.end(JSON.stringify({error:'Independent provider unavailable',mode:'tempo-testnet'}));}
  });
  return { server, close: () => provider.close() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const provider = await createProviderServer(process.argv.slice(2), process.env);
    const port = Number(process.env.ATLAS_PROVIDER_PORT ?? '4311');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid provider port');
    const host = process.env.ATLAS_PROVIDER_BIND_HOST ?? '127.0.0.1';
    if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('Invalid provider bind host');
    provider.server.once('error',() => {console.error('Provider listener unavailable; check the configured port');process.exitCode=1;void provider.close();});
    provider.server.listen(port,host,() => console.log(JSON.stringify({service:'atlas-provider',port,mode:'tempo-testnet',status:'configured'})));
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,() => provider.server.close(() => {void provider.close();}));
  } catch {console.error('Provider configuration unavailable: configure its own database, signed source export, issuer key, MPP secret, HTTPS origin and Moderato RPC');process.exitCode=1;}
}
