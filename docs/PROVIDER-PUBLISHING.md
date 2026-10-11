# Owner publication and independent providers

Updated 2026-10-11. Signed export, control proof, catalog discovery, fresh entitlement, Moderato charging and durable delivery are implemented. Hosted publication and real paid delivery remain unverified.

## Explicit owner workflow

1. At **/app/publish**, select a completed immutable snapshot. Fresh workspace owner/admin and GitHub administrative authority are required; read permission alone is insufficient.
2. Select exact source paths, review bytes/lines/digests, declare rights, choose private/authenticated/public metadata policy, and configure an HTTPS endpoint and exact PathUSD price/recipient. Saving remains a private draft mutation.
3. Explicitly approve and download the signed export. It contains only selected original files and supported graph members, exact commit/release identity, source/graph proofs and immutable terms digest. It is not uploaded automatically.
4. An independent operator installs that reviewed file in **its own database**, starts its configured HTTPS provider, and receives only the Atlas issuer **public** key.
5. Activate the selected revision. Atlas sends a short-lived signed control proof bound to the origin, publication, digest, revision and nonce. An anonymous nonce cannot reveal private metadata or prove control.
6. Accessible publications appear in **Providers** with exact package/version/commit and testnet terms. Dependency discovery requests the exact resolved version; missing versions are never replaced with latest.

Administration, declared rights, accuracy, endpoint control and settlement are separate claims. A rights checkbox is not independent licensing verification. No accurate/trustworthy badge is invented.

Draft history is capped at 50 records per workspace. Source/terms changes update the digest/revision and revoke activation. A changed installed release uses a new publication identity; old source cannot be replaced behind an existing paid binding.

## Independent runtime setup

Central Atlas applies its foundational migrations plus **202610110001** and **202610110002**. New migrations were validated locally, not applied to hosted databases.

A separate provider database applies only:

- `202610070005_provider_replay.sql`
- `202610070006_provider_ledger.sql`
- `202610110003_provider_delivery.sql`

No central Atlas tables, Clerk secrets/session credentials, buyer budget connection or central database fallback are required.

The SQL expects the standard Supabase roles `anon`, `authenticated` and `service_role` to exist. Use a separate Supabase project or provision equivalent PostgreSQL roles and server-only privileges before applying the migrations. A bare PostgreSQL database without those roles is not an installation target yet.

Configure the provider fields in [.env.example](../.env.example): database/CA, publication UUID, HTTPS origin, trusted issuer origin/public-key file, MPP secret file, fixed recipient/price/realm, and Moderato RPC/chain. Keep secrets and private source exports access-controlled.

```powershell
bun run provider:check
bun run provider:install -- "C:\secure\owner-approved-export.json"
bun run provider:testnet
```

The listener defaults to **127.0.0.1:4311** behind an operator-controlled HTTPS proxy. Startup fails closed when installed source, configured price/recipient/origin, issuer key or actual RPC chain differs. Installation is idempotent; immutable paid source cannot be replaced.

## Authorization and delivery

Atlas issues a 120-second signed grant scoped to principal/session, workspace membership revision, provider audience, publication digest, exact release, request digest and idempotency key. The provider freshly introspects it through Atlas, including the current Clerk session, owner authority and private buyer/source access. It never receives a Clerk bearer token.

Network requests use bounded public HTTPS, DNS/IP checks, pinned addresses, timeouts and redirect rejection. Private metadata requires the signed activation proof; anonymous health returns generic readiness only.

The provider owns immutable submission/delivery records, replay state and receipt reconciliation. Delivered passages and graph members retain signed provenance. A paid result can still be insufficient or wrong. [TEMPO.md](TEMPO.md) describes single submission and unknown recovery.

Revocation blocks new access/reuse even while identity or delivery HTTP requests are in flight. Previously delivered bytes cannot be recalled. Publication cannot broaden the selected exposure.

## Verification boundary

Independent tests run the real parser, Ed25519 proofs, SQL/RLS/triggers, offline MPP challenges and provider runtime against simulated transports. Provider-only schema installation, immutable terms, revoked membership/session, wrong versions, forged relationships and recovery without another charge are checked. This is not hosted authority, multi-backend contention or live settlement evidence.

See [BLOCKERS.md](BLOCKERS.md), [verifier evidence](evidence/overhaul-verifier-commerce.json) and [security evidence](evidence/overhaul-security.json). Fixture providers are development-only and do not charge or represent real recipients.
