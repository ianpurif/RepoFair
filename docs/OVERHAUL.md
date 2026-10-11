# Production engineering overhaul

Requested 2026-10-11. All commerce uses Tempo Moderato (42431); mainnet is forbidden.

## Priorities and acceptance

1. **Import reliability:** retain the PostgreSQL worker; checkpoint the immutable tree and verified blobs, process bounded download slices, fence leases, retry transient/rate-limit failures, and support cancellation and same-commit recovery. Keep the previous completed map available during updates. Reject duplicate jobs and publish a complete snapshot atomically. Test crashes, stale workers, revocation, truncated trees, and unchanged-blob reuse.
2. **General repository maps:** remove the root npm-package prerequisite. Retain exact package identity only where source declares it. Add deterministic Python syntax support and honest file-level coverage for other languages. Keep analysis bounded and imported code inert. Measure small/medium/large generated repositories; distinguish those results from real GitHub import measurements.
3. **Usable persisted workflows:** render durable import progress, recovery controls, grouped and bounded graphs, exact source navigation, real repository activity, and authenticated source retrieval. Remove fixture records from normal product discovery and navigation. Keep test fixtures behind explicit development configuration.
4. **Owner publication and Moderato commerce:** connect explicit exposure-reviewed publications, exact release mappings, revocation, standalone provider delivery, MPP settlement verification, replay protection and delivery recovery. Require configured owner/recipient/signer and preserve unknown settlement. No paid AI calls or transactions without the appropriate authorization.
5. **Independent acceptance:** security and verifier roles check final integration. Run starter, lint, types, product, browser, performance and production-build checks. Record live checks independently from generated/mock tests and keep the release gate blocked where evidence is missing.

## Architectural decisions

- Extend the existing PostgreSQL queue and independent Node worker. No Redis, graph database, hosted tracing service or additional queue infrastructure is justified by the current failure.
- Staging data is server-only. Readers receive only completed snapshots after fresh workspace and GitHub authorization; revocation invalidates worker claims and source reads.
- A Git commit is a repository version. Repositories without an exact package release have nullable package identity rather than an invented npm version.
- Deterministic indexing does not call AI. Optional Voyage/DeepSeek processing requires bounded input, explicit source disclosure and database-backed operating-cost reservations.
- Candidate evaluations: retain ts-morph/React Flow; use PostgreSQL node/edge data and bounded graph projection. Tree-sitter may be useful when a packaged, isolated language grammar provides better supported extraction. LangSmith remains disabled because private-source egress and measured benefit have not been established.

## Evidence boundary

The baseline product suite passed 233 tests on 2026-10-11. The starter gate currently reports a pre-existing CRLF formatting failure in `docs/PROGRESS.md`. Existing author/configuration/planning edits belong to the user and are preserved. New migrations will be validated locally before any separately authorized deployment. Passing mocks or PostgreSQL-WASM checks does not establish hosted concurrency, real GitHub webhook delivery, Tempo settlement or private AI quality.
