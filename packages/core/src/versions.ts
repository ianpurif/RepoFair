import type { ReleaseMapping } from '../../contracts/src/index.ts';
import { AtlasError } from './errors.ts';
export function isExactVersion(version: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version);
}
export function resolveRelease(mappings: readonly ReleaseMapping[], packageName: string, version: string): ReleaseMapping {
  if (!isExactVersion(version)) throw new AtlasError('EXACT_VERSION_REQUIRED', 'Resolve a lockfile version first.');
  const matches = mappings.filter(item => item.packageName === packageName && item.version === version);
  if (matches.length !== 1) throw new AtlasError(matches.length ? 'AMBIGUOUS_RELEASE' : 'UNSUPPORTED_VERSION',
    'No unique mapping for the requested package and version.');
  return matches[0]!;
}
