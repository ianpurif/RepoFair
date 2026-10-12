# RepoFair

**Map your code. Connect the knowledge.**

RepoFair imports authorized GitHub repositories into immutable code maps and source-grounded answers. Owners can export selected knowledge to an independent provider and activate a version-specific Tempo Moderato service. Live at **https://repofair.vercel.app**, deployed from the existing ianpurif/RepoFair repository on Vercel Hobby. Real sign-in, a 323-file GitHub import, source maps/citations and a signed public publication have passed live verification. Testnet payment acceptance and remaining limits are recorded in [current blockers](docs/BLOCKERS.md).

## Run locally

Use Node 22.16+ and Bun 1.4.1. Configure server-side credentials from [.env.example](.env.example); the example is a template, not runtime configuration.

```powershell
bun install --frozen-lockfile
node scripts/doctor.mjs
bun run dev
```

Open **http://localhost:3000**, sign in, connect GitHub in account settings, and open **Repositories**. Imports advance in bounded authenticated requests while the repository workspace is open. To process jobs while browsers are closed, start the optional durable worker:

```powershell
bun run worker
```

The launcher rejects an occupied port 3000. The existing hosted central schema has been verified without replaying migrations; the separate provider database has its three reviewed provider migrations installed.

## Implemented workflows

- Authorized public/private GitHub import with durable checkpoints, fenced leases, rate-limit backoff, cancellation, retry and unchanged-blob reuse. A previous completed map stays available while an update runs.
- General repository identity independent of npm. TS/JS syntax and bounded Python declarations/imports have deterministic analysis; other languages expose genuine file evidence with explicit coverage limits.
- Progressive graph pages, file/symbol search, source inspection, keyboard navigation and extractive questions pinned to an exact commit and original line ranges.
- Exact npm package-lock v3 dependency resolution and on-demand provider discovery. Missing versions remain unresolved; discovery never substitutes latest or purchases automatically.
- Explicit owner-reviewed signed exports, endpoint-control activation and revocation. Separate provider databases own their source, challenge secrets, prices, recipients and sale ledgers.
- Authenticated SDK, MCP and browser purchase controls with integer workspace allowances, one-time signing claims, authoritative Moderato receipt checks and recovery of existing payments/delivery.

Static relationships describe potential impact. Paying for context is not a correctness guarantee. Source, payment, delivery and evidence quality remain separate.

## Configuration and publication

[Provider publishing](docs/PROVIDER-PUBLISHING.md) explains export/install/activate. [Tempo](docs/TEMPO.md) defines chain and recovery guarantees. [SDK/MCP](docs/MCP.md) documents authenticated agent access and caller-owned signing.

Only **Tempo Moderato (42431)** and PathUSD are supported. The issuer private key stays on RepoFair; an independent provider receives only its public key. Wallet keys are never stored in the application. Private source leaves RepoFair only through an owner-approved export and authorized delivery.

Optional AI uses native Voyage embeddings/reranking and DeepSeek generation, disabled by default. Current private repository questions are deterministic and extractive. Private AI disclosure, operating-cost reservations and quality acceptance remain open; see [AI.md](docs/AI.md).

## Isolated fixtures

Normal product pages use persisted authenticated data. Public test fixtures require explicit development enablement and are always unavailable in production:

```powershell
$env:ATLAS_FIXTURES_ENABLED = "true"
$env:ATLAS_MODE = "fixture"
$env:NEXT_PUBLIC_ATLAS_MODE = "fixture"
bun run dev
```

Then open **/demo** and run `bun run fixture:provider-a` and `bun run fixture:provider-b` in separate terminals. These services have no payments or receipts. `bun run fixture:mcp` and `bun run sdk:example` exercise authored fixtures only.

## Verification

```powershell
node scripts/verify-starter.mjs
bun run lint
bun run typecheck
bun run test:product
bun run build
bun run worker:check
bun run provider:check
bun run evaluate
bun run verify:release
```

Browser checks require explicit local services; [TESTING.md](docs/TESTING.md) records commands and evidence boundaries. The public web and provider are deployed. Six real live browser checks passed. The full release gate remains blocked by the documented acceptance limits; real payment evidence is recorded separately. Only Moderato testnet is permitted; no mainnet or real-money activity occurred.
