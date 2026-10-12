# Production engineering overhaul

Updated 2026-10-11. Implementation and local verification are complete within the documented bounds. Hosted deployment and real payment acceptance remain blocked; this is not a production-readiness claim.

## Root causes and fixes

- Importing treated a small npm package as the universal repository model, repeated full downloads, and performed expensive TypeScript reference scans. General Git snapshots now have nullable package identity, deterministic multilingual coverage, bounded analysis and verified unchanged-blob reuse.
- Long imports lacked durable tree/blob checkpoints and actionable phase progress. The existing PostgreSQL queue now records discovery manifests and 32-file slices, uses four download workers, fences leases, retries transient/rate-limit failures, handles expired tokens/truncated trees, and supports cancellation and recovery. Complete snapshots publish atomically; the previous map remains readable.
- Normal product pages loaded fixture data. They now load authenticated persisted repositories, bounded graph pages, exact source ranges, job history, publication drafts and purchase states. Fixtures require explicit development enablement and are disabled in production.
- Publication/payment boundaries accepted insufficient graph proofs, stale entitlements or mutable purchase terms. Selected owner exports now sign original source and complete graph members; signed endpoint control, fresh authorization fences, immutable quotes, atomic reservations, independent provider ledgers and one-time submission bind every purchase.
- Native Edge exposed an unbound SDK fetch receiver; binding it fixed purchase-history recovery. Independent review also found and closed reader lock privilege, revocation race, provider URL/response and nested database connection defects.

## Architecture and features

Retain PostgreSQL and the separate bounded Node worker, ts-morph for supported TypeScript/JavaScript, React Flow for bounded interactive maps, and exact npm release mappings. Add pinned Lezer Python syntax extraction; other languages retain honest file-level source evidence. No graph database, Redis queue or tracing service was justified.

Imported scripts, dependencies and plugins are never executed. Analysis reaches at most 5,000 source files, 30 million characters, 50,000 nodes and 150,000 edges, with explicit omissions. The parser child has a 60-second deadline and 768 MiB V8 heap limit. Larger TypeScript sets retain declarations/imports/exports while expensive whole-program reference analysis is omitted.

The authenticated native SDK and stdio MCP expose pinned source, maps, questions and exact dependency discovery. Browser and caller-owned signing requires explicit immutable purchase terms and actual Moderato chain verification. Unknown settlement stays reserved; resume reconciles the existing record without another charge. Selected paid context includes signed source and graph provenance, independently of its accuracy.

Owner publishing remains explicit: review selected paths/rights/price, download the signed immutable export, install it in an independent operator database, verify HTTPS endpoint control, then activate. Private metadata cannot be discovered through anonymous control requests. Revocation blocks new access and in-flight delivery reuse.

Voyage and DeepSeek remain the exclusive optional application AI providers. Deterministic indexing makes no AI calls. Private questions use extractive evidence; private AI operating-budget/tracing acceptance remains open.

## Actual results

| Check | Result and scope |
|---|---|
| Product suite | 350/350 passed, 28 files, 39.42 seconds; actual implementation with labelled external transports |
| Browser | 21/21 passed in Edge; 19 fixture/transport/anonymous controls and two real development sign-in controls with simulated commerce/wallet responses |
| Starter | 105/105 passed |
| Source/build | Full TypeScript, ESLint/provider policy/hygiene, production Next build and worker/provider bundles passed |
| Evaluation | Three authored cases and two abstention guards; no general quality claim |
| Real GitHub import | 199 authorized files in 94.6 seconds, nine checkpoints, no retries; exact source, 160-node page, five citations and same-commit reuse passed in isolated local SQL |
| Production smoke | Eight pages HTTP 200; authenticated APIs deny anonymous calls with 401/no-store; fixture APIs 503 and /demo 404 even when fixture enablement is set |
| Read-only integrations | Clerk, Supabase, verified PostgreSQL TLS, GitHub App and DeepSeek model metadata passed |
| Independent work | All six actual custom roles completed; security and verifier findings/regressions recorded; backend model metadata unavailable |

The real import uses fresh Clerk-linked GitHub authorization and actual immutable source reads. New migration writes and source remain in an in-memory database; hosted reads only inspect existing membership/repository metadata. It does not establish changed-schema hosted browser acceptance or multi-backend concurrency.

## Benchmarks

| Generated files | Parser before | Parser after |
|---|---:|---:|
| 17 | 193 ms | 109 ms |
| 145 | 1,478 ms | 271 ms |
| 1,001 | Rejected by old bounds | 722 ms |
| 4,001 | Rejected by old bounds | 2,398 ms |

The actual SQL/checkpoint pipeline with simulated GitHub imported 4,001 files in 8.57 seconds. A one-file update took 8.10 seconds, downloaded one blob and reused 4,000; simulated HTTP requests fell from 5,288 to 1,288. Parsing still rebuilds the complete bounded graph. These sparse generated inputs do not establish dense large-repository or real-network throughput.

RSS is measured at return, not peak. The real importer parent used 563,662,848 bytes including PGlite; child peak memory is unmeasured. Indexing provider calls and cost were zero. Hosting/compute/storage costs remain unmeasured.

## Verified workflow boundaries and deployment requirements

Current checks verify source-backed general maps, exact source/citations, durable crash/retry/cancel/reuse controls, owner-selected proofs, version/tenant/revocation denial, authenticated SDK/MCP, immutable budget/payment state and recovery through the production implementation. Fixture receipts are not real settlement.

As of 2026-10-12, native hosted inspection confirms central 202610110001/002 already installed; this setup did not replay them or backfill migration history. A separate provider database/login on the existing Supabase cluster now has replay/ledger 005/006 and delivery 202610110003, with native TLS/schema/role/contention verification. Production web/worker and two approved temporary HTTPS tunnels are running; signing configuration, recipient/test price and a faucet-funded buyer account are prepared. The provider is preparation-only and returns inactive 503. An owner-approved signed artifact/publication identity, installation, endpoint-control activation and explicitly authorized real purchase/recovery remain open. Same-project separation and Quick Tunnels do not prove independent operators or permanent production hosting. Current scope is recorded in [publishing execution](evidence/publishing-execution.json).

Actual external activation, second-account discovery, distinct operator recipients, wallet signing, Moderato settlement/recovery, remote GitHub delivery, organization/Storage and private AI acceptance remain unverified. A local PostgreSQL concurrency refresh was unavailable because Docker's daemon did not start; single-backend SQL results are explicitly bounded. The release gate must continue to fail.

Evidence: [validation](evidence/overhaul-validation.json), [real import](evidence/overhaul-real-import.json), [benchmarks](evidence/import-pipeline-benchmark.json), [security](evidence/overhaul-security.json), [independent verifier](evidence/overhaul-verifier-commerce.json). Full configuration and remaining acceptance are in [BLOCKERS.md](BLOCKERS.md), [PROVIDER-PUBLISHING.md](PROVIDER-PUBLISHING.md) and [TEMPO.md](TEMPO.md).
