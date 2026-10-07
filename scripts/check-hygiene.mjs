import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { ROOT, walk } from './lib.mjs';
const errors=[];
for (const path of walk(ROOT)) {
  const name = relative(ROOT,path).replaceAll('\\','/');
  if (name.startsWith('supabase/.temp/') || name.startsWith('supabase/.branches/')) continue; // Supabase CLI state, not source.
  if (/\.(json|md|ts|tsx|mjs|toml|css|yml|sh)$/.test(name) || name === 'AGENTS.md') {
    const text=readFileSync(path,'utf8');
    if (text.includes('\0')) errors.push(`${name}: NUL byte`);
    if (text && !text.endsWith('\n')) errors.push(`${name}: missing final newline`);
    if (text.includes('\r\n')) errors.push(`${name}: expected LF`);
    if (name.endsWith('.json')) { try {JSON.parse(text);} catch {errors.push(`${name}: invalid JSON`);} }
    if (/[\uE200-\uE203]/.test(text)) errors.push(`${name}: unresolved chat citation markup`);
  }
}
if (errors.length) {console.error(errors.join('\n')); process.exitCode=1;}
else console.log('PASS scaffold file hygiene. This is not a substitute for application ESLint.');
