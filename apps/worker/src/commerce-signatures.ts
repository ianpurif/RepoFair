import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { KeyObject } from 'node:crypto';
import type { ProviderGrant, PublicationControlProof } from '../../../packages/contracts/src/commerce.ts';

/** Stable native JSON only. Signing never invokes toJSON or an imported accessor. */
export function canonicalJson(value: unknown): string {
  let count = 0;
  const visit = (item: unknown, depth: number): string => {
    if (++count > 500_000 || depth > 24) throw new Error('Signed document exceeds bounds');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isSafeInteger(item)) return JSON.stringify(item);
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length || Reflect.ownKeys(item).length !== item.length + 1) throw new Error('Signed arrays must be dense native JSON');
      const children: string[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item,String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Signed arrays cannot contain accessors');
        children.push(visit(descriptor.value,depth + 1));
      }
      return `[${children.join(',')}]`;
    }
    if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('Signed document must be native JSON');
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('Unsupported signed document field');
    return `{${(keys as string[]).sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Signed document cannot contain accessors');
      return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
    }).join(',')}}`;
  };
  const result = visit(value, 0); if (Buffer.byteLength(result) > 4_000_000) throw new Error('Signed document exceeds 4 MB'); return result;
}
export const documentDigest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export async function loadCommerceKey(file: string | undefined, kind: 'private' | 'public'): Promise<KeyObject> {
  if (!file?.trim()) throw new Error(`Publication ${kind === 'private' ? 'signing' : 'verification'} key file is not configured`);
  let key: KeyObject;
  try {
    const bytes = await readFile(file); if (!bytes.length || bytes.length > 16_384) throw new Error();
    key = kind === 'private' ? createPrivateKey(bytes) : createPublicKey(bytes);
  } catch { throw new Error('Publication key file is unavailable or invalid'); }
  if (key.asymmetricKeyType !== 'ed25519' || key.type !== kind) throw new Error('Publication keys must use Ed25519'); return key;
}
export function signDocument(value: unknown, key: KeyObject): string {
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 signing key required');
  return sign(null, Buffer.from(canonicalJson(value)), key).toString('base64url');
}
export function verifyDocument(value: unknown, signature: unknown, key: KeyObject): boolean {
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519' || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try { return verify(null, Buffer.from(canonicalJson(value)), key, Buffer.from(signature, 'base64url')); } catch { return false; }
}
export function createProviderGrant(grant: ProviderGrant, key: KeyObject): string {
  return `${Buffer.from(canonicalJson(grant)).toString('base64url')}.${signDocument(grant, key)}`;
}
export function createPublicationControlProof(proof: PublicationControlProof, key: KeyObject): string {
  return `${Buffer.from(canonicalJson(proof)).toString('base64url')}.${signDocument(proof,key)}`;
}
export function verifyPublicationControlProof(token: string,key: KeyObject,binding: {id:string;revision:number;digest:string;origin:string;nonce:string},now=Date.now()): void {
  if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/.test(token)) throw new Error('Invalid publication control proof');
  const [encoded,signature]=token.split('.');const value=JSON.parse(Buffer.from(encoded!,'base64url').toString('utf8')) as PublicationControlProof;
  const fields=['schemaVersion','purpose','publicationId','draftRevision','termsDigest','providerOrigin','nonce','expiresAtMs'];
  if (!verifyDocument(value,signature,key) || !value || Object.keys(value).length !== fields.length || fields.some(field=>!Object.hasOwn(value,field))
    || value.schemaVersion!==1 || value.purpose!=='activation-control' || value.publicationId!==binding.id || value.draftRevision!==binding.revision
    || value.termsDigest!==binding.digest || value.providerOrigin!==binding.origin || value.nonce!==binding.nonce
    || !/^[a-f0-9]{48}$/.test(value.nonce) || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs<=now || value.expiresAtMs>now+60_000) throw new Error('Invalid publication control proof binding');
}
export function verifyProviderGrant(token: string, key: KeyObject, issuer: string, providerId?: string, now = Date.now()): ProviderGrant {
  if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/.test(token)) throw new Error('Invalid provider delegation');
  const [encoded, signature] = token.split('.'); const value: unknown = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'));
  if (!verifyDocument(value, signature, key) || !value || typeof value !== 'object') throw new Error('Invalid provider delegation');
  const grant = value as ProviderGrant;
  const fields = ['schemaVersion','issuer','providerId','principalId','sessionId','workspaceId','permissionRevision','publicationDigest','packageName','version','requestDigest','idempotencyKey','expiresAtMs'];
  if (Object.keys(grant).some(field => !fields.includes(field)) || fields.some(field => !(field in grant)) || grant.schemaVersion !== 1
    || grant.issuer !== issuer || (providerId !== undefined && grant.providerId !== providerId)
    || !Number.isSafeInteger(grant.expiresAtMs) || grant.expiresAtMs <= now || grant.expiresAtMs > now + 300_000
    || !/^[a-f0-9]{64}$/.test(grant.publicationDigest) || !/^sha-256=[A-Za-z0-9+/]{43}=$/.test(grant.requestDigest)
    || !/^[A-Za-z0-9_-]{16,128}$/.test(grant.idempotencyKey)
    || fields.filter(field => !['schemaVersion','expiresAtMs'].includes(field)).some(field => typeof grant[field as keyof ProviderGrant] !== 'string' || String(grant[field as keyof ProviderGrant]).length > 512)) throw new Error('Invalid provider delegation binding');
  return Object.freeze(grant);
}
