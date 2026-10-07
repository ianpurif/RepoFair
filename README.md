# Chronos Atlas

**Map your code. Connect the knowledge.**

Atlas maps source relationships and connects version-specific evidence from independently operated knowledge providers. Public fixtures run without credentials. Clerk sign-in, Supabase persistence and read-only GitHub import now have real service adapters; acceptance evidence and remaining setup are tracked in [BLOCKERS.md](docs/BLOCKERS.md). Paid provider publication and Tempo settlement remain incomplete.

## Run locally

Use Node 22.16+ and Bun 1.4.1. From the repository root:

```sh
bun install --frozen-lockfile
bun run dev
```

Open **http://localhost:3000/demo**. The launcher fails if port 3000 is occupied. No external credentials are needed for fixtures. Run each provider in a separate terminal:

```sh
bun run provider:a
bun run provider:b
```

These are separate HTTP processes on 127.0.0.1:4311 and :4312, with separate identities and package/version catalogs. Payments are disabled, recipients are unset, and no receipts are fabricated. Stop a process to unpublish its local service. Already delivered data remains on the buyer's device.

For configured GitHub imports, sign in at `/sign-in`, connect GitHub in account settings and open `/app/repositories`. Run `bun run worker` in a separate terminal alongside the web server. Imports are durable jobs; stopping the worker leaves pending jobs pending rather than inventing a completed map. The private workspace uses deterministic source retrieval; private AI disclosure is not enabled.

## Local behavior

- In-memory ts-morph extraction of files, symbols, imports, re-exports, references and statically supported calls, with original source ranges and extraction methods.
- Bounded search, graph expansion and extractive answers with validated citations. Static relationships indicate potential impact, not confirmed breakage.
- Three-panel workspace, graph/list navigation, source inspection, version selection and separately approved provider requests.
- Five immutable source snapshots across one application and two dependencies. The second buyer snapshot resolves retry-kit 2.0.0 through a real npm lockfile.
- Typed local SDK and genuine MCP stdio tools. See [MCP setup](docs/MCP.md).
- Tenant and purchase SQL with PostgreSQL-WASM and hosted multi-connection policy/reservation tests. Actual Clerk session acceptance is recorded separately.

## Application AI

Voyage AI provides embeddings and reranking; DeepSeek provides generated answers and reasoning. Use the explicit AI option in the workspace after configuring server keys and reviewing the disclosure. See [AI setup and verification](docs/AI.md). Provider failures return errors without switching services. `bun run verify:ai` enforces the application provider policy.

## Source and authorization boundary

Fixture routes accept only catalog IDs. Authenticated repository routes require verified identity, workspace membership and fresh GitHub authorization before reading source. Immutable Git blobs are digest-checked and parsed without executing scripts, installing dependencies, loading plugins or following symlinks. Imported source stays within the configured application's PostgreSQL storage and authorized local responses.

Initial dependency resolution supports npm package-lock v3. Fixture file links match trusted catalog metadata. Unsupported resolution stays unresolved. Git imports use a separate Node parser process with a hard timeout, memory ceiling, sanitized environment and bounded source/graph sizes. They require a root package.json with an exact package version.

## Checks

```sh
node scripts/doctor.mjs
node scripts/verify-starter.mjs
bun run test:product
bun run lint
bun run typecheck
bun run build
bun run test:browser
bun run evaluate
bun run verify:release
```

The release command intentionally fails while full product gates are unmet. See [verification](docs/VERIFICATION.md), [progress](docs/PROGRESS.md), [limitations](docs/KNOWN-LIMITATIONS.md) and [demo](docs/DEMO.md).

## External setup

Configure Clerk/Supabase third-party auth, a read-only GitHub App, PostgreSQL, approved testnet signers and two provider recipients through local environment configuration. Never paste secrets into source or chat. Environment variables alone do not enable unverified integrations. Mainnet and public deployment require explicit authorization.

[BUILD.md](BUILD.md) remains the full product scope; [START.md](START.md) and [STATE.json](docs/STATE.json) define resumption. This local fixture delivery is not the completed paid-provider product.
