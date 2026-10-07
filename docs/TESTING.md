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

Browser tests exercise real fixture APIs, source navigation, original citations, version reset, explicit provider disclosure, failure states, keyboard and narrow layouts. These fixture checks do not establish authenticated import or paid approval.

See `docs/evidence/local-execution.json` and `docs/evidence/browser-verification.json` for actual results. Independent security findings and scope are recorded in SECURITY.md. No remote CI or production deployment is implied by local checks.

Application AI checks: `bun run verify:ai` audits source/manifests/lock/environment names. `bunx vitest run tests/ai` covers 62 provider and grounding boundary cases using mocked HTTP. Browser AI tests explicitly mock generation responses and assert disclosure, citation navigation and no fallback after failure. They never prove live model quality, account access or billing.

## Hosted verification — 2026-10-07

- `bun scripts/verify-integrations.ts`: read-only service/configuration probes; no secret output or inference calls.
- `bun scripts/verify-hosted-database.ts`: verified client-to-pooler TLS, separate backend tenant isolation, server repository grants, membership revocation, concurrent budget reservations and idempotency. Uses generated principals and cleans generated rows; this is separate from Clerk JWT verification.
- `bun scripts/verify-clerk-session.ts --allow-temporary-user`: real development Clerk widget sign-in, protected account route and Supabase JWT acceptance; deletes only its temporary test user/session. The Supabase OpenAPI root requires a secret key and is not a valid publishable-key authentication probe.
- `bun scripts/verify-hosted-webhook.ts`: native signed handler and actual localhost route checks, concurrent delivery deduplication, revocation and database persistence. Does not prove GitHub-origin delivery or public reachability.
- `node scripts/worker.mjs --once`: processes one queued import using a real linked user, installation token, immutable Git snapshot and isolated parser. Run `bun run worker` alongside the web server for continuous processing.
- `bun scripts/verify-private-repository-ui.ts --allow-test-session --wait-ready`: opt-in real private browser acceptance against the locally recorded authorized principal/import. Creates a short-lived sign-in ticket and a new session, preserves existing sessions, and revokes only its own session. No source, credential, screenshot or browser-state artifacts are saved by the verifier.
- `bun scripts/verify-hosted-import-locks.ts`: separate PostgreSQL backends verify repository-first locking, a reverse-order negative control and SKIP LOCKED; removes only generated audit records.

Evidence files identify scope, observed outcomes and cleanup. The private import and browser reports must be read independently of fixture test totals. No private source is sent to AI by these checks.
