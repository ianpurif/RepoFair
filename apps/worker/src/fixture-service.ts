import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_IDS, parseFixtureId } from '../../../packages/contracts/src/local.ts';
import type { FixtureId, LocalIndex } from '../../../packages/contracts/src/local.ts';
import { isSafeRelativePath } from '../../../packages/core/src/evidence.ts';
import { isExactVersion } from '../../../packages/core/src/versions.ts';
import { LOCAL_LIMITS, parseLocalIndex } from '../../../packages/core/src/local/index.ts';
import type { TrustedFixtureLink } from '../../../packages/core/src/local/index.ts';

const MODULE_WORKSPACE = fileURLToPath(new URL('../../../', import.meta.url));
const MAX_CATALOG_BYTES = 32_000;
type CatalogSnapshot = { repositoryId: string; packageName: string; version: string; root: string;
  kind: 'fixture'; snapshotId: FixtureId; revision: string; files: string[] };
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function requireFixture(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function contained(root: string, path: string): boolean {
  const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}
async function workspaceRoot(): Promise<string> {
  const cwd = process.cwd();
  // Next runs from apps/web; bundled import.meta.url may point inside .next.
  // These are fixed application locations, never caller-controlled import paths.
  const cwdRoot = basename(cwd) === 'web' && basename(dirname(cwd)) === 'apps' ? resolve(cwd, '../..') : cwd;
  for (const candidate of [...new Set([cwdRoot, MODULE_WORKSPACE])]) {
    try { const info = await lstat(resolve(candidate, 'fixtures/catalog.json')); if (info.isFile()) return candidate; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error('Trusted fixture catalog is unavailable at the application workspace');
}
/** Reject symlinks at each component, then verify realpath before any content read. */
async function safeFile(root: string, path: string, maxBytes: number): Promise<Buffer> {
  requireFixture(contained(root, path), 'Fixture path escapes trusted root');
  const parts = relative(root, path).split(sep).filter(Boolean); let current = root;
  const rootInfo = await lstat(root); requireFixture(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'Fixture root is not a plain directory');
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]!); const stat = await lstat(current);
    requireFixture(!stat.isSymbolicLink() && (i === parts.length - 1 ? stat.isFile() : stat.isDirectory()), 'Fixture symlinks and nonregular files are unsupported');
    if (i === parts.length - 1) requireFixture(stat.size <= maxBytes, 'Fixture file exceeds byte limit');
  }
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]);
  requireFixture(contained(realRoot, realFile), 'Fixture realpath escapes trusted root');
  const data = await readFile(realFile); requireFixture(data.byteLength <= maxBytes, 'Fixture file exceeds byte limit'); return data;
}
async function readCatalog(workspace: string): Promise<CatalogSnapshot[]> {
  const catalogBytes = await safeFile(workspace, resolve(workspace, 'fixtures/catalog.json'), MAX_CATALOG_BYTES);
  const catalog: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogBytes));
  requireFixture(object(catalog) && catalog.schemaVersion === 1 && Array.isArray(catalog.snapshots)
    && catalog.snapshots.length === FIXTURE_IDS.length, 'Invalid trusted fixture catalog');
  const snapshots: CatalogSnapshot[] = [];
  for (const raw of catalog.snapshots) {
    requireFixture(object(raw) && typeof raw.repositoryId === 'string' && raw.repositoryId.length > 0
      && typeof raw.packageName === 'string' && typeof raw.version === 'string' && isExactVersion(raw.version)
      && typeof raw.root === 'string' && raw.root.startsWith('fixtures/repos/') && isSafeRelativePath(raw.root)
      && raw.kind === 'fixture' && typeof raw.revision === 'string' && /^sha256:[a-f0-9]{64}$/.test(raw.revision)
      && Array.isArray(raw.files) && raw.files.length > 0 && raw.files.length <= LOCAL_LIMITS.files
      && raw.files.every((path: unknown) => typeof path === 'string' && isSafeRelativePath(path)
        && (path === 'package.json' || path === 'package-lock.json' || /^src\/.+\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(path)))
      && new Set(raw.files).size === raw.files.length, 'Invalid trusted fixture catalog entry');
    const snapshotId = parseFixtureId(raw.snapshotId);
    requireFixture(snapshotId === `${raw.repositoryId}@${raw.version}` && !snapshots.some(item => item.snapshotId === snapshotId)
      && !snapshots.some(item => item.root === raw.root), 'Ambiguous fixture catalog identity');
    snapshots.push({ ...raw, snapshotId } as CatalogSnapshot);
  }
  return snapshots;
}
async function load(workspace: string, snapshot: CatalogSnapshot): Promise<{ path: string; text: string }[]> {
  const fixtureRoot = resolve(workspace, snapshot.root);
  const hash = createHash('sha256'); const files: { path: string; text: string }[] = []; let bytes = 0;
  for (const path of [...snapshot.files].sort()) {
    // Check every path from workspace so fixture root ancestors cannot be symlinks either.
    const data = await safeFile(workspace, resolve(fixtureRoot, path), LOCAL_LIMITS.fileCharacters);
    bytes += data.byteLength; requireFixture(bytes <= LOCAL_LIMITS.totalCharacters, 'Fixture total exceeds byte limit');
    hash.update(path).update('\0').update(data).update('\0');
    files.push({ path, text: new TextDecoder('utf-8', { fatal: true }).decode(data) });
  }
  requireFixture(`sha256:${hash.digest('hex')}` === snapshot.revision, 'Fixture content digest differs from catalog snapshot');
  const manifest: unknown = JSON.parse(files.find(file => file.path === 'package.json')?.text ?? 'null');
  requireFixture(object(manifest) && manifest.name === snapshot.packageName && manifest.version === snapshot.version, 'Fixture package identity differs from catalog');
  return files;
}

/** Public authored fixtures only. No path, tenant or scope is accepted from a caller. */
export async function indexFixture(rawId: FixtureId): Promise<LocalIndex> {
  const id = parseFixtureId(rawId); const workspace = await workspaceRoot(); const catalog = await readCatalog(workspace);
  const snapshot = catalog.find(item => item.snapshotId === id); requireFixture(snapshot, 'Fixture snapshot is unavailable');
  const files = await load(workspace, snapshot); const links: TrustedFixtureLink[] = [];
  const lockText = files.find(file => file.path === 'package-lock.json')?.text;
  if (lockText) {
    const lock: unknown = JSON.parse(lockText);
    if (object(lock) && lock.lockfileVersion === 3 && object(lock.packages)) {
      for (const [lockPath, entry] of Object.entries(lock.packages)) {
        if (lockPath === '' || lockPath.startsWith('node_modules/') || !object(entry)) continue;
        // A lock path is matched as metadata; it is never used to read a dependency.
        const matches = catalog.filter(candidate => relative(resolve(workspace, snapshot.root), resolve(workspace, candidate.root)).split(sep).join('/') === lockPath
          && entry.name === candidate.packageName && entry.version === candidate.version);
        if (matches.length === 1) { await load(workspace, matches[0]!); links.push({ lockPath, packageName: matches[0]!.packageName, version: matches[0]!.version }); }
      }
    }
  }
  return parseLocalIndex({ scope: { tenantId: 'public-fixtures', principalId: 'fixture-reader', permissionRevision: 'catalog-v1' },
    snapshot: { repositoryId: snapshot.repositoryId, snapshotId: snapshot.snapshotId, kind: snapshot.kind, revision: snapshot.revision },
    packageName: snapshot.packageName, version: snapshot.version, files, trustedLinks: links, observedAt: new Date().toISOString() });
}
