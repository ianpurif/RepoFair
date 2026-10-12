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
  Dashboard integration and hosted cross-user RLS were subsequently verified;
  see the dated hosted audit below for the evidence scope.
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
| ts-morph / React Flow | Real 144-file Git snapshot parsed and persisted; Node child with hard timeout/memory bounds | Unsupported syntax/resolution remains explicit; no runtime execution claims. |
| Clerk / Supabase | Real sign-in, native session JWT acceptance, personal workspace provisioning, hosted RLS and concurrent reservations verified | Organization membership and private Storage remain open. |
| GitHub App | Linked-user/App authorization, durable private import, readback, citations and personal-owner draft administration verified | Remote webhook delivery and external publication remain open. |
| MPP / Tempo | Unwired testnet charge adapter plus hosted provider replay/quote/claim storage | Real entitlement, authoritative settlement verification and paid delivery/recovery. |
| Independent providers | Two separate fixture HTTP processes | Verified ownership, publication and distinct real recipients. |
| MCP | Official stdio tools and protocol tests | Authenticated/paid transport not implemented. |
| Application AI | Native Voyage embeddings/reranking + DeepSeek generation passed a four-request public-fixture workflow | Private authenticated AI and operating-cost reservations remain open. See AI.md. |
| LangSmith | Disabled | Optional redacted traces with approved handling. |
| Vitest / ESLint / Playwright | Installed local verification tooling | Live acceptance remains separate. |

Bootstrap resolves missing toolchain packages through npm publisher metadata and pins exact versions before Bun install. This step does not certify security, peer compatibility or runtime behavior. Inspect advisories and test rather than treating the newest tag as automatically safe.

Add each verified API signature, package version, source URL, observation date, minimal real test, actual outcome and unresolved assumptions as implementation proceeds. Never enter a guessed success, a fabricated network constant or another user's credential.

## Application AI provider decision — 2026-10-07

User requires Voyage AI for embeddings/retrieval and DeepSeek for all LLM/chat/reasoning/generation. Implemented native fetch against fixed official endpoints, server-only keys, explicit enablement and per-question disclosure. No model SDK, generic model env selection, provider fallback or retry. Defaults and verified official API references are recorded in AI.md. User approved up to US$1; four public-fixture calls passed with estimated cost US$0.00068157. This estimate is not a billing statement. No private repository source was sent to either service.

## Hosted identity and repository audit — 2026-10-07

Clerk Next 7.9.11 is installed. Static environment middleware configuration avoids the encryption-key requirement caused by dynamic key options. Native Clerk session JWTs use the supported Supabase third-party integration (no legacy token template). A publishable key cannot read the Supabase OpenAPI root: the verification instead uses an intentionally nonexistent table, which returns authenticated schema-cache 404 for valid tokens and 401 for an invalid token.

PostgreSQL uses the project's session pooler with certificate and hostname verification. The official Supabase CA is loaded through DATABASE_SSL_CA_FILE; verification is never disabled. Twelve RepoFair tables, including private publication drafts, are present. A separate provider-owned schema stores atomic replay state. Client-to-pooler verified TLS is distinct from the pooler's internal database hop.

Private repository reads require verified Clerk identity, workspace membership, a linked GitHub identity and fresh repository authorization. A personal owner's verified numeric GitHub user ID must match both the installation account and repository owner; organization/collaborator access requires independent user repository-read permission. Only then does the server set a transaction-local repository grant used by PostgreSQL RLS. Direct client JWT claims cannot supply this grant. GitHub permissions reference: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/permission-levels-for-a-personal-account-repository.

The App has one installation and read-only Contents/Metadata permission. The latest read-only probe found 73 accessible repositories, no event subscriptions, and HTTP 404 for webhook configuration. Local HMAC, replay, persistence and revocation tests pass, including hosted concurrent delivery tests; this does not establish remote GitHub delivery.

## Private publishing and provider storage — 2026-10-07

Private draft administration independently verifies GitHub ownership/admin rights,
not merely repository read access. Real signed-in create, explicit exposure,
save, reload and revoke passed with immutable source digests and revision checks.
Hosted capacity contention and native provider replay/quote/claim contention
passed with generated-record cleanup. The provider's sale ledger is independent
of buyer budgets, requires a fresh entitlement callback and independently checks
settlement through a required authoritative callback before saving it. These
callbacks are not yet wired to a live paid service. No source was published and
no payment or settlement receipt was created by the hosted storage audits.

## Current overhaul integration review — 2026-10-11

The previous sections are dated historical evidence. Current execution and scope are recorded in [overhaul-validation.json](evidence/overhaul-validation.json).

| Integration | Current implementation | Acceptance boundary |
|---|---|---|
| GitHub REST 2026-03-10 | Native App/user checks, bounded recursive/fallback tree discovery, verified blobs, expiring-token renewal and rate-limit backoff | Actual 199-file authorized GitHub import completed through the new service into isolated local SQL; updated hosted schema, large network imports and remote events remain open |
| PostgreSQL | Durable checkpoint/lease/retention migrations and immutable publication/buyer/provider ledgers | Actual SQL/RLS/triggers pass locally; new hosted multi-backend races not verified |
| ts-morph 28.0.0 | In-memory syntax extraction, bounded references and AST/graph output | No imported configuration/plugins/dependency execution; large inputs explicitly omit expensive references |
| @lezer/python 1.1.19 | Native packaged syntax tree and bounded declarations/relative imports | Python runtime execution, absolute environment resolution and cross-language call graphs unsupported |
| React Flow 12.12.0 | 160-node progressive pages, grouping/filtering and exact source navigation | Real browser rendering checked; dense graph throughput beyond bounds unmeasured |
| mppx 0.13.1 / viem 2.57.2 | Explicit single-token Moderato charge, canonical credential inspection, authoritative finality/receipt verification and durable recovery | Installed exact-version signatures and offline challenges tested; real signing/settlement absent |
| Authenticated SDK / MCP 1.32.0 | Native scoped HTTP and stdio read/discovery/recovery tools; caller-owned signing stays explicit | Real loopback/stdio tests; deployment/session/token rotation and hardware signers remain open |
| Voyage / DeepSeek | Exclusive fixed native HTTP providers; extractive private source is default | Metadata probe current; no new inference/private source egress; private AI cost/tracing acceptance open |

Official primary references were researched by the actual researcher and checked again where accessible. GitHub documents recursive tree bounds and non-recursive subtree fallback in [Git trees](https://docs.github.com/en/rest/git/trees?apiVersion=2026-03-10). Lezer documents compact syntax trees and bounded cursor traversal in [its guide](https://lezer.codemirror.net/docs/guide/). These inform source extraction rather than runtime semantic claims.

The [official Tempo repository](https://github.com/tempoxyz/tempo) identifies Moderato chain 42431 and its RPC. The [official MPP specification](https://paymentauth.org/draft-tempo-charge-00.pdf) requires receipt event verification against challenge parameters for hash credentials. Current [mppx main documentation](https://github.com/wevm/mppx) has evolved factory/currency defaults; this project deliberately validates installed 0.13.1 APIs and explicitly fixes the testnet asset/chain. Do not copy newer main APIs or default currencies into a pinned integration without compatibility tests. Some documentation URLs were unavailable to the web reader; local pinned source and offline/runtime tests are independently recorded.

Today's metadata probe found 74 accessible GitHub repositories, Contents/Metadata read permissions, no event subscriptions and webhook configuration 404. It did not verify a user OAuth session. The separate real-import verifier freshly checked Clerk-linked GitHub user authorization and actual source reads. Hosted metadata/TLS reads succeeded, Supabase Storage had zero buckets, and configured DeepSeek model metadata was available. No hosted schema, private source AI egress or real purchase was performed.

## Publishing setup clarification — 2026-10-11 UTC

An actual read-only researcher follow-up imported the installed viem Tempo APIs and read Moderato chain 42431, block 39150222 and PathUSD decimals 6. No funding, key generation, signing, broadcast or hosted writes were performed. The official [network source](https://github.com/tempoxyz/docs/blob/main/src/pages/docs/quickstart/connection-details.mdx) identifies the RPC and testnet explorer; the official [faucet source](https://github.com/tempoxyz/docs/blob/main/src/pages/docs/quickstart/faucet.mdx) documents the address-only faucet POST and changing test allocations.

The pinned [mppx charge source](https://github.com/wevm/mppx/blob/mppx@0.13.1/src/tempo/client/Charge.ts) and [viem signing source](https://github.com/wevm/viem/blob/viem@2.57.2/src/actions/wallet/signTransaction.ts) show that RepoFair's injected address plus forced pull mode requests `eth_signTransaction`. Ordinary EVM network configuration does not prove support for Tempo transaction signing. A caller-owned local-account signer is compatible with the installed SDK API; actual signatures and paid delivery remain unverified. The official [Tempo Wallet source](https://github.com/tempoxyz/docs/blob/main/src/pages/docs/wallet/index.mdx) defaults to mainnet and is not evidence for this Moderato browser flow.

For a temporary local test, official [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) can supply separate HTTPS origins for loopback RepoFair and the provider. Their URLs change when restarted and they do not establish production hosting. Provider origins and signed exports must be configured consistently. A separate Supabase project supplies the provider-only database and standard roles; its [PostgreSQL connection documentation](https://supabase.com/docs/guides/database/connecting-to-postgres) describes IPv4 session-pooler and verified-TLS configuration. Neither infrastructure service was provisioned by this follow-up.

## Publishing infrastructure execution — 2026-10-12

Current native schema introspection confirms central 001/002 signatures already installed: 15 tables, 149 columns, 94 non-NOT-NULL constraints, eight functions and four triggers. No central migration was replayed and the historical migration journal was not backfilled. Native PostgreSQL 17 and local PostgreSQL 18 represent NOT NULL constraints differently; exact column nullability is compared through `pg_attribute`, while all remaining constraint definitions remain exact. See [native evidence](evidence/publishing-infrastructure.json).

Provisioned a genuinely separate PostgreSQL database and restricted owner login on the existing Supabase cluster, using the copied session-pooler endpoint and project username suffix. Official [Supavisor FAQ](https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI) and [tenant/user routing guidance](https://supabase.com/docs/guides/troubleshooting/tenant-or-user-not-found) support additional databases/custom roles; this does not create a separate Supabase project or independently owned operator. Existing database administration privileges were sufficient; no Management API credential or guessed pooler hostname was used.

On PostgreSQL 17, database ownership requires SET permission, not merely MEMBER. Enabled SET only from the new provider role to the existing trusted administrator so it could create the provider-owned database; never granted central/admin roles to the provider. The provider has no superuser, database/role creation, replication, RLS bypass, inherited privileges or service-role/authenticated membership. Client-to-pooler TLS is certificate/hostname authorized; the internal pooler hop was observed separately and is not inferred encrypted.

Applied only provider replay/ledger/delivery migrations with an atomic SHA-256 journal. Independent native tests used two contender backends plus one observer, measured actual advisory-lock waits, verified one replay and sale winner out of eight attempts, denied unknown-state reopening/term changes and removed owned synthetic rows. Provider credentials were denied central RepoFair source access using `LIMIT 0`, without reading existing tenant contents. Buyer capacity/signing/spending races remain outside this scope.

Installed cloudflared 2026.9.3 checksum matched its [official release](https://github.com/cloudflare/cloudflared/releases/tag/2026.9.3). Two explicitly approved, tool-managed Quick Tunnels expose RepoFair and an inactive preparation-only provider. The preparation bundle imports only Node builtins, receives no database/source/key/RPC/payment settings and returns generic 503 on every route. Actual HTTPS checks pass. Permanent domains, independent hosting and paid endpoint control remain unverified.

Generated and verified Ed25519 issuer keys, a random MPP secret and two distinct testnet local accounts under a restricted outside-checkout Windows folder. One official address-only faucet request succeeded; actual Moderato chain 42431 and six-decimal PathUSD balance were read afterward. No service purchase, raw credential, payment hash, receipt, private source export or private AI egress was produced. The funded account is available to the caller-owned SDK example; browser Tempo pull signing remains unverified.

The initial real authenticated HTTPS browser attempt exposed a target-origin assumption in private mutations: comparing browser HTTPS Origin against the server's internal HTTP URL. The repaired guard uses exactly validated APP_ORIGIN as its sole configured browser authority, retains direct actual loopback port3000, ignores forwarded/Host headers for authorization and rejects malformed configuration or missing/null/foreign origins. This follows [OWASP's configured target-origin guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#identifying-the-target-origin). Forty-eight native guard/actual-route tests passed with synthetic identity/database callbacks; a separate actual security role reran them and reviewed the source. Fresh authenticated public ingress cases independently test all three loopback-origin rejections and the complete private source/graph/citation workflow; their actual results are in [browser evidence](evidence/private-repository-ui.json).

## Vercel preparation — 2026-10-13 local

The web app now uses a pinned Bun 1.4.1 frozen monorepo install and Node 22 Vercel Functions; `@vercel/functions` 3.9.11 attaches the shared `pg` pool to the Function lifecycle. Worker/provider images use pinned Bun to bundle and Node 22 to run, with separate database and secret boundaries. Exact production origins and live Clerk keys are required by the build gate, but structural checks do not verify credentials or reachability. Official guidance used: [Vercel monorepos](https://vercel.com/docs/monorepos), [Node runtimes](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions), [pool lifecycle](https://vercel.com/kb/guide/connection-pooling-with-functions), [Clerk production](https://clerk.com/docs/guides/development/deployment/production), [Supabase Clerk integration](https://supabase.com/docs/guides/auth/third-party/clerk), and [Vercel custom domains](https://vercel.com/docs/domains/working-with-domains/add-a-domain). The provider migrations currently require Supabase's standard `anon`, `authenticated`, and `service_role` roles; an arbitrary empty PostgreSQL database is unsupported. The dedicated `migrate-provider.mjs` command plans exactly three provider migrations and refuses an existing central schema or missing standard roles before applying them.

## RepoFair free-domain compatibility — 2026-10-13

The user requires the existing ianpurif/RepoFair repository and free repofair.vercel.app host. Official [Clerk Vercel guidance](https://clerk.com/docs/guides/development/deployment/vercel) requires development keys on .vercel.app; production Clerk requires an owned domain. The explicit REPOFAIR_HOSTED_TESTNET_AUTH mode permits matching real development keys only with an exact free Vercel origin and Moderato/no-fixture gates. Clerk development limits are not upgraded into production assurances. Public environment reads confirm RepoFair display name and GitHub enabled; the authenticated GitHub App metadata confirms slug repofair and read-only Contents/Metadata.

Targeted authenticated job slices retain leases and grants under the documented [300-second Hobby Fluid Compute limit](https://vercel.com/docs/functions/configuring-functions/duration). The Vercel build includes a self-contained 13.14MB trusted parser; native isolated execution and the generated Function trace were checked locally. Vercel production settings were updated using documented project/env REST APIs under a short-lived scoped user token. No token or application secrets are committed.

## Actual same-repository free deployments — 2026-10-13

The web and independent provider are deployed at https://repofair.vercel.app and https://repofair-provider.vercel.app from the existing ianpurif/RepoFair repository. Actual Clerk sessions, a323-file GitHub import into hosted PostgreSQL, source/graph/citations and six live browser checks passed. A selected two-file public RepoFair artifact was really signed, installed in the separate provider database and activated through signed endpoint control. This is one operator, not proof of independent customers/operators; no private source was exported.

Vercel's Node runtime transpiles the provider entry and its dependencies to JavaScript. TypeScript5.9.3 rewriteRelativeImportExtensions must remain enabled in apps/provider/tsconfig.json so relative .ts imports become .js. Three native emission/import/runtime regressions reproduce the initial boot error and check the correction; live provider health200 confirms the deployed runtime. See [TypeScript's option](https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html) and [Vercel Node Web handlers](https://vercel.com/docs/functions/runtimes/node-js).

The first actual purchase quote failed before any reservation or signature: web HTTP503 after29.5s and provider's eight-second socket cutoff interrupted fresh issuer authorization. Provider HTTP now defaults to10 seconds, bounds explicit commerce calls to180 seconds including DNS, and bounds issuer introspection to12 seconds below the unchanged15-second SQLidle guard. SDK quotes/recovery allow240 seconds below the300-second Function limit, without automatic retry. New provider quotes last at most300 seconds; frozen earlier deadlines and120-second grants are never extended. Issuer/provider grant expiry is rechecked after external waits before returning authorization or source. [Live commerce evidence](evidence/repofair-live-commerce.json) retains the actual separate settlement/delivery/recovery outcome.
