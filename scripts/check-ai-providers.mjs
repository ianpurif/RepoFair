import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { ROOT, walk } from './lib.mjs';

// Development-agent configuration/history is not application runtime code.
const forbidden = /openai|gpt-[\w.-]+|text-embedding-(?:ada|3)|@ai-sdk\/(?:azure|anthropic|google)/i;
const paths = ['apps', 'packages'].flatMap(dir => walk(join(ROOT, dir)))
  .filter(path => /\.(?:ts|tsx|js|mjs|json)$/.test(path));
paths.push(...['package.json', 'bun.lock', '.env.example', 'supabase/config.toml'].map(path => join(ROOT, path)).filter(existsSync));
const failures = paths.filter(path => forbidden.test(readFileSync(path, 'utf8'))).map(path => relative(ROOT, path));
// Inspect local variable names only; never report or copy secret values.
const environments = [...readdirSync(ROOT).filter(name => /^\.env(?:\.|$)/.test(name)).map(name => join(ROOT, name)),
  ...['apps', 'packages'].flatMap(dir => walk(join(ROOT, dir))).filter(path => /^\.env(?:\.|$)/.test(basename(path)))];
for (const path of environments) {
  const name = relative(ROOT, path);
  const names = [...readFileSync(path, 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(match => match[1]);
  if (names.some(name => /openai|^ATLAS_(?:GENERATION|EMBEDDING)_MODEL$/i.test(name))) failures.push(`${name} (obsolete AI variable name)`);
}
if (failures.length) { console.error('Application AI provider policy failed:\n' + failures.join('\n')); process.exitCode = 1; }
else console.log('PASS application AI provider policy: Voyage AI + DeepSeek; no forbidden runtime dependencies, calls, or environment names.');
