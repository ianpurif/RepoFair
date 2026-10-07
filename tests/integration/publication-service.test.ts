import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicationService } from '../../apps/worker/src/publication-service.ts';
import { createRepositoryService } from '../../apps/worker/src/repository-service.ts';
import { githubForPrincipal } from '../../apps/worker/src/clerk-github.ts';
import { AtlasDatabaseError } from '../../apps/worker/src/database.ts';
import type { AtlasDatabase, AtlasTransaction } from '../../apps/worker/src/database.ts';
import { GitHubError } from '../../apps/worker/src/github.ts';
import type { GitHubAppClient, VerifiedGitHubUser } from '../../apps/worker/src/github.ts';
import { parseRepositoryIndex } from '../../packages/core/src/local/parser.ts';
import type { PublicationProposal } from '../../packages/contracts/src/index.ts';

vi.mock('../../apps/worker/src/clerk-github.ts', () => ({ githubForPrincipal: vi.fn() }));
vi.mock('../../apps/worker/src/repository-service.ts', () => ({ createRepositoryService: vi.fn() }));
// Real PGlite migration/RLS/transaction operations and genuine synthetic source
// graph; GitHub/Clerk proof is mocked. No hosted identity/concurrency is claimed.
const sql = new PGlite(); const workspaceId = randomUUID(); const repositoryId = randomUUID(); const snapshotId = randomUUID();
const principal = 'user_owner'; const reader = 'user_reader'; const outsider = 'user_outside'; const commitSha = 'a'.repeat(40);
const files = [{ path: 'package.json', text: '{"name":"@example/pkg","version":"1.0.0","exports":{".":"./src/index.ts","./retry":"./src/index.ts"}}' },
  { path: 'src/index.ts', text: 'export function retry(n: number) {\n  return n + 1;\n}\n' },
  { path: 'src/unselected.ts', text: 'export const privateValue = "private-source-sentinel";\n' }];
const index = parseRepositoryIndex({ scope: { tenantId: workspaceId, principalId: principal, permissionRevision: '1:1' },
  snapshot: { kind: 'git', repositoryId, snapshotId, revision: commitSha }, packageName: '@example/pkg', version: '1.0.0', observedAt: '2026-10-07T00:00:00Z', files });
const authority = vi.fn(); const getIndex = vi.fn(); const queries: string[][] = [];
async function transaction<T>(actor: string | null, work: (tx: AtlasTransaction) => Promise<T>): Promise<T> {
  await sql.exec('BEGIN'); const trace: string[] = []; queries.push(trace);
  try {
    await sql.exec(actor ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE NONE');
    await sql.query("SELECT set_config('request.jwt.claims',$1,true),set_config('atlas.authorized_repository_ids','[]',true)", [JSON.stringify(actor ? { sub: actor, role: 'authenticated' } : {})]);
    const result = await work({ query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => {
      trace.push(text); try { const result = await sql.query<Row>(text, values); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, command: '', oid: 0, fields: [] }; }
      catch { throw new AtlasDatabaseError('query', 'Database operation failed'); }
    } }); await sql.exec('COMMIT'); return result;
  } catch (error) { await sql.exec('ROLLBACK'); throw error; }
}
const db = { withPrincipalTransaction: <T>(actor: string, work: (tx: AtlasTransaction) => Promise<T>) => transaction(actor, work),
  withAdminTransaction: <T>(work: (tx: AtlasTransaction) => Promise<T>) => transaction(null, work) } as unknown as AtlasDatabase;
function service() { return createPublicationService(db, {}); }
beforeAll(async () => {
  await sql.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    GRANT USAGE ON SCHEMA auth TO authenticated; GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;`);
  for (const migration of ['202610030001_atlas.sql', '202610070001_personal_workspaces.sql', '202610070002_github_jobs.sql', '202610070003_server_repository_grants.sql', '202610070004_publication_drafts.sql']) await sql.exec(await readFile(`supabase/migrations/${migration}`, 'utf8'));
});
beforeEach(async () => {
  await sql.exec('TRUNCATE atlas.workspaces CASCADE');
  await sql.query('INSERT INTO atlas.workspaces(id,name) VALUES($1,\'Audit workspace\')', [workspaceId]);
  await sql.query("INSERT INTO atlas.memberships(workspace_id,principal_id,role) VALUES($1,$2,'owner'),($1,$3,'reader')", [workspaceId, principal, reader]);
  await sql.query("INSERT INTO atlas.repositories(id,workspace_id,name,visibility,github_repository_id,github_installation_id,github_owner,github_name) VALUES($1,$2,'Audit source','private',100,99,'owner','repository')", [repositoryId, workspaceId]);
  await sql.query("INSERT INTO atlas.snapshots(id,workspace_id,repository_id,revision,status) VALUES($1,$2,$3,$4,'complete')", [snapshotId, workspaceId, repositoryId, commitSha]);
  vi.clearAllMocks(); queries.length = 0;
  authority.mockResolvedValue({ repository: { id: 100 }, principalId: principal, githubUserId: 10, authority: 'personal-owner' });
  getIndex.mockResolvedValue(index);
  vi.mocked(createRepositoryService).mockReturnValue({ getIndex } as unknown as ReturnType<typeof createRepositoryService>);
  vi.mocked(githubForPrincipal).mockResolvedValue({ client: { authorizePublication: authority } as unknown as GitHubAppClient,
    user: { principalId: principal, githubUserId: 10, login: 'owner' } as VerifiedGitHubUser });
});
afterAll(async () => { await sql.close(); });
function proposal(changes: Partial<PublicationProposal> = {}): PublicationProposal { return { packageName: index.packageName, version: index.version, exports: {}, exposedPaths: [], rightsStatement: '', accessPolicy: 'private', proposedEndpoint: null, testnetTerms: null, ...changes }; }
describe('private publication administrative drafts', () => {
  it('canonicalizes case-insensitive workspace IDs before lock keys and digest binding', async () => {
    const draft = await service().createDraft(principal, workspaceId.toUpperCase(), repositoryId);
    expect(draft.workspaceId).toBe(workspaceId);
    expect((await service().getDraft(principal, draft.id)).termsDigest).toBe(draft.termsDigest);
  });
  it('does not promote module symbols into undeclared or conflicting package export mappings', async () => {
    const draft = await service().createDraft(principal, workspaceId, repositoryId);
    await expect(service().updateDraft(principal, draft.id, 1, proposal({ exposedPaths: ['src/unselected.ts'], exports: { './privateValue': 'src/unselected.ts' } }))).rejects.toMatchObject({ code: 'export-unverified' });
    const conflictFiles = files.map(file => file.path === 'package.json' ? { ...file, text: JSON.stringify({ name: '@example/pkg', version: '1.0.0', exports: { '.': './src/index.ts', './privateValue': './src/index.ts' } }) } : file);
    getIndex.mockResolvedValue(parseRepositoryIndex({ scope: index.scope, snapshot: index.snapshot, packageName: index.packageName, version: index.version, observedAt: '2026-10-07T00:00:00Z', files: conflictFiles }));
    await expect(service().updateDraft(principal, draft.id, 1, proposal({ exposedPaths: ['src/unselected.ts'], exports: { './privateValue': 'src/unselected.ts' } }))).rejects.toMatchObject({ code: 'export-unverified' });
  });
  it('caps creation atomically while keeping all retained drafts and revocations readable', async () => {
    for (let count = 0; count < 50; count++) {
      const draft = await service().createDraft(principal, workspaceId, repositoryId);
      if (count % 10 === 0) await service().revokeDraft(principal, draft.id, draft.revision);
    }
    await expect(service().createDraft(principal, workspaceId, repositoryId)).rejects.toMatchObject({ code: 'draft-limit', status: 422 });
    const history = await service().listDrafts(principal, workspaceId);
    expect(history).toHaveLength(50); expect(history.filter(draft => draft.state === 'revoked')).toHaveLength(5);
  });
  it('creates a private empty-exposure draft without publishing, approval, endpoint proof, model or payment actions', async () => {
    const draft = await service().createDraft(principal, workspaceId, repositoryId);
    expect(draft).toMatchObject({ revision: 1, state: 'draft', published: false, approval: null, endpointProof: 'unverified', payment: 'disabled', rights: 'not-declared', accuracy: 'unverified' });
    expect(draft.proposal).toEqual(proposal()); expect(draft.preview).toMatchObject({ snapshotId, commitSha, files: [], fileCount: 0, totalBytes: 0 });
    expect(draft.administration).toMatchObject({ status: 'verified', basis: 'personal-owner' }); expect(Number.isFinite(Date.parse(draft.administration.checkedAt))).toBe(true);
    expect(JSON.stringify(draft)).not.toContain('private-source-sentinel'); expect((await service().getDraft(principal, draft.id)).termsDigest).toBe(draft.termsDigest);
    expect(await service().listDrafts(principal, workspaceId)).toHaveLength(1);
    expect((await sql.query('SELECT * FROM atlas.purchases')).rows).toHaveLength(0);
  });
  it('denies workspace readers and outsiders before GitHub proof or source reads', async () => {
    for (const actor of [reader, outsider]) await expect(service().createDraft(actor, workspaceId, repositoryId)).rejects.toMatchObject({ code: 'denied', status: 403 });
    expect(githubForPrincipal).not.toHaveBeenCalled(); expect(getIndex).not.toHaveBeenCalled();
  });
  it('requires distinct current GitHub administration even for workspace owners with repository read access', async () => {
    authority.mockRejectedValue(new GitHubError('unauthorized', 'Read is not administration'));
    await expect(service().createDraft(principal, workspaceId, repositoryId)).rejects.toMatchObject({ code: 'publication-authority-required', status: 403 });
    expect(getIndex).not.toHaveBeenCalled(); expect((await sql.query('SELECT id FROM atlas.publication_drafts')).rows).toHaveLength(0);
  });
  it('previews only explicitly selected real files, validates actual export mappings, and binds all terms to new revision/digest', async () => {
    const draft = await service().createDraft(principal, workspaceId, repositoryId);
    const changed = proposal({ exposedPaths: ['src/index.ts'], exports: { '.': 'src/index.ts' }, rightsStatement: 'I declare permission to offer this selected source.', accessPolicy: 'public',
      proposedEndpoint: 'https://provider.example/context', testnetTerms: { network: 'eip155:42431', operation: 'context.retrieve', token: `0x${'1'.repeat(40)}`, recipient: `0x${'2'.repeat(40)}`, atomicPrice: '1000' } });
    const saved = await service().updateDraft(principal, draft.id, 1, changed);
    expect(saved.revision).toBe(2); expect(saved.termsDigest).not.toBe(draft.termsDigest); expect(saved.rights).toBe('declared');
    expect(saved.preview).toMatchObject({ fileCount: 1, totalBytes: Buffer.byteLength(files[1]!.text), files: [{ path: 'src/index.ts', lines: 4, bytes: Buffer.byteLength(files[1]!.text), sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
    expect(saved).toMatchObject({ published: false, approval: null, endpointProof: 'unverified', payment: 'disabled', accuracy: 'unverified' });
    expect(JSON.stringify(saved)).not.toContain(files[1]!.text); expect(JSON.stringify(saved)).not.toContain('private-source-sentinel');
    expect((await service().getDraft(principal, saved.id)).termsDigest).toBe(saved.termsDigest);
    await expect(service().updateDraft(principal, saved.id, 1, changed)).rejects.toMatchObject({ code: 'revision-conflict', status: 409 });
  });
  it('rejects invented versions, paths, exports, verification flags, endpoints, policy and money units', async () => {
    const draft = await service().createDraft(principal, workspaceId, repositoryId);
    const invalid: unknown[] = [proposal({ version: '2.0.0' }), proposal({ version: 'latest' }), proposal({ exposedPaths: ['../secret.ts'] }), proposal({ exposedPaths: ['./src/index.ts'] }),
      proposal({ exposedPaths: ['src/missing.ts'] }), proposal({ exposedPaths: ['src/index.ts', 'src/index.ts'] }), proposal({ exports: { '.': 'src/index.ts' } }),
      proposal({ exposedPaths: ['src/index.ts'], exports: { './invented': 'src/index.ts' } }), { ...proposal(), published: true }, { ...proposal(), approval: { trusted: true } },
      proposal({ proposedEndpoint: 'http://provider.example/context' }), proposal({ proposedEndpoint: 'https://localhost/context' }), proposal({ proposedEndpoint: 'https://127.0.0.1/context' }), proposal({ proposedEndpoint: 'https://user:secret@provider.example/context' }),
      { ...proposal(), accessPolicy: 'everyone' }, { ...proposal(), testnetTerms: { network: 'eip155:4217', operation: 'context.retrieve', token: `0x${'1'.repeat(40)}`, recipient: `0x${'2'.repeat(40)}`, atomicPrice: '1' } },
      { ...proposal(), testnetTerms: { network: 'eip155:42431', operation: 'context.retrieve', token: `0x${'1'.repeat(40)}`, recipient: `0x${'2'.repeat(40)}`, atomicPrice: '1.5' } }];
    for (const value of invalid) await expect(service().updateDraft(principal, draft.id, 1, value)).rejects.toMatchObject({ status: 400 });
    expect((await service().getDraft(principal, draft.id)).revision).toBe(1);
  });
  it('requires admin role and server repository grant in real SQL RLS and denies authenticated mutations', async () => {
    const draft = await service().createDraft(principal, workspaceId, repositoryId);
    expect((await db.withPrincipalTransaction(principal, tx => tx.query('SELECT id FROM atlas.publication_drafts'))).rows).toHaveLength(0);
    const allowed = await db.withPrincipalTransaction(principal, async tx => { await tx.query("SELECT set_config('atlas.authorized_repository_ids',$1,true)", [JSON.stringify([repositoryId])]); return tx.query('SELECT id FROM atlas.publication_drafts'); });
    expect(allowed.rows).toEqual([{ id: draft.id }]);
    const denied = await db.withPrincipalTransaction(reader, async tx => { await tx.query("SELECT set_config('atlas.authorized_repository_ids',$1,true)", [JSON.stringify([repositoryId])]); return tx.query('SELECT id FROM atlas.publication_drafts'); });
    expect(denied.rows).toHaveLength(0);
    await expect(db.withPrincipalTransaction(principal, tx => tx.query("UPDATE atlas.publication_drafts SET state='revoked' WHERE id=$1", [draft.id]))).rejects.toBeInstanceOf(AtlasDatabaseError);
    for (const set of ["published=true", "approval='{}'::jsonb", "endpoint_proof='verified'", "payment='enabled'"]) await expect(db.withAdminTransaction(tx => tx.query(`UPDATE atlas.publication_drafts SET ${set} WHERE id=$1`, [draft.id]))).rejects.toBeInstanceOf(AtlasDatabaseError);
  });
  it('rechecks membership and repository revisions under repository-first locks before writes', async () => {
    authority.mockImplementationOnce(async () => ({ repository: { id: 100 }, principalId: principal, authority: 'personal-owner' }))
      .mockImplementationOnce(async () => { await sql.query('UPDATE atlas.memberships SET revision=2 WHERE workspace_id=$1', [workspaceId]); return { repository: { id: 100 }, principalId: principal, authority: 'personal-owner' }; });
    await expect(service().createDraft(principal, workspaceId, repositoryId)).rejects.toMatchObject({ code: 'authorization-changed' });
    expect((await sql.query('SELECT id FROM atlas.publication_drafts')).rows).toHaveLength(0);
    for (const trace of queries) { const repository = trace.findIndex(query => /FROM atlas.repositories[\s\S]*FOR UPDATE/.test(query));
      const membership = trace.findIndex(query => /FROM atlas.memberships[\s\S]*FOR SHARE/.test(query)); if (membership >= 0) expect(repository).toBeLessThan(membership); }
  });
  it('rechecks fresh GitHub administration before persistence and before every draft read', async () => {
    const draft = await service().createDraft(principal, workspaceId, repositoryId);
    authority.mockResolvedValueOnce({ repository: { id: 100 }, principalId: principal, authority: 'personal-owner' }).mockRejectedValueOnce(new GitHubError('unauthorized', 'Revoked'));
    await expect(service().updateDraft(principal, draft.id, 1, proposal())).rejects.toMatchObject({ code: 'publication-authority-required' });
    authority.mockRejectedValue(new GitHubError('unauthorized', 'Revoked')); queries.length = 0;
    await expect(service().getDraft(principal, draft.id)).rejects.toMatchObject({ code: 'publication-authority-required' });
    expect(await service().listDrafts(principal, workspaceId)).toEqual([]);
    expect(queries.flat().some(query => /SELECT d\.\*/.test(query))).toBe(true); // RLS list reads carry an empty proof grant.
    expect((await sql.query<{ revision: string }>('SELECT revision::text FROM atlas.publication_drafts WHERE id=$1', [draft.id])).rows[0]?.revision).toBe('1');
  });
  it('denies a current role downgrade even when a membership revision was not bumped', async () => {
    const draft = await service().createDraft(principal, workspaceId, repositoryId);
    authority.mockImplementationOnce(async () => { await sql.query("UPDATE atlas.memberships SET role='reader' WHERE workspace_id=$1 AND principal_id=$2", [workspaceId, principal]);
      return { repository: { id: 100 }, principalId: principal, authority: 'personal-owner' }; });
    await expect(service().getDraft(principal, draft.id)).rejects.toMatchObject({ code: 'authorization-changed' });
    await expect(service().listDrafts(principal, workspaceId)).rejects.toMatchObject({ code: 'denied' });
  });
  it('rejects a proposal over64KiB and refuses stored metadata whose digest was tampered', async () => {
    const draft = await service().createDraft(principal, workspaceId, repositoryId);
    const additional = Array.from({ length: 191 }, (_, n) => ({ path: `src/${'a'.repeat(350)}-${n}.ts`, text: 'export const value = 1;' }));
    const boundedIndex = parseRepositoryIndex({ scope: index.scope, snapshot: index.snapshot, packageName: index.packageName, version: index.version,
      observedAt: '2026-10-07T00:00:00Z', files: [files[0]!, ...additional] });
    getIndex.mockResolvedValueOnce(boundedIndex);
    await expect(service().updateDraft(principal, draft.id, 1, proposal({ exposedPaths: additional.map(file => file.path) }))).rejects.toMatchObject({ code: 'proposal-limit', status: 413 });
    await sql.query("UPDATE atlas.publication_drafts SET terms_digest=$1 WHERE id=$2", ['0'.repeat(64), draft.id]);
    await expect(service().getDraft(principal, draft.id)).rejects.toMatchObject({ code: 'draft-invalid' });
  });
  it('binds every edited proposed term and exposure selection to its own revision and digest', async () => {
    const draft = await service().createDraft(principal, workspaceId, repositoryId); let current = draft;
    const terms: PublicationProposal['testnetTerms'] = { network: 'eip155:42431', operation: 'context.retrieve', token: `0x${'1'.repeat(40)}`, recipient: `0x${'2'.repeat(40)}`, atomicPrice: '1000' };
    for (const changes of [{ exposedPaths: ['src/index.ts'] }, { exports: { './retry': 'src/index.ts' } }, { rightsStatement: 'I declare publication rights.' },
      { accessPolicy: 'authenticated' }, { proposedEndpoint: 'https://provider.example/context' }, { testnetTerms: terms },
      { testnetTerms: { ...terms, atomicPrice: '2000' } }, { testnetTerms: { ...terms, recipient: `0x${'3'.repeat(40)}` } }] as Partial<PublicationProposal>[]) {
      const next = await service().updateDraft(principal, current.id, current.revision, { ...current.proposal, ...changes });
      expect(next.termsDigest).not.toBe(current.termsDigest); expect(next.revision).toBe(current.revision + 1);
      expect(next).toMatchObject({ published: false, approval: null, endpointProof: 'unverified', payment: 'disabled' }); current = next;
    }
  });
  it('retains revoked records, changes digest/revision, refuses later edits and never publishes', async () => {
    const draft = await service().createDraft(principal, workspaceId, repositoryId); const revoked = await service().revokeDraft(principal, draft.id, 1);
    expect(revoked).toMatchObject({ state: 'revoked', revision: 2, published: false, approval: null, payment: 'disabled' }); expect(revoked.termsDigest).not.toBe(draft.termsDigest);
    expect((await service().revokeDraft(principal, draft.id, 2)).termsDigest).toBe(revoked.termsDigest);
    await expect(service().updateDraft(principal, draft.id, 2, proposal())).rejects.toMatchObject({ code: 'draft-revoked' });
    expect((await sql.query('SELECT id FROM atlas.publication_drafts')).rows).toHaveLength(1);
  });
  it('keeps old immutable draft identity and refuses edits using a newer repository snapshot', async () => {
    const draft = await service().createDraft(principal, workspaceId, repositoryId);
    getIndex.mockResolvedValue({ ...index, snapshot: { ...index.snapshot, snapshotId: randomUUID(), revision: 'b'.repeat(40) } });
    await expect(service().updateDraft(principal, draft.id, 1, proposal())).rejects.toMatchObject({ code: 'snapshot-changed' });
    expect((await service().getDraft(principal, draft.id)).commitSha).toBe(commitSha);
  });
});
