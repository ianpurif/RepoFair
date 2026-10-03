# Local SDK and MCP

The actual MCP v1.32 stdio server exposes atlas_list_fixtures, atlas_explore, atlas_question and atlas_source. It accepts public fixture IDs and bounded arguments only.

Run from the repository root with `bun run mcp`. Configure an MCP client with command `bun`, argument `packages/sdk/src/mcp.ts`, and the repository as cwd. The cwd is required to locate the trusted fixture catalog. Protocol output uses stdout; avoid wrappers that contaminate JSON-RPC with logs.

`bun run sdk:example` calls the running web fixture APIs using AtlasFixtureClient. Source responses bind to the requested snapshot, path and line range. Redirects and remote destinations are rejected by this loopback-only client.

The integration test negotiates MCP, lists tools, retrieves cited evidence and rejects a traversal identifier using the official SDK. This proves the in-memory protocol pair. Remote Streamable HTTP, OAuth and paid MPP MCP transport remain unimplemented.
