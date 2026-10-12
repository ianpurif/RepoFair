# Owner publication and independent providers

Updated 2026-10-12. Signing configuration, a separate hosted provider database and temporary HTTPS origins are now prepared. Signed export, control proof, catalog discovery, fresh entitlement, Moderato charging and durable delivery are implemented. Source publication remains inactive; real paid delivery remains unverified.

## Explicit owner workflow

1. At **/app/publish**, select a completed immutable snapshot. Fresh workspace owner/admin and GitHub administrative authority are required; read permission alone is insufficient.
2. Select exact source paths, review bytes/lines/digests, declare rights, choose private/authenticated/public metadata policy, and configure an HTTPS endpoint and exact PathUSD price/recipient. Saving remains a private draft mutation.
3. Explicitly approve and download the signed export. It contains only selected original files and supported graph members, exact commit/release identity, source/graph proofs and immutable terms digest. It is not uploaded automatically.
4. An independent operator installs that reviewed file in **its own database**, starts its configured HTTPS provider, and receives only the RepoFair issuer **public** key.
5. Activate the selected revision. RepoFair sends a short-lived signed control proof bound to the origin, publication, digest, revision and nonce. An anonymous nonce cannot reveal private metadata or prove control.
6. Accessible publications appear in **Providers** with exact package/version/commit and testnet terms. Dependency discovery requests the exact resolved version; missing versions are never replaced with latest.

Administration, declared rights, accuracy, endpoint control and settlement are separate claims. A rights checkbox is not independent licensing verification. No accurate/trustworthy badge is invented.

Draft history is capped at 50 records per workspace. Source/terms changes update the digest/revision and revoke activation. A changed installed release uses a new publication identity; old source cannot be replaced behind an existing paid binding.

## Independent runtime setup

Central RepoFair requires its foundational migrations plus **202610110001** and **202610110002**. The current hosted database already contains their exact tables, columns, constraints, functions and triggers, verified through native PostgreSQL on 2026-10-12. This setup did not replay those migrations or backfill their historical journal.

A separate provider database applies only:

- `202610070005_provider_replay.sql`
- `202610070006_provider_ledger.sql`
- `202610110003_provider_delivery.sql`

No central RepoFair tables, Clerk secrets/session credentials, buyer budget connection or central database fallback are required.

The SQL expects the standard Supabase roles `anon`, `authenticated` and `service_role` to exist. Use a separate Supabase project or provision equivalent PostgreSQL roles and server-only privileges before applying the migrations. A bare PostgreSQL database without those roles is not an installation target yet.

Configure the provider fields in [.env.example](../.env.example): database/CA, publication UUID, HTTPS origin, trusted issuer origin/public-key file, MPP secret file, fixed recipient/price/realm, and Moderato RPC/chain. Keep secrets and private source exports access-controlled.

The provider UUID is the downloaded signed export's `artifact.id`, which is the saved draft identity. Its endpoint must be the exact provider origin followed by `/context/retrieve`; configured recipient and integer price must match the export. Origins have no trailing slash or path.

On a separate provider host, configure only provider variables. The Node launcher now accepts an explicit provider-only environment file and drops inherited central credentials, proxy/TLS overrides and runtime preloads. Explicit files reject unsupported fields. Bundling reads no application environment file and does not inline credentials. The normal entry declares its external PostgreSQL driver directly.

```powershell
node scripts/provider.mjs --build
node scripts/provider.mjs --install "C:\secure\owner-approved-export.json" --env-file "C:\secure\provider.env"
node scripts/provider.mjs --env-file "C:\secure\provider.env"
```

Use a fresh shell without inherited RepoFair secrets. Keep issuer private keys, central database credentials, Clerk/GitHub secrets and buyer signing keys out of the provider environment. The provider receives only the issuer public key and needs only the recipient address, never that recipient's wallet private key.

The listener defaults to **127.0.0.1:4311** behind an operator-controlled HTTPS proxy. Startup fails closed when installed source, configured price/recipient/origin, issuer key or actual RPC chain differs. Installation is idempotent; immutable paid source cannot be replaced.

For readiness before a source export is approved, use `node scripts/provider.mjs --prepare --env-file "C:\secure\provider.env"`. This compiles a separate entry containing only Node builtins. Its child receives only operating-system settings and the port, loads no database/source/key/RPC/payment modules, and returns generic **503** on every route. It cannot activate itself or issue payment challenges.

## Prepared environment — 2026-10-12

RepoFair is temporarily reachable at `https://known-les-characters-narrow.trycloudflare.com`; the inactive provider is at `https://dennis-headline-bytes-pct.trycloudflare.com`. Both user-approved Cloudflare Quick Tunnels change on restart and depend on this machine. These are not permanent production hosting.

Provisioned a separate database, `atlas_provider_payments`, with dedicated login `atlas_provider_runtime` on the existing Supabase cluster. Applied only the three provider migrations above, with an atomic digest journal. The login has no superuser, database/role creation, replication, RLS bypass or central service-role membership. Native tests denied central RepoFair table access and verified separate-backend replay/sale contention. This is database/credential separation within one project, not proof of a separate operator or independent infrastructure ownership.

Ed25519 issuer keys, MPP secret, provider-only database/CA configuration and two testnet account keys are stored under `C:\Users\IAN\.atlas-secrets`, outside the checkout and OneDrive, with restricted Windows ACLs. The provider receives only the issuer public key and recipient address. Root `.env.local` and provider settings now bind the actual temporary origins. No publication UUID was invented; it will come from an explicitly approved signed artifact.

The provider is currently running preparation only. Actual HTTPS health, retrieve, resume and control routes return inactive **503**, without payment headers. No source artifact was exported, installed or activated, and no purchase was made. See [execution evidence](evidence/publishing-execution.json) and [native database evidence](evidence/publishing-infrastructure.json).

## Authorization and delivery

RepoFair issues a 120-second signed grant scoped to principal/session, workspace membership revision, provider audience, publication digest, exact release, request digest and idempotency key. The provider freshly introspects it through RepoFair, including the current Clerk session, owner authority and private buyer/source access. It never receives a Clerk bearer token.

Network requests use bounded public HTTPS, DNS/IP checks, pinned addresses, timeouts and redirect rejection. Private metadata requires the signed activation proof; anonymous health returns generic readiness only.

The provider owns immutable submission/delivery records, replay state and receipt reconciliation. Delivered passages and graph members retain signed provenance. A paid result can still be insufficient or wrong. [TEMPO.md](TEMPO.md) describes single submission and unknown recovery.

Revocation blocks new access/reuse even while identity or delivery HTTP requests are in flight. Previously delivered bytes cannot be recalled. Publication cannot broaden the selected exposure.

## Verification boundary

Independent product tests run the real parser, Ed25519 proofs, SQL/RLS/triggers, offline MPP challenges and provider runtime against simulated identity/payment transports. Provider-only schema installation, immutable terms, revoked membership/session, wrong versions, forged relationships and recovery without another charge are checked. A separate native hosted audit passed 11 infrastructure checks, including real multi-backend replay and sale contention with synthetic rows cleaned afterward. Neither scope establishes real paid entitlement, settlement or delivery.

See [BLOCKERS.md](BLOCKERS.md), [verifier evidence](evidence/overhaul-verifier-commerce.json) and [security evidence](evidence/overhaul-security.json). Fixture providers are development-only and do not charge or represent real recipients.
