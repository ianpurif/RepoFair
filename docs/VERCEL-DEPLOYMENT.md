# Deploy RepoFair on free Vercel hosting

Use the existing repository **https://github.com/ianpurif/RepoFair**. The requested public hostname is **https://repofair.vercel.app**, assigned and live. Do not create another source repository, buy a domain, select a paid plan, or enable mainnet. Only Tempo Moderato chain 42431 and PathUSD are implemented.

Current deployments are https://repofair.vercel.app and https://repofair-provider.vercel.app. Both use the same existing GitHub repository and Hobby plan. Pushing main triggers deployment; verify the production alias after READY.

## Web project

Import the existing repository into the user's Hobby team, select Next.js, and set Root Directory to `apps/web`. Include source files outside that directory. Use Node 22, Fluid Compute and its 300-second Function allowance. The checked-in Vercel configuration pins Bun 1.4.1 for frozen installation and runs the production build gate. The build packages the trusted parser into `.atlas/repository-parser-child.mjs` and includes it in repository-job Function traces; imported source is never executed.

The public hostname must exactly match `APP_ORIGIN` and `ATLAS_PUBLIC_ORIGIN`, without a trailing slash. Generated preview hosts are not browser authorization origins and stay noindex. Vercel supplies HTTPS without user-owned DNS.

## Real authentication on the free hostname

Clerk officially requires an owned domain for its production instance and does not permit production keys on `.vercel.app`. Use the existing real Clerk development instance with matching `pk_test_`/`sk_test_` keys and `REPOFAIR_HOSTED_TESTNET_AUTH=clerk-development`. This serves genuine sessions and GitHub connections; it has Clerk's documented 100-user cap, development notices, relaxed session guarantees and indexing limits. Do not claim unrestricted production identity. See [Clerk Vercel deployment](https://clerk.com/docs/guides/development/deployment/vercel).

Required web environment:

| Key | Value/source |
| --- | --- |
| `APP_ORIGIN`, `ATLAS_PUBLIC_ORIGIN` | Exact assigned HTTPS `.vercel.app` production hostname |
| `REPOFAIR_HOSTED_TESTNET_AUTH` | `clerk-development` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Matching existing development-instance keys |
| `DATABASE_URL`, `DATABASE_SSL_CA` | Existing hosted central PostgreSQL URL and verified inline PEM CA |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | Existing RepoFair App ID, inline RSA private PEM and webhook secret |
| `ATLAS_PUBLICATION_SIGNING_KEY` | Existing dedicated Ed25519 PKCS#8 issuer private PEM, server only |
| `ATLAS_MODE`, `NEXT_PUBLIC_ATLAS_MODE`, `ATLAS_FIXTURES_ENABLED` | `tempo-testnet`, `tempo-testnet`, `false` |
| `TEMPO_RPC_URL`, `TEMPO_CHAIN_ID`, `TEMPO_TOKEN_ADDRESS` | Verified Moderato RPC, `42431`, `0x20c0000000000000000000000000000000000000` |
| `ATLAS_AI_ENABLED` | `false`; genuine extractive code questions remain available |
| `ATLAS_SEARCH_INDEXING_ENABLED` | Explicit `true` only for the assigned production hostname; Clerk development limitations still apply |

Replace local secret-file alternatives with their inline values in Vercel; never upload buyer or recipient private keys, provider database credentials, provider MPP secrets, or private source exports to the web project. Settings retain legacy `ATLAS_*`, `@atlas/*`, PostgreSQL `atlas` schemas, protocol headers and SDK symbols for compatibility with existing data and integrations. These technical identifiers are not product branding.

## Repository connection and imports

Enable GitHub in the existing Clerk instance. Each owner connects their own GitHub account and installs the verified [RepoFair GitHub App](https://github.com/apps/repofair/installations/new) on selected repositories. RepoFair independently verifies the linked numeric user identity, actual GitHub authority, installation and workspace membership.

A repository workspace polls progress and submits authenticated same-origin `advance` requests for its own repository. Each request advances one bounded durable slice, retaining leases, permission checks, cancellation, retry and exact source identity. No local worker is needed while the workspace is open; leaving it preserves checkpoints for the next visit. A persistent worker remains an optional way to continue jobs while browsers are closed. GitHub webhook updates additionally require the App's real callback `https://repofair.vercel.app/api/webhooks/github`, matching secret and event subscriptions; do not claim remote webhook acceptance without an actual delivery.

Do not replay migrations on the existing hosted database. Fresh installations may use `migrate-central.mjs --plan` / `--apply` only after setting the central database URL and CA; an existing unjournaled schema requires audit.

## Independent testnet providers

Owners review and export selected immutable source before an independently configured provider installs it. The provider has its own HTTPS origin, database, issuer public key, MPP secret, recipient public address and exact integer terms; the web project must not inherit its secrets. A fresh provider Supabase target requires the standard `anon`, `authenticated` and `service_role` roles. The `migrate-provider.mjs --plan` / `--apply` command reads only provider credentials, journals exactly three provider migrations and refuses a central schema.

For Vercel, import the **same** existing repository as a second Hobby project named repofair-provider, Root Directory apps/provider, framework Other, Node22, outside-root source enabled and Fluid Compute/300 seconds. apps/provider/vercel.json routes requests to api/index.ts. Keep rewriteRelativeImportExtensions enabled in its tsconfig: Vercel emits JavaScript, so transitive relative .ts imports must become .js.

Configure only the 13 provider fields: ATLAS_PROVIDER_ID, ATLAS_PROVIDER_ORIGIN, ATLAS_PROVIDER_DATABASE_URL, ATLAS_PROVIDER_DATABASE_SSL_CA, ATLAS_PROVIDER_AUTHORIZATION_ISSUER, ATLAS_PROVIDER_ISSUER_PUBLIC_KEY, ATLAS_PROVIDER_MPP_SECRET, ATLAS_PROVIDER_RECIPIENT, ATLAS_PROVIDER_PRICE_UNITS, ATLAS_PROVIDER_REALM, TEMPO_RPC_URL, TEMPO_CHAIN_ID and TEMPO_TOKEN_ADDRESS. Use the actual signed artifact identity, provider HTTPS origin, web issuer origin, independent database/MPP secret and issuer public key. Keep buyer wallet keys and the issuer private key outside this project.

The current two-file public RepoFair export is installed and active. A configured provider still requires a real signed export, endpoint control and buyer-approved Moderato payment/delivery/recovery. No payment, provider sale, customer or receipt is fabricated for deployment. The release gate remains blocked until actual acceptance evidence exists.

## Live verification

Verify the public page and RepoFair branding, actual sign-in/sign-out, account provisioning, GitHub connection/App installation, genuine import completion, graph/source/citations and unauthorized-account denial on the deployed URL. Confirm anonymous private APIs return 401, fixture APIs are unavailable, wrong Origin mutations are denied, and mainnet is refused. Inspect the actual deployed parser trace and run the SEO browser suite against the live URL. Record failures separately from successes. A build or simulated transport is not live verification.
