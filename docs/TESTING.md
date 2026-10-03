# Verification strategy

Starter checks run offline with Node's built-in test runner and type stripping. They validate supplied deterministic helpers and harness structure, not the complete product. The starter lint command checks only file hygiene; add real ESLint and Vitest/browser/database checks in P0/P1.

## Commands
- `node scripts/verify-starter.mjs`: hygiene, requested agent settings, domain unit tests, fixture integrity and provider boundary tests.
- `node scripts/typecheck.mjs --core-only`: pure contracts/core/SDK types; local TypeScript or explicitly available compiler required.
- `bun run typecheck`: core and Next source after dependency installation.
- `bun run build`: production Next build after bootstrap.
- `bun run verify:release`: validates product milestone evidence; deliberately fails in the supplied starter.

## Product test matrix
Parsing: aliases, imports, reexports, dynamic/unresolved refs, oversized/malicious files, snapshot stability.
Evidence: exact lines, cited content, denied scope, revoked permission revisions, provider provenance, partial context.
Versions: exact vs ranges, wrong package, ambiguous mapping, stale cached evidence, unsupported release, no automatic fallback.
Federation: distinct IDs, verified export linkage, malformed graph, unresolved symbols, buyer source minimization.
Money: serializable reservation races, expiry, amount/recipient/network substitution, replay, crash recovery, pending settlement, settled payment plus failed delivery.
Authorization: real Clerk-derived principals and DB policies; actual denied reads/writes across every table/storage path. A unit test of a scope helper is not an RLS test.
Browser: import, graph navigation, cite line, source/version change, purchase approval, publish exposure, error/empty/loading, narrow layout, keyboard/reduced-motion.

Evaluate against a competent lexical/vector baseline with identical source access. Record reviewed supporting file sets, unanswered questions, wrong-version questions, latency and full incurred cost. Do not replace a failed task with a passing fixture in the report.

Record exact commands, timestamps, exit codes and evidence paths. Unrun or skipped is not passed. Require independent review before live data/funds.
