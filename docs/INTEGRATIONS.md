# Integration ledger

Last packaging review: 2026-10-03. Documentation checks and live verification are separate.

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
