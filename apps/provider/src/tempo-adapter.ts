import { BodyDigest, Receipt } from 'mppx';
import type { Store } from 'mppx';
import { Mppx, tempo } from 'mppx/server';
import type { Client } from 'viem';
import { tempoModerato } from 'viem/tempo/chains';
import type { PurchaseTerms } from '../../../packages/contracts/src/index.ts';
import { parseQuestion } from '../../../packages/contracts/src/local.ts';
import { isExactVersion } from '../../../packages/core/src/versions.ts';
import { atomicToDecimal, validateTestnetTerms, validateTestnetTermsShape, TEMPO_TESTNET_NETWORK } from '../../../packages/sdk/src/payment-policy.ts';

export type TempoProviderConfig = Readonly<{
  providerId: string; origin: string; realm: string; recipient: `0x${string}`;
  token: `0x${string}`; decimals: number; atomicPrice: string; secretKey: string; quoteLifetimeMs: number;
}>;
export type RetrievalInput = Readonly<{ packageName: string; version: string; question: string; idempotencyKey: string }>;
export type AuthorizedRetrieval = Readonly<{ principalId: string; permissionRevision: string; input: RetrievalInput }>;
export type DurablePurchaseClaim = Readonly<{ state: 'claimed' | 'pending' | 'unknown' | 'settled' | 'rejected'; receipt?: Receipt.Receipt }>;
export type TempoProviderDependencies = Readonly<{
  /** Authorize actual identity and exact-version availability before producing any quote. Never use body tenant claims. */
  authorize(request: Request, input: RetrievalInput): Promise<AuthorizedRetrieval>;
  /** Durable immutable quote keyed by authorized principal+provider+idempotency; altered terms must fail. */
  quote(authorization: AuthorizedRetrieval, proposed: PurchaseTerms): Promise<PurchaseTerms>;
  /** Read the bound durable purchase before quoting, so paid delivery resumes even after quote expiry. */
  lookup(authorization: AuthorizedRetrieval, requestDigest: string): Promise<(DurablePurchaseClaim & { terms: PurchaseTerms }) | null>;
  /** Verify explicit testnet spending approval and an existing atomic budget reservation; atomically claim broadcast once. */
  claim(authorization: AuthorizedRetrieval, terms: PurchaseTerms): Promise<DurablePurchaseClaim>;
  /** Separate authoritative finality/terms reconciliation. An untrusted receipt header is never enough. */
  verifySettlement(authorization: AuthorizedRetrieval, terms: PurchaseTerms, receipt: Receipt.Receipt): Promise<boolean>;
  saveSettlement(authorization: AuthorizedRetrieval, terms: PurchaseTerms, receipt: Receipt.Receipt): Promise<void>;
  markUnknown(authorization: AuthorizedRetrieval, terms: PurchaseTerms): Promise<void>;
  /** Idempotent delivery must be resumable from saved settlement without broadcasting again. */
  deliver(authorization: AuthorizedRetrieval, terms: PurchaseTerms): Promise<Response>;
  /** Shared durable atomic replay adapter; SDK in-memory defaults are deliberately disallowed. */
  replayStore: Store.AtomicStore;
  /** Caller owns RPC configuration; the resolved client must match Moderato exactly. No account/fee payer is supplied. */
  getClient(): Promise<Client> | Client;
  now(): number;
}>;
function requireAdapter(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function reply(status: number, error: string, payment: 'not-attempted' | 'unknown' | 'settled' = 'not-attempted'): Response {
  return Response.json({ mode: 'tempo-testnet', error, payment }, { status, headers: { 'Cache-Control': 'no-store', 'X-Atlas-Mode': 'tempo-testnet' } });
}
async function boundedBody(request: Request): Promise<string> {
  requireAdapter(request.body, 'Request body required'); const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
    requireAdapter(bytes <= 8192, 'Request body exceeds 8192 bytes'); chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  const content = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(content);
}

/** Unwired testnet adapter. No environment flags, signer, route, RPC defaults or credentials activate it. */
export function createTempoTestnetAdapter(config: TempoProviderConfig | null, dependencies: TempoProviderDependencies | null): {
  status: 'configured-unverified' | 'unavailable'; handle(request: Request): Promise<Response>;
} {
  if (!config || !dependencies) return { status: 'unavailable', handle: async () => reply(503, 'Tempo payment integration requires durable authorization, reservation, replay, settlement and delivery adapters') };
  config = Object.freeze({ ...config });
  const origin = new URL(config.origin);
  requireAdapter(origin.protocol === 'https:' && origin.origin === config.origin && !origin.username && !origin.password, 'Provider origin must be exact HTTPS');
  requireAdapter(new TextEncoder().encode(config.secretKey).byteLength >= 32 && config.realm.length > 0
    && Number.isSafeInteger(config.quoteLifetimeMs) && config.quoteLifetimeMs > 0 && config.quoteLifetimeMs <= 300_000, 'Invalid testnet provider configuration');
  requireAdapter(config.providerId.length > 0 && /^0x[a-fA-F0-9]{40}$/.test(config.token) && /^0x[a-fA-F0-9]{40}$/.test(config.recipient)
    && !/^0x0{40}$/i.test(config.token) && !/^0x0{40}$/i.test(config.recipient), 'Configured token and recipient are required');
  atomicToDecimal(config.atomicPrice, config.decimals);
  requireAdapter(dependencies.replayStore && ['get', 'put', 'delete', 'update'].every(name => typeof (dependencies.replayStore as unknown as Record<string, unknown>)[name] === 'function'), 'Durable atomic replay adapter required');
  for (const name of ['authorize', 'quote', 'lookup', 'claim', 'verifySettlement', 'saveSettlement', 'markUnknown', 'deliver', 'getClient', 'now'] as const) requireAdapter(typeof dependencies[name] === 'function', `Required ${name} adapter is missing`);
  const method = tempo.charge({ testnet: true, chainId: tempoModerato.id, currency: config.token, decimals: config.decimals,
    recipient: config.recipient, supportedModes: ['pull'], machineTokenEnabled: false,
    waitForConfirmation: true, html: false, store: dependencies.replayStore, storeKeyPrefix: `${config.providerId}:`,
    getClient: async ({ chainId }) => {
      requireAdapter(chainId === tempoModerato.id, 'Only Tempo Moderato is permitted');
      const client = await dependencies.getClient(); requireAdapter(client.chain?.id === tempoModerato.id, 'RPC client is not Tempo Moderato'); return client;
    } });
  const payment = Mppx.create({ methods: [method], realm: config.realm, secretKey: config.secretKey, requiresAuth: true });
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== config!.origin || url.pathname !== '/context/retrieve' || url.search || request.method !== 'POST') return reply(404, 'Payment route unavailable');
    let body: string; let input: RetrievalInput; let authorized: AuthorizedRetrieval;
    try {
      body = await boundedBody(request.clone()); const raw: unknown = JSON.parse(body);
      requireAdapter(object(raw) && typeof raw.packageName === 'string' && raw.packageName.length > 0 && raw.packageName.length <= 200
        && typeof raw.version === 'string' && isExactVersion(raw.version) && typeof raw.idempotencyKey === 'string'
        && /^[A-Za-z0-9_-]{16,128}$/.test(raw.idempotencyKey), 'Invalid exact-version request');
      input = Object.freeze({ packageName: raw.packageName, version: raw.version, question: parseQuestion(raw.question), idempotencyKey: raw.idempotencyKey });
      authorized = await dependencies!.authorize(request, input);
      requireAdapter(authorized.principalId.length > 0 && authorized.permissionRevision.length > 0
        && JSON.stringify(authorized.input) === JSON.stringify(input), 'Authorization does not bind this request');
    } catch { return reply(403, 'Unauthorized or unavailable exact-version request'); }
    const proposed: PurchaseTerms = { providerId: config!.providerId, operation: 'context.retrieve', requestDigest: BodyDigest.compute(body),
      packageName: input.packageName, version: input.version, network: TEMPO_TESTNET_NETWORK, token: config!.token,
      recipient: config!.recipient, atomicAmount: config!.atomicPrice, expiresAtMs: dependencies!.now() + config!.quoteLifetimeMs };
    function sameTerms(terms: PurchaseTerms): void {
      for (const field of ['providerId', 'operation', 'requestDigest', 'packageName', 'version', 'network', 'token', 'recipient', 'atomicAmount'] as const)
        requireAdapter(terms[field] === proposed[field], 'Persisted quote differs from requested terms');
    }
    async function resumeDelivery(terms: PurchaseTerms, claim: DurablePurchaseClaim): Promise<Response> {
      let receipt: Receipt.Receipt;
      try { receipt = Receipt.Schema.parse(claim.receipt);
        requireAdapter(receipt.method === 'tempo' && await dependencies!.verifySettlement(authorized, terms, receipt), 'Saved settlement failed verification');
      } catch { return reply(503, 'Saved settlement cannot be verified; reconcile this purchase without another charge', 'unknown'); }
      try {
        const response = await dependencies!.deliver(authorized, terms); response.headers.set('Payment-Receipt', Receipt.serialize(receipt)); return response;
      } catch { return reply(503, 'Paid delivery unavailable; resume this purchase without another charge', 'settled'); }
    }
    try {
      const existing = await dependencies!.lookup(authorized, proposed.requestDigest);
      if (existing) {
        validateTestnetTermsShape(existing.terms); sameTerms(existing.terms);
        if (existing.state === 'settled') return resumeDelivery(existing.terms, existing);
        return reply(409, 'Payment is pending, unknown or rejected; reconcile before any new purchase', existing.state === 'rejected' ? 'not-attempted' : 'unknown');
      }
    } catch { return reply(503, 'Durable purchase lookup unavailable'); }
    let terms: PurchaseTerms;
    try {
      terms = await dependencies!.quote(authorized, proposed); validateTestnetTerms(terms, dependencies!.now());
      sameTerms(terms);
      requireAdapter(terms.expiresAtMs <= proposed.expiresAtMs, 'Persisted quote extends approved expiry');
    } catch { return reply(409, 'Immutable payment quote unavailable'); }
    const options = { amount: atomicToDecimal(terms.atomicAmount, config!.decimals), feePayer: false as const, expires: new Date(terms.expiresAtMs), externalId: input.idempotencyKey,
      scope: input.idempotencyKey, meta: { providerId: terms.providerId, operation: terms.operation, requestDigest: terms.requestDigest,
        packageName: terms.packageName, version: terms.version, idempotencyKey: input.idempotencyKey } };
    const charge = payment.tempo.charge(options);
    if (!request.headers.has('Payment-Authorization')) {
      const result = await charge(request); requireAdapter(result.status === 402, 'An unpaid request must not be delivered'); return result.challenge;
    }
    let claim: DurablePurchaseClaim;
    try { claim = await dependencies!.claim(authorized, terms); } catch { return reply(503, 'Durable payment reservation unavailable'); }
    if (claim.state === 'settled') {
      return resumeDelivery(terms, claim);
    }
    if (claim.state !== 'claimed') return reply(409, 'Payment is pending, unknown or rejected; reconcile before any new purchase', claim.state === 'rejected' ? 'not-attempted' : 'unknown');
    let settled = false;
    try {
      const result = await charge(request);
      requireAdapter(result.status === 200, 'Submitted payment credential was not accepted');
      // withReceipt obtains the actual SDK receipt; never construct receipt fields ourselves.
      const paidResponse = result.withReceipt(new Response(null));
      const header = paidResponse.headers.get('Payment-Receipt'); requireAdapter(header, 'SDK settlement receipt is absent');
      const receipt = Receipt.deserialize(header);
      requireAdapter(receipt.method === 'tempo' && await dependencies!.verifySettlement(authorized, terms, receipt), 'Settlement verification unavailable');
      await dependencies!.saveSettlement(authorized, terms, receipt); settled = true;
      const response = await dependencies!.deliver(authorized, terms); response.headers.set('Payment-Receipt', header); return response;
    } catch {
      if (settled) return reply(503, 'Paid delivery unavailable; resume this purchase without another charge', 'settled');
      try { await dependencies!.markUnknown(authorized, terms); } catch { /* Durable claimed state must remain pending. Never release or retry. */ }
      return reply(503, 'Settlement is unknown; reconcile this purchase without another charge', 'unknown');
    }
  }
  return { status: 'configured-unverified', handle };
}
