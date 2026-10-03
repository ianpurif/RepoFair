# External setup and blockers

Initial state: not checked in the user's environment.

## Confirmed 2026-10-03

User confirmed external credentials are not configured and directed completion
of all safe local work. Do not request secrets in chat. Clerk/Supabase/GitHub App
and real Tempo testnet purchase acceptance remain blocked on setup.

Docker executable exists but its Linux engine pipe is unavailable. No psql was
found on PATH. Database migrations can be reviewed; actual multi-connection
PostgreSQL/RLS tests remain unverified until a test database is available.
No global tools, trust or permission settings were changed.

Toolchain, trusted workspace and real role delegation are available. Bootstrap
completed successfully with Bun 1.4.1 and generated the real lockfile.

- Codex client/version, workspace trust and access to requested Astra/Sol configurations.
- Bun installation and registry/network permission for project dependencies.
- Clerk/Supabase project credentials and approved configuration (P5; private data gates sooner).
- Read-only GitHub App setup and selected repository permissions.
- Application generation/embedding provider configuration when that feature is implemented.
- Tempo testnet endpoints/asset details, signer approval and two provider recipients for real payment evidence.

None of these permits fabrication. Continue the local fixture pipeline while external capabilities are blocked. Batch required user inputs, explain why each is needed, and never request secrets in source-controlled files or public chat output.
