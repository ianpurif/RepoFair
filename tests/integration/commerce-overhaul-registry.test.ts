import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { BodyDigest } from 'mppx';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicationDraft, PublicationProposal } from '../../packages/contracts/src/index.ts';
import { MODERATO_NETWORK, MODERATO_PATHUSD } from '../../packages/contracts/src/commerce.ts';
import { parseRepositoryIndex } from '../../packages/core/src/local/parser.ts';
import { AtlasDatabase } from '../../apps/worker/src/database.ts';
import type { AtlasPool } from '../../apps/worker/src/database.ts';
import { githubForPrincipal } from '../../apps/worker/src/clerk-github.ts';
import { GitHubError } from '../../apps/worker/src/github.ts';
import type { GitHubAppClient, VerifiedGitHubUser } from '../../apps/worker/src/github.ts';
import { createRepositoryService } from '../../apps/worker/src/repository-service.ts';
import { createPublicationService } from '../../apps/worker/src/publication-service.ts';
import { createPublicationRegistry } from '../../apps/worker/src/publication-registry.ts';
import { verifyProviderGrant, verifyPublicationControlProof } from '../../apps/worker/src/commerce-signatures.ts';
import { verifyPublicationArtifact } from '../../apps/worker/src/publication-artifact.ts';
import type { ProviderHttp } from '../../apps/worker/src/provider-http.ts';

vi.mock('../../apps/worker/src/clerk-github.ts', () => ({ githubForPrincipal: vi.fn() }));
vi.mock('../../apps/worker/src/repository-service.ts', () => ({ createRepositoryService: vi.fn() }));
// Native service/database/signature and exact-source operations execute.
// Remote Clerk/GitHub proofs and endpoint transport are explicit injected
// test doubles. Barriers change actual SQL rows while remote proof is pending.
const sql = new PGlite(); const keys = generateKeyPairSync('ed25519');
const sourceWorkspace = randomUUID(); const purchaseWorkspace = randomUUID(); const repositoryId = randomUUID(); const snapshotId = randomUUID();
const owner = 'user_verifierowner'; const buyer = 'user_verifierbuyer'; const outsider = 'user_verifieroutsider'; const sessionId = 'sess_verifier';
const issuer = 'https://atlas.registry-verifier.dev'; const origin = 'https://provider.registry-verifier.dev'; const commitSha = 'a'.repeat(40);
const files = [{ path: 'package.json', text: '{"name":"@verifier/registry","version":"1.0.0","exports":{".":"./src/index.ts"}}' },
  { path: 'src/index.ts', text: 'export function retry(value: number) {\n  return value + 1;\n}\n' }];
const index = parseRepositoryIndex({ scope: { tenantId: sourceWorkspace, principalId: owner, permissionRevision: '1:1' },
  snapshot: { kind: 'git', repositoryId, snapshotId, revision: commitSha }, packageName: '@verifier/registry', version: '1.0.0', observedAt: '2026-10-11T00:00:00Z', files });
const proposal: PublicationProposal = { packageName: '@verifier/registry', version: '1.0.0', exports: { '.': 'src/index.ts' }, exposedPaths: ['package.json', 'src/index.ts'],
  rightsStatement: 'Synthetic verification source explicitly approved for this isolated test.', accessPolicy: 'private', proposedEndpoint: origin + '/context/retrieve',
  testnetTerms: { network: MODERATO_NETWORK, operation: 'context.retrieve', token: MODERATO_PATHUSD, recipient: '0x' + '2'.repeat(40), atomicPrice: '1000' } };
let directory = ''; let environment: Record<string, string> = {}; let current: PublicationDraft; let now = Date.now();
const authority = vi.fn(); const getIndex = vi.fn(); const getGraph = vi.fn(); const sessionActive = vi.fn();
const requestDigest = BodyDigest.compute('{"question":"retry","version":"1.0.0"}'); const idem = 'registry_request_00000001';
let transport: ProviderHttp;
const http: ProviderHttp = vi.fn(async (url, options) => transport(url, options));
const traces: string[][] = []; let tail: Promise<void> = Promise.resolve();
const pool = Object.assign(new EventEmitter(), {
  connect: async () => {
    const previous = tail; let releaseQueue = () => {};
    tail = new Promise<void>(complete => { releaseQueue = complete; }); await previous;
    const trace: string[] = []; traces.push(trace);
    return Object.assign(new EventEmitter(), {
      query: async (text: string, values?: unknown[]) => {
        trace.push(text); const result = await sql.query(text, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, command: '', oid: 0, fields: [] };
      }, release: () => { releaseQueue(); },
    });
  }, end: async () => {},
}) as unknown as AtlasPool;
const database = new AtlasDatabase(pool);
function registry() { return createPublicationRegistry(database, environment, { http, now: () => now, sessionActive }); }
function approval() { return { expectedRevision: current.revision, termsDigest: current.termsDigest, exposureApproved: true }; }
function manifest(nonce: string) { return { schemaVersion: 1, mode: 'tempo-testnet', providerId: current.id, nonce, origin, operation: 'context.retrieve',
  publicationDigest: current.termsDigest, packageName: proposal.packageName, version: proposal.version, commitSha, network: MODERATO_NETWORK,
  token: MODERATO_PATHUSD, tokenDecimals: 6, recipient: proposal.testnetTerms!.recipient, atomicPrice: '1000', realm: 'registry-verifier', authorizationIssuer: issuer }; }
async function activate() { return registry().activateDraft(owner, current.id, approval()); }
function barrier() {
  let release = () => {}; let started = () => {};
  const arrived = new Promise<void>(complete => { started = complete; });
  const wait = new Promise<void>(complete => { release = complete; });
  return { arrived, release, wait, started };
}
beforeAll(async () => {
  await sql.exec("CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$; GRANT USAGE ON SCHEMA auth TO authenticated; GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;");
  for (const migration of (await readdir('supabase/migrations')).filter(file => file.endsWith('.sql')).sort()) await sql.exec(await readFile(join('supabase/migrations', migration), 'utf8'));
  directory = await mkdtemp(join(tmpdir(), 'atlas-overhaul-registry-verifier-')); const privateFile = join(directory, 'issuer-private.pem');
  await writeFile(privateFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  environment = { ATLAS_PUBLIC_ORIGIN: issuer, ATLAS_PUBLICATION_SIGNING_KEY_FILE: privateFile };
}, 30_000);
beforeEach(async () => {
  await sql.exec('TRUNCATE atlas.workspaces CASCADE');
  await sql.query("INSERT INTO atlas.workspaces(id,name) VALUES($1,'Publication source'),($2,'Buyer spending')", [sourceWorkspace, purchaseWorkspace]);
  await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role) VALUES($1,$2,'owner'),($1,$3,'reader'),($4,$3,'owner')", [sourceWorkspace, owner, buyer, purchaseWorkspace]);
  await sql.query("INSERT INTO atlas.repositories(id,workspace_id,name,visibility,github_repository_id,github_installation_id,github_owner,github_name) VALUES($1,$2,'Synthetic publication source','private',100,99,'verifier','source')", [repositoryId, sourceWorkspace]);
  await sql.query("INSERT INTO atlas.snapshots(id,workspace_id,repository_id,revision,status) VALUES($1,$2,$3,$4,'complete')", [snapshotId, sourceWorkspace, repositoryId, commitSha]);
  authority.mockReset(); getIndex.mockReset(); getGraph.mockReset(); sessionActive.mockReset(); vi.mocked(http).mockClear(); now = Date.now();
  authority.mockResolvedValue({ repository: { id: 100 }, principalId: owner, githubUserId: 10, authority: 'personal-owner' });
  getIndex.mockResolvedValue(index);
  getGraph.mockImplementation(async (actor: string) => {
    const row = (await sql.query<{ revision: string; permission_revision: string }>('SELECT m.revision::text,r.permission_revision::text FROM atlas.memberships m JOIN atlas.repositories r ON r.workspace_id=m.workspace_id WHERE m.workspace_id=$1 AND m.principal_id=$2 AND r.id=$3 AND NOT r.access_revoked', [sourceWorkspace, actor, repositoryId])).rows[0];
    if (!row) throw new Error('Synthetic private source access is denied');
    return { scope: { tenantId: sourceWorkspace, principalId: actor, permissionRevision: row.revision + ':' + row.permission_revision } };
  });
  sessionActive.mockResolvedValue(true);
  vi.mocked(createRepositoryService).mockReturnValue({ getIndex, getGraph } as unknown as ReturnType<typeof createRepositoryService>);
  vi.mocked(githubForPrincipal).mockResolvedValue({ client: { authorizePublication: authority } as unknown as GitHubAppClient,
    user: { principalId: owner, githubUserId: 10, login: 'verifier' } as VerifiedGitHubUser });
  const initial = await createPublicationService(database, {}).createDraft(owner, sourceWorkspace, repositoryId);
  current = await createPublicationService(database, {}).updateDraft(owner, initial.id, initial.revision, proposal);
  transport = async (url, options) => {
    const nonce = new URL(url).searchParams.get('nonce')!;
    verifyPublicationControlProof(options!.headers!['X-Atlas-Publication-Control']!, keys.publicKey,
      { id: current.id, revision: current.revision, digest: current.termsDigest, origin, nonce }, now);
    return Response.json(manifest(nonce));
  };
  traces.length = 0; authority.mockClear(); getGraph.mockClear();
});
afterAll(async () => {
  await database.close(); await sql.close();
  if (directory) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.split(/[\\/]/).at(-1)?.startsWith('atlas-overhaul-registry-verifier-')) throw new Error('Temporary verifier cleanup target is invalid');
    await rm(directory, { recursive: true, force: true });
  }
});
describe('actual publication registration and fresh authorization fences', () => {
  it('requires explicit owner approval before source export and binds the real selected snapshot', async () => {
    await expect(registry().exportDraft(owner, current.id, { ...approval(), exposureApproved: false })).rejects.toMatchObject({ code: 'explicit-approval-required' });
    await expect(registry().exportDraft(buyer, current.id, approval())).rejects.toThrow();
    const signed = await registry().exportDraft(owner, current.id, approval());
    expect(verifyPublicationArtifact(signed, keys.publicKey).artifact.files.map(file => file.path)).toEqual(proposal.exposedPaths);
    expect(signed.artifact.commitSha).toBe(commitSha); expect(http).not.toHaveBeenCalled();
  });
  it('activates only with a signed scoped endpoint-control proof and denies mismatched installed terms', async () => {
    const active = await activate(); expect(active).toMatchObject({ id: current.id, state: 'active', version: '1.0.0', commitSha });
    expect(vi.mocked(http).mock.calls[0]![1]!.headers!['X-Atlas-Publication-Control']).toBeTruthy();
    transport = async url => Response.json({ ...manifest(new URL(url).searchParams.get('nonce')!), recipient: '0x' + '3'.repeat(40) });
    await expect(activate()).rejects.toMatchObject({ code: 'endpoint-proof-mismatch' });
    expect((await sql.query<{ state: string }>('SELECT state FROM atlas.publications')).rows[0]!.state).toBe('active');
  });
  it('does not reveal private catalog metadata across tenant boundaries and requires exact release filters', async () => {
    await activate();
    expect(await registry().catalog(outsider)).toEqual([]); expect(getGraph).not.toHaveBeenCalled();
    expect(await registry().catalog(buyer, proposal.packageName, '1.0.1')).toEqual([]);
    expect(await registry().catalog(buyer, proposal.packageName, 'latest')).toEqual([]);
    expect(await registry().catalog(buyer, proposal.packageName, '1.0.0')).toHaveLength(1);
    expect(getGraph).toHaveBeenCalledWith(buyer, repositoryId, { snapshotId, limit: 1 });
  });
  it('issues an audience-scoped request-bound grant and independently refreshes it during introspection', async () => {
    await activate(); const issued = await registry().grant(buyer, sessionId, purchaseWorkspace, current.id, requestDigest, idem);
    expect(verifyProviderGrant(issued.token, keys.publicKey, issuer, current.id, now)).toMatchObject({ principalId: buyer, workspaceId: purchaseWorkspace, publicationDigest: current.termsDigest, requestDigest });
    expect(await registry().introspect(issued.token)).toEqual(issued.grant); expect(sessionActive).toHaveBeenCalledTimes(2);
    sessionActive.mockResolvedValue(false);
    await expect(registry().introspect(issued.token)).rejects.toMatchObject({ code: 'delegation-denied' });
  });
  it('rejects membership deletion during the remote session check before creating a grant', async () => {
    await activate(); const pause = barrier(); sessionActive.mockImplementationOnce(async () => { pause.started(); await pause.wait; return true; });
    const pending = registry().grant(buyer, sessionId, purchaseWorkspace, current.id, requestDigest, idem).then(() => null, error => error);
    await pause.arrived; await sql.query('DELETE FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2', [purchaseWorkspace, buyer]); pause.release();
    expect(await pending).toMatchObject({ code: 'delegation-denied' });
  });
  it('rejects revoked-and-regranted membership with a newer revision during session verification', async () => {
    await activate(); const pause = barrier(); sessionActive.mockImplementationOnce(async () => { pause.started(); await pause.wait; return true; });
    const pending = registry().grant(buyer, sessionId, purchaseWorkspace, current.id, requestDigest, idem).then(() => null, error => error);
    await pause.arrived;
    await sql.query('DELETE FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2', [purchaseWorkspace, buyer]);
    await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role,revision) VALUES($1,$2,'owner',2)", [purchaseWorkspace, buyer]); pause.release();
    expect(await pending).toMatchObject({ code: 'delegation-denied' });
  });
  it('rejects membership revision changes during introspection after the initial grant check', async () => {
    await activate(); const issued = await registry().grant(buyer, sessionId, purchaseWorkspace, current.id, requestDigest, idem);
    const pause = barrier(); sessionActive.mockImplementationOnce(async () => { pause.started(); await pause.wait; return true; });
    const pending = registry().introspect(issued.token).then(() => null, error => error);
    await pause.arrived; await sql.query('UPDATE atlas.memberships SET revision=revision+1 WHERE workspace_id=$1 AND principal_id=$2', [purchaseWorkspace, buyer]); pause.release();
    expect(await pending).toMatchObject({ code: 'delegation-denied' });
  });
  it('rejects publication revocation while remote session verification is pending', async () => {
    await activate(); const pause = barrier(); sessionActive.mockImplementationOnce(async () => { pause.started(); await pause.wait; return true; });
    const pending = registry().grant(buyer, sessionId, purchaseWorkspace, current.id, requestDigest, idem).then(() => null, error => error);
    await pause.arrived; await sql.query("UPDATE atlas.publications SET state='revoked' WHERE id=$1", [current.id]); pause.release();
    expect(await pending).toMatchObject({ code: 'publication-unavailable' });
  });
  it('rejects a draft change after the candidate publication read and refreshes administrative proof', async () => {
    await activate();
    authority.mockImplementationOnce(async () => {
      await createPublicationService(database, {}).revokeDraft(owner, current.id, current.revision);
      return { repository: { id: 100 }, principalId: owner, githubUserId: 10, authority: 'personal-owner' };
    });
    await expect(registry().available(buyer, current.id)).rejects.toMatchObject({ code: 'publication-unavailable' });
    expect((await sql.query<{ state: string }>('SELECT state FROM atlas.publications')).rows[0]!.state).toBe('revoked');
  });
  it('rejects private-source revision changes between graph authorization and the final publication fence', async () => {
    await activate();
    getGraph.mockImplementationOnce(async () => {
      await sql.query('UPDATE atlas.memberships SET revision=2 WHERE workspace_id=$1 AND principal_id=$2', [sourceWorkspace, buyer]);
      return { scope: { tenantId: sourceWorkspace, principalId: buyer, permissionRevision: '1:1' } };
    });
    await expect(registry().available(buyer, current.id)).rejects.toMatchObject({ code: 'delegation-denied' });
  });
  it('denies publishing after administrative downgrade even if the membership revision was not updated', async () => {
    const pause = barrier(); authority.mockImplementationOnce(async () => { pause.started(); await pause.wait; return { repository: { id: 100 }, principalId: owner, authority: 'personal-owner' }; });
    const pending = registry().exportDraft(owner, current.id, approval()).then(() => null, error => error);
    await pause.arrived; await sql.query("UPDATE atlas.memberships SET role='reader' WHERE workspace_id=$1 AND principal_id=$2", [sourceWorkspace, owner]); pause.release();
    expect(await pending).toMatchObject({ code: 'authorization-changed' }); expect(http).not.toHaveBeenCalled();
  });
  it('denies expired grants and current GitHub administration revocation before source entitlement', async () => {
    await activate(); const issued = await registry().grant(buyer, sessionId, purchaseWorkspace, current.id, requestDigest, idem);
    now = issued.grant.expiresAtMs;
    await expect(registry().introspect(issued.token)).rejects.toMatchObject({ code: 'delegation-denied' });
    now = Date.now(); authority.mockRejectedValue(new GitHubError('unauthorized', 'Synthetic administration revoked'));
    await expect(registry().available(buyer, current.id)).rejects.toMatchObject({ code: 'publication-authority-required' });
  });
  it('keeps repository-first trusted mutation locks while authenticated readers retain no UPDATE privilege', async () => {
    await activate(); await registry().grant(buyer, sessionId, purchaseWorkspace, current.id, requestDigest, idem);
    for (const trace of traces) {
      const repositoryLock = trace.findIndex(text => /FROM atlas.repositories.*FOR UPDATE/.test(text));
      const draftLock = trace.findIndex(text => /FROM atlas.publication_drafts.*FOR UPDATE/.test(text));
      if (draftLock >= 0) expect(repositoryLock).toBeGreaterThanOrEqual(0);
      if (draftLock >= 0) expect(repositoryLock).toBeLessThan(draftLock);
      if (trace.includes('SET LOCAL ROLE authenticated')) expect(trace.some(text => /FOR (?:UPDATE|SHARE)/.test(text))).toBe(false);
    }
    await expect(database.withPrincipalTransaction(buyer, tx => tx.query("UPDATE atlas.publications SET state='active'"))).rejects.toThrow();
  });
});
