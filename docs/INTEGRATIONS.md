# Integration ledger

Last packaging review: 2026-10-03. Documentation checks and live verification are separate.

## Execution research — 2026-10-03

Real read-only research task `/root/p0_research` verified registry HTTP 200 for
Next 16.3.8, React/DOM 19.3.0, Tailwind/PostCSS plugin 4.3.3, PostCSS 8.5.28,
ts-morph 28.0.0, React Flow 12.12.0, Clerk Next 7.9.10, Supabase JS 2.117.2,
mppx 0.13.1, viem 2.57.2 and MCP SDK v1 1.32.0. Framework peers fit; Node22
meets Next/Supabase requirements. Install and runtime outcomes are tracked separately.

- Parser: https://ts-morph.com/setup/file-system and https://ts-morph.com/details/imports.
  Use in-memory Project/createSourceFile, no imported plugins/config execution.
- UI: https://reactflow.dev/learn and https://tailwindcss.com/docs/installation/using-postcss.
  Explicit canvas dimensions; Flow styles after Tailwind.
- Auth: https://clerk.com/docs/guides/development/integrations/databases/supabase
  and https://supabase.com/docs/guides/auth/third-party/clerk. Third-party auth
  uses accessToken callback and Clerk text subject via auth.jwt()->>'sub'.
  Dashboard integration and actual cross-user RLS tests still required.
- MPP: https://mpp.dev/quickstart/server.md and
  https://mpp.dev/sdk/typescript/client/Mppx.create and
  https://mpp.dev/payment-methods/tempo/charge.md. Server Mppx.create with
  tempo.charge; charge request then withReceipt. Client polyfill:false avoids
  global fetch interception. Inspect terms and reserve integer budget before signing.
- MCP: https://github.com/modelcontextprotocol/typescript-sdk and
  https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/README.md.
  Main documents split v2 packages; mppx supports v1 SDK >=1.25.0. Initial
  implementation pins v1.32.0 pending separately checked v2 compatibility.
- Codex: https://learn.chatgpt.com/docs/agent-configuration/subagents confirms
  standalone name/description/developer_instructions TOML schema. Both real
  preflight roles completed; no backend model inference from role labels.
- Contest: https://colosseum.com/legal/Crypto%20World%27s%20Fair%20Hackathon%20Rules.pdf
  sections 5–6: cutoff October 12 2026 23:59 Pacific, October 13 14:59 Manila.
  Readiness target one day earlier. Registration/eligibility not verified.

No authenticated external integration or payment was performed by these checks.

Payment adapter inspection verified installed mppx 0.13.1 declarations/source:
decimal SDK amount becomes atomic challenge amount; chain ID is in
request.methodDetails; opaque metadata uses official PaymentRequest.deserialize;
requiresAuth uses Payment-Authorization; successful withReceipt returns the SDK
receipt. waitForConfirmation:true is explicit. Sources:
https://mpp.dev/sdk/typescript/server/Mppx.create,
https://mpp.dev/sdk/typescript/client/Mppx.create,
https://mpp.dev/payment-methods/tempo/charge.md. Offline tests do not enable live mode.

Local SQL validation uses @electric-sql/pglite 0.5.8, verified from npm and
https://pglite.dev/docs/ and https://pglite.dev/docs/api on 2026-10-03.
`new PGlite()`, exec(migration), parameterized query and role switching run the
actual migration. Four tests pass, including row visibility, denied mutations,
reservations, malformed idempotency, unknown settlement and revocation.
The test claim shim is not hosted JWT verification; single-backend WASM is not
multi-connection concurrency proof.

| Integration | Current local state | Remaining acceptance |
|---|---|---|
| Codex agents | Six roles actually delegated; handles recorded | Observed child model fields remain unavailable, not inferred. |
| Next/React/Tailwind | Exact pins installed, production build passes | Hosted runtime not deployed. |
| TypeScript | 5.9.3; full source checks pass | Recheck future changes. |
| ts-morph / React Flow | Actual fixture parser and interactive graph | Hard parser isolation before arbitrary imports. |
| Clerk / Supabase | SQL foundation and local policy tests | Hosted identity, Storage, multi-connection tests and service adapters. |
| GitHub App | Unavailable | Read-only import, exact snapshots, webhooks and publisher authority. |
| MPP / Tempo | Unwired testnet adapter and offline official SDK challenge tests | Durable adapters, independent final review and actual settlement/recovery. |
| Independent providers | Two separate fixture HTTP processes | Verified ownership, publication and distinct real recipients. |
| MCP | Official stdio tools and protocol tests | Authenticated/paid transport not implemented. |
| Application AI | Native Voyage embeddings/reranking + DeepSeek JSON generation; local disclosure-gated path | HTTP-mocked acceptance only; live provider access unverified. See AI.md. |
| LangSmith | Disabled | Optional redacted traces with approved handling. |
| Vitest / ESLint / Playwright | Installed local verification tooling | Live acceptance remains separate. |

Bootstrap resolves missing toolchain packages through npm publisher metadata and pins exact versions before Bun install. This step does not certify security, peer compatibility or runtime behavior. Inspect advisories and test rather than treating the newest tag as automatically safe.

Add each verified API signature, package version, source URL, observation date, minimal real test, actual outcome and unresolved assumptions as implementation proceeds. Never enter a guessed success, a fabricated network constant or another user's credential.

## Application AI provider decision — 2026-10-07

User requires Voyage AI for embeddings/retrieval and DeepSeek for all LLM/chat/reasoning/generation. Implemented native fetch against fixed official endpoints, server-only keys, explicit enablement and per-question disclosure. No model SDK, generic model env selection, provider fallback or retry. Defaults and verified official API references are recorded in AI.md. Real paid calls were not authorized or performed.
