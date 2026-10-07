import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export function readJson(path) { return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')); }
export function walk(dir, ignore = new Set(['node_modules','.git','.next','.atlas','coverage','dist','test-results','playwright-report','__pycache__'])) {
  return readdirSync(dir, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry => {
    if (ignore.has(entry.name) || entry.isSymbolicLink()) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path, ignore) : [path];
  });
}
export function findExecutable(name) {
  const suffixes = process.platform === 'win32' ? ['.exe', '.com', '.cmd', ''] : [''];
  for (const folder of (process.env.PATH ?? '').split(delimiter)) for (const ext of suffixes) {
    const candidate = join(folder, name + ext);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
/** No shell interpolation. Support npm's Windows shims by invoking their JS entry. */
export function command(name, args = []) {
  const binary = findExecutable(name);
  if (!binary) throw new Error(`${name} is not installed/on PATH. Install it yourself or use the supported client; this script does not change global tools.`);
  if (!binary.toLowerCase().endsWith('.cmd')) return { bin: binary, args };
  const relative = { npm: 'npm/bin/npm-cli.js', tsc: 'typescript/bin/tsc' }[name];
  const entry = relative ? join(dirname(binary), 'node_modules', relative) : null;
  if (entry && existsSync(entry)) return {bin:process.execPath,args:[entry,...args]};
  throw new Error(`Unsupported ${name} Windows shim layout. Open the installed tool directly; no unsafe shell fallback was used.`);
}
export function runProgram(name, args, options = {}) {
  const spec = command(name, args);
  const result = spawnSync(spec.bin, spec.args, {cwd:ROOT,stdio:'inherit',...options});
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) throw new Error(`${name} exited with ${result.signal ?? result.status}`);
  return result;
}
export function requireNode() {
  const [major,minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16)) throw new Error('Node.js 22.16+ is required for starter TypeScript tests.');
}
