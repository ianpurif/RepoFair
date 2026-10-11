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

## Hosted repository review — 2026-10-07

Actual `/root/private_import_security` review found inconsistent repository/job lock ordering, insufficient event/body binding for signed webhook payloads, and a possible direct-database path around fresh GitHub authorization if the schema were exposed. Fixes use consistent repository-first locks, event-specific body shape checks, and transaction-local server repository grants enforced by RLS. The database adapter clears grants for every principal transaction. Hosted checks deny source/graph reads without a grant, deny the wrong tenant even with a grant, and deny a revoked member. Imported code is parsed in a bounded child with a sanitized environment; it is never installed or executed.

Actual `/root/webhook_verifier` independently passed 16 local tests and 17 hosted/HTTP checks covering HMAC rejection, concurrent deduplication, immutable jobs, cancellation, revocation and persisted signed localhost ping. Test records were cleaned. Remote GitHub delivery and dashboard secret matching remain unverified.

The earlier payment-review scheduling limitation was resolved by `/root/payment_backend_audit`. Saved immutable purchase terms remain authoritative after provider configuration changes; mismatched provider identity remains denied. This review and regression tests do not establish real settlement or durable payment delivery.

Final actual read-only `/root/import_final_security` review found no critical/high defect in the scoped import boundary after the bounded parallel downloader, parser diagnostics and bulk insert changes. It checked fresh authorization before reads/publication, numeric personal-owner binding, transaction-local grant reset/RLS, immutable hashes, isolated parsing, repository-first locks and extractive private questions. No tests or live requests were performed by this reviewer; the separate hosted/API/browser reports supply execution evidence. This is not a full-product security certification.

## Private publication and provider storage review — 2026-10-07

Actual read-only `/root/publication_security` review identified false package
subpath export claims from parsed module symbols and an unlimited-create/bounded-
list history failure. Exact package.json export declarations and bounded retained
history fixed these. Follow-up found UUID case could split capacity locks; the
service now uses canonical UUIDs. The actual capacity helper subsequently passed
hosted contention across two repositories and mixed-case IDs with one remaining
slot. Generated metadata was inaccessible to ordinary users and was cleaned.

The same role independently reviewed provider replay and quote/claim ledgers.
It found no remaining concrete defect in the bounded scope: provider state is
independent from buyer credentials, missing-key locks serialize writers, unknown
outcomes cannot reopen claims, receipt references are unique and settlement
persistence invokes a required authoritative verifier. SQL rejects malformed
null/type fields and mutation of immutable terms. The reviewer performed no
tests or live requests; separate hosted evidence covers storage contention only.
Real entitlement/finality verification and durable paid delivery remain unwired.
No scoped review is a full-product release security certification.

## Production overhaul independent review — 2026-10-11

Actual atlas_security and atlas_verifier tasks reviewed and executed the changed boundaries. [Security evidence](evidence/overhaul-security.json) records ten reproduced findings and fixes; [verifier evidence](evidence/overhaul-verifier-commerce.json) records adversarial source/proof/registry/buyer/provider tests and retained-history capacity checks.

Complete canonical source, node and edge signatures reject invented graph relationships. Signed origin-bound control proofs protect private provider metadata. Fresh owner/buyer/session/revision fences reject revocation during external calls. Old purchases retain immutable source/terms. DNS/IP/pinned HTTPS and body/timeout limits bound provider egress. Ledger settlement reuses the active transaction, eliminating a reproduced single-connection deadlock. Authenticated readers no longer request mutation-only row locks.

The buyer atomically reserves integer allowance, claims credential dispatch once and preserves unknown settlement. Providers own replay/quote/delivery state independently, verify exact canonical Moderato transfers and authoritative settlement, and reconcile delivery without a second submission. Models/MCP cannot approve allowance, new purchases or signing.

Native Edge separately reproduced an unbound global fetch receiver in the SDK. The lead bound fetch correctly; the full browser suite passed 21/21 and the independent security follow-up passed 12/12 SDK tests. Its evidence distinguishes the lead's Edge execution from the reviewer's source/local tests.

Workspace retention is enforced by SQL locks/triggers at 100 snapshots/1,000 jobs; existing completed/pending imports remain reusable. Ten independent capacity tests verify rollback, isolation and preserved source. These serialized PostgreSQL-WASM checks do not prove multi-backend contention.

No new critical/high defect remains demonstrated in the reviewed local scope. New hosted schema/concurrency, external operator authority, wallet behavior, settlement, organizations/Storage and private AI operating budgets remain release gates. A scoped review is not a security certification. No private source appears in reports or model requests.
