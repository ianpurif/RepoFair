import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseRepositoryIndex } from '../packages/core/src/local/parser.ts';

const sizes = [16, 144, 1000, 4000];
const childSize = process.argv.indexOf('--child');
if (childSize >= 0) {
  const count = Number(process.argv[childSize + 1]);
  if (!sizes.includes(count)) throw new Error('Unsupported benchmark size');
  const files = [{ path: 'package.json', text: JSON.stringify({ name: 'atlas-generated-benchmark', version: '1.0.0' }) },
    ...Array.from({ length: count }, (_, i) => ({ path: `packages/module-${Math.floor(i / 32)}/file-${i}.ts`,
      text: `${i > 0 ? `import { value${i - 1} } from '${i % 32 ? './' : `../module-${Math.floor((i - 1) / 32)}/`}file-${i - 1}';\n` : ''}export function value${i}(input: number) { return ${i > 0 ? `value${i - 1}(input)` : 'input'} + ${i}; }\n` }))];
  const started = performance.now();
  try {
    const index = parseRepositoryIndex({ scope: { tenantId: 'benchmark', principalId: 'benchmark', permissionRevision: '1' },
      snapshot: { repositoryId: 'benchmark', snapshotId: 'generated', kind: 'git', revision: 'a'.repeat(40) },
      packageName: 'atlas-generated-benchmark', version: '1.0.0', files, observedAt: new Date().toISOString() });
    console.log(JSON.stringify({ files: files.length, bytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0),
      status: 'complete', durationMs: Math.round(performance.now() - started), rssAtReturnBytes: process.memoryUsage().rss,
      nodes: index.nodes.length, edges: index.edges.length, serializedBytes: Buffer.byteLength(JSON.stringify(index)),
      providerCalls: 0, indexingProviderCostUsd: 0 }));
  } catch (error) {
    console.log(JSON.stringify({ files: files.length, status: 'rejected', durationMs: Math.round(performance.now() - started),
      reason: error instanceof Error ? error.message : 'Parser failed', rssAtReturnBytes: process.memoryUsage().rss, providerCalls: 0 }));
  }
} else {
  const label = process.argv.includes('--baseline') ? 'baseline' : 'after';
  const script = fileURLToPath(import.meta.url);
  const results: unknown[] = [];
  for (const count of sizes) {
    const result = await new Promise<unknown>((resolveResult, reject) => {
      const child = spawn(process.execPath, [script, '--child', String(count)], { windowsHide: true, stdio: ['ignore','pipe','pipe'],
        env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
      let output = ''; let errors = '';
      const timer = setTimeout(() => { child.kill(); resolveResult({ files: count + 1, status: 'timeout', durationMs: 90000 }); }, 90000);
      child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { errors += String(data); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); if (code !== 0) resolveResult({ files: count + 1, status: 'process-failed', exitCode: code, diagnostic: errors.slice(0, 200) });
        else { try { resolveResult(JSON.parse(output)); } catch { reject(new Error('Invalid benchmark output')); } } });
    });
    results.push(result); console.log(JSON.stringify(result));
  }
  await mkdir(resolve('docs/evidence'), { recursive: true });
  await writeFile(resolve(`docs/evidence/import-benchmark-${label}.json`), JSON.stringify({ timestamp: new Date().toISOString(),
    scope: 'Generated TypeScript monorepo parser benchmark, separate Node process per size. No GitHub network calls, hosted concurrency, AI, or transactions.',
    memoryMetric: 'RSS at parser return; includes runtime and parser library, not a sampled peak or a production memory guarantee.', results }, null, 2) + '\n');
}
