import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Actual TypeScript emission and native Node module loading execute. No application
// environment is inherited, publication is absent, and no database/RPC/payment runs.
const root = resolve(import.meta.dirname, '../..');
const entry = join(root, 'apps/provider/api/index.ts');
const configFile = join(root, 'apps/provider/tsconfig.json');

function compilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  if (config.error) throw new Error(`Provider tsconfig diagnostic ${config.error.code}`);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configFile));
  if (parsed.errors.length) throw new Error(`Provider tsconfig diagnostics ${parsed.errors.map(error => error.code).join(',')}`);
  return { ...parsed.options, noEmit: false };
}

function imports(code: string): string[] {
  const source = ts.createSourceFile('emitted.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const specifiers: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

function emit(file: string, options: ts.CompilerOptions): string {
  const output = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: options, reportDiagnostics: true });
  if (output.diagnostics?.length) throw new Error(`Provider emission diagnostics ${output.diagnostics.map(error => error.code).join(',')}`);
  return output.outputText;
}

function emittedGraph(): Map<string, string> {
  const options = compilerOptions();
  expect(options.rewriteRelativeImportExtensions).toBe(true);
  const pending = [entry];
  const emitted = new Map<string, string>();
  while (pending.length) {
    const source = pending.shift()!;
    const outputPath = relative(root, source).replace(/\.ts$/, '.js');
    if (emitted.has(outputPath)) continue;
    const output = emit(source, options);
    emitted.set(outputPath, output);
    for (const specifier of imports(output).filter(specifier => specifier.startsWith('./') || specifier.startsWith('../'))) {
      expect(specifier, `Emitted import in ${outputPath}`).not.toMatch(/\.tsx?$/);
      const dependency = resolve(dirname(source), specifier).replace(/\.js$/, '.ts');
      expect(existsSync(dependency), `Traced dependency ${relative(root, dependency)}`).toBe(true);
      pending.push(dependency);
    }
  }
  return emitted;
}

describe('actual provider TypeScript emission for Vercel Node', () => {
  it('reproduces the broken static/dynamic .ts imports when extension rewriting is absent', () => {
    const options = { ...compilerOptions(), rewriteRelativeImportExtensions: false };
    expect(imports(emit(entry, options))).toContain('../src/vercel.ts');
    expect(imports(emit(join(root, 'apps/provider/src/vercel.ts'), options))).toContain('./runtime.ts');
  });

  it('rewrites the entry, dynamic runtime and complete transitive relative import graph to resolvable JavaScript', () => {
    const emitted = emittedGraph();
    expect(imports(emitted.get(join('apps/provider/api/index.js'))!)).toContain('../src/vercel.js');
    expect(imports(emitted.get(join('apps/provider/src/vercel.js'))!)).toContain('./runtime.js');
    expect(emitted.has(join('apps/provider/src/runtime.js'))).toBe(true);
    expect(emitted.has(join('apps/worker/src/provider-http.js'))).toBe(true);
    expect(emitted.has(join('apps/worker/src/database.js'))).toBe(true);
    expect(emitted.has(join('packages/contracts/src/commerce.js'))).toBe(true);
  });

  it('loads the actual emitted entry and runtime with native Node and fails closed before publication configuration', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'repofair-provider-emission-'));
    const target = resolve(temporary), parent = resolve(tmpdir()) + sep;
    if (!target.startsWith(parent) || !target.slice(parent.length).startsWith('repofair-provider-emission-')) {
      throw new Error('Provider emission cleanup target is outside its temporary directory');
    }
    try {
      const graph = emittedGraph();
      for (const [path, code] of graph) {
        const target = join(temporary, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, code);
      }
      await writeFile(join(temporary, 'package.json'), '{"type":"module"}\n');
      // Reuse installed pinned dependencies, without installing anything or copying credentials.
      await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'), 'junction');
      // Bun keeps dependencies such as pg at their owning workspace's node_modules.
      for (const workspace of new Set([...graph.keys()].map(path => path.split(sep).slice(0, 2).join(sep)))) {
        const dependencies = join(root, workspace, 'node_modules');
        if (existsSync(dependencies)) await symlink(dependencies, join(temporary, workspace, 'node_modules'), 'junction');
      }
      await writeFile(join(temporary, 'probe.mjs'), `
import assert from 'node:assert/strict';
import api from './apps/provider/api/index.js';
import { createIndependentProvider } from './apps/provider/src/runtime.js';
await assert.rejects(createIndependentProvider({}), /independent publication UUID/);
const response = await api.fetch(new Request('https://repofair-provider.vercel.app/health'));
assert.equal(response.status, 503);
assert.equal(response.headers.get('cache-control'), 'no-store');
assert.deepEqual(await response.json(), { error: 'Independent provider unavailable', mode: 'tempo-testnet' });
console.log(JSON.stringify({ entryLoaded: true, runtimeLoaded: true, missingPublicationStatus: 503 }));
`);
      const result = spawnSync(process.execPath, [join(temporary, 'probe.mjs')], { cwd: temporary, encoding: 'utf8',
        env: { SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TEMP: temporary, TMP: temporary },
        windowsHide: true, timeout: 15_000 });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ entryLoaded: true, runtimeLoaded: true, missingPublicationStatus: 503 });
    } finally {
      // Verify the generated target before recursive cleanup; rm removes the dependency junction itself.
      await rm(target, { recursive: true, force: true });
    }
  });
});
