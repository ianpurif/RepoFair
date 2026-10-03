# Verification strategy

Local checks cover the authored fixture product. They do not establish hosted authorization, concurrent database connections or real payment settlement.

## Commands

- `node scripts/verify-starter.mjs`: 105 dependency-free starter/domain checks.
- `bun run test:product`: Vitest parser, evidence, federation, SDK/MCP, SQL and payment-policy tests. Stop provider processes on 4311/4312 first; integration tests own these ports.
- `bun run lint`: ESLint plus file hygiene.
- `bun run typecheck`: contracts, core, worker, provider, SDK and Next sources.
- `bun run build`: production Next build.
- `bun run evaluate`: equal-source BM25 comparison and abstention guardrails; writes the measured fixture report.
- `bun run test:browser`: start web on 3000 and both fixture providers first. Windows uses installed Edge; other hosts need Playwright Chromium. Tests do not auto-start or replace occupied services.
- `bun run verify:release`: full product acceptance gate; remains blocked.

## Evidence boundaries

PostgreSQL-WASM executes the real migration with separate local test principals and a JWT-claim shim. It checks policy isolation, denied mutation, reservation accounting and replay rejection. It cannot prove hosted Clerk authentication, Storage policies or multi-connection reservation races.

Payment tests generate an official SDK challenge offline and exercise approval checks and uncertainty handling. They never sign or settle a transaction. Durable payment adapters are required but unwired; no paid recovery success is claimed.

Browser tests exercise real fixture APIs, source navigation, original citations, version reset, explicit provider disclosure, failure states, keyboard and narrow layouts. Authenticated import and paid approval are unavailable, not passing fixtures for those features.

See `docs/evidence/local-execution.json` and `docs/evidence/browser-verification.json` for actual results. Independent security findings and scope are recorded in SECURITY.md. No remote CI or production deployment is implied by local checks.
