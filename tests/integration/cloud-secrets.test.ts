import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import type { PublicClient } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { loadDatabasePoolConfiguration } from '../../apps/worker/src/database.ts';
import type { AtlasDatabase, AtlasTransaction } from '../../apps/worker/src/database.ts';
import { loadCommerceKey, signDocument, verifyDocument } from '../../apps/worker/src/commerce-signatures.ts';
import { buildPublicationArtifact, signPublicationPassages } from '../../apps/worker/src/publication-artifact.ts';
import { createIndependentProvider, independentProviderEnvironment, installProviderArtifact, loadProviderMppSecret } from '../../apps/provider/src/runtime.ts';
import { parseRepositoryIndex } from '../../packages/core/src/local/parser.ts';
import type { PublicationDraft } from '../../packages/contracts/src/index.ts';
import { MODERATO_NETWORK, MODERATO_PATHUSD } from '../../packages/contracts/src/commerce.ts';

// Native Ed25519/X509 and the actual provider configuration execute. Keys,
// source, identities, database callbacks and RPC responses are synthetic;
// no actual credentials, network request, signature spend or settlement occurs.
const pair = generateKeyPairSync('ed25519');
const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const sentinel = 'PRIVATE_CONFIGURATION_SENTINEL';
const content = { schemaVersion: 1, message: 'Only a local synthetic signature.' };

describe('serverless issuer and independent provider secrets', () => {
  it.each(['multiline', 'escaped-newlines', 'escaped-crlf', 'crlf'])('loads inline Ed25519 %s PEMs and signs/verifies real native bytes without files', async representation => {
    const convert = (pem: string) => representation === 'escaped-newlines' ? pem.replace(/\n/g, '\\n')
      : representation === 'escaped-crlf' ? pem.replace(/\n/g, '\\r\\n') : representation === 'crlf' ? pem.replace(/\n/g, '\r\n') : pem;
    const signing = await loadCommerceKey(undefined, 'private', convert(privatePem));
    const verification = await loadCommerceKey(undefined, 'public', convert(publicPem));
    expect(signing.type).toBe('private'); expect(verification.type).toBe('public');
    const signature = signDocument(content, signing);
    expect(verifyDocument(content, signature, verification)).toBe(true);
    expect(verifyDocument({ ...content, message: 'altered' }, signature, verification)).toBe(false);
  });
  it('retains existing PEM-file configuration and refuses a public/private PEM type swap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-cloud-key-files-'));
    try {
      const privateFile = join(directory, 'private.pem'); const publicFile = join(directory, 'public.pem');
      await writeFile(privateFile, privatePem); await writeFile(publicFile, publicPem);
      const signing = await loadCommerceKey(privateFile, 'private'); const verification = await loadCommerceKey(publicFile, 'public');
      expect(verifyDocument(content, signDocument(content, signing), verification)).toBe(true);
      await expect(loadCommerceKey(privateFile, 'public')).rejects.toThrow('Ed25519');
      await expect(loadCommerceKey(publicFile, 'private')).rejects.toThrow('Ed25519');
      await expect(loadCommerceKey(directory, 'private')).rejects.toThrow('accessible PEM file');
      await writeFile(privateFile, privatePem + sentinel);
      await expect(loadCommerceKey(privateFile, 'private')).rejects.toThrow('single valid');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('rejects private PEM at the public-only provider boundary even though native createPublicKey can derive it', async () => {
    expect(createPublicKey(privatePem).type).toBe('public');
    await expect(loadCommerceKey(undefined, 'public', privatePem)).rejects.toThrow('single valid');
    await expect(loadCommerceKey(undefined, 'private', publicPem)).rejects.toThrow('single valid');
  });
  it('rejects competing key sources before file access and permits unused blank template fields', async () => {
    await expect(loadCommerceKey(`${sentinel}.pem`, 'private', privatePem)).rejects.toThrow('exactly one');
    expect((await loadCommerceKey(' ', 'private', privatePem)).asymmetricKeyType).toBe('ed25519');
    await expect(loadCommerceKey(' ', 'private', ' ')).rejects.toThrow('not configured');
  });
  it('rejects malformed, extra, encrypted and unsupported asymmetric keys with sanitized errors', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const encrypted = pair.privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: sentinel }).toString();
    const appended = Buffer.concat([pair.privateKey.export({ format: 'der', type: 'pkcs8' }), Buffer.from(sentinel)]);
    const extraDer = `-----BEGIN PRIVATE KEY-----\n${appended.toString('base64')}\n-----END PRIVATE KEY-----`;
    for (const pem of [sentinel, `${sentinel}\n${privatePem}`, privatePem + sentinel, privatePem + publicPem, privatePem + '\0',
      privatePem.replace('BEGIN PRIVATE KEY', 'BEGIN PUBLIC KEY'), privatePem.replace(/\n/g, ''), encrypted, extraDer, 'x'.repeat(16_385),
      rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), ec.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()]) {
      const error = await loadCommerceKey(undefined, 'private', pem).then(() => null, error => error as Error);
      expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(sentinel); expect(String(error)).not.toContain(privatePem.trim());
    }
    for (const key of [rsa.publicKey, ec.publicKey]) await expect(loadCommerceKey(undefined, 'public', key.export({ format: 'pem', type: 'spki' }).toString())).rejects.toThrow('Ed25519');
  });
  it('rejects nonstring key sources without invoking unsafe conversions or leaking their content', async () => {
    const invalid = { secret: sentinel, toString: () => { throw new Error(sentinel); } } as unknown as string;
    for (const operation of [() => loadCommerceKey(invalid, 'private'), () => loadCommerceKey(undefined, 'private', invalid)]) {
      const error = await operation().then(() => null, error => error as Error);
      expect(String(error)).toContain('configuration'); expect(String(error)).not.toContain(sentinel);
    }
  });
  it('maps only the independent provider CA/database into verified connection configuration', async () => {
    const source = { ATLAS_PROVIDER_DATABASE_URL: 'postgresql://synthetic:synthetic@provider.example.com/provider', ATLAS_PROVIDER_DATABASE_SSL_CA: rootCertificates[0],
      DATABASE_URL: `${sentinel}`, DATABASE_SSL_CA: `${sentinel}`, DATABASE_SSL_CA_FILE: `${sentinel}.pem`, ATLAS_PUBLICATION_SIGNING_KEY: privatePem };
    const mapped = independentProviderEnvironment(source);
    expect(Object.keys(mapped).sort()).toEqual(['DATABASE_SSL_CA', 'DATABASE_SSL_CA_FILE', 'DATABASE_URL']);
    expect(mapped.DATABASE_URL).toContain('/provider'); expect(mapped.DATABASE_SSL_CA_FILE).toBeUndefined();
    expect((await loadDatabasePoolConfiguration(mapped)).ssl).toEqual({ rejectUnauthorized: true, ca: rootCertificates[0] });
    await expect(loadDatabasePoolConfiguration(independentProviderEnvironment({ ...source, ATLAS_PROVIDER_DATABASE_SSL_CA_FILE: `${sentinel}.pem` }))).rejects.toThrow('exactly one');
    expect(() => independentProviderEnvironment({ DATABASE_URL: source.ATLAS_PROVIDER_DATABASE_URL })).toThrow('Independent provider database');
  });
  it('loads the same bounded MPP secret from an inline value or an existing file', async () => {
    const secret = 'synthetic-mpp-secret-'.repeat(3);
    expect(await loadProviderMppSecret({ ATLAS_PROVIDER_MPP_SECRET: `\n${secret}\n` })).toBe(secret);
    expect(Buffer.byteLength(await loadProviderMppSecret({ ATLAS_PROVIDER_MPP_SECRET: 'é'.repeat(16) }))).toBe(32);
    const directory = await mkdtemp(join(tmpdir(), 'atlas-cloud-mpp-secret-'));
    try {
      const file = join(directory, 'mpp.txt'); await writeFile(file, `\n${secret}\n`);
      expect(await loadProviderMppSecret({ ATLAS_PROVIDER_MPP_SECRET_FILE: file })).toBe(secret);
      await expect(loadProviderMppSecret({ ATLAS_PROVIDER_MPP_SECRET_FILE: file, ATLAS_PROVIDER_MPP_SECRET: secret })).rejects.toThrow('exactly one');
      await expect(loadProviderMppSecret({ ATLAS_PROVIDER_MPP_SECRET_FILE: directory })).rejects.toThrow('unavailable or invalid');
      await writeFile(file, 'x'.repeat(4097)); await expect(loadProviderMppSecret({ ATLAS_PROVIDER_MPP_SECRET_FILE: file })).rejects.toThrow('unavailable or invalid');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('rejects missing, weak, excessive, conflicting and nonstring MPP configuration without secret/path disclosure', async () => {
    for (const configured of [{}, { ATLAS_PROVIDER_MPP_SECRET: ' ' }, { ATLAS_PROVIDER_MPP_SECRET: 'x'.repeat(31) },
      { ATLAS_PROVIDER_MPP_SECRET: 'é'.repeat(513) }, { ATLAS_PROVIDER_MPP_SECRET: sentinel.repeat(300) },
      { ATLAS_PROVIDER_MPP_SECRET_FILE: `${sentinel}.txt`, ATLAS_PROVIDER_MPP_SECRET: sentinel.repeat(3) },
      { ATLAS_PROVIDER_MPP_SECRET_FILE: `${sentinel}.txt` }, { ATLAS_PROVIDER_MPP_SECRET: { secret: sentinel } }]) {
      const error = await loadProviderMppSecret(configured as Record<string, string>).then(() => null, error => error as Error);
      expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(sentinel);
    }
  });
  it('installs and starts an actual independent provider with only inline public issuer/MPP secrets', async () => {
    const providerId = randomUUID(), workspaceId = randomUUID(), repositoryId = randomUUID(), snapshotId = randomUUID();
    const commitSha = 'a'.repeat(40), providerOrigin = 'https://provider.cloud-secrets.dev';
    const files = [{ path: 'package.json', text: '{"name":"@synthetic/cloud-secrets","version":"1.0.0","exports":{".":"./src/index.ts"}}' },
      { path: 'src/index.ts', text: 'export function synthetic() { return 1; }\n' }];
    const draft = { schemaVersion: 1, id: providerId, workspaceId, repositoryId, snapshotId, commitSha, revision: 1, termsDigest: 'b'.repeat(64), state: 'draft',
      proposal: { packageName: '@synthetic/cloud-secrets', version: '1.0.0', exports: { '.': 'src/index.ts' }, exposedPaths: files.map(file => file.path),
        rightsStatement: 'Synthetic test source only.', accessPolicy: 'private', proposedEndpoint: providerOrigin + '/context/retrieve',
        testnetTerms: { network: MODERATO_NETWORK, operation: 'context.retrieve', token: MODERATO_PATHUSD, recipient: '0x' + '2'.repeat(40), atomicPrice: '1000' } },
      preview: { snapshotId, commitSha, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0),
        files: files.map(file => ({ path: file.path, lines: file.text.split('\n').length, bytes: Buffer.byteLength(file.text), sourceDigest: createHash('sha256').update(file.text).digest('hex') })) },
    } as unknown as PublicationDraft;
    const index = parseRepositoryIndex({ scope: { tenantId: workspaceId, principalId: 'synthetic-owner', permissionRevision: '1' },
      snapshot: { kind: 'git', repositoryId, snapshotId, revision: commitSha }, packageName: draft.proposal.packageName, version: '1.0.0', observedAt: '2026-10-12T00:00:00Z', files });
    const artifact = signPublicationPassages(buildPublicationArtifact(draft, index), pair.privateKey);
    const signed = { artifact, signature: signDocument(artifact, pair.privateKey) };
    const query = vi.fn(async (text: string) => ({ rows: text.startsWith('SELECT artifact,signature,terms_digest') ? [{ ...signed, terms_digest: draft.termsDigest }] : [], rowCount: 0 }));
    const close = vi.fn(async () => {});
    const database = { withAdminTransaction: async (callback: (tx: AtlasTransaction) => Promise<unknown>) => callback({ query } as unknown as AtlasTransaction), close } as unknown as AtlasDatabase;
    const environment = { ATLAS_PROVIDER_ID: providerId, ATLAS_PROVIDER_ORIGIN: providerOrigin, ATLAS_PROVIDER_AUTHORIZATION_ISSUER: 'https://atlas.cloud-secrets.dev',
      ATLAS_PROVIDER_ISSUER_PUBLIC_KEY: publicPem, ATLAS_PROVIDER_MPP_SECRET: 'synthetic-mpp-challenge-secret-'.repeat(2), TEMPO_CHAIN_ID: '42431',
      ATLAS_PROVIDER_RECIPIENT: draft.proposal.testnetTerms!.recipient, ATLAS_PROVIDER_PRICE_UNITS: '1000' };
    await installProviderArtifact(database, environment, signed);
    expect(query.mock.calls.some(([text]) => text.startsWith('INSERT INTO atlas_provider.publications'))).toBe(true);
    const getChainId = vi.fn(async () => 42431);
    const client = { chain: { id: 42431 }, getChainId } as unknown as PublicClient;
    const http = vi.fn(async () => { throw new Error('Network requests are forbidden in this local configuration test'); });
    const provider = await createIndependentProvider(environment, { database, client, http });
    expect((await provider.handle(new Request(providerOrigin + '/health'))).status).toBe(200);
    expect((await provider.handle(new Request(providerOrigin + '/.well-known/atlas-provider.json'))).status).toBe(403);
    expect(http).not.toHaveBeenCalled(); expect(getChainId).toHaveBeenCalledTimes(1);
    await provider.close(); expect(close).toHaveBeenCalledTimes(1);
  });
});
