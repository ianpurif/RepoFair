# External setup and blockers

Current checkpoint: local tools verified; external integrations remain unavailable.

## Confirmed 2026-10-03

User confirmed external credentials are not configured and directed completion
of all safe local work. Do not request secrets in chat. Clerk/Supabase/GitHub App
and real Tempo testnet purchase acceptance remain blocked on setup.

Docker executable exists but its Linux engine pipe is unavailable. No psql was
found on PATH. Database migrations can be reviewed; actual multi-connection
PostgreSQL/RLS tests remain unverified until a test database is available.
No global tools, trust or permission settings were changed.

Subsequent local PostgreSQL-WASM migration tests passed with a test claim shim.
This narrows SQL/policy uncertainty but leaves hosted auth and multi-connection
database testing blocked. See tests/database and the integration ledger.

Toolchain, trusted workspace and real role delegation are available. Bootstrap
completed successfully with Bun 1.4.1 and generated the real lockfile.

- Clerk/Supabase project credentials and approved configuration (P5; private data gates sooner).
- Read-only GitHub App setup and selected repository permissions.
- Application generation/embedding provider configuration when that feature is implemented.
- Tempo testnet endpoints/asset details, signer approval and two provider recipients for real payment evidence.

None of these permits fabrication. Continue the local fixture pipeline while external capabilities are blocked. Batch required user inputs, explain why each is needed, and never request secrets in source-controlled files or public chat output.

## Resume checklist

1. Configure Clerk/Supabase third-party auth and a read-only GitHub App locally; never share secret values in chat. Implement and verify identity-to-tenant, import and durable worker adapters before private source is accepted.
2. Provide an isolated PostgreSQL/Supabase test database. Apply reviewed migrations and verify hosted identities, Storage isolation and concurrent reservations.
3. Complete verified publisher/repository authority, endpoint control and exposure-reviewed publication. Local fixture process publication is not this workflow.
4. Configure approved Tempo Moderato asset, signer and two independent provider recipients. Complete durable quote/reservation/replay/finality/delivery adapters and independent security review before wiring payment routes. Capture actual testnet settlement and interrupted-delivery recovery evidence.
5. Repeat full acceptance checks and release gate. Public deployment, package publication and real-money spending require separate explicit authorization.

The later independent payment-adapter review could not be scheduled because the client returned `agent thread limit reached`. Lead review and offline tests were completed; this independent gate remains open.
