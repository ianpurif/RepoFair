# Deployment plan, not a deployment claim

Local source runtime uses Node 22.16+; Bun resolves workspace packages. Web runs at localhost:3000. Separate provider health boundaries use ports 4311 and 4312. Worker is a separate future process.

Production plan: Next web on a compatible host, Supabase PostgreSQL/Storage, a persistent worker host and independently deployable provider instances. Long indexing must not rely on short-lived serverless request duration.

Before deployment: run full build/browser/database/integration gates, document supported versions, apply migrations and RLS, configure Clerk/GitHub origins and webhooks, validate provider egress and rate limits, set retention, isolate signing paths, and verify secrets redaction. Add queue recovery, health/readiness distinction and backup/rollback instructions.

Starter health endpoints signal only a running process, not product readiness. No Docker/Postgres substitute should be presented as fully configured Supabase Auth/Storage/RLS. Do not publicly deploy without explicit authorization.
