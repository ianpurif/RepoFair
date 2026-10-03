import type { DependencyBinding } from '../../../contracts/src/index.ts';
import { isExactVersion } from '../versions.ts';
import { record } from './limits.ts';

/** Worker supplies only links whose catalog identity and content digest were checked. */
export type TrustedFixtureLink = Readonly<{ lockPath: string; packageName: string; version: string }>;
export function packageSpecifier(specifier: string): { packageName: string; subpath: string } | null {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes('\\') || specifier.includes(':')) return null;
  const parts = specifier.split('/'); const count = specifier.startsWith('@') ? 2 : 1;
  if (parts.length < count || parts.some(part => !part || part === '.' || part === '..')) return null;
  return { packageName: parts.slice(0, count).join('/'), subpath: parts.length === count ? '.' : `./${parts.slice(count).join('/')}` };
}
export function bindDependency(packageName: string, importedNames: readonly string[], sourcePath: string,
  manifest: unknown, lockfile: unknown, links: readonly TrustedFixtureLink[]): DependencyBinding {
  const unresolved = (reason: string): DependencyBinding => ({ packageName, version: null, importedNames, sourcePath, status: 'unresolved', reason });
  if (!record(manifest)) return unresolved('Missing valid package.json');
  const dependencies = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies]
    .filter(record);
  const declared = dependencies.map(map => map[packageName]).filter(value => typeof value === 'string');
  if (!declared.length) return unresolved('Package import is not declared in package.json');
  if (new Set(declared).size > 1) return unresolved('Conflicting package dependency declarations');
  if (!record(lockfile) || lockfile.lockfileVersion !== 3 || !record(lockfile.packages)) return unresolved('Supported package-lock v3 resolution is missing');
  const root = lockfile.packages[''];
  if (!record(root) || root.version !== manifest.version || (root.name !== undefined && root.name !== manifest.name)) return unresolved('Lockfile root identity differs from package.json');
  const rootDeclarations = [root.dependencies, root.devDependencies, root.peerDependencies, root.optionalDependencies].filter(record);
  if (!rootDeclarations.some(map => map[packageName] === declared[0])) return unresolved('Lockfile dependency declaration is stale');
  const entry = lockfile.packages[`node_modules/${packageName}`];
  if (!record(entry)) return unresolved('No top-level lockfile package resolution');
  let version: unknown = entry.version;
  if (entry.link === true) {
    if (typeof entry.resolved !== 'string') return unresolved('Fixture link has no lock target');
    const linked = lockfile.packages[entry.resolved];
    const trusted = links.filter(link => link.lockPath === entry.resolved && link.packageName === packageName);
    if (!record(linked) || linked.name !== packageName || trusted.length !== 1 || linked.version !== trusted[0]!.version) return unresolved('File link is not an exact trusted catalog mapping');
    if (declared[0] !== `file:${entry.resolved}`) return unresolved('Fixture link declaration differs from resolved catalog path');
    version = linked.version;
  } else if (entry.name !== undefined && entry.name !== packageName) return unresolved('Lockfile package identity differs from import');
  if (typeof version !== 'string' || !isExactVersion(version)) return unresolved('Lockfile package version is not exact');
  return { packageName, version, importedNames, sourcePath, status: 'exact', reason: null };
}
