import { describe, expect, it } from 'vitest';
import { answerLocal, lookupSource, parseLocalIndex, parseRepositoryIndex, validateLocalAnswer, validateLocalIndex, validateSourceIndex, LOCAL_LIMITS } from '../../packages/core/src/local/index.ts';
import type { ParseRepositoryInput } from '../../packages/core/src/local/index.ts';
import { indexFixture } from '../../apps/worker/src/fixture-service.ts';

// Synthetic unit inputs exercise the parser after the separately verified
// GitHub download boundary; they make no claim of a real repository import.
const metadata = {
  scope: { tenantId: 'tenant-a', principalId: 'verified-principal-a', permissionRevision: '7' },
  snapshot: { repositoryId: 'repository-a', snapshotId: 'snapshot-a', kind: 'git' as const, revision: '1234567890abcdef1234567890abcdef12345678' },
  packageName: '@example/private-app', version: '2.3.4', observedAt: '2026-10-07T00:00:00.000Z',
};
function input(source: Record<string, string> = {}, extra: Partial<ParseRepositoryInput> = {}): ParseRepositoryInput {
  return { ...metadata, files: Object.entries({ 'package.json': JSON.stringify({ name: metadata.packageName, version: metadata.version }),
    'src/policy.ts': 'export const retryLimit = 3;\nexport function retry(attempt: number) {\n  return attempt < retryLimit;\n}',
    'src/use.ts': "import { retry } from './policy';\nexport function canRetry() { return retry(1); }", ...source }).map(([path, text]) => ({ path, text })), ...extra };
}
describe('genuine Git index identity and retrieval', () => {
  it('retains Git commit/repository/scope and real source ranges across graph, lookup and answers', () => {
    const index = parseRepositoryIndex(input()); validateSourceIndex(index);
    expect(index.mode).toBe('git'); expect(index.snapshot).toEqual(metadata.snapshot);
    expect(index.evidence.every(item => item.source.kind === 'git' && item.source.revision === metadata.snapshot.revision && item.scope === metadata.scope)).toBe(true);
    expect(index.nodes.every(node => node.repositoryId === metadata.snapshot.repositoryId && node.snapshotId === metadata.snapshot.snapshotId)).toBe(true);
    expect(index.edges.some(edge => edge.relation === 'resolved-call')).toBe(true);
    const passage = lookupSource(index, 'src/policy.ts', 3, 3);
    expect(passage.source).toEqual({ ...metadata.snapshot, path: 'src/policy.ts', startLine: 3, endLine: 3 });
    expect(passage.original).toBe('  return attempt < retryLimit;');
    const answer = answerLocal(index, 'How does retry use retryLimit?'); validateLocalAnswer(answer, index);
    expect(answer.status).toBe('evidence_ready'); expect(answer.answer).toContain(metadata.snapshot.revision);
    expect(answer.citations.length).toBeGreaterThan(0);
    for (const citation of answer.citations) {
      expect(citation.source.kind).toBe('git'); expect(citation.source.revision).toBe(metadata.snapshot.revision);
      expect(lookupSource(index, citation.source.path, citation.source.startLine, citation.source.endLine).original).toBe(citation.original);
    }
    expect(answer.activities.at(-1)?.detail).toContain('exact Git commit');
  });
  it('keeps fixture parser/validator strict and rejects mode/kind/revision substitution', async () => {
    expect(() => parseLocalIndex(input())).toThrow('fixture');
    const git = parseRepositoryIndex(input()); expect(() => validateLocalIndex(git)).toThrow('Unsupported local');
    for (const snapshot of [{ ...metadata.snapshot, kind: 'fixture' as const }, { ...metadata.snapshot, revision: `sha256:${'a'.repeat(64)}` },
      { ...metadata.snapshot, revision: 'main' }, { ...metadata.snapshot, revision: 'a'.repeat(64) }, { ...metadata.snapshot, revision: 'A'.repeat(40) }]) {
      expect(() => parseRepositoryIndex(input({}, { snapshot }))).toThrow('Git commit');
      expect(() => validateSourceIndex({ ...git, snapshot })).toThrow('snapshot');
    }
    expect(() => validateSourceIndex({ ...git, mode: 'fixture' })).toThrow('snapshot');
    const fixture = await indexFixture('retry-kit@2.0.0'); validateLocalIndex(fixture); validateSourceIndex(fixture);
    expect(() => parseRepositoryIndex({ ...input(), snapshot: fixture.snapshot })).toThrow('Git commit');
    expect(() => validateSourceIndex({ ...fixture, mode: 'git' })).toThrow('snapshot');
  });
  it('rejects missing/invalid manifest versions and mismatched source identity without inventing defaults', () => {
    const noManifest = { ...input(), files: input().files.filter(file => file.path !== 'package.json') };
    expect(() => parseRepositoryIndex(noManifest)).toThrow('root package.json');
    for (const version of [undefined, 'latest', '^2.3.4', '', 2]) {
      expect(() => parseRepositoryIndex(input({ 'package.json': JSON.stringify({ name: metadata.packageName, version }) }))).toThrow('supported exact version');
    }
    expect(() => parseRepositoryIndex(input({ 'package.json': JSON.stringify({ version: metadata.version }) }))).toThrow('package name');
    expect(() => parseRepositoryIndex(input({}, { version: '^2.3.4' }))).toThrow('exact package version');
    expect(() => parseRepositoryIndex(input({ 'package.json': JSON.stringify({ name: metadata.packageName, version: '9.0.0' }) }))).toThrow('identity');
    const git = parseRepositoryIndex(input()); expect(() => validateSourceIndex({ ...git, version: '9.0.0' })).toThrow('source manifest');
  });
  it('rejects caller-supplied fixture trusted links and leaves Git file links unresolved', () => {
    const manifest = { name: metadata.packageName, version: metadata.version, dependencies: { '@example/library': 'file:packages/library' } };
    const lock = { lockfileVersion: 3, packages: { '': manifest, 'packages/library': { name: '@example/library', version: '1.2.3' }, 'node_modules/@example/library': { link: true, resolved: 'packages/library' } } };
    const files = input({ 'package.json': JSON.stringify(manifest), 'package-lock.json': JSON.stringify(lock), 'src/external.ts': "import { run } from '@example/library';\nrun();" });
    const index = parseRepositoryIndex(files);
    expect(index.dependencies[0]).toMatchObject({ version: null, status: 'unresolved' });
    expect(index.dependencies[0]?.reason).toContain('trusted catalog');
    for (const trustedLinks of [[], [{ lockPath: 'packages/library', packageName: '@example/library', version: '1.2.3' }], undefined]) {
      const hostile = { ...files, trustedLinks };
      expect(() => parseRepositoryIndex(hostile)).toThrow('not permitted for Git');
    }
  });
  it('uses exact package-lock resolutions and refuses unresolved external source/runtime claims', () => {
    const manifest = { name: metadata.packageName, version: metadata.version, dependencies: { '@example/library': '^1.0.0' } };
    const index = parseRepositoryIndex(input({ 'package.json': JSON.stringify(manifest),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': manifest, 'node_modules/@example/library': { version: '1.2.3' } } }),
      'src/external.ts': "import { run } from '@example/library';\nexport function external() { return run(); }" }));
    expect(index.dependencies[0]).toMatchObject({ version: '1.2.3', status: 'exact' });
    expect(answerLocal(index, 'Does library@2.0.0 support retry?').status).toBe('abstained');
    expect(answerLocal(index, 'Prove retry never fails in production').citations).toHaveLength(0);
    expect(answerLocal(index, 'zzzxxyy nonexistent symbol').answer).toContain('Git commit');
    expect(index.limitations.join(' ')).toContain('File/workspace links');
    expect(index.limitations.join(' ')).not.toContain('Public authored fixture');
  });
  it('rejects altered Git citations, cross-tenant evidence and mixed commits', () => {
    const index = parseRepositoryIndex(input()); const answer = answerLocal(index, 'retryLimit');
    const mixed = structuredClone(index); (mixed.evidence[0]!.source as { revision: string }).revision = 'f'.repeat(40);
    expect(() => validateSourceIndex(mixed)).toThrow('snapshot');
    const foreign = structuredClone(index); (foreign.evidence[0]! as { scope: unknown }).scope = { ...metadata.scope, tenantId: 'tenant-b' };
    expect(() => validateSourceIndex(foreign)).toThrow('scope');
    const forged = structuredClone(answer); (forged.citations[0]!.source as { kind: string }).kind = 'fixture';
    expect(() => validateLocalAnswer(forged, index)).toThrow('Noncanonical');
    expect(() => lookupSource(index, '../policy.ts', 1, 1)).toThrow('path');
    expect(() => lookupSource(index, 'src/policy.ts', 1, 50)).toThrow('unavailable');
  });
  it('treats scripts/plugins/source as data and preserves existing parser bounds', () => {
    const marker = '__atlasGitParserExecuted';
    const index = parseRepositoryIndex(input({ 'package.json': JSON.stringify({ name: metadata.packageName, version: metadata.version, scripts: { install: 'exit 99' } }),
      'src/malicious.ts': `globalThis.${marker} = true;\nthrow new Error('must not execute');\nexport const safeData = 1;`,
      'tsconfig.json': '{"compilerOptions":{"plugins":[{"name":"untrusted-code"}]}}' }));
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined(); expect(index.nodes.some(node => node.label === 'safeData')).toBe(true);
    expect(() => parseRepositoryIndex(input({ '../escape.ts': 'export const escape = true;' }))).toThrow('Invalid');
    expect(() => parseRepositoryIndex(input({ 'src/huge.ts': 'x'.repeat(LOCAL_LIMITS.fileCharacters + 1) }))).toThrow('oversized');
  });
});
