import { describe, expect, it } from 'vitest';
import { parseRepositoryIndex, lookupSource, answerLocal, validateSourceIndex, GIT_LIMITS } from '../../packages/core/src/local/index.ts';
import type { ParseRepositoryInput } from '../../packages/core/src/local/index.ts';

function source(files: Record<string,string>, identity: Partial<ParseRepositoryInput> = {}): ParseRepositoryInput {
  return { scope: { tenantId: 'owner', principalId: 'reader', permissionRevision: '1:1' },
    snapshot: { repositoryId: 'repo', snapshotId: 'snapshot', kind: 'git', revision: 'a'.repeat(40) },
    packageName: null, version: null, observedAt: '2026-10-11T00:00:00Z',
    files: Object.entries(files).map(([path,text]) => ({ path,text })), ...identity };
}
describe('general repository evidence without invented package releases', () => {
  it('indexes rootless Python and Rust source and retrieves actual pinned lines', () => {
    const index = parseRepositoryIndex(source({
      'service/__init__.py': '',
      'service/utils.py': 'def compute(value):\n    return value + 1\n',
      'service/main.py': 'from .utils import compute\nclass Service:\n    def run(self):\n        return compute(2)\n',
      'src/main.rs': 'fn main() { println!("retained source only"); }',
    }));
    validateSourceIndex(index); expect(index.packageName).toBeNull(); expect(index.version).toBeNull();
    expect(index.nodes.filter(node => node.kind === 'symbol').map(node => node.label)).toEqual(expect.arrayContaining(['compute','Service','run']));
    const imports = index.edges.filter(edge => edge.extractionMethod === 'python-ast-import');
    expect(imports).toHaveLength(1); expect(imports[0]?.relation).toBe('imports');
    expect(index.edges.some(edge => edge.relation === 'resolved-call')).toBe(false);
    expect(index.nodes.some(node => node.label === 'main' && node.kind === 'symbol')).toBe(false);
    expect(lookupSource(index,'service/utils.py',2,2).original).toBe('    return value + 1');
    const answer = answerLocal(index,'How does compute use value?');
    expect(answer.status).toBe('evidence_ready'); expect(answer.answer).toContain('this repository');
    expect(answer.answer).not.toContain('null@null'); expect(answer.citations.every(item => item.source.revision === 'a'.repeat(40))).toBe(true);
    expect(() => validateSourceIndex({ ...index, packageName: 'fabricated', version: '1.0.0' })).toThrow('source manifest');
  });
  it('never extracts imports or definitions from strings and retains syntax-error source as file evidence', () => {
    const index = parseRepositoryIndex(source({
      'pkg/__init__.py': '', 'pkg/utils.py': 'def compute():\n    return 1\n',
      'pkg/notes.py': 'text = """from .utils import compute\ndef invented():\n    pass\n"""\n',
      'pkg/broken.py': 'def broken(:\n    pass\n',
    }));
    expect(index.edges.filter(edge => edge.extractionMethod === 'python-ast-import')).toHaveLength(0);
    expect(index.nodes.some(node => node.label === 'invented' || node.label === 'broken')).toBe(false);
    expect(index.unresolved.join(' ')).toContain('Python syntax diagnostics');
    expect(lookupSource(index,'pkg/broken.py',1,1).original).toBe('def broken(:');
  });
  it('binds each workspace import to its closest declared manifest and exact lock resolution', () => {
    const index = parseRepositoryIndex(source({
      'package.json': '{"name":"workspace","private":true}',
      'packages/a/package.json': '{"name":"a","version":"1.0.0","dependencies":{"dep":"^1.0.0"}}',
      'packages/b/package.json': '{"name":"b","version":"2.0.0","dependencies":{"dep":"^2.0.0"}}',
      'packages/a/index.ts': "import { run } from 'dep'; export const a = run;",
      'packages/b/index.ts': "import { run } from 'dep'; export const b = run;",
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {
        '': { name: 'workspace' }, 'packages/a': { name: 'a', version: '1.0.0', dependencies: { dep: '^1.0.0' } },
        'packages/b': { name: 'b', version: '2.0.0', dependencies: { dep: '^2.0.0' } },
        'node_modules/dep': { version: '1.9.0' }, 'packages/b/node_modules/dep': { version: '2.4.0' },
      } }),
    }, { packageName: 'workspace' }));
    expect(index.version).toBeNull(); expect(index.dependencies.map(binding => [binding.sourcePath,binding.version])).toEqual([
      ['packages/a/index.ts','1.9.0'], ['packages/b/index.ts','2.4.0'],
    ]);
  });
  it('supports large syntax maps without pretending semantic call resolution ran', () => {
    const files = Object.fromEntries(Array.from({ length: 210 }, (_, i) => [`src/module-${i}.ts`, `export function value${i}() { return ${i}; }`]));
    const index = parseRepositoryIndex(source(files));
    expect(index.nodes.filter(node => node.kind === 'file')).toHaveLength(210);
    expect(index.nodes.filter(node => node.kind === 'symbol')).toHaveLength(210);
    expect(index.limitations.join(' ')).toContain('Semantic symbol references and resolved calls are omitted');
    expect(index.edges.some(edge => edge.relation === 'resolved-call')).toBe(false);
    expect(() => parseRepositoryIndex(source({ 'too-large.ts': ' '.repeat(GIT_LIMITS.fileCharacters + 1) }))).toThrow('oversized');
  });
});
