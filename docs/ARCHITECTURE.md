# Proposed implementation architecture

## Boundaries
- **Web:** Clerk identity and workspace UI; authenticated orchestration APIs; no long-running indexing inside request handlers.
- **Worker:** bounded import/index/retrieval jobs from a PostgreSQL queue. Each job has trusted tenant/principal scope, snapshot, cancellation/deadline and limits.
- **Provider:** independent service with its own index access, release manifest, recipient and access policy. One paid context.retrieve operation initially.
- **Contracts:** runtime-validated versioned service formats. Starter TypeScript types are not sufficient validation for hostile JSON.
- **Core:** deterministic authorization/policy/evidence/version/budget logic. Pure reducers require transactional persistence around them.
- **SDK/MCP:** client-facing integration; signer supplied by authorized caller. The starter capability endpoint is not MCP.

## Indexing pipeline
Authorize repository -> resolve commit -> safely download bounded contents -> parse allowed TS/JS without execution -> retain original source spans -> derive scoped graph -> searchable lexical index -> optional bounded embeddings. Git snapshots retain true commit IDs. Local fixtures use content digests with kind=fixture; never invent a commit hash.

## Request pipeline
Authorize -> search current allowed snapshot -> bounded graph expansion -> determine external version -> list approved providers -> request approval -> reserve budget transactionally -> MPP request -> preserve settlement/delivery separately -> validate provenance/version -> safely join -> answer with original citations or limitation.

## Persistence to implement
Organizations/memberships, repository grants, snapshots/files, nodes/edges, jobs, provider registrations, release mappings, access entitlements, investigations, evidence, quotes/reservations, payment attempts and deliveries. Use unique idempotency constraints and appropriate row locking. Record publication/content rights separately from data accuracy.

Use a single PostgreSQL database initially. Node/edge tables are enough. Avoid a graph database, Redis, learned router, distributed event bus and general marketplace infrastructure until measured need.

## Invariants
Graph IDs include repo + snapshot + local identity. No name-only joins. No latest-version fallback. Provider-supplied graph claims are labeled until checked against source. Public repository status does not bypass paid-provider terms or private purchaser scope.

See BUILD sections 6–12. Interfaces below are scaffolding, not shipped integrations.

## Application AI implementation (2026-10-07)

The loopback fixture AI route validates explicit disclosure before parsing a catalog snapshot, uses Voyage document/query embeddings and reranking, then DeepSeek JSON generation. The model returns citation IDs; deterministic code resolves canonical source evidence. Every request is isolated; no shared embedding cache exists. Source navigation remains local. Native clients permit only the two fixed provider hosts, with bounded bodies, deadlines and no retries/fallbacks. This unauthenticated fixture capability is not enabled for public deployment.
