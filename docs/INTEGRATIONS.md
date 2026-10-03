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

| Integration | Supplied state | Required acceptance |
|---|---|---|
| Codex agents | Six standalone TOML files, requested model/effort fields statically checked | Confirm trusted workspace, account access and actual delegation in user's client. |
| Astra/Sol | Astra medium; Sol xhigh; no silent fallback | Record requested values and observed runtime values where exposed. |
| Next/React/Tailwind | Source scaffold with initial pins | Resolve tooling, generate bun.lock, verify peers and production build. |
| TypeScript | Pure core checked using locally available 5.8.3 compiler | Bootstrap chooses exact supported 5.x tooling; rerun after install. |
| ts-morph / React Flow | Not installed or implemented | Versioned parser and actual graph, not a canned node list. |
| Clerk / Supabase | Environment placeholders only | Current third-party auth integration; real RLS tests, no stale JWT template. |
| GitHub App | Not implemented | Read-only import, exact snapshot, webhook verification, publishing authority. |
| MPP / Tempo | Disabled | Official SDK request/receipt validation and real testnet evidence with safe recovery. |
| Independent provider | Local health/unavailable boundary only | Actual paid bounded version-correct context delivery and separate recipients. |
| MCP | Not implemented | Real protocol server/transport using supported SDK, not a renamed JSON route. |
| Application generation | No model or key configured | Cited answers over allowed original source and explicit limitations. |
| LangSmith | Disabled | Optional redacted traces/evaluation with approved data handling. |
| Vitest / ESLint / Playwright | Product tooling to add in P0/P1 | Full unit/integration/browser/lint coverage; retain starter tests. |

Bootstrap resolves missing toolchain packages through npm publisher metadata and pins exact versions before Bun install. This step does not certify security, peer compatibility or runtime behavior. Inspect advisories and test rather than treating the newest tag as automatically safe.

Add each verified API signature, package version, source URL, observation date, minimal real test, actual outcome and unresolved assumptions as implementation proceeds. Never enter a guessed success, a fabricated network constant or another user's credential.
