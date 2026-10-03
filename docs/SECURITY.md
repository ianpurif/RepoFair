# Threat model and release blockers

Assets: private source, repository grants, purchased context, source provenance, signing credentials, funds, organization metadata and reusable caches.

Trust boundaries: user/browser -> server; server -> GitHub; parser -> untrusted files; caller -> provider; model -> deterministic policy; provider -> retrieved context; payment evidence -> verified settlement; Clerk identity -> database policies.

## Required controls
Authenticate before scope creation. Client tenant IDs are not authority. Use supported Clerk/Supabase verification and RLS. Apply identical scope checks to graph/search/storage/exports/traces/caches. Test attempted cross-tenant reads and writes with real database identities.

Do not run imported scripts, hooks, tsconfig plugins, dependencies or submodules. Enforce archive totals, realpath containment, symlink restrictions, extension/type bounds and parser deadlines. A relative-path helper alone is not filesystem isolation.

Provider/repository URL handling needs DNS/IP egress controls, redirect validation, credential rejection and response bounds. Blocking one literal localhost string is not full SSRF protection. Restrict developer localhost exceptions to configured fixture origins.

Do not let model or source instructions modify permissions, acceptance rules or money. Treat code comments and metadata as data. Sanitize rendered Markdown and preserve escaped source text.

Budgets use integer units and database transactions. Quotes bind provider, operation, content digest, package/version, asset/network/recipient, amount and expiry. Unknown settlement stays reserved. Replayed delivery is not a new purchase. A hash/string supplied by a client is not a verified receipt.

No keys in browser bundles, logs, imported source, storage or model inputs. No raw queries/private source on-chain. Privacy/retention claims must match actual providers.

## Review gate
An unresolved critical/high access, source-execution, payment replay or data-leak defect blocks the corresponding release. Do not downgrade a test to a mock to pass. Independent reviewer findings include path, consequence, reproduction and a concrete fix/test requirement.
