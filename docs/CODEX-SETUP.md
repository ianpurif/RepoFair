# Codex setup and troubleshooting

Open the extracted `chronos-atlas-codex-starter` folder, including hidden `.codex` and `.agents` directories. Use a current signed-in Codex client and send `Read and execute START.md.`

## Exact configuration
Lead: `gpt-6-astra`, `medium`. Implementation/default subagents: `gpt-6.1-sol`, `xhigh`. Read-only architecture/research/security override to Astra medium. Extra high is spelled `xhigh` in configuration. The requested level is not `max`.

Current official docs use standalone `.codex/agents/*.toml` with name, description and developer_instructions. Each file supplies model, effort and sandbox. `[agents].max_concurrent_threads_per_session = 2` excludes the main thread. No legacy config_file registration table is needed for this format.

Project settings are loaded only when the client trusts the project. Approve trust yourself when prompted. CLI overrides, current session/IDE selections and managed policy may change effective behavior. The starter does not edit global project-trust records.

## Optional launcher
`node scripts/launch-codex.mjs` starts an interactive CLI with explicit lead settings and the START prompt. Use `--dry-run` to inspect arguments without calling any model. It requires an installed Codex CLI and does not install or authenticate one. The launcher supports POSIX binaries, native Windows executables and the usual npm Codex shim layout. Other Windows shims may require opening Codex directly.

The launcher cannot grant your account access to models, select a model in an already-running UI session, approve trust, bypass administrator policy or eliminate login prompts. Do not claim a model was changed merely because a file was edited.

## Permissions
The starter uses workspace-write with on-request approvals, not danger-full-access. Shell network access is off by default; dependency downloads can require approval. Web search is enabled for current documentation. Read-only review roles do not write reports; the primary records their results.

Never disable safeguards, substitute another model, add API keys to config or run repeated paid API probes to work around a failure. Product API keys belong to the future application and are separate from Codex login.

## Static checks versus real execution
`verify-starter` checks the requested model fields and expected files. Packaging also parses TOML using Python's parser. These are not authenticated delegation tests. START requires a small real delegation in your own client, with actual handles recorded in AGENT-RUNS.jsonl.
