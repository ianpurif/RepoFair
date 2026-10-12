import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { PublicClient } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AtlasDatabase, AtlasTransaction } from '../../apps/worker/src/database.ts';
import type { PublicationDraft } from '../../packages/contracts/src/index.ts';
import { MODERATO_NETWORK, MODERATO_PATHUSD } from '../../packages/contracts/src/commerce.ts';
import { parseRepositoryIndex } from '../../packages/core/src/local/parser.ts';
import { signDocument } from '../../apps/worker/src/commerce-signatures.ts';
import { buildPublicationArtifact, signPublicationPassages } from '../../apps/worker/src/publication-artifact.ts';

// Actual runtime and native artifact signatures execute. Owned database callbacks,
// RPC chain responses, source and keys are synthetic; no hosted pool or payment opens.
const pools = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../apps/worker/src/database.ts', () => ({ createAtlasDatabase: pools.create }));
import { createIndependentProvider } from '../../apps/provider/src/runtime.ts';
import { createVercelProviderHandler } from '../../apps/provider/src/vercel.ts';

const keys = generateKeyPairSync('ed25519');
const origin = 'https://repofair-provider.vercel.app';
const providerId = randomUUID(), workspaceId = randomUUID(), repositoryId = randomUUID(), snapshotId = randomUUID();
const commitSha = 'a'.repeat(40);
const files = [{ path: 'package.json', text: '{"name":"@synthetic/provider-vercel","version":"1.0.0","exports":{".":"./src/index.ts"}}' },
  { path: 'src/index.ts', text: 'export function syntheticAdapterSource() { return 1; }\n' }];
const draft = {
  schemaVersion: 1, id: providerId, workspaceId, repositoryId, snapshotId, commitSha, revision: 1, termsDigest: 'b'.repeat(64), state: 'draft',
  proposal: { packageName: '@synthetic/provider-vercel', version: '1.0.0', exports: { '.': 'src/index.ts' }, exposedPaths: files.map(file => file.path),
    rightsStatement: 'Synthetic test source only.', accessPolicy: 'private', proposedEndpoint: origin + '/context/retrieve',
    testnetTerms: { network: MODERATO_NETWORK, operation: 'context.retrieve', token: MODERATO_PATHUSD, recipient: '0x' + '2'.repeat(40), atomicPrice: '1000' } },
  preview: { snapshotId, commitSha, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0),
    files: files.map(file => ({ path: file.path, lines: file.text.split('\n').length, bytes: Buffer.byteLength(file.text),
      sourceDigest: createHash('sha256').update(file.text).digest('hex') })) },
} as unknown as PublicationDraft;
const index = parseRepositoryIndex({ scope: { tenantId: workspaceId, principalId: 'synthetic-owner', permissionRevision: '1' },
  snapshot: { kind: 'git', repositoryId, snapshotId, revision: commitSha }, packageName: draft.proposal.packageName, version: '1.0.0',
  observedAt: '2026-10-13T00:00:00Z', files });
const artifact = signPublicationPassages(buildPublicationArtifact(draft, index), keys.privateKey);
const stored = { artifact, signature: signDocument(artifact, keys.privateKey), terms_digest: draft.termsDigest };
const environment = {
  ATLAS_PROVIDER_ID: providerId, ATLAS_PROVIDER_ORIGIN: origin, ATLAS_PROVIDER_AUTHORIZATION_ISSUER: 'https://repofair.vercel.app',
  ATLAS_PROVIDER_ISSUER_PUBLIC_KEY: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  ATLAS_PROVIDER_MPP_SECRET: 'synthetic-mpp-secret-'.repeat(3), ATLAS_PROVIDER_DATABASE_URL: 'synthetic-owned-pool',
  ATLAS_PROVIDER_RECIPIENT: '0x' + '2'.repeat(40), ATLAS_PROVIDER_PRICE_UNITS: '1000', TEMPO_CHAIN_ID: '42431',
};
const client = { chain: { id: 42431 }, getChainId: async () => 42431 } as unknown as PublicClient;

function database(row: unknown = stored) {
  const query = vi.fn(async () => ({ rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 }));
  const close = vi.fn(async () => {});
  return {
    value: { withAdminTransaction: async (callback: (tx: AtlasTransaction) => Promise<unknown>) => callback({ query } as unknown as AtlasTransaction), close } as unknown as AtlasDatabase,
    query, close,
  };
}

beforeEach(() => { pools.create.mockReset(); });

describe('actual provider initialization with synthetic owned pools', () => {
  it('closes an owned pool when the installed artifact is absent', async () => {
    const owned = database(null); pools.create.mockResolvedValue(owned.value);
    await expect(createIndependentProvider(environment, { client })).rejects.toThrow('owner-approved signed publication');
    expect(pools.create).toHaveBeenCalledOnce(); expect(owned.close).toHaveBeenCalledOnce();
  });

  it('closes an owned pool when artifact signature verification fails', async () => {
    const owned = database({ ...stored, signature: 'SYNTHETIC_INVALID_SIGNATURE' }); pools.create.mockResolvedValue(owned.value);
    await expect(createIndependentProvider(environment, { client })).rejects.toThrow();
    expect(owned.close).toHaveBeenCalledOnce();
  });

  it('closes an owned pool when configured terms differ from the real signed artifact', async () => {
    const owned = database(); pools.create.mockResolvedValue(owned.value);
    await expect(createIndependentProvider({ ...environment, ATLAS_PROVIDER_PRICE_UNITS: '999' }, { client })).rejects.toThrow('differs from the signed export');
    expect(owned.close).toHaveBeenCalledOnce();
  });

  it('leaves a supplied caller-owned database open on initialization failure', async () => {
    const supplied = database(null);
    await expect(createIndependentProvider(environment, { client, database: supplied.value })).rejects.toThrow('owner-approved signed publication');
    expect(pools.create).not.toHaveBeenCalled(); expect(supplied.close).not.toHaveBeenCalled();
  });

  it('preserves the original failure when closing an owned pool also fails', async () => {
    const owned = database(null); owned.close.mockRejectedValue(new Error('SYNTHETIC_CLOSE_SECRET')); pools.create.mockResolvedValue(owned.value);
    const failure = await createIndependentProvider(environment, { client }).then(() => null, error => error as Error);
    expect(String(failure)).toContain('owner-approved signed publication');
    expect(String(failure)).not.toContain('SYNTHETIC_CLOSE_SECRET'); expect(owned.close).toHaveBeenCalledOnce();
  });

  it('cleans repeated failed adapter initialization then retains one successful owned runtime', async () => {
    const first = database(null), second = database(null), successful = database();
    pools.create.mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value).mockResolvedValueOnce(successful.value);
    let provider: Awaited<ReturnType<typeof createIndependentProvider>> | undefined;
    const factory = vi.fn(async (passed: Readonly<Record<string, string | undefined>>) => { provider = await createIndependentProvider(passed, { client }); return provider; });
    const handle = createVercelProviderHandler(environment, factory);
    for (let attempt = 0; attempt < 2; attempt++) expect((await handle(new Request(origin + '/health'))).status).toBe(503);
    expect(first.close).toHaveBeenCalledOnce(); expect(second.close).toHaveBeenCalledOnce();
    const ready = await handle(new Request(origin + '/health'));
    expect(ready.status).toBe(200); expect(await ready.json()).toEqual({ mode: 'tempo-testnet', configuration: 'ready', network: MODERATO_NETWORK });
    expect((await handle(new Request(origin + '/health'))).status).toBe(200);
    expect(factory).toHaveBeenCalledTimes(3); expect(pools.create).toHaveBeenCalledTimes(3);
    expect(successful.close).not.toHaveBeenCalled(); expect(successful.query).toHaveBeenCalledOnce();
    await provider!.close(); expect(successful.close).toHaveBeenCalledOnce();
  });
});
