import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LocalAnswer, LocalIndex, SourceEvidence } from '@atlas/contracts';

function textResult(value: Awaited<ReturnType<Client['callTool']>>): unknown {
  expect(value.isError).not.toBe(true);
  expect(Array.isArray(value.content)).toBe(true);
  const content = value.content as { type: string; text?: string }[];
  expect(content).toHaveLength(1); expect(content[0]?.type).toBe('text');
  return JSON.parse(content[0]!.text!);
}

it('actual stdio subprocess negotiates MCP, lists tools, and binds versioned citations to real source', async () => {
  const client = new Client({ name: 'atlas-independent-stdio-verifier', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: 'bun', args: ['packages/sdk/src/mcp.ts'], cwd: resolve('.'),
    env: { ...getDefaultEnvironment(), ATLAS_MODE: 'fixture' }, stderr: 'pipe' });
  const stderr: string[] = []; transport.stderr?.on('data', chunk => stderr.push(String(chunk)));
  try {
    await client.connect(transport);
    expect(transport.pid).toBeGreaterThan(0);
    expect(client.getServerVersion()).toMatchObject({ name: 'chronos-atlas-fixture', version: '0.1.0' });
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual(['atlas_explore', 'atlas_list_fixtures', 'atlas_question', 'atlas_source']);
    expect(textResult(await client.callTool({ name: 'atlas_list_fixtures', arguments: {} }))).toMatchObject({ mode: 'fixture', payments: 'disabled' });
    const index = textResult(await client.callTool({ name: 'atlas_explore', arguments: { fixtureId: 'retry-kit@2.0.0' } })) as LocalIndex;
    expect(index.snapshot.snapshotId).toBe('retry-kit@2.0.0'); expect(index.nodes.length).toBeGreaterThan(0);
    const answer = textResult(await client.callTool({ name: 'atlas_question', arguments: { fixtureId: 'retry-kit@2.0.0', question: 'What happens for permanent errors?' } })) as LocalAnswer;
    expect(answer.status).toBe('evidence_ready'); expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.answer).toContain('if (error.permanent === true) return false');
    for (const citation of answer.citations) {
      expect(citation.source.snapshotId).toBe('retry-kit@2.0.0'); expect(citation.source.revision).toBe(index.snapshot.revision);
      const original = (await readFile(resolve('fixtures/repos/retry-kit/v2', citation.source.path), 'utf8')).replace(/\r\n/g, '\n').split('\n').slice(citation.source.startLine - 1, citation.source.endLine).join('\n');
      expect(citation.original).toBe(original);
      const source = textResult(await client.callTool({ name: 'atlas_source', arguments: { fixtureId: 'retry-kit@2.0.0', path: citation.source.path, startLine: citation.source.startLine, endLine: citation.source.endLine } })) as SourceEvidence;
      expect(source.source).toEqual(citation.source); expect(source.original).toBe(original);
    }
    expect(stderr).toEqual([]);
  } finally { await client.close(); await transport.close(); }
}, 30000);

it('stdio rejects private selectors, source escape, unsupported version and unbounded input without leakage', async () => {
  const client = new Client({ name: 'atlas-independent-stdio-boundary-verifier', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: 'bun', args: ['packages/sdk/src/mcp.ts'], cwd: resolve('.'),
    env: { ...getDefaultEnvironment(), ATLAS_MODE: 'fixture' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    for (const arguments_ of [{ fixtureId: '../../private' }, { fixtureId: 'retry-kit@9.0.0' }]) {
      const result = await client.callTool({ name: 'atlas_explore', arguments: arguments_ });
      expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).not.toContain('import {');
    }
    const escaped = await client.callTool({ name: 'atlas_source', arguments: { fixtureId: 'retry-kit@2.0.0', path: '../../.env', startLine: 1, endLine: 1 } });
    expect(escaped.isError).toBe(true); expect(JSON.stringify(escaped.content)).not.toContain(resolve('.'));
    const oversized = await client.callTool({ name: 'atlas_question', arguments: { fixtureId: 'retry-kit@2.0.0', question: 'x'.repeat(2001) } });
    expect(oversized.isError).toBe(true);
    const unknown = textResult(await client.callTool({ name: 'atlas_question', arguments: { fixtureId: 'retry-kit@2.0.0', question: 'Explain retry-kit 9.0.0 behavior.' } })) as LocalAnswer;
    expect(unknown.status).toBe('abstained'); expect(unknown.citations).toEqual([]);
    const followup = textResult(await client.callTool({ name: 'atlas_explore', arguments: { fixtureId: 'event-log@1.0.0' } })) as LocalIndex;
    expect(followup.snapshot.snapshotId).toBe('event-log@1.0.0');
  } finally { await client.close(); await transport.close(); }
}, 30000);
