import { describe, expect, it } from 'vitest';
import { answerLocal, lookupSource, parseLocalIndex, validateLocalIndex, LOCAL_LIMITS } from '../../packages/core/src/local/index.ts';
import type { ParseLocalInput } from '../../packages/core/src/local/index.ts';
import type { LocalIndex } from '../../packages/contracts/src/local.ts';

const metadata = { scope: { tenantId: 'fixtures', principalId: 'reader', permissionRevision: '1' },
  snapshot: { repositoryId: 'example', snapshotId: 'example@1.0.0', kind: 'fixture' as const, revision: `sha256:${'a'.repeat(64)}` },
  packageName: '@example/app', version: '1.0.0', observedAt: '2026-10-03T00:00:00.000Z' };
function input(source: Record<string, string>, extra: Partial<ParseLocalInput> = {}): ParseLocalInput {
  return { ...metadata, files: Object.entries({ 'package.json': JSON.stringify({ name: metadata.packageName, version: metadata.version }), ...source })
    .map(([path, text]) => ({ path, text })), ...extra };
}
function symbol(index: LocalIndex, name: string): string { return index.nodes.find(node => node.kind === 'symbol' && node.label === name)!.id; }

describe('in-memory source parser', () => {
  it('extracts alias imports, reexports, calls and references with exact checked source', () => {
    const index = parseLocalIndex(input({
      'src/impl.ts': 'export function run(value: number) { return value + 1; }\nexport const policy = 3;',
      'src/barrel.ts': "export { run as execute, policy } from './impl';",
      'src/app.ts': "import { execute as go, policy as limit } from './barrel';\nexport function application() { return go(limit); }",
    }));
    expect(index.edges.some(edge => edge.from === symbol(index, 'application') && edge.to === symbol(index, 'run') && edge.relation === 'resolved-call')).toBe(true);
    expect(index.edges.some(edge => edge.from === symbol(index, 'application') && edge.to === symbol(index, 'policy') && edge.relation === 'references')).toBe(true);
    expect(index.edges.filter(edge => edge.relation === 'exports').length).toBeGreaterThanOrEqual(4);
    for (const edge of index.edges) {
      const passage = index.evidence.find(item => item.id === edge.evidenceId)!;
      expect(lookupSource(index, passage.source.path, passage.source.startLine, passage.source.endLine).original).toBe(passage.original);
      expect(edge.extractionMethod.startsWith('ts-morph-')).toBe(true);
    }
  });
  it('resolves default imports and namespace calls, without joining same-named symbols', () => {
    const index = parseLocalIndex(input({ 'src/one.ts': 'export default function run() { return 1; }\nexport function named() { return 2; }',
      'src/two.ts': 'export function run() { return 3; }',
      'src/use.ts': "import chosen from './one';\nimport * as api from './one';\nexport function use() { return chosen() + api.named(); }" }));
    const runs = index.nodes.filter(node => node.kind === 'symbol' && node.label === 'run');
    expect(runs).toHaveLength(2);
    const calls = index.edges.filter(edge => edge.relation === 'resolved-call');
    expect(calls).toHaveLength(2);
    expect(calls.some(edge => edge.to === runs.find(node => node.localId.startsWith('src/two.ts'))!.id)).toBe(false);
  });
  it('honors lexical shadowing instead of symbol name matching', () => {
    const index = parseLocalIndex(input({ 'src/dep.ts': 'export function run() { return 1; }',
      'src/use.ts': "import { run } from './dep';\nexport function use(run: () => number) { return run(); }" }));
    expect(index.edges.some(edge => edge.relation === 'resolved-call')).toBe(false);
    expect(index.unresolved.some(item => item.includes('call run'))).toBe(true);
  });
  it('follows named reexports of locally imported aliases and detects export cycles', () => {
    const index = parseLocalIndex(input({ 'src/impl.ts': 'export function run() { return 1; }',
      'src/barrel.ts': "import { run as original } from './impl';\nexport { original as execute };",
      'src/use.ts': "import { execute as go } from './barrel';\nexport function use() { return go(); }",
      'src/cycle-a.ts': "export { missing } from './cycle-b';", 'src/cycle-b.ts': "export { missing } from './cycle-a';" }));
    expect(index.edges.some(edge => edge.from === symbol(index, 'use') && edge.to === symbol(index, 'run') && edge.relation === 'resolved-call')).toBe(true);
    expect(index.unresolved.some(item => item.includes('re-export missing'))).toBe(true);
  });
  it('marks ambiguous wildcard exports, unsupported dynamic calls and missing paths unresolved', () => {
    const index = parseLocalIndex(input({ 'src/a.ts': 'export function run() { return 1; }',
      'src/b.ts': 'export function run() { return 2; }',
      'src/barrel.ts': "export * from './a';\nexport * from './b';",
      'src/use.ts': "import { run } from './barrel';\nimport { missing } from './absent';\nrun();\nimport('./a');\nrequire('./b');" }));
    expect(index.edges.some(edge => edge.relation === 'resolved-call')).toBe(false);
    expect(index.unresolved.some(item => item.includes('unresolved export run'))).toBe(true);
    expect(index.unresolved.some(item => item.includes('./absent'))).toBe(true);
    expect(index.unresolved.some(item => item.includes('call import'))).toBe(true);
    expect(index.unresolved.some(item => item.includes('call require'))).toBe(true);
  });
  it('treats scripts and malicious source as data and never evaluates configuration', () => {
    const marker = '__atlasParserExecuted';
    const index = parseLocalIndex(input({
      'package.json': JSON.stringify({ name: metadata.packageName, version: metadata.version, scripts: { install: 'exit 99' } }),
      'src/evil.ts': `globalThis.${marker} = true;\nthrow new Error('must never execute');\nexport function read() { return 1; }`,
      'tsconfig.json': '{"compilerOptions":{"plugins":[{"name":"evil"}]}}',
    }));
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    expect(index.nodes.some(node => node.label === 'read')).toBe(true);
  });
  it('fails closed on traversal, duplicate paths, huge inputs and package identity mismatch', () => {
    expect(() => parseLocalIndex(input({ '../evil.ts': 'export const x = 1;' }))).toThrow('Invalid');
    expect(() => parseLocalIndex({ ...input({}), files: [{ path: 'package.json', text: '{}' }, { path: 'package.json', text: '{}' }] })).toThrow('Invalid');
    expect(() => parseLocalIndex(input({ 'src/huge.ts': 'x'.repeat(LOCAL_LIMITS.fileCharacters + 1) }))).toThrow('oversized');
    expect(() => parseLocalIndex(input({ 'package.json': '{"name":"wrong","version":"1.0.0"}' }))).toThrow('identity');
  });
});

describe('exact package-lock v3 binding', () => {
  function dependency(version: unknown, lockVersion = 3) {
    return input({ 'src/use.ts': "import { run as execute } from '@example/lib';\nexecute();",
      'package.json': JSON.stringify({ name: metadata.packageName, version: metadata.version, dependencies: { '@example/lib': '^1.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: lockVersion, packages: { '': { name: metadata.packageName, version: metadata.version, dependencies: { '@example/lib': '^1.0.0' } },
        'node_modules/@example/lib': { version } } }) });
  }
  it('uses the exact installed lock version instead of the requested range', () => {
    const index = parseLocalIndex(dependency('1.2.3'));
    expect(index.dependencies[0]).toMatchObject({ version: '1.2.3', status: 'exact', importedNames: ['run'] });
    expect(index.edges.filter(edge => edge.relation === 'package-binding')).toHaveLength(1);
    expect(index.edges.filter(edge => edge.relation === 'resolved-call')).toHaveLength(0);
  });
  it('never substitutes latest or a range for a missing exact resolution', () => {
    for (const index of [parseLocalIndex(dependency('^1.2.3')), parseLocalIndex(dependency('1.2.3', 2))]) {
      expect(index.dependencies[0]).toMatchObject({ version: null, status: 'unresolved' });
    }
  });
  it('accepts file links only from exact trusted catalog metadata', () => {
    const base = input({ 'src/use.ts': "import { run } from '@example/lib';",
      'package.json': JSON.stringify({ name: metadata.packageName, version: metadata.version, dependencies: { '@example/lib': 'file:../lib/v1' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { name: metadata.packageName, version: metadata.version, dependencies: { '@example/lib': 'file:../lib/v1' } },
        '../lib/v1': { name: '@example/lib', version: '1.0.0' }, 'node_modules/@example/lib': { link: true, resolved: '../lib/v1' } } }) });
    expect(parseLocalIndex(base).dependencies[0]!.status).toBe('unresolved');
    expect(parseLocalIndex({ ...base, trustedLinks: [{ lockPath: '../lib/v1', packageName: '@example/lib', version: '2.0.0' }] }).dependencies[0]!.status).toBe('unresolved');
    expect(parseLocalIndex({ ...base, trustedLinks: [{ lockPath: '../lib/v1', packageName: '@example/lib', version: '1.0.0' }] }).dependencies[0]!.version).toBe('1.0.0');
  });
});

describe('original-source and response boundary', () => {
  function fixture() { return parseLocalIndex(input({ 'src/retry.ts': 'export function retry(attempt: number) {\n  return attempt < 3;\n}' })); }
  it('rejects altered source, mixed revisions, foreign scope, forged edge evidence and line ranges', () => {
    const index = fixture();
    const altered = structuredClone(index) as unknown as { evidence: Record<string, unknown>[] };
    altered.evidence[0]!.original = 'fabricated'; expect(() => validateLocalIndex(altered)).toThrow('match');
    const mixed = structuredClone(index); (mixed.evidence[0]!.source as { revision: string }).revision = `sha256:${'b'.repeat(64)}`;
    expect(() => validateLocalIndex(mixed)).toThrow('snapshot');
    const foreign = structuredClone(index); (foreign.evidence[0]! as { scope: unknown }).scope = { ...foreign.scope, tenantId: 'foreign' };
    expect(() => validateLocalIndex(foreign)).toThrow('scope');
    const forged = structuredClone(index); (forged.edges[0]! as { evidenceId: string }).evidenceId = 'missing';
    expect(() => validateLocalIndex(forged)).toThrow('edge');
    const unsupported = structuredClone(index); (unsupported.edges[0]! as unknown as Record<string, unknown>).relation = 'made-up';
    delete (unsupported.edges[0]! as unknown as Record<string, unknown>).extractionMethod;
    expect(() => validateLocalIndex(unsupported)).toThrow('edge');
    expect(() => lookupSource(index, '../retry.ts', 1, 2)).toThrow('path');
    expect(() => lookupSource(index, 'src/retry.ts', 0, 2)).toThrow('range');
    expect(() => lookupSource(index, 'src/retry.ts', 1, 99)).toThrow('unavailable');
    expect(lookupSource(index, 'src/retry.ts', 2, 2).original).toBe('  return attempt < 3;');
  });
  it('returns source excerpts and actual operation timings, or abstains without evidence', () => {
    const index = fixture(); const answer = answerLocal(index, 'How does retry use attempt?');
    expect(answer.status).toBe('evidence_ready'); expect(answer.answer).toContain('return attempt < 3');
    expect(answer.citations.length).toBeGreaterThan(0); expect(answer.edgeIds.length).toBeGreaterThan(0);
    expect(answer.activities.map(item => item.operation)).toEqual(['validate-index', 'lexical-source-search', 'expand-parsed-graph', 'validate-citations']);
    expect(answer.activities.every(item => item.durationMs >= 0 && Number.isFinite(Date.parse(item.startedAt)))).toBe(true);
    expect(answerLocal(index, 'zzzz nonexistentxyz').status).toBe('abstained');
    expect(answerLocal(index, 'Prove no retry ever fails in production').citations).toHaveLength(0);
    expect(() => answerLocal(index, 'x'.repeat(2001))).toThrow('2000');
  });
});
