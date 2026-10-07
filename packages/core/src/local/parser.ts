import { Project, Node, ScriptTarget, ModuleKind, ModuleResolutionKind, SyntaxKind } from 'ts-morph';
import type { SourceFile as AstFile, Node as AstNode, Identifier } from 'ts-morph';
import type { DependencyBinding, GraphNode, LocalIndex, ParsedEdge, RepositoryIndex, Scope, Snapshot, SourceEvidence, SourceIndex } from '../../../contracts/src/index.ts';
import { isSafeRelativePath } from '../evidence.ts';
import { nodeId } from '../graph.ts';
import { isExactVersion } from '../versions.ts';
import { assertLocal, LOCAL_LIMITS, record, sourceLines } from './limits.ts';
import { bindDependency, packageSpecifier } from './versions.ts';
import type { TrustedFixtureLink } from './versions.ts';
import { evidenceId, validateSourceIndex } from './validation.ts';

export type ParseLocalInput = Readonly<{
  scope: Scope; snapshot: Snapshot; packageName: string; version: string;
  files: readonly Readonly<{ path: string; text: string }>[];
  trustedLinks?: readonly TrustedFixtureLink[];
  observedAt: string;
}>;
/** Authorization and immutable Git download verification belong to the caller. */
export type ParseRepositoryInput = Omit<ParseLocalInput, 'trustedLinks'>;
type Declaration = { ast: AstNode; graph: GraphNode; name: string };
type ReExport = { module: string | null; name: string; exported: string; ast: AstNode };
type Target = { nodeId: string; callable: boolean };

/** POSIX relative resolution over supplied source only. No filesystem or tsconfig loading. */
function resolveRelative(from: string, specifier: string, paths: ReadonlySet<string>): string | null {
  // eslint-disable-next-line no-control-regex -- reject control characters in untrusted module paths
  if (!specifier.startsWith('.') || specifier.includes('\\') || /[\x00-\x1f]/.test(specifier)) return null;
  const stack = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') { if (!stack.length) return null; stack.pop(); } else stack.push(part);
  }
  const path = stack.join('/');
  const stem = path.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  const candidates = [...new Set([path, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`, `${stem}.mts`, `${stem}.cts`,
    `${path}/index.ts`, `${path}/index.tsx`, `${path}/index.js`])].filter(candidate => paths.has(candidate));
  return candidates.length === 1 ? candidates[0]! : null;
}
function key(ast: AstNode): string { return `${ast.getSourceFile().getFilePath()}:${ast.getStart()}`; }
function json(text: string | undefined, label: string): unknown {
  if (text === undefined) return null;
  try { return JSON.parse(text); } catch { throw new Error(`Invalid ${label}`); }
}
function callable(ast: AstNode): boolean {
  if (Node.isFunctionDeclaration(ast)) return true;
  if (Node.isVariableDeclaration(ast)) {
    const initializer = ast.getInitializer(); return !!initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer));
  }
  return false;
}

export function parseLocalIndex(input: ParseLocalInput): LocalIndex {
  return parseSourceIndex(input, 'fixture');
}
export function parseRepositoryIndex(input: ParseRepositoryInput): RepositoryIndex {
  assertLocal(input && !Object.hasOwn(input, 'trustedLinks'), 'Fixture trusted links are not permitted for Git repositories');
  return parseSourceIndex(input, 'git');
}
function parseSourceIndex(input: ParseLocalInput, mode: 'fixture'): LocalIndex;
function parseSourceIndex(input: ParseRepositoryInput, mode: 'git'): RepositoryIndex;
function parseSourceIndex(input: ParseLocalInput, mode: 'fixture' | 'git'): SourceIndex {
  const started = Date.now();
  const revisionPattern = mode === 'fixture' ? /^sha256:[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/;
  assertLocal(input && input.snapshot?.kind === mode && typeof input.snapshot.revision === 'string'
    && revisionPattern.test(input.snapshot.revision), `Immutable ${mode === 'git' ? '40-character Git commit' : 'fixture snapshot'} required`);
  assertLocal(typeof input.version === 'string' && isExactVersion(input.version)
    && typeof input.observedAt === 'string' && Number.isFinite(Date.parse(input.observedAt)), `Invalid ${mode} metadata: supported exact package version and observation time are required`);
  assertLocal(Array.isArray(input.files) && input.files.length > 0 && input.files.length <= LOCAL_LIMITS.files, 'Invalid source count');
  const paths = new Set<string>(); let total = 0;
  const files = input.files.map(file => {
    assertLocal(typeof file.path === 'string' && isSafeRelativePath(file.path) && !paths.has(file.path)
      && typeof file.text === 'string' && file.text.length <= LOCAL_LIMITS.fileCharacters, 'Invalid or oversized input file');
    paths.add(file.path); total += file.text.length;
    const lineCount = sourceLines(file.text).length; assertLocal(lineCount <= LOCAL_LIMITS.linesPerFile, 'Source line limit exceeded');
    return { path: file.path, text: file.text, lineCount };
  });
  assertLocal(total <= LOCAL_LIMITS.totalCharacters, 'Source total limit exceeded');
  const manifest = json(files.find(file => file.path === 'package.json')?.text, 'package.json');
  if (mode === 'git') {
    assertLocal(record(manifest), 'Git repository requires a root package.json manifest');
    assertLocal(typeof manifest.version === 'string' && isExactVersion(manifest.version), 'Git package.json must declare a supported exact version');
    assertLocal(typeof manifest.name === 'string' && manifest.name.trim().length > 0, 'Git package.json must declare its package name');
  }
  assertLocal(record(manifest) && manifest.name === input.packageName && manifest.version === input.version, 'Package identity differs from snapshot');
  const lock = json(files.find(file => file.path === 'package-lock.json')?.text, 'package-lock.json');
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true,
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler,
      allowJs: true, noLib: true, skipLibCheck: true } });
  const astFiles = new Map<string, AstFile>(); let astCount = 0;
  const unresolved = new Set<string>();
  const nodes = new Map<string, GraphNode>(); const edges = new Map<string, ParsedEdge>(); const evidence = new Map<string, SourceEvidence>();
  const dependencies: DependencyBinding[] = [];
  function budget(): void {
    assertLocal(Date.now() - started <= LOCAL_LIMITS.parseMs, 'Parser time limit exceeded');
    assertLocal(nodes.size <= LOCAL_LIMITS.nodes && edges.size <= LOCAL_LIMITS.edges && evidence.size <= LOCAL_LIMITS.evidence
      && unresolved.size <= LOCAL_LIMITS.edges, 'Parser graph limit exceeded');
  }
  function addNode(localId: string, kind: GraphNode['kind'], label: string): GraphNode {
    const id = nodeId(input.snapshot.repositoryId, input.snapshot.snapshotId, localId);
    const node = { id, ...{ repositoryId: input.snapshot.repositoryId, snapshotId: input.snapshot.snapshotId }, localId, kind, label };
    nodes.set(id, node); budget(); return node;
  }
  const fileNodes = new Map(files.map(file => [file.path, addNode(file.path, 'file', file.path)]));
  function passage(path: string, startLine: number, endLine: number): SourceEvidence {
    const file = files.find(file => file.path === path)!;
    endLine = Math.min(endLine, startLine + LOCAL_LIMITS.passageLines - 1);
    const id = evidenceId(input, path, startLine, endLine);
    const item: SourceEvidence = { id, scope: input.scope, source: { ...input.snapshot, path, startLine, endLine },
      original: sourceLines(file.text).slice(startLine - 1, endLine).join('\n'), providerId: null,
      observedAt: input.observedAt, provenance: 'parsed-source' };
    evidence.set(id, item); budget(); return item;
  }
  function source(ast: AstNode): SourceEvidence {
    const path = ast.getSourceFile().getFilePath().slice('/atlas/'.length);
    const file = ast.getSourceFile();
    const start = file.getLineAndColumnAtPos(ast.getStart()).line;
    const end = file.getLineAndColumnAtPos(Math.max(ast.getStart(), ast.getEnd() - 1)).line;
    return passage(path, start, end);
  }
  function edge(from: string, to: string, relation: ParsedEdge['relation'], extractionMethod: ParsedEdge['extractionMethod'], item: SourceEvidence): void {
    const id = JSON.stringify([from, to, relation, extractionMethod, item.id]);
    edges.set(id, { id, from, to, relation, extractionMethod, evidenceId: item.id, provenance: 'parsed-source' }); budget();
  }
  for (const file of files) {
    if (/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(file.path)) {
      const ast = project.createSourceFile(`/atlas/${file.path}`, file.text); astFiles.set(file.path, ast);
      astCount += ast.getDescendants().length; assertLocal(astCount <= LOCAL_LIMITS.astNodes, 'AST size limit exceeded'); budget();
      const diagnostics = ast.getPreEmitDiagnostics().filter(diagnostic => diagnostic.getCode() >= 1000 && diagnostic.getCode() < 2000);
      if (diagnostics.length) unresolved.add(`${file.path}: source has syntax diagnostics; affected relationships may be incomplete`);
    }
    for (let line = 1; line <= file.lineCount; line += LOCAL_LIMITS.passageLines) passage(file.path, line, Math.min(file.lineCount, line + LOCAL_LIMITS.passageLines - 1));
  }
  const declarations = new Map<string, Declaration>();
  const locals = new Map<string, Map<string, Declaration>>();
  const exports = new Map<string, Map<string, Target>>();
  const reexports = new Map<string, ReExport[]>();
  const importDefinitions = new Map<string, Map<string, { module: string; name: string }>>();
  const imports = new Map<string, Target>();
  const namespaces = new Map<string, { path: string | null; target: Target }>();
  for (const [path, ast] of astFiles) {
    locals.set(path, new Map()); exports.set(path, new Map()); reexports.set(path, []);
    importDefinitions.set(path, new Map());
    for (const declaration of ast.getImportDeclarations()) {
      for (const spec of declaration.getNamedImports()) importDefinitions.get(path)!.set(spec.getAliasNode()?.getText() ?? spec.getNameNode().getText(),
        { module: declaration.getModuleSpecifierValue(), name: spec.getNameNode().getText() });
      const defaultImport = declaration.getDefaultImport();
      if (defaultImport) importDefinitions.get(path)!.set(defaultImport.getText(), { module: declaration.getModuleSpecifierValue(), name: 'default' });
    }
    for (const declaration of ast.getDescendants()) {
      if (!Node.isFunctionDeclaration(declaration) && !Node.isVariableDeclaration(declaration) && !Node.isClassDeclaration(declaration)
        && !Node.isInterfaceDeclaration(declaration) && !Node.isTypeAliasDeclaration(declaration) && !Node.isEnumDeclaration(declaration)) continue;
      const nameNode = declaration.getNameNode();
      if (!nameNode || !Node.isIdentifier(nameNode)) { unresolved.add(`${path}:${declaration.getStartLineNumber()}: anonymous/destructured declaration unsupported`); continue; }
      const name = nameNode.getText();
      const graph = addNode(`${path}#${name}@${declaration.getStartLineNumber()}:${declaration.getStart()}`, 'symbol', name);
      const item = { ast: declaration, graph, name }; declarations.set(key(declaration), item); source(declaration);
      const parent = declaration.getParent();
      const statement = Node.isVariableDeclaration(declaration) ? declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement) : undefined;
      const top = Node.isSourceFile(parent) || (statement && Node.isSourceFile(statement.getParent()));
      if (top) locals.get(path)!.set(name, item);
      const exported = top && (statement ? statement.hasExportKeyword() : declaration.hasExportKeyword());
      if (exported) {
        const defaultExport = !statement && declaration.hasDefaultKeyword();
        exports.get(path)!.set(defaultExport ? 'default' : name, { nodeId: graph.id, callable: callable(declaration) });
        edge(fileNodes.get(path)!.id, graph.id, 'exports', 'ts-morph-export', source(declaration));
      }
    }
    for (const declaration of ast.getExportDeclarations()) {
      const module = declaration.getModuleSpecifierValue() ?? null;
      const specs = declaration.getNamedExports();
      if (declaration.getNamespaceExport()) {
        unresolved.add(`${path}:${declaration.getStartLineNumber()}: namespace re-export unsupported`); continue;
      }
      if (!specs.length && module) reexports.get(path)!.push({ module, name: '*', exported: '*', ast: declaration });
      for (const spec of specs) reexports.get(path)!.push({ module, name: spec.getNameNode().getText(),
        exported: spec.getAliasNode()?.getText() ?? spec.getNameNode().getText(), ast: declaration });
    }
    for (const assignment of ast.getExportAssignments()) {
      const expr = assignment.getExpression();
      if (Node.isIdentifier(expr) && !assignment.isExportEquals()) reexports.get(path)!.push({ module: null, name: expr.getText(), exported: 'default', ast: assignment });
      else unresolved.add(`${path}:${assignment.getStartLineNumber()}: expression/default export unsupported`);
    }
  }
  function resolveExport(path: string, name: string, seen = new Set<string>()): Target | null {
    budget(); const identity = `${path}:${name}`;
    if (seen.has(identity) || seen.size >= 12) return null; const nextSeen = new Set(seen).add(identity);
    const direct = exports.get(path)?.get(name); if (direct) return direct;
    const matches: Target[] = [];
    for (const entry of reexports.get(path) ?? []) {
      if (entry.exported !== name && entry.exported !== '*') continue;
      if (entry.exported === '*' && name === 'default') continue;
      if (entry.module === null) {
        const local = locals.get(path)?.get(entry.name);
        if (local) matches.push({ nodeId: local.graph.id, callable: callable(local.ast) });
        else {
          const imported = importDefinitions.get(path)?.get(entry.name);
          const target = imported ? resolveRelative(path, imported.module, paths) : null;
          if (target && imported) { const resolved = resolveExport(target, imported.name, nextSeen); if (resolved) matches.push(resolved); }
        }
        continue;
      }
      const target = resolveRelative(path, entry.module, paths);
      if (target) { const resolved = resolveExport(target, entry.name === '*' ? name : entry.name, nextSeen); if (resolved) matches.push(resolved); }
    }
    const unique = new Map(matches.map(match => [match.nodeId, match])); return unique.size === 1 ? [...unique.values()][0]! : null;
  }
  function external(path: string, specifier: string, names: readonly string[], ast: AstNode): Target | null {
    const parsed = packageSpecifier(specifier);
    if (!parsed) { unresolved.add(`${path}:${ast.getStartLineNumber()}: unsupported module ${specifier}`); return null; }
    const binding = bindDependency(parsed.packageName, names, path, manifest, lock, mode === 'fixture' ? input.trustedLinks ?? [] : []);
    dependencies.push(binding);
    const graph = addNode(`package:${parsed.packageName}@${binding.version ?? 'unresolved'}`, 'package', `${parsed.packageName}@${binding.version ?? 'unresolved'}`);
    edge(fileNodes.get(path)!.id, graph.id, 'package-binding', 'ts-morph-import', source(ast));
    if (binding.reason) unresolved.add(`${path}: ${parsed.packageName}: ${binding.reason}`);
    unresolved.add(`${path}: ${specifier}: external source/export evidence unavailable${binding.version ? ` for exact version ${binding.version}` : ''}`);
    return { nodeId: graph.id, callable: false };
  }
  for (const [path, ast] of astFiles) {
    for (const declaration of ast.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue(); const names = declaration.getNamedImports();
      const targetPath = resolveRelative(path, specifier, paths);
      const packageTarget = specifier.startsWith('.') ? null : external(path, specifier,
        [...names.map(spec => spec.getNameNode().getText()), ...(declaration.getDefaultImport() ? ['default'] : []), ...(declaration.getNamespaceImport() ? ['*'] : [])], declaration);
      const fileTarget = targetPath ? { nodeId: fileNodes.get(targetPath)!.id, callable: false } : packageTarget;
      if (fileTarget) edge(fileNodes.get(path)!.id, fileTarget.nodeId, 'imports', 'ts-morph-import', source(declaration));
      else unresolved.add(`${path}:${declaration.getStartLineNumber()}: unresolved/ambiguous module ${specifier}`);
      for (const spec of names) {
        const target = targetPath ? resolveExport(targetPath, spec.getNameNode().getText()) : packageTarget;
        if (target) imports.set(key(spec), target);
        else unresolved.add(`${path}:${spec.getStartLineNumber()}: unresolved export ${spec.getNameNode().getText()} from ${specifier}`);
      }
      const defaultImport = declaration.getDefaultImport();
      if (defaultImport) {
        const target = targetPath ? resolveExport(targetPath, 'default') : packageTarget;
        if (target) imports.set(key(declaration.getImportClause()!), target);
        else unresolved.add(`${path}:${declaration.getStartLineNumber()}: unresolved default export from ${specifier}`);
      }
      const namespace = declaration.getNamespaceImport();
      if (namespace && fileTarget) namespaces.set(key(namespace.getParent()), { path: targetPath, target: fileTarget });
    }
    for (const entry of reexports.get(path) ?? []) {
      const targetPath = entry.module ? resolveRelative(path, entry.module, paths) : null;
      if (entry.exported === '*') {
        if (targetPath) edge(fileNodes.get(path)!.id, fileNodes.get(targetPath)!.id, 'exports', 'ts-morph-export', source(entry.ast));
        else unresolved.add(`${path}:${entry.ast.getStartLineNumber()}: unresolved wildcard export ${entry.module}`);
      } else {
        const target = resolveExport(path, entry.exported);
        if (target) edge(fileNodes.get(path)!.id, target.nodeId, 'exports', 'ts-morph-export', source(entry.ast));
        else unresolved.add(`${path}:${entry.ast.getStartLineNumber()}: unresolved/ambiguous re-export ${entry.exported}`);
      }
    }
  }
  function identifierTarget(identifier: Identifier): Target | null {
    const candidates: Target[] = [];
    for (const declaration of identifier.getSymbol()?.getDeclarations() ?? []) {
      const imported = imports.get(key(declaration)); const declared = declarations.get(key(declaration));
      if (imported) candidates.push(imported);
      else if (declared) candidates.push({ nodeId: declared.graph.id, callable: callable(declared.ast) });
    }
    const unique = new Map(candidates.map(target => [target.nodeId, target])); return unique.size === 1 ? [...unique.values()][0]! : null;
  }
  function expressionTarget(expression: AstNode): Target | null {
    if (Node.isIdentifier(expression)) return identifierTarget(expression);
    if (Node.isPropertyAccessExpression(expression)) {
      const base = expression.getExpression(); if (!Node.isIdentifier(base)) return null;
      for (const declaration of base.getSymbol()?.getDeclarations() ?? []) {
        const namespace = namespaces.get(key(declaration));
        if (namespace) return namespace.path ? resolveExport(namespace.path, expression.getName()) : namespace.target;
      }
    }
    return null;
  }
  function owner(ast: AstNode, path: string): string {
    for (const parent of ast.getAncestors()) { const declaration = declarations.get(key(parent)); if (declaration) return declaration.graph.id; }
    return fileNodes.get(path)!.id;
  }
  for (const [path, ast] of astFiles) {
    for (const call of ast.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression(); const target = expressionTarget(expression);
      if (target?.callable && !call.hasQuestionDotToken()) edge(owner(call, path), target.nodeId, 'resolved-call', 'ts-morph-call', source(call));
      else unresolved.add(`${path}:${call.getStartLineNumber()}: call ${expression.getText().slice(0, 160)} is not statically resolved to an indexed function`);
    }
    for (const identifier of ast.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (identifier.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) || identifier.getFirstAncestorByKind(SyntaxKind.ExportDeclaration)) continue;
      const parent = identifier.getParent();
      if (declarations.has(key(parent)) && (parent as AstNode & { getNameNode(): AstNode | undefined }).getNameNode() === identifier) continue;
      // Member names resolve only through supported namespace imports, not by spelling.
      if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) {
        const target = expressionTarget(parent);
        if (target && owner(identifier, path) !== target.nodeId) edge(owner(identifier, path), target.nodeId, 'references', 'ts-morph-reference', source(parent));
        continue;
      }
      const target = identifierTarget(identifier);
      if (target && owner(identifier, path) !== target.nodeId) edge(owner(identifier, path), target.nodeId, 'references', 'ts-morph-reference', source(identifier));
    }
  }
  // A simple explicit exports map is a release-to-source declaration, not a provider join.
  if (record(manifest.exports)) for (const [name, target] of Object.entries(manifest.exports)) {
    if (typeof target === 'string' && target.startsWith('./') && paths.has(target.slice(2))) {
      const packageNode = addNode(`package:${input.packageName}@${input.version}`, 'package', `${input.packageName}@${input.version}`);
      edge(packageNode.id, fileNodes.get(target.slice(2))!.id, 'exports', 'explicit-release-export', passage('package.json', 1, files.find(file => file.path === 'package.json')!.lineCount));
    } else unresolved.add(`package.json: unsupported/absent export mapping ${name}`);
  }
  const index: SourceIndex = { schemaVersion: 1, mode, scope: input.scope, snapshot: input.snapshot,
    packageName: input.packageName, version: input.version, files, nodes: [...nodes.values()], edges: [...edges.values()],
    evidence: [...evidence.values()], dependencies, unresolved: [...unresolved], limitations: [
      mode === 'fixture' ? 'Public authored fixture only; no production repository authorization is established.'
        : 'Git commit identity and original supplied source are retained. The caller must authorize repository access before supplying source; parsing does not authenticate users or verify repository ownership.',
      'Static TypeScript/JavaScript relationships indicate potential impact, not confirmed runtime behavior or breakage.',
      'Local named/default/namespace imports and named/wildcard re-exports are supported. Dynamic imports, require, computed members, class dispatch and executable configuration are unsupported.',
      mode === 'fixture' ? 'Only package-lock v3 top-level resolutions and explicitly trusted fixture links bind exact dependency versions.'
        : 'Only package-lock v3 top-level resolutions bind exact dependency versions. File/workspace links, other lockfile formats and missing resolutions remain unresolved.',
      'External source and export evidence requires a separate exact-version provider workflow.',
      'Parsing has bounded files, bytes, AST size and a checked deadline; the synchronous parser cannot interrupt a single AST operation.',
    ] };
  validateSourceIndex(index); return index;
}
