# RepoFair SDK

The existing `@atlas/sdk` workspace package exports `RepoFairClient` for public capabilities and `AuthenticatedRepoFairClient` for real authenticated repository and commerce APIs. Legacy package names and exported aliases remain compatible with existing integrations.

Use your existing Clerk session for authenticated calls:

```ts
import { RepoFairClient, AuthenticatedRepoFairClient } from '@atlas/sdk';
const origin = 'https://repofair.vercel.app';
const publicClient = new RepoFairClient(origin);
console.log(await publicClient.capabilities());
const client = new AuthenticatedRepoFairClient(origin, {
  sessionToken: () => clerk.session.getToken(),
});
const account = await client.account();
const repositories = await client.repositories(account.workspaces[0].id);
```

Credentials go only to the exact RepoFair HTTPS origin. Requests reject redirects, enforce byte bounds and use bounded deadlines. Ordinary API requests allow 30 seconds; explicit quotes and existing paid delivery/recovery allow 240 seconds to cover fresh cross-service authorization below Vercel's 300-second Function limit. No request automatically retries a signature, credential or payment.

Repository methods include import/status/control, progressive maps, exact source ranges, extractive questions and exact dependency resolution. Commerce methods expose catalog/history, integer allowances, explicit approval, unsigned cancellation and signer-free recovery. `pay` accepts a caller-owned Moderato signer and claims signing once before invoking it. A pending/unknown outcome retains its reservation and must be reconciled rather than replaced.

See [MCP.md](MCP.md) for actual authenticated MCP tools and [TEMPO.md](TEMPO.md) for fixed testnet terms, the protected caller-owned CLI and current verification boundaries. A model cannot grant authentication or spending authority. Fixture clients require explicit development enablement and cannot access production fixtures. The workspace package has not been published to a registry.
