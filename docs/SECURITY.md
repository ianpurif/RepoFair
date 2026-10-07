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

## Independent review — 2026-10-03

Actual task `/root/security_review` reproduced three issues: provider answer
metadata was insufficiently validated; null SQL replay terms bypassed `<>`
comparisons; SDK source responses were not bound to the requested locator.
Lead added bounded answer/canonical citation validation, re-extracts fixture
answers after independent source verification, uses null-safe SQL comparisons
and rejects missing terms, and binds SDK source to exact path/range. Regression
tests pass. No critical/high defect was demonstrated in reviewed fixture paths.
This is not a production-security certification; live gates remain blocked.

## Final adapter review boundary

The lead reviewed the later unwired Tempo adapter and corrected saved receipt failure to report unknown settlement instead of settled delivery failure. Its regression passes. An independent follow-up review could not start: both resuming the security agent and spawning the configured security role returned `agent thread limit reached`. This is a client coordination limit, not a successful independent review. Independent adapter review remains required before payment activation.

## Application AI boundary review — 2026-10-07

Actual read-only architect review `/root/ai_boundary_review` checked egress/consent/citations and found disclosure approval could survive question edits. Lead fixed approval reset on edits, suggestions and version changes, and consumes it on submission; browser regressions pass. Review also noted Host checks alone are not authentication. The loopback-only launcher now supplies an internal server marker required by the route; public deployment remains unsupported. Native clients have fixed vendor hosts, no redirects/retries/fallback, bounded bodies/deadlines and sanitized errors. No independent live-account/security certification is claimed.
