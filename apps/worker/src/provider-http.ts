import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export function publicProviderUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')
    || isIP(url.hostname.replace(/^\[|\]$/g, '')) || url.hostname.length > 253
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal|test|example|invalid|onion)$/i.test(url.hostname)) throw new Error('Provider endpoint must use a public HTTPS hostname on port 443');
  return url;
}
export function isPublicProviderAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number) as [number,number,number,number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0))
      || (a===192&&b===88&&c===99) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const canonical=new URL(`http://[${address}]/`).hostname.slice(1,-1);const parts=canonical.split(':');
    const first=Number.parseInt(parts[0]!,16);const second=Number.parseInt(parts[1]||'0',16);
    return first>=0x2000&&first<=0x3fff&&first!==0x2002&&first!==0x3fff
      && !(first===0x2001&&(second<=0x1ff||second===0xdb8));
  }
  return false;
}
export type ProviderHttp = (url: string, options?: Readonly<{ method?: 'GET' | 'POST'; headers?: Readonly<Record<string,string>>; body?: string; maximumBytes?: number }>) => Promise<Response>;
/** HTTP no-content statuses cannot be passed even an empty buffer as a Fetch body. */
export function boundedProviderResponse(status:number,headers:Headers,body:Buffer):Response {
  if (!Number.isInteger(status) || status<200 || status>599) throw new Error('Invalid provider HTTP status');
  return new Response([204,205,304].includes(status)?null:new Uint8Array(body),{status,headers});
}
/** Resolve and pin the public address for this TLS connection. No redirects, cookies or ambient credentials. */
export const providerHttp: ProviderHttp = async (input, options = {}) => {
  const url = publicProviderUrl(input); const maximum = options.maximumBytes ?? 1_000_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4_000_000 || (options.body && Buffer.byteLength(options.body) > 8192)) throw new Error('Provider request exceeds bounds');
  let dnsTimer:ReturnType<typeof setTimeout>|undefined;
  const addresses=await Promise.race([lookup(url.hostname,{all:true,verbatim:true}),new Promise<never>((_resolve,reject)=>{dnsTimer=setTimeout(()=>reject(new Error('Provider DNS deadline exceeded')),5000);})]).finally(()=>clearTimeout(dnsTimer));
  if (!addresses.length || addresses.length>16 || addresses.some(item => !isPublicProviderAddress(item.address))) throw new Error('Provider DNS includes an unsupported address');
  const pinned = addresses[0]!;
  return new Promise<Response>((resolve,reject) => {
    const request = httpsRequest(url, {
      method: options.method ?? 'GET', headers: { Accept: 'application/json', ...options.headers },
      // Node can request either a single address or an array; both remain pinned.
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      }, timeout: 8000, maxHeaderSize: 16_384,
    }, response => {
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) { response.destroy(); request.destroy(); reject(new Error('Provider redirects are disallowed')); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maximum) { response.destroy(); request.destroy(); reject(new Error('Provider response exceeds bounds')); } else chunks.push(chunk); });
      response.on('error', () => reject(new Error('Provider response interrupted')));
      response.on('end', () => {
        try {
          const headers = new Headers();
          for (const name of ['content-type','www-authenticate','payment-receipt','x-atlas-mode']) {
            const value = response.headers[name]; if (typeof value === 'string') headers.set(name, value);
          }
          resolve(boundedProviderResponse(status,headers,Buffer.concat(chunks)));
        } catch { reject(new Error('Invalid provider HTTP response')); }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('Provider deadline exceeded')), 10_000);
    request.once('close', () => clearTimeout(deadline)); request.once('timeout', () => request.destroy(new Error('Provider timed out')));
    request.once('error', () => reject(new Error('Provider connection failed')));
    if (options.body) request.write(options.body); request.end();
  });
};
