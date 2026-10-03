# Multi-agent operating plan

The primary thread coordinates with Astra medium. It must actually spawn the configured roles; writing six personas in one answer is not delegation. Read `.codex/agent-policy.json` and keep it consistent with configuration.

## Waves
1. **Preflight:** architect + researcher, both read-only, bounded to P0/P1. Verify model/client access and return concrete plans.
2. **Contracts:** lead incorporates findings and owns shared schemas, dependency plan and migrations. Do not fan out before interfaces exist.
3. **Implementation:** engineer + frontend on disjoint paths against the agreed interfaces. Lead integrates shared-file changes, not concurrent edits.
4. **Verification:** close completed workers, then verifier + security reviewer. Verifier can write assigned tests; security stays read-only. Lead applies fixes or assigns them back.
5. **Checkpoint:** run commands, inspect evidence, update ledgers and commit a meaningful unit. Start the next wave.

Maximum two open spawned threads, excluding primary. Close completed threads instead of exhausting the cap. Roles do not spawn children. Do not spawn a specialist for trivial edits the lead can perform safely.

## Task contract
Use `docs/templates/TASK.md`: objective, milestone, exact allowed paths, read-only references, forbidden operations, interface version, acceptance checks, dependencies and bounded return format. Record leases in `docs/TASKS.json`; expired/interrupted leases are not active ownership. A read-only architectural review cannot produce a claimed code change.

Shared-file ownership defaults to lead: root manifests/lockfiles, packages/contracts, migrations, `.codex`, `AGENTS.md`, BUILD, shared progress. Assign them to a single agent explicitly when needed. The lead should avoid editing files an active worker owns. Run full builds after workers finish; simultaneous Next builds can conflict.

No worker commits. No reset/clean/stash-overwrite to hide conflicts. Inspect each returned diff. Independent checks must be run, not paraphrased from the implementer.

## Return format
Return summary, files inspected/changed, actual commands and exit results, concrete findings, limitations and suggested next task. Do not request or store hidden chain-of-thought; a concise rationale is enough.

## Model evidence
Log actual Codex task handles and timestamps only after the tool returns them. Requested model/effort is from configuration; observed model/effort is null unless the client exposes it. An agent repeating a model name is not backend proof. Do not fabricate verification of an account's access.

Model not available: retain the requested setting, record the failure, ask the user about access or a permitted change, and continue nonblocked work possible in the current authorized session. No silent fallback. No file can force a client to expose missing features.

## Resume and long sessions
Save progress at each gate and before context compaction. On resumption inspect filesystem, Git and state, check for unfinished work and continue the earliest unmet gate. Never assume a prior process is alive or repeat payment calls because context was lost. Resume requires the user's active Codex session, not a promised background service.
