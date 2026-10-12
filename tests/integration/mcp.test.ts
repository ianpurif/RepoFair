import { it, expect,vi,afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAtlasMcpServer } from '../../packages/sdk/src/mcp.ts';
vi.stubEnv('ATLAS_MODE','fixture');vi.stubEnv('ATLAS_FIXTURES_ENABLED','true');afterAll(()=>vi.unstubAllEnvs());
it('negotiates real MCP, lists tools and returns cited fixture evidence', async () => {
  const server = createAtlasMcpServer(); const client = new Client({ name: 'atlas-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = await client.listTools(); expect(tools.tools.map(t => t.name)).toContain('atlas_question');
    const result = await client.callTool({ name: 'atlas_question', arguments: { fixtureId: 'retry-kit@2.0.0', question: 'permanent errors' } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('error.permanent');
    const denied = await client.callTool({ name: 'atlas_explore', arguments: { fixtureId: '../../private' } });
    expect(denied.isError).toBe(true);
  } finally { await client.close(); await server.close(); }
});
