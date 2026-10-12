# Start RepoFair

## Instruction to Codex

Read and execute this file. Build the product defined in **BUILD.md**, continuing through P0–P6. Do not stop at a plan, scaffold or the first milestone. This folder is the starting scaffold, not a finished application.

### Read before editing

Read `AGENTS.md`, all of `BUILD.md`, `docs/PLAN.md`, `docs/PROGRESS.md`, `docs/STATE.json`, and `docs/ORCHESTRATION.md`. Read `docs/STARTER-STATUS.md` so you do not mistake supplied helpers for product features. Follow the numbered sections across multiple reads when tool output is truncated.

The current product is **general codebase intelligence plus paid, independently operated knowledge providers**. Do not revive superseded repair sales, transaction diagnosis, or payment-security scanner scope.

### Requested models — do not silently change

- Primary coordinator and all six custom-agent roles: **GPT-6.1 Sol**, `gpt-6.1-sol`, `max` (reasoning effort explicitly requested by the user). No other models, lower efforts or fallbacks.
- Use only the six configured roles in `.codex/agents/`. At most two spawned agents open concurrently. Do not recursively delegate.

Configuration is a requested setting, not proof of the actual running model. Inspect active client/session settings where possible. Do not claim that reading a file changes a running thread's model. If an IDE overrides the lead model, request a switch or use the optional project launcher. No model or effort fallback is permitted; report unavailable settings as a blocker.

### Start-up sequence

1. Inspect the directory and Git status. Preserve all user work. Initialize local Git only when this directory is not already inside a different repository. Do not change author identity.
2. Run `node scripts/doctor.mjs` and `node scripts/verify-starter.mjs`. Read their actual results. Neither command installs dependencies, spends funds, nor contacts a model.
3. Verify the Codex custom-agent schema and active workspace trust. The project is configured for the current standalone TOML agent format. If this client cannot load it, report the exact compatibility problem; do not invent a successful delegation.
4. Perform a small real delegation: ask `atlas_architect` to review P0/P1 scope and `atlas_researcher` to verify the initial stack. Record actual task handles and returned observations in `docs/AGENT-RUNS.jsonl`. Requested/observed model fields remain separate; record observed values as null when the client does not expose them. Close both completed agents.
5. Complete P0's dependency and compatibility check. Run `node scripts/bootstrap.mjs --install` after reviewing its package plan. This resolves missing development dependencies to exact registry versions, writes an audit record, and runs Bun. Respect network approval. Never synthesize a lockfile or treat a registry error as success.
6. Implement the P1 local map-and-evidence vertical slice. Then progress through the remaining milestones. Use `docs/ORCHESTRATION.md` for task ownership, review gates, resumption and coordination.
7. Update state and evidence after every integration. Before each checkpoint, run the relevant checks, review the diff and make a meaningful commit when an existing Git author is configured. Commit only assigned, reviewed files.

### Continue, rather than waiting unnecessarily

Make ordinary reversible local decisions and continue. Do not ask the user to choose a border radius, table name or routine folder arrangement. Batch genuinely missing secrets/configuration into one concise request while continuing the fixture workflow and independent tasks.

Do not auto-install system tools, alter global settings, trust the project on the user's behalf, publish packages, push a repository, deploy publicly, submit the hackathon or spend real funds. Project trust, login, network approvals, model access, credentials and payment authorization may require user action.

### Resume cleanly

After interruption, re-read the progress/state files, inspect the working tree, and resume the earliest unmet gate. Do not restart from scratch, assume a previous agent is still running, or duplicate a payment. Record stopped tasks as interrupted.

### Finish honestly

Distinguish implemented+tested, implemented+unverified, blocked and not implemented. Report actual startup commands and test results. If live integration is blocked, complete all safe independent work and leave an exact next-step checklist. Never call testnet fixtures a production deployment.
