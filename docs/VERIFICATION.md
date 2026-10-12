# Historical packaging verification

The section below records the supplied scaffold. Current execution results are recorded in `docs/evidence/local-execution.json` and the current checkpoint appended below.

Checked on **2026-10-03**, using Node.js **22.16.0** and the locally available TypeScript **5.8.3** compiler.

| Check | Actual result | Scope |
|---|---|---|
| Starter/domain tests | **104 passed, 0 failed, 0 skipped** | Amount arithmetic, reservations, state transitions, citations, scope matching, graph identities/bounds, exact versions, fixtures, SDK validation, provider unavailable behavior, requested agent fields and launcher. |
| Core TypeScript check | **Passed** | Contracts, core and SDK; not the Next application. |
| TOML syntax | **7 files parsed** | Project configuration and six custom-agent files, using Python `tomllib`. |
| JavaScript syntax | **22 .mjs files passed** | Node `--check`; not authenticated/live service behavior. |
| Launcher dry-run | **Passed** | Correct requested lead and START prompt; no Codex process or model was invoked. |
| Fixture integrity | **Passed** | Actual source digests and locally generated npm lockfile, not invented commits. |
| Release guard | **Correctly blocked** | Product milestones and live integration evidence are still missing. |

Exact outputs and a machine-readable record are in `docs/evidence/`.

## Not run or verified

Bun and the Codex CLI were not installed in the packaging container, and registry downloads from that container encountered DNS failure. No root dependency install or `bun.lock` is claimed. Next.js production build, browser interaction, application lint, database/RLS integration, GitHub/Clerk/Supabase/model access, actual Codex delegation, Tempo settlement and MCP remain unverified or unimplemented as described in STARTER-STATUS.md.

The source pins and official configuration documentation were inspected separately. That does not establish successful installation, actual account access, the effective model of a running thread, or production readiness.

These passing tests validate **the starter foundations**. They are not proof that the final product's security, payments or market claims hold. P0 must install/verify dependencies; P1â€“P6 must implement and independently validate the product gates.

## Current local implementation checkpoint â€” 2026-10-03

| Check | Result | Boundary |
|---|---|---|
| Frozen Bun install | Passed | Real installed lockfile |
| Starter tests | 105 passed | Original helper/scaffold scope |
| Product tests | 47 passed in 10 files | Parser, federation, hostile evidence, SQL, SDK/MCP, payment policy |
| Browser | 12 passed, 0 skipped | Production server; actual fixture providers; Edge |
| Lint/typecheck/build |Passed | Full implemented local source |
| Evaluation | 3 cases, 2 passing abstention guards | Equal source access, tiny authored fixtures |
| Favicon follow-up |HTTP200 | Asset-only correction after browser run; rebuilt app |

Evidence: `docs/evidence/local-execution.json`, `browser-verification.json`, and `retrieval-evaluation.json`. Browser report retains the earlier selector timeout. Independent review scope and remaining review gap are in SECURITY.md. Release remains blocked on hosted auth, real multi-connection database safety, verified publication and real Tempo settlement/recovery. No CI, public deployment or payment transaction is claimed.

## Application AI change — 2026-10-07

62 focused AI tests and 14 browser checks pass; 105 starter tests, full types, lint, frozen install and production build pass. The new provider audit reports no forbidden application runtime dependency/call/configuration. Tests use mocked Voyage/DeepSeek HTTP and browser answer transport, with no live paid requests. See `docs/evidence/ai-provider-migration.json` and AI.md for scope and the first browser selector correction. Earlier checkpoint counts above remain historical.

## Hosted private-import checkpoint — 2026-10-07

The current product suite passes 192 tests in 18 files; the focused import/auth/webhook suites pass 81 tests. Fixture browser checks pass 14/14. Lint, full source types and the production build pass. `docs/evidence/live-audit-checkpoint.json` links each result and its scope.

Separate real evidence now covers Clerk widget sign-in and Supabase JWT acceptance, hosted multi-connection RLS/reservations, lock contention, signed localhost webhook persistence, and the user's private RepoFair import. The private browser checks exact source, graph expansion/list/origins, eight cited source ranges, keyboard/narrow layout and negative API requests. Verification sessions were revoked without revoking existing user sessions.

One approved public-fixture Voyage/DeepSeek workflow also passed with eight canonical citations and estimated usage below US$0.001. No private source was sent to AI. Remote webhook delivery, organizations/Storage, publisher acceptance, real Tempo settlement/recovery and authenticated paid agent access remain separate open gates; release intentionally remains blocked.

## Production overhaul checkpoint — 2026-10-11

Current final execution: 350/350 product tests in 28 files (39.42 seconds), 105/105 starter tests, 21/21 Edge browser checks (59.8 seconds), full TypeScript, lint/provider policy/hygiene, production build and worker/provider bundles passed. The evaluation retains three tiny authored cases and two abstention guards.

Browser results separate 19 fixture/transport/anonymous controls from two real development sign-in controls whose commerce/wallet responses are simulated. Native Edge found an actual SDK fetch receiver defect; after correction, browser and independent 12-test SDK verification passed.

A separate current real GitHub check freshly verified the existing authorized Clerk-linked user and imported 199 actual files using the new production service, with new SQL in an in-memory database only. It completed nine checkpoints in 94.6 seconds with no retries, validated source/graph/five citations and same-commit reuse. No hosted migration, source persistence by the verifier or AI call occurred.

Parser and actual SQL pipeline benchmarks cover small/medium/large generated inputs. The 4,001-file pipeline completed in 8.57 seconds; a one-file update reused 4,000 blobs, downloaded one and reduced simulated requests from 5,288 to 1,288. This is not real large-network import performance. RSS is measured at return, not peak.

[Validation](evidence/overhaul-validation.json) links the actual reports, bounded claims and corrected failures. All six actual role tasks completed; requested model/effort are recorded without inventing backend attestation. New hosted multi-backend concurrency, publication, real Moderato settlement/recovery and full acceptance remain open. No deployment, CI or successful paid delivery is claimed; the release gate remains blocked.
