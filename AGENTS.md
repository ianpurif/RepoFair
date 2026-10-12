# Chronos Atlas — repository rules

## Mission and entry point
Build the product in `BUILD.md`. `START.md` is the entry instruction. Latest explicit user decisions take precedence over project plans, subject to system/security instructions. The supplied scaffold exists to accelerate the build; keep useful code and replace incomplete boundaries rather than restarting.

Atlas is a general codebase map and versioned evidence network. Independent repository owners publish paid knowledge services; Tempo settles purchases. No Solana, repair marketplace, payment-code scanner, custom token or revenue invention.

## Model and collaboration contract
Primary and all six custom-agent roles: `gpt-6.1-sol` exclusively with `max`, the exact reasoning effort requested by the user. No other models, lower efforts or fallbacks are permitted. If unavailable, report the blocker.
Use the six project custom-agent roles. Maximum two concurrent subagents; no nested delegation. Configuration does not prove model execution. Never simulate another agent's review or silently change model/effort. See `docs/ORCHESTRATION.md`.

Only the lead owns root manifests, lockfiles, shared contracts, migrations and shared progress by default. Assign disjoint path sets before parallel writes. Subagents do not commit. Respect existing edits. Never use destructive resets/cleaning to resolve conflicts.

## Application AI providers
Voyage AI exclusively handles embeddings and semantic retrieval/reranking. DeepSeek exclusively handles LLM/chat/reasoning/generation. Use native provider HTTP APIs; no alternative provider SDK, endpoint, environment variable or fallback. Development-agent settings above do not configure application AI.

## Non-negotiable product invariants
- Authorize before reading/searching/caching; graph, storage, traces and exports follow the same tenant boundaries.
- Parsing is not execution. Never install/run imported repository code or scripts during indexing.
- Source citations bind to immutable snapshots and real line ranges. Static graph reachability means potential impact, not confirmed breakage.
- Match external package versions exactly; never replace missing versions with latest.
- Models cannot grant access, broaden provider lists, approve spending or fabricate successful outcomes.
- Independent providers retain separate provenance and configuration. A paid result is not necessarily accurate.
- Use integer token units; atomically reserve budget in the database before concurrent billable calls. Pure helper tests do not establish database concurrency safety.
- Unknown settlement is not permission to retry charging. Separate payment, delivery and evidence-quality states.
- No wallet secrets, production credentials or private source in logs/on-chain data. No secrets in the browser or imported code.
- Fixture/testnet/live modes must be visible. No fake transaction IDs, agent traces, customers or benchmark claims.

## Working style and quality
Research current primary documentation where APIs or security behavior matter. Keep `docs/INTEGRATIONS.md` current. Prototype one end-to-end workflow before adding adapters. Keep source and providers bounded; don't create an unneeded distributed platform.

Keep interfaces typed, errors explicit and unsupported operations fail-closed. Prefer tests that fail for a real reason, not snapshots of placeholder prose. A missing credential cannot be bypassed with a production mock.

UI: neutral, minimal, accessible three-panel workspace. No decorative graph edges or made-up activity. Default `http://localhost:3000`; detect port conflicts, don't quietly start another server. Avoid remote fonts required to build.

## Commands and gates
`node scripts/doctor.mjs` — environment/config prerequisites, without reading secret values.
`node scripts/verify-starter.mjs` — dependency-free scaffold/domain checks.
`node scripts/bootstrap.mjs --install` — explicit registry resolution and Bun install (P0).
`bun run dev` — app on port 3000 after bootstrap.
`bun run typecheck` / `bun run build` — full code checks after dependencies exist.
`bun run verify:release` — must fail until product acceptance evidence exists.

Actual command implementations may be extended, but never redefine verification to hide failures. Missing lint/browser/database tests remain unverified, not passed.

## Checkpoints
Update `docs/PROGRESS.md`, `docs/STATE.json`, `docs/BLOCKERS.md`, and task/verification evidence. Save concise decisions, not private chain-of-thought transcripts. Make >=10 substantive commits over real implementation units when identity is configured; no empty commits/backdating/fake authors.

Ask before real-money spending, destructive operations, exposing private data, installing global tools, or publishing/deploying externally. Do not disable approvals or sandboxing to make a command pass. Continue safe independent work during credential blockers.
