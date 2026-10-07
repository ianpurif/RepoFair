import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { PublicationDraft, PublicationPreview, PublicationProposal, RepositoryIndex } from '../../../packages/contracts/src/index.ts';
import { isSafeRelativePath } from '../../../packages/core/src/evidence.ts';
import { isExactVersion } from '../../../packages/core/src/versions.ts';
import { LOCAL_LIMITS } from '../../../packages/core/src/local/limits.ts';
import type { AtlasDatabase, AtlasTransaction } from './database.ts';
import { GitHubError } from './github.ts';
import type { GitHubPublishingAuthority } from './github.ts';
import { githubForPrincipal } from './clerk-github.ts';
import { createRepositoryService } from './repository-service.ts';

export class PublicationServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 503) { super(message); this.name = 'PublicationServiceError'; }
}
function fail(code: string, message: string, status = 400): never { throw new PublicationServiceError(code, message, status); }
function assert(condition: unknown, code: string, message: string, status = 400): asserts condition { if (!condition) fail(code, message, status); }
function uuid(value: string): string { assert(typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value), 'invalid-id', 'Invalid draft, workspace or repository identifier'); return value.toLowerCase(); }
function actor(value: string): void { assert(typeof value === 'string' && /^user_[A-Za-z0-9]+$/.test(value), 'denied', 'Verified sign-in is required', 401); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function keys(value: Record<string, unknown>, expected: readonly string[]): void { assert(Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)), 'invalid-proposal', 'Use only the supported proposal fields'); }
function revision(value: unknown): number { assert(Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < Number.MAX_SAFE_INTEGER, 'invalid-revision', 'A valid expected draft revision is required'); return value as number; }
function path(value: unknown): string { assert(typeof value === 'string' && value.length <= 1000 && isSafeRelativePath(value), 'invalid-path', 'Select exact repository-relative source paths'); return value; }
function address(value: unknown): string { assert(typeof value === 'string' && /^0x[a-f0-9]{40}$/i.test(value) && !/^0x0{40}$/i.test(value), 'invalid-terms', 'Use a nonzero testnet token or recipient address'); return value.toLowerCase(); }
function endpoint(value: unknown): string | null {
  if (value === null) return null;
  assert(typeof value === 'string' && value.length <= 2000, 'invalid-endpoint', 'Use a proposed HTTPS endpoint');
  let url: URL; try { url = new URL(value); } catch { return fail('invalid-endpoint', 'Use a proposed HTTPS endpoint'); }
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && (!url.port || url.port === '443')
    && !isIP(url.hostname.replace(/^\[|\]$/g, '')) && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(url.hostname)
    && !/(?:^|\.)(?:localhost|local|internal|test)$/i.test(url.hostname), 'invalid-endpoint', 'Use a public HTTPS endpoint without credentials or query parameters');
  return url.href;
}
function validateProposal(value: unknown, index?: RepositoryIndex): PublicationProposal {
  assert(record(value), 'invalid-proposal', 'A complete publication proposal is required');
  keys(value, ['packageName', 'version', 'exports', 'exposedPaths', 'rightsStatement', 'accessPolicy', 'proposedEndpoint', 'testnetTerms']);
  assert(typeof value.packageName === 'string' && value.packageName.length <= 256 && /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(value.packageName)
    && typeof value.version === 'string' && isExactVersion(value.version), 'invalid-package', 'Use the immutable snapshot package name and exact version');
  if (index) assert(value.packageName === index.packageName && value.version === index.version, 'package-mismatch', 'Package and version must match this immutable snapshot');
  assert(Array.isArray(value.exposedPaths) && value.exposedPaths.length <= LOCAL_LIMITS.files, 'invalid-exposure', 'Select a bounded explicit list of source paths');
  const exposedPaths = value.exposedPaths.map(path).sort();
  assert(new Set(exposedPaths).size === exposedPaths.length, 'invalid-exposure', 'Source paths must not repeat');
  const sourcePaths = new Set(index?.files.map(file => file.path));
  if (index) assert(exposedPaths.every(selected => sourcePaths.has(selected)), 'source-unavailable', 'Selected source must exist in this immutable snapshot');
  assert(record(value.exports) && Object.keys(value.exports).length <= LOCAL_LIMITS.files, 'invalid-exports', 'Use a bounded explicit export mapping');
  let manifestExports: unknown;
  if (index) {
    manifestExports = (JSON.parse(index.files.find(file => file.path === 'package.json')!.text) as { exports?: unknown }).exports;
  }
  const exports: Record<string, string> = {};
  for (const key of Object.keys(value.exports).sort()) {
    assert(key === '.' || /^\.\/[A-Za-z0-9_$./-]{1,200}$/.test(key), 'invalid-exports', 'Use explicit package export names without wildcards');
    const selected = path(value.exports[key]); assert(exposedPaths.includes(selected), 'invalid-exports', 'Every mapped export must be explicitly exposed');
    if (index) {
      const declared = typeof manifestExports === 'string' ? key === '.' && manifestExports === `./${selected}`
        : record(manifestExports) && manifestExports[key] === `./${selected}`;
      assert(declared, 'export-unverified', 'Package export mappings must match an exact package.json export declaration');
    }
    exports[key] = selected;
  }
  assert(typeof value.rightsStatement === 'string' && value.rightsStatement.length <= 2000 && !value.rightsStatement.includes('\0'), 'invalid-rights', 'Use a bounded rights statement');
  assert(typeof value.accessPolicy === 'string' && ['private', 'authenticated', 'public'].includes(value.accessPolicy), 'invalid-policy', 'Select a supported proposed access policy');
  let testnetTerms: PublicationProposal['testnetTerms'] = null;
  if (value.testnetTerms !== null) {
    assert(record(value.testnetTerms), 'invalid-terms', 'Use complete proposed Tempo testnet terms'); keys(value.testnetTerms, ['network', 'operation', 'token', 'recipient', 'atomicPrice']);
    const terms = value.testnetTerms;
    assert(terms.network === 'eip155:42431' && terms.operation === 'context.retrieve' && typeof terms.atomicPrice === 'string'
      && /^[1-9][0-9]{0,77}$/.test(terms.atomicPrice) && BigInt(terms.atomicPrice) <= (1n << 256n) - 1n, 'invalid-terms', 'Use positive integer units on Tempo Moderato testnet');
    testnetTerms = { network: 'eip155:42431', operation: 'context.retrieve', token: address(terms.token), recipient: address(terms.recipient), atomicPrice: terms.atomicPrice };
  }
  const proposal: PublicationProposal = { packageName: value.packageName, version: value.version, exports, exposedPaths,
    rightsStatement: value.rightsStatement.trim(), accessPolicy: value.accessPolicy as PublicationProposal['accessPolicy'], proposedEndpoint: endpoint(value.proposedEndpoint), testnetTerms };
  assert(Buffer.byteLength(JSON.stringify(proposal), 'utf8') <= 65536, 'proposal-limit', 'Proposal exceeds the 64 KiB budget', 413);
  return proposal;
}
type Candidate = { id: string; workspace_id: string; permission_revision: string; member_revision: string; github_owner: string; github_name: string; github_repository_id: string | number; github_installation_id: string | number; draft_id?: string };
type DraftRow = { id: string; workspace_id: string; repository_id: string; snapshot_id: string; commit_sha: string; revision: string | number; state: 'draft' | 'revoked'; proposal: unknown; preview: unknown; terms_digest: string; created_at: Date | string; updated_at: Date | string };
type Proof = { authority: GitHubPublishingAuthority['authority']; checkedAt: string };
function preview(index: RepositoryIndex, proposal: PublicationProposal): PublicationPreview {
  const files = proposal.exposedPaths.map(selected => { const file = index.files.find(item => item.path === selected)!;
    return { path: selected, lines: file.lineCount, bytes: Buffer.byteLength(file.text, 'utf8'), sourceDigest: createHash('sha256').update(file.text).digest('hex') }; });
  return { snapshotId: index.snapshot.snapshotId, commitSha: index.snapshot.revision, files, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}
function digest(row: Pick<DraftRow, 'id' | 'workspace_id' | 'repository_id' | 'snapshot_id' | 'commit_sha' | 'state'>, nextRevision: number, proposal: PublicationProposal, exposure: PublicationPreview): string {
  return createHash('sha256').update(JSON.stringify([1, row.id, row.workspace_id, row.repository_id, row.snapshot_id, row.commit_sha, nextRevision, row.state,
    proposal.packageName, proposal.version, Object.entries(proposal.exports).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), proposal.exposedPaths, proposal.rightsStatement,
    proposal.accessPolicy, proposal.proposedEndpoint, proposal.testnetTerms,
    [exposure.snapshotId, exposure.commitSha, exposure.files.map(file => [file.path, file.lines, file.bytes, file.sourceDigest]), exposure.fileCount, exposure.totalBytes]])).digest('hex');
}
function response(row: DraftRow, proof: Proof): PublicationDraft {
  const proposal = validateProposal(row.proposal); const exposure = row.preview as PublicationPreview; const currentRevision = revision(Number(row.revision));
  assert(record(exposure) && exposure.snapshotId === row.snapshot_id && exposure.commitSha === row.commit_sha && Array.isArray(exposure.files)
    && exposure.files.length === proposal.exposedPaths.length && exposure.fileCount === exposure.files.length
    && exposure.files.every((file, index) => record(file) && file.path === proposal.exposedPaths[index] && typeof file.lines === 'number' && Number.isSafeInteger(file.lines) && file.lines > 0
      && typeof file.bytes === 'number' && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && typeof file.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(file.sourceDigest))
    && exposure.totalBytes === exposure.files.reduce((sum, file) => sum + file.bytes, 0), 'draft-invalid', 'Stored private draft metadata is invalid', 503);
  assert(digest(row, currentRevision, proposal, exposure) === row.terms_digest, 'draft-invalid', 'Stored private draft terms no longer match their revision', 503);
  const safePreview: PublicationPreview = { snapshotId: exposure.snapshotId, commitSha: exposure.commitSha,
    files: exposure.files.map(file => ({ path: file.path, lines: file.lines, bytes: file.bytes, sourceDigest: file.sourceDigest })), fileCount: exposure.fileCount, totalBytes: exposure.totalBytes };
  return { schemaVersion: 1, id: row.id, workspaceId: row.workspace_id, repositoryId: row.repository_id, snapshotId: row.snapshot_id, commitSha: row.commit_sha,
    revision: currentRevision, termsDigest: row.terms_digest, state: row.state, proposal, preview: safePreview,
    published: false, approval: null, endpointProof: 'unverified', payment: 'disabled', administration: { status: 'verified', basis: proof.authority, checkedAt: proof.checkedAt },
    rights: proposal.rightsStatement ? 'declared' : 'not-declared', accuracy: 'unverified', createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}

export function createPublicationService(database: AtlasDatabase, env: Readonly<Record<string, string | undefined>>) {
  const repositories = createRepositoryService(database, env);
  async function member(principalId: string, workspaceId: string): Promise<string> {
    actor(principalId); uuid(workspaceId);
    return database.withPrincipalTransaction(principalId, async tx => {
      const row = (await tx.query<{ role: string; revision: string }>('SELECT role,revision::text FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2', [workspaceId, principalId])).rows[0];
      assert(row && ['owner', 'admin'].includes(row.role), 'denied', 'Workspace administrative permission is required', 403); return row.revision;
    });
  }
  async function candidate(principalId: string, workspaceId: string | null, identifier: string, draft = false): Promise<Candidate> {
    actor(principalId); uuid(identifier); if (workspaceId) await member(principalId, workspaceId);
    return database.withAdminTransaction(async tx => {
      const row = (await tx.query<Candidate>(`SELECT r.id,r.workspace_id,r.permission_revision::text,m.revision::text AS member_revision,
        r.github_owner,r.github_name,r.github_repository_id,r.github_installation_id${draft ? ',d.id AS draft_id' : ''}
        FROM atlas.repositories r JOIN atlas.memberships m ON m.workspace_id=r.workspace_id
        ${draft ? 'JOIN atlas.publication_drafts d ON d.repository_id=r.id AND d.workspace_id=r.workspace_id' : ''}
        WHERE ${draft ? 'd' : 'r'}.id=$1 AND m.principal_id=$2 AND m.role IN ('owner','admin') AND NOT r.access_revoked
        ${workspaceId ? 'AND r.workspace_id=$3' : ''}`, workspaceId ? [identifier, principalId, workspaceId] : [identifier, principalId])).rows[0];
      assert(row, 'draft-unavailable', 'Private draft or repository is unavailable', 404); return row;
    });
  }
  async function authority(principalId: string, row: Candidate): Promise<Proof> {
    let proof: GitHubPublishingAuthority;
    try { const linked = await githubForPrincipal(principalId, env);
      proof = await linked.client.authorizePublication(linked.user, { owner: row.github_owner, name: row.github_name,
        repositoryId: Number(row.github_repository_id), installationId: Number(row.github_installation_id) }); }
    catch (error) { if (error instanceof GitHubError && error.code === 'unauthorized') return fail('publication-authority-required', 'Current repository administrative publishing authority is required', 403); throw error; }
    assert(proof.principalId === principalId && proof.repository.id === Number(row.github_repository_id) && ['personal-owner', 'repository-admin'].includes(proof.authority), 'denied', 'Current repository publishing authority is required', 403);
    return { authority: proof.authority, checkedAt: new Date().toISOString() };
  }
  async function lockGrant(tx: AtlasTransaction, principalId: string, row: Candidate): Promise<void> {
    const repository = (await tx.query<{ permission_revision: string; access_revoked: boolean }>('SELECT permission_revision::text,access_revoked FROM atlas.repositories WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [row.id, row.workspace_id])).rows[0];
    const membership = (await tx.query<{ role: string; revision: string }>('SELECT role,revision::text FROM atlas.memberships WHERE workspace_id=$1 AND principal_id=$2 FOR SHARE', [row.workspace_id, principalId])).rows[0];
    assert(repository && !repository.access_revoked && repository.permission_revision === row.permission_revision && membership && ['owner', 'admin'].includes(membership.role)
      && membership.revision === row.member_revision, 'authorization-changed', 'Administrative permissions changed; request access again', 403);
  }
  async function source(principalId: string, row: Candidate): Promise<RepositoryIndex> { return repositories.getIndex(principalId, row.id); }
  async function getDraft(principalId: string, draftId: string): Promise<PublicationDraft> {
    const selected = await candidate(principalId, null, draftId, true); const proof = await authority(principalId, selected);
    return database.withPrincipalTransaction(principalId, async tx => {
      await tx.query("SELECT set_config('atlas.authorized_repository_ids',$1,true)", [JSON.stringify([selected.id])]);
      const row = (await tx.query<DraftRow>(`SELECT d.* FROM atlas.publication_drafts d JOIN atlas.repositories r ON r.id=d.repository_id AND r.workspace_id=d.workspace_id
        JOIN atlas.memberships m ON m.workspace_id=d.workspace_id WHERE d.id=$1 AND d.workspace_id=$2 AND m.principal_id=$3
        AND m.role IN ('owner','admin') AND m.revision=$4 AND r.permission_revision=$5`, [draftId, selected.workspace_id, principalId, selected.member_revision, selected.permission_revision])).rows[0];
      assert(row, 'authorization-changed', 'Private draft is no longer available to this administration scope', 403); return response(row, proof);
    });
  }
  async function listDrafts(principalId: string, workspaceId: string): Promise<readonly PublicationDraft[]> {
    const initial = await member(principalId, workspaceId);
    const candidates = await database.withAdminTransaction(async tx => (await tx.query<Candidate>(`SELECT DISTINCT r.id,r.workspace_id,r.permission_revision::text,m.revision::text AS member_revision,
      r.github_owner,r.github_name,r.github_repository_id,r.github_installation_id FROM atlas.publication_drafts d
      JOIN atlas.repositories r ON r.id=d.repository_id AND r.workspace_id=d.workspace_id JOIN atlas.memberships m ON m.workspace_id=d.workspace_id
      WHERE d.workspace_id=$1 AND m.principal_id=$2 AND m.role IN ('owner','admin') AND NOT r.access_revoked LIMIT 51`, [workspaceId, principalId])).rows);
    assert(candidates.length <= 50, 'draft-limit', 'Administrative repository list exceeds its supported bound', 422);
    const allowed = new Map<string, { row: Candidate; proof: Proof }>();
    for (const row of candidates) { try { allowed.set(row.id, { row, proof: await authority(principalId, row) }); }
      catch (error) { if (error instanceof PublicationServiceError && error.code === 'publication-authority-required') continue; throw error; } }
    return database.withPrincipalTransaction(principalId, async tx => {
      await tx.query("SELECT set_config('atlas.authorized_repository_ids',$1,true)", [JSON.stringify([...allowed.keys()])]);
      const rows = (await tx.query<DraftRow & { member_revision: string; permission_revision: string }>(`SELECT d.*,m.revision::text AS member_revision,r.permission_revision::text FROM atlas.publication_drafts d
        JOIN atlas.repositories r ON r.id=d.repository_id AND r.workspace_id=d.workspace_id JOIN atlas.memberships m ON m.workspace_id=d.workspace_id
        WHERE d.workspace_id=$1 AND m.principal_id=$2 AND m.role IN ('owner','admin') ORDER BY d.created_at DESC LIMIT 51`, [workspaceId, principalId])).rows;
      assert(rows.length <= 50, 'draft-limit', 'Private draft list exceeds its supported bound', 422);
      return rows.map(row => { const approved = allowed.get(row.repository_id); assert(approved && row.member_revision === initial && row.permission_revision === approved.row.permission_revision,
        'authorization-changed', 'Administrative permissions changed; request access again', 403); return response(row, approved.proof); });
    });
  }
  async function createDraft(principalId: string, workspaceId: string, repositoryId: string): Promise<PublicationDraft> {
    workspaceId = uuid(workspaceId);
    const selected = await candidate(principalId, workspaceId, repositoryId); await authority(principalId, selected);
    const index = await source(principalId, selected);
    const proposal = validateProposal({ packageName: index.packageName, version: index.version, exports: {}, exposedPaths: [], rightsStatement: '', accessPolicy: 'private', proposedEndpoint: null, testnetTerms: null }, index);
    const exposure = preview(index, proposal); const proof = await authority(principalId, selected);
    return database.withAdminTransaction(async tx => {
      await lockGrant(tx, principalId, selected);
      // Serialize workspace-wide capacity even when drafts target different
      // repositories. Retained revoked drafts remain visible as bounded history.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`atlas-publication-capacity:${selected.workspace_id}`]);
      const count = (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM atlas.publication_drafts WHERE workspace_id=$1', [workspaceId])).rows[0]?.count;
      assert(typeof count === 'number' && count < 50, 'draft-limit', 'Workspace draft history is limited to 50 records; existing drafts remain available', 422);
      const snapshot = (await tx.query('SELECT id FROM atlas.snapshots WHERE id=$1 AND repository_id=$2 AND workspace_id=$3 AND revision=$4 AND status=\'complete\' FOR SHARE', [index.snapshot.snapshotId, selected.id, workspaceId, index.snapshot.revision])).rows[0];
      assert(snapshot, 'snapshot-changed', 'A complete immutable repository snapshot is required', 409);
      const identity = { id: randomUUID(), workspace_id: workspaceId, repository_id: selected.id, snapshot_id: index.snapshot.snapshotId, commit_sha: index.snapshot.revision, state: 'draft' as const };
      const row = (await tx.query<DraftRow>('INSERT INTO atlas.publication_drafts(id,workspace_id,repository_id,snapshot_id,commit_sha,proposal,preview,terms_digest,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) RETURNING *',
        [identity.id, workspaceId, selected.id, identity.snapshot_id, identity.commit_sha, JSON.stringify(proposal), JSON.stringify(exposure), digest(identity, 1, proposal, exposure), principalId])).rows[0];
      assert(row, 'draft-unavailable', 'Private draft could not be created', 503); return response(row, proof);
    });
  }
  async function updateDraft(principalId: string, draftId: string, expectedRevision: number, input: unknown): Promise<PublicationDraft> {
    revision(expectedRevision); const selected = await candidate(principalId, null, draftId, true); await authority(principalId, selected);
    const index = await source(principalId, selected); const proposal = validateProposal(input, index); const exposure = preview(index, proposal); const proof = await authority(principalId, selected);
    return database.withAdminTransaction(async tx => {
      await lockGrant(tx, principalId, selected);
      const current = (await tx.query<DraftRow>('SELECT * FROM atlas.publication_drafts WHERE id=$1 AND repository_id=$2 AND workspace_id=$3 FOR UPDATE', [draftId, selected.id, selected.workspace_id])).rows[0];
      assert(current && Number(current.revision) === expectedRevision, 'revision-conflict', 'Draft changed; reload its current revision', 409);
      assert(current.state === 'draft', 'draft-revoked', 'Revoked drafts cannot be edited', 409);
      assert(current.snapshot_id === index.snapshot.snapshotId && current.commit_sha === index.snapshot.revision, 'snapshot-changed', 'Create a new draft for the current immutable repository snapshot', 409);
      const next = revision(expectedRevision + 1);
      const row = (await tx.query<DraftRow>(`UPDATE atlas.publication_drafts SET proposal=$1::jsonb,preview=$2::jsonb,revision=$3,terms_digest=$4,
        approval=NULL,published=false,endpoint_proof='unverified',payment='disabled',updated_at=now() WHERE id=$5 AND workspace_id=$6 RETURNING *`,
        [JSON.stringify(proposal), JSON.stringify(exposure), next, digest(current, next, proposal, exposure), draftId, selected.workspace_id])).rows[0];
      assert(row, 'draft-unavailable', 'Private draft could not be saved', 503); return response(row, proof);
    });
  }
  async function revokeDraft(principalId: string, draftId: string, expectedRevision: number): Promise<PublicationDraft> {
    revision(expectedRevision); const selected = await candidate(principalId, null, draftId, true); const proof = await authority(principalId, selected);
    return database.withAdminTransaction(async tx => {
      await lockGrant(tx, principalId, selected);
      const current = (await tx.query<DraftRow>('SELECT * FROM atlas.publication_drafts WHERE id=$1 AND repository_id=$2 AND workspace_id=$3 FOR UPDATE', [draftId, selected.id, selected.workspace_id])).rows[0];
      assert(current && Number(current.revision) === expectedRevision, 'revision-conflict', 'Draft changed; reload its current revision', 409);
      if (current.state === 'revoked') return response(current, proof);
      const previous = response(current, proof); const next = revision(expectedRevision + 1);
      const row = (await tx.query<DraftRow>(`UPDATE atlas.publication_drafts SET state='revoked',revision=$1,terms_digest=$2,
        approval=NULL,published=false,endpoint_proof='unverified',payment='disabled',updated_at=now() WHERE id=$3 AND workspace_id=$4 RETURNING *`,
        [next, digest({ ...current, state: 'revoked' }, next, previous.proposal, previous.preview), draftId, selected.workspace_id])).rows[0];
      assert(row, 'draft-unavailable', 'Private draft could not be revoked', 503); return response(row, proof);
    });
  }
  return { listDrafts, createDraft, getDraft, updateDraft, revokeDraft };
}
