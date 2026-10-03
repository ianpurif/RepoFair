# Chronos Atlas · Codex starter

**Open this folder in Codex and send:**

> Read and execute START.md.

The full product build prompt is in `BUILD.md`. No copy/paste from another conversation is required.

## Agents

| Role | Model | Effort |
|---|---|---|
| Primary coordinator | GPT-6 Astra | medium |
| Architect, researcher, security reviewer | GPT-6 Astra | medium |
| Engineer, frontend engineer, verifier | GPT-6.1 Sol | xhigh (Extra high) |

Six project-local custom agents; two concurrent spawned agents maximum. No silent fallback. These are requested settings, not a claim that your account has access or that the agents already ran.

Use a current Codex client, sign in, and approve workspace trust when asked. Project settings cannot override every existing IDE/session or administrator setting. `docs/CODEX-SETUP.md` explains this.

Optional CLI shortcut, from this directory:

```sh
node scripts/launch-codex.mjs
```

It launches the requested lead model with the START instruction. It does not install Codex, grant project trust, bypass permissions or launch unattended sessions.

## What is here

The complete build specification; custom-agent configuration and six local skills; architecture/security/UX specifications; phase gates and resume state; a Next.js source scaffold; independent provider/worker boundaries; TypeScript contracts and tested deterministic helpers; original three-repository fixtures; preflight/bootstrap/test scripts and CI.

This is **the build starter**, not the finished Atlas product. The graph parser, AI retrieval, GitHub/Clerk/Supabase integration, paid provider delivery, and MCP service are milestone work. The starter never pretends they are enabled.

## Local checks before installing anything

Node.js 22.16+ is required; Node 22 or 24 LTS is the intended development family.

```sh
node scripts/doctor.mjs
node scripts/verify-starter.mjs
```

P0 then reviews the integration plan, runs `node scripts/bootstrap.mjs --install`, and generates the real `bun.lock`. No fabricated lockfile or node_modules are included.

After bootstrap:

```sh
bun run dev
```

The starter page is at `http://localhost:3000`; it describes actual scaffold status, not a simulated product. Test provider health boundaries can run at separate local ports with `bun run provider:a` and `bun run provider:b`.

## Safety and external setup

Fixture mode is the default. No real credentials or signing keys are included. The `.env.example` file documents later integrations; copying it is not required to read START or run starter checks. Project shell networking remains approval-controlled.

Codex may need you to approve network access and provide Clerk, Supabase, GitHub, model and Tempo configuration for the corresponding live milestones. It is instructed to continue fixture work rather than block all development.

Read `docs/STARTER-STATUS.md` and `docs/VERIFICATION.md` for the exact supplied scope and test record. No agents or paid integrations were authenticated during packaging.
