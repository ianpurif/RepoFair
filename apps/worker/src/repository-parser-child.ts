import { parseRepositoryIndex } from '../../../packages/core/src/local/index.ts';
import type { ParseRepositoryInput } from '../../../packages/core/src/local/index.ts';

// Bundle this trusted entry point for Node. Imported source is JSON data only;
// tsconfig plugins, package scripts and repository dependencies are never run.
try {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > 64_000_000) throw new Error('input-limit');
    chunks.push(part);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ParseRepositoryInput;
  const index = parseRepositoryIndex(input);
  process.stdout.write(JSON.stringify(index));
} catch (error) {
  // Return only fixed allowlisted diagnostics: never exception text, paths,
  // syntax, imported strings, environment values or sensitive snippets.
  const codes: Readonly<Record<string, string>> = {
    'input-limit': 'parser-input-limit', 'Invalid source count': 'parser-source-count',
    'Invalid or oversized input file': 'parser-source-file', 'Source line limit exceeded': 'parser-line-limit',
    'Source total limit exceeded': 'parser-total-limit', 'Parser time limit exceeded': 'parser-time-limit',
    'AST size limit exceeded': 'parser-ast-limit', 'Parser graph limit exceeded': 'parser-graph-limit',
    'Invalid package.json': 'parser-manifest-invalid', 'Invalid package-lock.json': 'parser-lock-invalid',
    'Git repository requires a root package.json manifest': 'parser-manifest-invalid',
    'Git package.json must declare a supported exact version': 'parser-manifest-invalid',
    'Git package.json must declare its package name': 'parser-manifest-invalid',
    'Package identity differs from snapshot': 'parser-manifest-invalid',
    'Index exceeds limits': 'parser-graph-limit', 'Invalid graph node': 'parser-evidence-invalid',
    'Symbol node is outside snapshot': 'parser-evidence-invalid', 'Invalid source evidence': 'parser-evidence-invalid',
    'Invalid edge extraction or source': 'parser-evidence-invalid', 'Invalid index limitations': 'parser-limitations-invalid',
    'Invalid dependency binding': 'parser-dependency-invalid', 'Invalid exact dependency version': 'parser-dependency-invalid',
  };
  const message = error instanceof Error ? error.message : '';
  const code = Object.hasOwn(codes, message) ? codes[message] : 'parser-failed';
  process.stdout.write(JSON.stringify({ error: code }));
  process.exitCode = 1;
}
