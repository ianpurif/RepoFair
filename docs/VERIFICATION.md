# Packaging verification

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

These passing tests validate **the starter foundations**. They are not proof that the final product's security, payments or market claims hold. P0 must install/verify dependencies; P1–P6 must implement and independently validate the product gates.
