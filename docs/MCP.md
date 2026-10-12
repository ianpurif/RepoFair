# Authenticated SDK and MCP

Updated 2026-10-11. `bun run mcp` starts the actual MCP v1.32 stdio server over the authenticated Atlas API. Fixture tools require a separate development command.

## Configuration

Set `ATLAS_API_ORIGIN` to the exact Atlas HTTPS origin and `ATLAS_SESSION_TOKEN_FILE` to a private file containing the caller's Clerk session token. The file is read per request, allowing the caller to refresh it. Expired/revoked sessions fail closed. Loopback development additionally requires `ATLAS_ALLOW_LOCAL_DEVELOPMENT=true`.

Run `bun run mcp`, or configure the client's command as `bun`, argument `packages/sdk/src/mcp.ts`, and this repository as cwd. JSON-RPC stays on stdout; configuration errors use sanitized stderr. Never place secrets in prompts or tool arguments.

Tools read the account, authorized repositories, durable import status, bounded maps/source, commit-pinned answers, exact dependency/provider discovery and persisted purchase history. Models may resume an **existing** submitted purchase, but cannot configure an allowance, approve a new purchase, provide payment credentials or invoke signing.

Session tokens go only to Atlas. Providers receive short-lived audience-scoped issuer grants, never Clerk tokens. Redirects, excessive bytes and timeouts fail explicitly.

## Caller-owned SDK

`AuthenticatedAtlasClient` is exported by `@atlas/sdk`. Supply a session-token callback for each request:

```ts
import { AuthenticatedAtlasClient } from '@atlas/sdk';

const atlas = new AuthenticatedAtlasClient('https://your-atlas.example', {
  sessionToken: () => yourSessionProvider.getToken(),
});
const { index } = await atlas.map(repositoryId, immutableSnapshotId);
const { answer } = await atlas.question(
  repositoryId, immutableSnapshotId, 'Which source handles cancellation?',
);
```

`resolveDependency` returns accessible providers for a selected node's exact resolved release without buying or substituting another version.

New payment approval is application-owned code outside model tools. Configure the workspace allowance, approve the exact service amount/question, then call `pay(reservation, {account, getClient})` with a caller-owned Moderato signer. The SDK freezes the official challenge/body, claims signing first and checks the remote chain. See [TEMPO.md](TEMPO.md).

After an uncertain response, call `resumePurchase(existingPurchaseId)`. It supplies no credential and never signs/broadcasts again. There is no global fetch patch or environment-loaded wallet key.

## Verification and fixtures

Tests use native loopback HTTP, official offline challenges, actual MCP protocol and the production stdio child process. They check credential origin, redirects, bounds, mainnet/wrong-RPC refusal, recovery and absence of approval/signing tools. Identity/chain transports remain fixtures; no real signing or paid MCP transport is established.

`bun run fixture:mcp` exposes authored tools only with explicit enablement outside production. `bun run sdk:example` uses the loopback fixture client. Production refuses fixture mode.

Remote MCP Streamable HTTP/OAuth transport is not implemented. Authenticated stdio uses the existing Atlas HTTPS API and does not claim a separate remote paid MCP service.
