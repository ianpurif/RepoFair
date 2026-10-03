import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { FIXTURE_IDS, parseFixtureId } from '@atlas/contracts';
import { indexFixture } from '@atlas/worker/fixtures';
import { answerLocal, lookupSource } from '@atlas/core/local';

export function createAtlasMcpServer(): McpServer {
  if ((process.env.ATLAS_MODE ?? 'fixture') !== 'fixture') throw new Error('Only public fixture MCP is enabled');
  const server = new McpServer({ name: 'chronos-atlas-fixture', version: '0.1.0' });
  const fixtureId = z.enum(['jobboard-app@1.0.0', 'jobboard-app@2.0.0', 'retry-kit@1.0.0', 'retry-kit@2.0.0', 'event-log@1.0.0']);
  const wrap = async (operation: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation()) }] }; }
    catch { return { isError: true, content: [{ type: 'text' as const, text: 'Fixture operation failed. Check snapshot and input bounds.' }] }; }
  };
  server.registerTool('atlas_list_fixtures', { description: 'List public demonstration snapshots. No private repository access.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: JSON.stringify({ mode: 'fixture', fixtureIds: FIXTURE_IDS, payments: 'disabled' }) }] }));
  server.registerTool('atlas_explore', { description: 'Parse a bounded public fixture graph. Static edges show potential relationships.', inputSchema: { fixtureId } },
    ({ fixtureId }) => wrap(async () => indexFixture(parseFixtureId(fixtureId))));
  server.registerTool('atlas_question', { description: 'Retrieve original cited fixture passages. Extractive, no generation model or paid calls.', inputSchema: { fixtureId, question: z.string().trim().min(1).max(2000) } },
    ({ fixtureId, question }) => wrap(async () => answerLocal(await indexFixture(parseFixtureId(fixtureId)), question)));
  server.registerTool('atlas_source', { description: 'Read exact original source lines from a public fixture snapshot.', inputSchema: { fixtureId, path: z.string().min(1).max(500), startLine: z.number().int().min(1), endLine: z.number().int().min(1) } },
    ({ fixtureId, path, startLine, endLine }) => wrap(async () => lookupSource(await indexFixture(parseFixtureId(fixtureId)), path, startLine, endLine)));
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createAtlasMcpServer().connect(new StdioServerTransport());
}
