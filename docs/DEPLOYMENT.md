# Deployment plan, not a deployment claim

Local source runtime uses Node 22.16+; Bun resolves workspace packages. Web runs at localhost:3000. Separate provider health boundaries use ports 4311 and 4312. Worker is a separate future process.

The current local providers now expose bounded public fixture context through
separate processes on 4311/4312. They do not accept paid requests. The development
web app uses the workspace fixture catalog, so run commands from the repository
root. A standalone deployment must deliberately package that catalog and source;
the current fixture demo is not a deployment-ready private ingestion service.

Production plan: Next web on a compatible host, Supabase PostgreSQL/Storage, a persistent worker host and independently deployable provider instances. Long indexing must not rely on short-lived serverless request duration.

Before deployment: run full build/browser/database/integration gates, document supported versions, apply migrations and RLS, configure Clerk/GitHub origins and webhooks, validate provider egress and rate limits, set retention, isolate signing paths, and verify secrets redaction. Add queue recovery, health/readiness distinction and backup/rollback instructions.

Starter health endpoints signal only a running process, not product readiness. No Docker/Postgres substitute should be presented as fully configured Supabase Auth/Storage/RLS. Do not publicly deploy without explicit authorization.
