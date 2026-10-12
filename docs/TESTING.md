# Verification strategy

Updated 2026-10-11. Check outcomes and their scope are in [the overhaul evidence](evidence/overhaul-validation.json). Current code is tested locally; hosted acceptance, concurrency and real settlement are separate gates.

## Commands

- `node scripts/doctor.mjs`: prerequisites/configuration presence without secret values.
- `node scripts/verify-starter.mjs`: 105 starter/domain checks, independent of full product acceptance.
- `bun run test:product`: actual parser, worker, SQL/RLS, registry, provider runtime, SDK/MCP and payment-policy tests. Stop fixture processes on 4311/4312 first; existing integration tests own those ports.
- `bun run lint`: ESLint, source hygiene and the Voyage/DeepSeek provider policy.
- `bun run typecheck`: contracts/core/worker/provider/SDK and Next source.
- `bun run build`: Next production build; do not run it against a simultaneous Next development server.
- `bun run worker:check` / `bun run provider:check`: isolated Node executable bundles.
- `bun run evaluate`: equal-source BM25 comparison and abstention guardrails; the tiny authored cases do not establish general quality.
- `bun run verify:release`: must remain blocked until full externally accepted workflows are verified.

## Browser checks

Start the web server on 3000 with `ATLAS_FIXTURES_ENABLED=true` in development, plus `bun run fixture:provider-a` and `bun run fixture:provider-b`. Then run `bun run test:browser`. Windows uses installed Edge; other hosts need Playwright Chromium. Tests never replace occupied services.

Two additional controls require explicit `ATLAS_BROWSER_TEST_SESSION=true`, configured development Clerk, and the already authorized principal record in ignored `.atlas/live-principal.json`. They create a 120-second ticket and a fresh session, verify the real account route, test browser mainnet refusal and history recovery against labelled commerce transports, and revoke only the new session/unused ticket. Existing sessions are preserved. Traces, saved auth state and failure screenshots are disabled for these opt-in cases.

This real sign-in does not turn mocked catalog/history/RPC responses into hosted commerce acceptance. Ordinary fixture cases and actual anonymous API denial remain distinct.

## SQL and payment boundaries

PGlite executes genuine migration SQL, RLS, triggers and AtlasDatabase transactions with a test claim shim. It verifies tenant isolation, denied direct mutation, capacities/rollback, lease fencing, immutable approvals, reservation accounting, single submission, replay rejection and provider-only migration installation. Its single serialized backend does **not** prove networked PostgreSQL lock contention or Clerk JWT validation.

Official offline MPP challenges, parser-built signed exports, native SDK/MCP HTTP and canonical-transfer checks run through the production implementation. Simulated RPC/identity/HTTPS transports are explicitly labelled. No test signature, transaction hash or receipt is claimed as a real wallet authorization or settlement.

[Independent verifier evidence](evidence/overhaul-verifier-commerce.json) and [security evidence](evidence/overhaul-security.json) list executed commands, regressions and limitations.

## Performance and read-only services

`node --experimental-transform-types --max-old-space-size=768 scripts/import-benchmark.ts` reproduces the SQL/checkpoint import benchmark with generated source and simulated GitHub. Parser baseline/after reports separately measure isolated deterministic analysis. RSS is measured at return, not sampled peak; AI calls/cost are zero while infrastructure costs remain unmeasured.

`bun run verify:integrations` probes Clerk, PostgreSQL/TLS, Supabase, GitHub App metadata and DeepSeek model availability. It sends no private source, performs no inference, applies no migrations and submits no payment. It creates/revokes only its own read-only installation token.

`node --experimental-transform-types --max-old-space-size=768 scripts/verify-overhaul-import.ts --allow-authorized-source-read` requires the existing authorized principal/import records. It freshly verifies Clerk-linked GitHub access, reads only existing hosted membership/repository metadata, and imports actual immutable GitHub source using the production service into an in-memory PGlite database. It validates graph/source/citations and same-commit reuse, saves only aggregate evidence, and closes the local database. It applies no hosted migration and is not a hosted concurrency or new-session acceptance test.

## Historical hosted evidence

The dated 2026-10-07 reports independently record real Clerk/Supabase JWT acceptance, private GitHub import/source/answers/browser, separate-backend RLS/reservations/lock contention, localhost signed webhook handling, private draft administration and provider replay/quote/claim storage. They do not certify the overhaul's new schema, real remote webhook delivery, external publication or settlement.

Opt-in scripts remain available in `scripts/verify-*.ts`; inspect their declared scope and owned-record cleanup before use. No current local success implies remote CI, deployment, successful paid delivery or general answer accuracy.
