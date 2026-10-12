import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Challenge, Credential, Receipt, Store } from 'mppx';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, stringToHex } from 'viem';
import type { PublicClient } from 'viem';
import { Abis, Transaction } from 'viem/tempo';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogProvider, ProviderGrant, PublicationDraft } from '../../packages/contracts/src/index.ts';
import { MODERATO_NETWORK, MODERATO_PATHUSD } from '../../packages/contracts/src/commerce.ts';
import { parseRepositoryIndex } from '../../packages/core/src/local/parser.ts';
import { AtlasDatabase } from '../../apps/worker/src/database.ts';
import type { AtlasPool } from '../../apps/worker/src/database.ts';
import { createCommerceService } from '../../apps/worker/src/commerce-service.ts';
import { createProviderGrant, signDocument } from '../../apps/worker/src/commerce-signatures.ts';
import { buildPublicationArtifact, retrievePublishedContext, signPublicationPassages } from '../../apps/worker/src/publication-artifact.ts';
import { PublicationServiceError } from '../../apps/worker/src/publication-service.ts';
import type { createPublicationRegistry } from '../../apps/worker/src/publication-registry.ts';
import type { ProviderHttp } from '../../apps/worker/src/provider-http.ts';
import { inspectPaymentCredential, verifyModeratoSettlement } from '../../apps/worker/src/tempo-verification.ts';
import type { PaymentSubmission } from '../../apps/worker/src/tempo-verification.ts';
import { createTempoTestnetAdapter } from '../../apps/provider/src/tempo-adapter.ts';
import type { TempoProviderConfig, TempoProviderDependencies } from '../../apps/provider/src/tempo-adapter.ts';

// The actual buyer service, SQL migrations, signing-policy inspector, official
// offline MPP challenge generator, and receipt verifier execute. Registry
// authority and RPC/HTTP responses are injected synthetic test transports.
// Test credentials use fixed meaningless signature scalars, no wallet signer
// or broadcast. The generated hash is a test binding, not a live transaction.
const sql = new PGlite(); const keys = generateKeyPairSync('ed25519');
const workspaceId = randomUUID(); const otherWorkspace = randomUUID(); const repositoryId = randomUUID(); const snapshotId = randomUUID(); const providerId = randomUUID();
const principal = 'user_buyer'; const otherPrincipal = 'user_other'; const sessionId = 'sess_buyer';
const origin = 'https://provider.buyer-verifier.dev'; const issuer = 'https://atlas.buyer-verifier.dev'; const commitSha = 'a'.repeat(40);
const source = [{ path: 'package.json', text: '{"name":"@verifier/buyer","version":"1.0.0","exports":{".":"./src/index.ts"}}' },
  { path: 'src/index.ts', text: 'export function retry(value: number) {\n  return value + 1;\n}\n' }];
const index = parseRepositoryIndex({ scope: { tenantId: workspaceId, principalId: principal, permissionRevision: '1:1' },
  snapshot: { kind: 'git', repositoryId, snapshotId, revision: commitSha }, packageName: '@verifier/buyer', version: '1.0.0', observedAt: '2026-10-11T00:00:00Z', files: source });
const draft: PublicationDraft = {
  schemaVersion: 1, id: providerId, workspaceId, repositoryId, snapshotId, commitSha, revision: 1, termsDigest: 'b'.repeat(64), state: 'draft',
  proposal: { packageName: '@verifier/buyer', version: '1.0.0', exports: { '.': 'src/index.ts' }, exposedPaths: source.map(file => file.path),
    rightsStatement: 'Synthetic verifier source approved solely for local isolated testing.', accessPolicy: 'private', proposedEndpoint: origin + '/context/retrieve',
    testnetTerms: { network: MODERATO_NETWORK, operation: 'context.retrieve', token: MODERATO_PATHUSD, recipient: '0x' + '2'.repeat(40), atomicPrice: '1000' } },
  preview: { snapshotId, commitSha, fileCount: source.length, totalBytes: source.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0),
    files: source.map(file => ({ path: file.path, lines: file.text.split('\n').length, bytes: Buffer.byteLength(file.text), sourceDigest: createHash('sha256').update(file.text).digest('hex') })) },
  published: false, approval: null, endpointProof: 'unverified', payment: 'disabled', rights: 'declared', accuracy: 'unverified',
  administration: { status: 'verified', basis: 'personal-owner', checkedAt: '2026-10-11T00:00:00Z' }, createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z',
};
const artifact = signPublicationPassages(buildPublicationArtifact(draft, index), keys.privateKey);
const provider: CatalogProvider = { id: providerId, packageName: '@verifier/buyer', version: '1.0.0', endpoint: origin + '/context/retrieve', realm: 'verifier-realm',
  accessPolicy: 'private', network: MODERATO_NETWORK, token: MODERATO_PATHUSD, recipient: draft.proposal.testnetTerms!.recipient, atomicPrice: '1000', tokenDecimals: 6,
  commitSha, snapshotId, publicationDigest: draft.termsDigest, rightsStatement: draft.proposal.rightsStatement };
let now = Date.now(); let directory = ''; let environment: Record<string, string> = {};
let entitlement = true; let activeSession = true; let metadata: CatalogProvider = provider;
let chainId = 42431; let canonical = true; let successful = true; let eventAmount = 1000n; let eventRecipient = provider.recipient;
let recorded: PaymentSubmission | null = null; let eventMemo = ''; let fakeLogs: unknown[] | null = null;
const blockHash = '0x' + 'c'.repeat(64);
const rpcRequest = vi.fn(async ({ method }: { method: string }) => { if (method === 'eth_chainId') return '0x' + chainId.toString(16); throw new Error('No synthetic broadcast is permitted'); });
const rpc = {
  chain: { id: 42431 },
  getChainId: vi.fn(async () => chainId),
  request: rpcRequest,
  getTransaction: vi.fn(async () => ({ hash: recorded!.transactionHash, from: recorded!.sender, chainId: 42431 })),
  getTransactionReceipt: vi.fn(async () => ({ transactionHash: recorded!.transactionHash, from: recorded!.sender, status: successful ? 'success' : 'reverted',
    blockNumber: 100n, blockHash, logs: fakeLogs ?? [{ address: MODERATO_PATHUSD, data: encodeAbiParameters([{ type: 'uint256' }], [eventAmount]),
      topics: encodeEventTopics({ abi: Abis.tip20, eventName: 'TransferWithMemo', args: { from: recorded!.sender, to: eventRecipient as '0x', memo: eventMemo as '0x' } }),
      blockNumber: 100n, transactionHash: recorded!.transactionHash, transactionIndex: 0, blockHash, logIndex: 0, removed: false }] })),
  getBlock: vi.fn(async () => ({ hash: canonical ? blockHash : '0x' + 'd'.repeat(64), timestamp: BigInt(Math.floor(now / 1000)) })),
} as unknown as PublicClient;
// Serialize AtlasDatabase transactions on the one PGlite backend. This tests
// real accounting/constraints, not separate PostgreSQL connection contention.
let tail: Promise<void> = Promise.resolve();
const pool = Object.assign(new EventEmitter(), {
  connect: async () => {
    const previous = tail; let releaseQueue = () => {};
    tail = new Promise<void>(complete => { releaseQueue = complete; }); await previous;
    return Object.assign(new EventEmitter(), {
      query: async (text: string, values?: unknown[]) => {
        const result = await sql.query(text, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, command: '', oid: 0, fields: [] };
      }, release: () => { releaseQueue(); },
    });
  }, end: async () => {},
}) as unknown as AtlasPool;
const database = new AtlasDatabase(pool);
const available = vi.fn(async (_actor: string, id: string) => {
  if (!entitlement || id !== providerId) throw new PublicationServiceError('publication-unavailable', 'Synthetic revoked publication', 404);
  return { metadata };
});
const grant = vi.fn(async (actor: string, session: string, workspace: string, id: string, digest: string, idem: string) => {
  if (!entitlement || !activeSession || actor !== principal || session !== sessionId || id !== providerId) throw new PublicationServiceError('delegation-denied', 'Synthetic revoked entitlement or session', 403);
  const grant: ProviderGrant = { schemaVersion: 1, issuer, providerId, principalId: actor, sessionId: session, workspaceId: workspace,
    permissionRevision: '1:' + metadata.publicationDigest, publicationDigest: metadata.publicationDigest, packageName: metadata.packageName, version: metadata.version,
    requestDigest: digest, idempotencyKey: idem, expiresAtMs: now + 120_000 };
  return { provider: metadata, grant, token: createProviderGrant(grant, keys.privateKey) };
});
const registry = { available, grant } as unknown as ReturnType<typeof createPublicationRegistry>;
const config: TempoProviderConfig = { providerId, origin, realm: provider.realm, token: MODERATO_PATHUSD, recipient: provider.recipient as '0x', decimals: 6,
  atomicPrice: '1000', secretKey: randomBytes(48).toString('base64'), quoteLifetimeMs: 60_000 };
function offlineQuote() {
  const dependencies: TempoProviderDependencies = {
    now: () => now, authorize: async (_request, input) => ({ principalId: principal, permissionRevision: '1', input }),
    quote: async (_authorization, terms) => terms, lookup: async () => null,
    claim: async () => { throw new Error('No synthetic charge is permitted'); }, bindSubmission: async () => { throw new Error('No synthetic charge is permitted'); },
    verifySettlement: async () => false, saveSettlement: async () => { throw new Error('No synthetic settlement write is permitted'); },
    markUnknown: async () => {}, deliver: async () => { throw new Error('No synthetic provider delivery is permitted'); }, replayStore: Store.memory(), getClient: () => rpc,
  };
  return createTempoTestnetAdapter(config, dependencies);
}
let responder: ProviderHttp;
const http: ProviderHttp = vi.fn(async (url, options) => responder(url, options));
function service() { return createCommerceService(database, environment, { registry, http, client: rpc, now: () => now }); }
function request(key = 'buyer_request_00000001', changes: Record<string, unknown> = {}) {
  return { workspaceId, providerId, question: 'How does retry work?', idempotencyKey: key, approvedAtomicAmount: '1000', ...changes };
}
function memo(realm: string, challengeId: string): '0x' {
  return ('0x' + keccak256(stringToHex('mpp')).slice(2, 10) + '01' + keccak256(stringToHex(realm)).slice(2, 22) + '00'.repeat(10) + keccak256(stringToHex(challengeId)).slice(2, 16)) as '0x';
}
type Reservation = Awaited<ReturnType<ReturnType<typeof createCommerceService>['createPurchase']>>;
async function testCredential(reservation: Reservation, changes: { chainId?: number; amount?: bigint; recipient?: '0x'; attribution?: '0x' } = {}) {
  const challenge = Challenge.deserialize((await offlineQuote().handle(new Request(provider.endpoint, { method: 'POST', body: reservation.requestBody }))).headers.get('WWW-Authenticate')!);
  const serialized = await Transaction.serialize({ type: 'tempo', chainId: changes.chainId ?? 42431, nonce: 0, nonceKey: 0n, gas: 100_000n,
    maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, validBefore: Math.floor(reservation.approval.terms.expiresAtMs / 1000),
    calls: [{ to: MODERATO_PATHUSD, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transferWithMemo',
      args: [changes.recipient ?? provider.recipient as '0x', changes.amount ?? 1000n, changes.attribution ?? memo(provider.realm, reservation.approval.challengeId)] }) }],
    signature: { type: 'secp256k1', signature: { r: 1n, s: 1n, yParity: 0 } } });
  return Credential.serialize({ challenge, payload: { type: 'transaction', signature: serialized } });
}
async function reserveAndBind(key = 'buyer_request_00000001') {
  await service().setAllowance(principal, workspaceId, '5000'); const reservation = await service().createPurchase(principal, sessionId, request(key));
  expect(await service().claimSigning(principal, sessionId, reservation.purchase.id)).toEqual({ state: 'claimed' });
  const credential = await testCredential(reservation); await service().bindCredential(principal, reservation.purchase.id, credential);
  recorded = await inspectPaymentCredential(credential, reservation.approval, now); eventMemo = memo(provider.realm, reservation.approval.challengeId);
  return { reservation, credential };
}
function receipt(): Receipt.Receipt { return { method: 'tempo', status: 'success', reference: recorded!.transactionHash, timestamp: new Date(now).toISOString() }; }
function delivered() {
  const context = retrievePublishedContext(artifact, 'How does retry work?');
  return { schemaVersion: 1, mode: 'tempo-testnet', providerId, publicationDigest: artifact.termsDigest, commitSha, snapshotId, payment: 'settled', delivery: 'ready',
    context, sourceSignatures: artifact.sourceSignatures, graphSignatures: artifact.graphSignatures };
}
function readyResponse(body: unknown = delivered()): Response { return Response.json(body, { headers: { 'Payment-Receipt': Receipt.serialize(receipt()) } }); }
beforeAll(async () => {
  await sql.exec("CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$; GRANT USAGE ON SCHEMA auth TO authenticated; GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;");
  for (const migration of (await readdir('supabase/migrations')).filter(file => file.endsWith('.sql')).sort()) await sql.exec(await readFile(join('supabase/migrations', migration), 'utf8'));
  directory = await mkdtemp(join(tmpdir(), 'atlas-overhaul-buyer-verifier-')); const privateFile = join(directory, 'issuer-private.pem');
  await writeFile(privateFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' })); environment = { ATLAS_PUBLICATION_SIGNING_KEY_FILE: privateFile };
}, 30_000);
beforeEach(async () => {
  await sql.exec('TRUNCATE atlas.workspaces CASCADE');
  await sql.query("INSERT INTO atlas.workspaces(id,name) VALUES($1,'Buyer verifier'),($2,'Other verifier')", [workspaceId, otherWorkspace]);
  await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [workspaceId, principal, otherWorkspace, otherPrincipal]);
  now = Date.now(); entitlement = true; activeSession = true; metadata = provider; chainId = 42431; canonical = true; successful = true;
  eventAmount = 1000n; eventRecipient = provider.recipient; recorded = null; eventMemo = ''; fakeLogs = null;
  available.mockClear(); grant.mockClear(); vi.mocked(http).mockClear();
  rpcRequest.mockClear(); vi.mocked(rpc.getChainId).mockClear(); vi.mocked(rpc.getTransaction).mockClear(); vi.mocked(rpc.getTransactionReceipt).mockClear(); vi.mocked(rpc.getBlock).mockClear();
  responder = async (url, options) => offlineQuote().handle(new Request(url, { method: options?.method ?? 'GET',
    ...(options?.headers !== undefined ? { headers: options.headers } : {}), ...(options?.body !== undefined ? { body: options.body } : {}) }));
});
afterAll(async () => {
  await database.close(); await sql.close();
  if (directory) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.split(/[\\/]/).at(-1)?.startsWith('atlas-overhaul-buyer-verifier-')) throw new Error('Temporary verifier cleanup target is invalid');
    await rm(directory, { recursive: true, force: true });
  }
});
describe('actual buyer SQL accounting, tenant policy, and immutable approval', () => {
  it('atomically reserves approved integer units from a configured allowance with a genuine offline SDK quote', async () => {
    await service().setAllowance(principal, workspaceId, '1000');
    const reservation = await service().createPurchase(principal, sessionId, request());
    expect(reservation.purchase).toMatchObject({ providerId, version: '1.0.0', network: MODERATO_NETWORK, paymentState: 'reserved', atomicAmount: '1000' });
    expect(reservation.approval).toMatchObject({ commitSha, snapshotId, publicationDigest: artifact.termsDigest, tokenDecimals: 6 });
    expect((await service().history(principal, workspaceId)).budgets).toEqual([{ network: MODERATO_NETWORK, token: MODERATO_PATHUSD, allowance: '1000', reserved: '1000', spent: '0' }]);
    expect(http).toHaveBeenCalledTimes(1); expect(rpcRequest.mock.calls.every(([call]) => call.method === 'eth_chainId')).toBe(true);
  });
  it('does not accept zero, fractional, numeric, overflowing, or implicitly increased spending approvals', async () => {
    for (const amount of ['0', '1.5', 1000, (1n << 256n).toString(), '1001']) await expect(service().createPurchase(principal, sessionId, request(undefined, { approvedAtomicAmount: amount }))).rejects.toThrow();
    for (const allowance of ['1.1', -1, (1n << 256n).toString()]) await expect(service().setAllowance(principal, workspaceId, allowance)).rejects.toThrow();
    expect(http).not.toHaveBeenCalled(); expect((await sql.query('SELECT * FROM atlas.purchases')).rows).toEqual([]);
  });
  it('rejects wrong network and changed price before requesting a quote', async () => {
    metadata = { ...provider, network: 'eip155:4217' } as unknown as CatalogProvider;
    await expect(service().createPurchase(principal, sessionId, request())).rejects.toMatchObject({ code: 'approval-mismatch' });
    metadata = { ...provider, atomicPrice: '2000' };
    await expect(service().createPurchase(principal, sessionId, request())).rejects.toMatchObject({ code: 'approval-mismatch' });
    expect(http).not.toHaveBeenCalled();
  });
  it('fails closed on over-budget or missing allowance and rolls back incomplete policy rows', async () => {
    await expect(service().createPurchase(principal, sessionId, request())).rejects.toThrow();
    expect((await sql.query('SELECT * FROM atlas.purchases')).rows).toEqual([]);
    await service().setAllowance(principal, workspaceId, '999');
    await expect(service().createPurchase(principal, sessionId, request())).rejects.toThrow();
    expect((await sql.query('SELECT * FROM atlas.purchases')).rows).toEqual([]);
    expect((await service().history(principal, workspaceId)).budgets[0]).toMatchObject({ reserved: '0', spent: '0', allowance: '999' });
  });
  it('keeps unchanged idempotent approval at one reservation and rejects altered request terms', async () => {
    await service().setAllowance(principal, workspaceId, '5000'); const first = await service().createPurchase(principal, sessionId, request());
    const again = await service().createPurchase(principal, sessionId, request());
    expect(again.purchase.id).toBe(first.purchase.id); expect(http).toHaveBeenCalledTimes(1);
    await expect(service().createPurchase(principal, sessionId, request(undefined, { question: 'A different request' }))).rejects.toMatchObject({ code: 'idempotency-mismatch' });
    expect((await sql.query('SELECT * FROM atlas.purchases')).rows).toHaveLength(1);
    expect((await service().history(principal, workspaceId)).budgets[0]).toMatchObject({ reserved: '1000', spent: '0' });
  });
  it('does not expose or mutate another tenant purchase or allowance', async () => {
    await service().setAllowance(principal, workspaceId, '5000'); const reservation = await service().createPurchase(principal, sessionId, request());
    await expect(service().history(otherPrincipal, workspaceId)).rejects.toMatchObject({ code: 'denied' });
    await expect(service().setAllowance(otherPrincipal, workspaceId, '5000')).rejects.toMatchObject({ code: 'denied' });
    await expect(service().claimSigning(otherPrincipal, sessionId, reservation.purchase.id)).rejects.toMatchObject({ code: 'purchase-unavailable' });
    await expect(service().releaseUnsigned(otherPrincipal, reservation.purchase.id)).rejects.toMatchObject({ code: 'purchase-unavailable' });
    expect((await database.withPrincipalTransaction(otherPrincipal, tx => tx.query('SELECT * FROM atlas.purchases'))).rows).toEqual([]);
    await expect(database.withPrincipalTransaction(principal, tx => tx.query("UPDATE atlas.purchases SET payment_state='settled'"))).rejects.toThrow();
  });
  it('denies an outsider before quote transport and does not lower allowance below active reservations', async () => {
    await expect(service().createPurchase(otherPrincipal, sessionId, request())).rejects.toMatchObject({ code: 'denied' }); expect(http).not.toHaveBeenCalled();
    await service().setAllowance(principal, workspaceId, '2000'); await service().createPurchase(principal, sessionId, request());
    await expect(service().setAllowance(principal, workspaceId, '999')).rejects.toMatchObject({ code: 'budget-reserved' });
    expect((await service().setAllowance(principal, workspaceId, '1000')).allowance).toBe('1000');
  });
  it('guards immutable provider, amount, version, digest, approval, and request policy in actual SQL', async () => {
    await service().setAllowance(principal, workspaceId, '5000'); const reservation = await service().createPurchase(principal, sessionId, request());
    for (const update of ["amount=999", "recipient='0x3333333333333333333333333333333333333333'", "version='2.0.0'", "request_body='{}'", "terms_digest='" + 'f'.repeat(64) + "'", "approval='{}'::jsonb"]) {
      await expect(sql.query('UPDATE atlas.purchases SET ' + update + ' WHERE id=$1', [reservation.purchase.id])).rejects.toThrow();
    }
    expect((await sql.query<{ amount: string }>('SELECT amount::text FROM atlas.purchases')).rows[0]!.amount).toBe('1000');
  });
  it('rejects revoked publication or session before granting signing permission', async () => {
    await service().setAllowance(principal, workspaceId, '5000'); const reservation = await service().createPurchase(principal, sessionId, request());
    activeSession = false;
    await expect(service().claimSigning(principal, sessionId, reservation.purchase.id)).rejects.toMatchObject({ code: 'delegation-denied' });
    expect((await service().history(principal, workspaceId)).purchases[0]!.paymentState).toBe('reserved');
    activeSession = true; entitlement = false;
    await expect(service().claimSigning(principal, sessionId, reservation.purchase.id)).rejects.toMatchObject({ code: 'delegation-denied' });
    expect((await service().history(principal, workspaceId)).budgets[0]).toMatchObject({ reserved: '1000', spent: '0' });
  });
  it('rejects publication changes while a quote is in flight without reserving stale terms', async () => {
    await service().setAllowance(principal, workspaceId, '5000');
    responder = async (url, options) => {
      const response = await offlineQuote().handle(new Request(url, { method: 'POST', body: options!.body! })); metadata = { ...provider, publicationDigest: 'd'.repeat(64) }; return response;
    };
    await expect(service().createPurchase(principal, sessionId, request())).rejects.toMatchObject({ code: 'publication-changed' });
    expect((await sql.query('SELECT * FROM atlas.purchases')).rows).toEqual([]);
    expect((await service().history(principal, workspaceId)).budgets[0]).toMatchObject({ reserved: '0', spent: '0' });
  });
});
describe('signing claims, durable binding, replay, and unknown outcomes', () => {
  it('permits one signing claim and rejects a second pending purchase for the same provider', async () => {
    await service().setAllowance(principal, workspaceId, '5000'); const first = await service().createPurchase(principal, sessionId, request());
    const second = await service().createPurchase(principal, sessionId, request('buyer_request_00000002'));
    expect(await service().claimSigning(principal, sessionId, first.purchase.id)).toEqual({ state: 'claimed' });
    expect(await service().claimSigning(principal, sessionId, first.purchase.id)).toEqual({ state: 'pending' });
    await expect(service().claimSigning(principal, sessionId, second.purchase.id)).rejects.toMatchObject({ code: 'purchase-pending' });
    await expect(service().createPurchase(principal, sessionId, request('buyer_request_00000003'))).rejects.toMatchObject({ code: 'purchase-pending' });
    expect((await service().history(principal, workspaceId)).budgets[0]).toMatchObject({ reserved: '2000', spent: '0' });
  });
  it('binds canonical transaction hash and derived sender once without storing a raw credential', async () => {
    const { reservation, credential } = await reserveAndBind();
    const stored = (await sql.query<{ transaction_hash: string; sender: string; approval: unknown }>('SELECT transaction_hash,sender,approval FROM atlas.purchases')).rows[0]!;
    expect(stored.transaction_hash).toBe(recorded!.transactionHash); expect(stored.sender).toBe(recorded!.sender);
    expect(JSON.stringify(stored)).not.toContain(credential);
    await expect(service().bindCredential(principal, reservation.purchase.id, credential)).rejects.toMatchObject({ code: 'invalid-state' });
    await expect(sql.query('UPDATE atlas.purchases SET transaction_hash=$1 WHERE id=$2', ['0x' + 'f'.repeat(64), reservation.purchase.id])).rejects.toThrow();
  });
  it('rejects wrong chain, changed amount/recipient, and unrelated challenge attribution before binding', async () => {
    await service().setAllowance(principal, workspaceId, '5000'); const reservation = await service().createPurchase(principal, sessionId, request());
    await service().claimSigning(principal, sessionId, reservation.purchase.id);
    for (const changed of [{ chainId: 4217 }, { amount: 1001n }, { recipient: ('0x' + '3'.repeat(40)) as '0x' }, { attribution: ('0x' + '0'.repeat(64)) as '0x' }]) {
      await expect(service().bindCredential(principal, reservation.purchase.id, await testCredential(reservation, changed))).rejects.toThrow();
    }
    expect((await sql.query('SELECT transaction_hash FROM atlas.purchases')).rows[0]).toEqual({ transaction_hash: null });
  });
  it('retains reservations for unknown signing and prevents local cancellation, re-signing, or a new charge', async () => {
    await service().setAllowance(principal, workspaceId, '5000'); const reservation = await service().createPurchase(principal, sessionId, request());
    await service().claimSigning(principal, sessionId, reservation.purchase.id); await service().markUnknown(principal, reservation.purchase.id); await service().markUnknown(principal, reservation.purchase.id);
    expect(await service().claimSigning(principal, sessionId, reservation.purchase.id)).toEqual({ state: 'unknown' });
    await expect(service().releaseUnsigned(principal, reservation.purchase.id)).rejects.toMatchObject({ code: 'invalid-state' });
    await expect(service().createPurchase(principal, sessionId, request('buyer_request_00000002'))).rejects.toMatchObject({ code: 'purchase-pending' });
    expect((await service().history(principal, workspaceId)).budgets[0]).toMatchObject({ reserved: '1000', spent: '0' });
  });
  it('releases only an unsigned reservation and refuses local release after a signing claim', async () => {
    await service().setAllowance(principal, workspaceId, '5000'); const first = await service().createPurchase(principal, sessionId, request());
    await service().releaseUnsigned(principal, first.purchase.id);
    expect((await service().history(principal, workspaceId)).budgets[0]).toMatchObject({ reserved: '0', spent: '0' });
    const second = await service().createPurchase(principal, sessionId, request('buyer_request_00000002')); await service().claimSigning(principal, sessionId, second.purchase.id);
    await expect(service().releaseUnsigned(principal, second.purchase.id)).rejects.toMatchObject({ code: 'invalid-state' });
  });
  it('persists forwarding before transport and permits no duplicate credential dispatch while the first request is in flight', async () => {
    const { reservation, credential } = await reserveAndBind(); let notify = () => {}; let finish = () => {};
    const started = new Promise<void>(complete => { notify = complete; }); const release = new Promise<void>(complete => { finish = complete; });
    responder = async () => { notify(); await release; return Response.json({ payment: 'unknown' }, { status: 503 }); };
    const first = service().resume(principal, sessionId, reservation.purchase.id, credential).then(() => null, error => error);
    await started;
    await expect(service().resume(principal, sessionId, reservation.purchase.id, credential)).rejects.toMatchObject({ code: 'submission-already-forwarded' });
    finish(); expect(await first).toMatchObject({ code: 'delivery-pending' });
    expect(http).toHaveBeenCalledTimes(2); // one unpaid quote plus one credential dispatch
    const history = await service().history(principal, workspaceId); expect(history.purchases[0]!.paymentState).toBe('unknown'); expect(history.budgets[0]!.reserved).toBe('1000');
    await expect(sql.query('UPDATE atlas.purchases SET credential_dispatched_at=NULL WHERE id=$1', [reservation.purchase.id])).rejects.toThrow();
  });
  it('recovers after a transport failure only through a request without Payment-Authorization', async () => {
    const { reservation, credential } = await reserveAndBind();
    responder = async () => { throw new Error('Synthetic dropped response'); };
    await expect(service().resume(principal, sessionId, reservation.purchase.id, credential)).rejects.toMatchObject({ code: 'payment-unknown' });
    const dispatches = vi.mocked(http).mock.calls.filter(([, options]) => Object.hasOwn(options!.headers!, 'Payment-Authorization')); expect(dispatches).toHaveLength(1);
    await expect(service().resume(principal, sessionId, reservation.purchase.id, credential)).rejects.toMatchObject({ code: 'invalid-state' });
    responder = async (_url, options) => { expect(Object.hasOwn(options!.headers!, 'Payment-Authorization')).toBe(false); return Response.json({ payment: 'unknown' }, { status: 503 }); };
    await expect(service().resume(principal, sessionId, reservation.purchase.id)).rejects.toMatchObject({ code: 'delivery-pending' });
    expect((await service().history(principal, workspaceId)).budgets[0]).toMatchObject({ reserved: '1000', spent: '0' });
  });
});
describe('remote settlement validation and separate delivery outcome', () => {
  it('requires remote Moderato identity, canonical block, exact amount/recipient, and challenge-attributed token logs', async () => {
    const { reservation } = await reserveAndBind(); const terms = reservation.approval.terms;
    expect(await verifyModeratoSettlement(rpc, terms, receipt(), recorded!)).toBe(true);
    chainId = 4217; expect(await verifyModeratoSettlement(rpc, terms, receipt(), recorded!)).toBe(false); chainId = 42431;
    canonical = false; expect(await verifyModeratoSettlement(rpc, terms, receipt(), recorded!)).toBe(false); canonical = true;
    eventAmount = 1001n; expect(await verifyModeratoSettlement(rpc, terms, receipt(), recorded!)).toBe(false); eventAmount = 1000n;
    eventRecipient = '0x' + '3'.repeat(40); expect(await verifyModeratoSettlement(rpc, terms, receipt(), recorded!)).toBe(false); eventRecipient = provider.recipient;
    eventMemo = '0x' + '0'.repeat(64); expect(await verifyModeratoSettlement(rpc, terms, receipt(), recorded!)).toBe(false);
    expect(await verifyModeratoSettlement(rpc, terms, { ...receipt(), reference: '0x' + 'e'.repeat(64) }, recorded!)).toBe(false);
  });
  it('refuses an unverified receipt and leaves the budget reservation intact', async () => {
    const { reservation } = await reserveAndBind(); successful = false;
    await expect(service().reconcile(principal, reservation.purchase.id, receipt())).rejects.toMatchObject({ code: 'settlement-unverified' });
    expect((await service().history(principal, workspaceId)).budgets[0]).toMatchObject({ reserved: '1000', spent: '0' });
  });
  it('records verified synthetic receipt once and returns independently publisher-verified source context', async () => {
    const { reservation, credential } = await reserveAndBind(); responder = async () => readyResponse();
    const result = await service().resume(principal, sessionId, reservation.purchase.id, credential);
    expect(result.purchase).toMatchObject({ paymentState: 'settled', deliveryState: 'ready', receiptReference: recorded!.transactionHash });
    expect(result.context.evidence.length).toBeGreaterThan(0); expect(result.context.version).toBe('1.0.0'); expect(result.context.evidence.every(item => item.source.revision === commitSha)).toBe(true);
    await service().resume(principal, sessionId, reservation.purchase.id);
    expect((await service().history(principal, workspaceId)).budgets[0]).toMatchObject({ reserved: '0', spent: '1000' });
    expect(signDocument(artifact, keys.privateKey)).toHaveLength(86);
  });
  it('retains settled payment when graph evidence fails and recovers source delivery without a second credential', async () => {
    const { reservation, credential } = await reserveAndBind();
    responder = async () => readyResponse({ ...delivered(), graphSignatures: { nodes: {}, edges: {} } });
    await expect(service().resume(principal, sessionId, reservation.purchase.id, credential)).rejects.toMatchObject({ code: 'evidence-invalid' });
    const failed = await service().history(principal, workspaceId); expect(failed.purchases[0]).toMatchObject({ paymentState: 'settled', deliveryState: 'failed' });
    expect(failed.budgets[0]).toMatchObject({ reserved: '0', spent: '1000' });
    responder = async (_url, options) => { expect(Object.hasOwn(options!.headers!, 'Payment-Authorization')).toBe(false); return readyResponse(); };
    const recovered = await service().resume(principal, sessionId, reservation.purchase.id);
    expect(recovered.purchase).toMatchObject({ paymentState: 'settled', deliveryState: 'ready' }); expect((await service().history(principal, workspaceId)).budgets[0]!.spent).toBe('1000');
  });
  it('blocks source return after session or publication entitlement is revoked during provider delivery', async () => {
    const { reservation, credential } = await reserveAndBind();
    responder = async () => { activeSession = false; return readyResponse(); };
    await expect(service().resume(principal, sessionId, reservation.purchase.id, credential)).rejects.toMatchObject({ code: 'delivery-revoked' });
    const history = await service().history(principal, workspaceId); expect(history.purchases[0]).toMatchObject({ paymentState: 'settled', deliveryState: 'revoked' });
    expect(history.budgets[0]).toMatchObject({ reserved: '0', spent: '1000' });
    expect(grant).toHaveBeenCalledTimes(4); // approval, signing, initial delivery, return-boundary reauthorization
  });
  it('removes purchase and budget visibility immediately after membership revocation', async () => {
    const { reservation } = await reserveAndBind();
    await sql.query('DELETE FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2', [workspaceId, principal]);
    await expect(service().history(principal, workspaceId)).rejects.toMatchObject({ code: 'denied' });
    await expect(service().resume(principal, sessionId, reservation.purchase.id)).rejects.toMatchObject({ code: 'purchase-unavailable' });
    expect((await database.withPrincipalTransaction(principal, tx => tx.query('SELECT * FROM atlas.purchases'))).rows).toEqual([]);
    expect((await sql.query<{ reserved: string }>('SELECT reserved::text FROM atlas.budgets')).rows[0]!.reserved).toBe('1000');
  });
  it('rejects stale exact release or snapshot in delivered context while preserving real accounting states', async () => {
    const { reservation, credential } = await reserveAndBind();
    responder = async () => readyResponse({ ...delivered(), snapshotId: randomUUID(), context: { ...delivered().context, version: 'latest' } });
    await expect(service().resume(principal, sessionId, reservation.purchase.id, credential)).rejects.toMatchObject({ code: 'evidence-invalid' });
    const history = await service().history(principal, workspaceId); expect(history.purchases[0]).toMatchObject({ paymentState: 'settled', deliveryState: 'failed' }); expect(history.budgets[0]!.spent).toBe('1000');
  });
});
