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
