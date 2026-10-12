# Deploy Chronos Atlas

This is a deployment runbook, not evidence that a production site or payment service is live. The web project runs on Vercel Node.js 22. Durable indexing runs as a persistent worker. Each paid provider runs on a separate HTTPS host and its own PostgreSQL database. Moderato chain 42431 and PathUSD are the only payment network and asset implemented.

## 1. Give Atlas its own source repository and domain

The current Git `origin` names the separate `ianpurif/RepoFair` repository. Create a private repository specifically for Chronos Atlas and push only this reviewed Atlas checkout there. Do not push Atlas into RepoFair. Use a domain you control, such as `atlas.yourdomain.tld`. In Vercel, add the domain to the Atlas web project and create the exact A/CNAME/TXT records shown under Project Settings → Domains. Choose one canonical hostname; redirect the other. Verify HTTPS before enabling indexing. The temporary `trycloudflare.com` tunnels are not production origins.

## 2. Prepare production identity and central PostgreSQL

Create a Clerk **production** instance for the canonical domain. Complete Clerk's DNS records and any Google/GitHub OAuth credentials you intend to offer; development `pk_test_`/`sk_test_` keys cannot serve production. Configure Clerk's Supabase third-party integration and the authenticated role claim in a production Supabase project. Apply only the seven central SQL migrations, in order, to a **fresh** Atlas database. The command below refuses an existing unjournaled Atlas schema, records exact SHA-256 digests, and excludes provider payment migrations:

```powershell
node --experimental-transform-types scripts/migrate-central.mjs --plan
# Set DATABASE_URL and DATABASE_SSL_CA in this shell through a trusted secret manager.
node --experimental-transform-types scripts/migrate-central.mjs --apply
```

Do not run `supabase db push` over this mixed migration directory. An existing central database needs a separate schema/journal audit before using the apply command. Use a bounded pooler connection and a trusted PEM CA. Store passwords and PEMs in secret managers, never Git or public `NEXT_PUBLIC_` variables. Verify real Clerk login, a distinct-user denial, database RLS and a private import before allowing external users.

## 3. Configure GitHub source access

Use a GitHub App with numeric App ID, a private RSA key, read-only Contents and Metadata permissions, and the events used by the webhook handler (`installation`, `installation_repositories`, `repository`, `push`, and `ping`). Set its webhook URL to `https://atlas.yourdomain.tld/api/webhooks/github` and configure the same random webhook secret on Vercel. Install the App only on repositories whose owner has approved access. Configure GitHub as a Clerk social connection separately; Atlas verifies the linked user's authority as well as the App installation. Test a real signed GitHub delivery and revocation before depending on automatic sync.

## 4. Create the Vercel project

Import the Atlas Git repository in Vercel. Set **Root Directory** to `apps/web` and enable **Include source files outside of the Root Directory** so `packages/*` and shared scripts are available. Select Next.js and Node.js **22.x**. The checked-in `apps/web/vercel.json` runs frozen Bun installation and `scripts/build-vercel.mjs`; do not select the Bun Functions runtime. Use the default Next.js Output Directory. Set the following Production environment variables before deploying:

| Variable | Production value |
| --- | --- |
| `APP_ORIGIN`, `ATLAS_PUBLIC_ORIGIN` | Identical exact canonical HTTPS Atlas origin, no trailing slash |
| `ATLAS_MODE`, `NEXT_PUBLIC_ATLAS_MODE`, `ATLAS_FIXTURES_ENABLED` | `tempo-testnet`, `tempo-testnet`, `false` |
| `DATABASE_URL`, `DATABASE_SSL_CA` | Production central PostgreSQL pooler URL and inline verified CA PEM |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Matched Clerk production `pk_live_` and `sk_live_` keys |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | Production GitHub App ID, inline RSA PEM and matching webhook secret |
| `ATLAS_PUBLICATION_SIGNING_KEY` | Dedicated production Ed25519 PKCS#8 private PEM, server only |
| `TEMPO_RPC_URL`, `TEMPO_CHAIN_ID`, `TEMPO_TOKEN_ADDRESS` | Verified Moderato HTTPS RPC, `42431`, `0x20c0000000000000000000000000000000000000` |
| `ATLAS_SEARCH_INDEXING_ENABLED` | `false` until domain, notices and smoke checks are complete; then `true` |

On Vercel, leave `DATABASE_SSL_CA_FILE`, `GITHUB_APP_PRIVATE_KEY_FILE` and `ATLAS_PUBLICATION_SIGNING_KEY_FILE` unset. They are local or persistent-host alternatives; the build refuses them. Keep `SUPABASE_SERVICE_ROLE_KEY`, provider database credentials, provider MPP secret, buyer keys and recipient private keys out of the web project. The production build validates the required fields and rejects development Clerk keys and temporary origins without printing their values. It cannot prove that the services are reachable or that payments settled.

## 5. Run the persistent indexer

Deploy `Dockerfile.worker` as an always-on worker service on a container host. Give it the **central** `DATABASE_URL`/`DATABASE_SSL_CA`, `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`, `CLERK_SECRET_KEY`, and `ATLAS_MODE=tempo-testnet`. Set replicas to one initially and configure restart-on-failure. The image uses Node 22 for the service and an isolated Node child for parsing; Bun 1.4.1 is a build tool only. The worker is not a Vercel Function. Check its structured logs for completed durable checkpoints without exposing source or credentials. Validate a real authorized private import and a queued webhook job end to end.

## 6. Run an independent provider when an owner publishes

Use a separate operator-controlled **Supabase project** and secret store for each provider. Its database must have the built-in `anon`, `authenticated`, and `service_role` roles; empty generic PostgreSQL cannot apply the provider RLS migrations. With a dedicated provider migration role that can create the provider schema, run `node --experimental-transform-types scripts/migrate-provider.mjs --plan`, then `node --experimental-transform-types scripts/migrate-provider.mjs --apply` against only `ATLAS_PROVIDER_DATABASE_URL` plus `ATLAS_PROVIDER_DATABASE_SSL_CA` (or `_FILE`). The command applies only the three provider SQL files with a digest journal, refuses a central Atlas schema, and requires audit of an unjournaled provider schema. Use a restricted runtime login afterward. `Dockerfile.provider` builds the configured Node runtime and an install entry. Give the provider only its own `ATLAS_PROVIDER_DATABASE_URL`/`ATLAS_PROVIDER_DATABASE_SSL_CA`, exact public `ATLAS_PROVIDER_ORIGIN`, `ATLAS_PROVIDER_AUTHORIZATION_ISSUER` equal to Atlas's canonical origin, Atlas's **public** Ed25519 key, provider MPP secret, realm, recipient address, exact integer `ATLAS_PROVIDER_PRICE_UNITS`, and the fixed Moderato RPC/chain/token. It never needs central DB credentials, a Clerk secret, an issuer private key or a wallet private key. Route HTTPS ingress to container port 4311; the container binds `0.0.0.0` only behind that ingress.

The provider ID comes from the actual owner-approved signed export. Review the exact repository snapshot, file paths, licensing and payment terms before export. Install that file in the provider database with the bundled `apps/provider/.atlas/install.mjs` entry, then start the provider. Only then activate the matching publication in Atlas and verify signed endpoint control. An inactive provider must return 503 and no payment challenge. The existing same-cluster test database demonstrates technical database separation, not independent operator ownership.

## 7. Verify, then enable discovery

Check the canonical public home, `/robots.txt`, `/sitemap.xml`, Open Graph image, privacy and terms pages, HTTPS headers, sign-in and sign-out. Anonymous private APIs should return 401 without private source; unauthenticated webhooks should be rejected before database work. Test an authorized GitHub import, immutable citations and cross-account denial. Verify provider origin/issuer/terms and, with explicit owner and buyer approval, a bounded Moderato purchase, authoritative receipt and no-double-charge recovery. `bun run verify:release` must remain blocked until evidence exists for those gates; a passing build is not a release acceptance.

Add real operator contact, retention/erasure process and applicable legal terms to the public notices before opening accounts. Then set `ATLAS_SEARCH_INDEXING_ENABLED=true` in Vercel Production and redeploy. Verify the domain in Google Search Console or other search engine webmaster tools and submit the canonical `/sitemap.xml`. Crawling and ranking are external outcomes, not guaranteed by the sitemap.
