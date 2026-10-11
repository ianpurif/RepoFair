# Current integration blockers

Updated 2026-10-11. The overhaul implements durable imports, persisted UX, signed owner exports, authenticated SDK/MCP and independent Moderato payment/delivery adapters. Local checks are separate from external acceptance. Credentials being present is not evidence of completion.

## Required deployment and acceptance

1. **New schema and runtime:** reviewed central migrations `202610110001` and `202610110002` have not been applied to hosted PostgreSQL. Independent provider databases need replay/ledger migrations 005/006 and delivery migration `202610110003`. Deploy the existing Node worker alongside Atlas; no Redis or new queue service is required. Validate real TLS/driver/RLS behavior and multi-backend capacity, signing, replay and spending races on the changed schema.
2. **Updated hosted imports:** the new production service completed an actual authorized GitHub repository in an isolated local database: 199 files, 94.6 seconds, nine checkpoints, verified source/graph/citations and same-commit reuse. Fresh linked GitHub authorization passed. Repeat the full hosted browser workflow, crash/retry/cancel, a large real repository and changed commits after migration. Generated large/recovery benchmarks do not establish live large-import throughput; the 2026-10-07 hosted browser report applies to its earlier revision.
3. **Remote GitHub delivery:** today's read-only probe confirms Contents/Metadata read permission and reachable repository access, but no subscribed events and webhook configuration HTTP 404. An approved reachable HTTPS callback, matching secret/events and actual GitHub delivery/revocation must be verified.
4. **External publication/provider configuration:** configure the central HTTPS issuer origin and Ed25519 signing-key file; each independent operator needs its own database/CA, public HTTPS origin, issuer public key, MPP secret file, immutable publication identity, price, recipient and Moderato RPC. These new publication/provider fields are unconfigured. Explicit export/control proof and delivery are implemented, but real operator installation, owner activation, second-account discovery and revocation have not been accepted.
5. **Tempo settlement:** only Moderato 42431/PathUSD is supported. Actual chain/asset reads passed. No testnet signer, wallet behavior or distinct real recipient flow has been accepted. Verify authoritative settlement and interrupted delivery recovery without a second charge using authorized testnet funding/signing. No live transaction or successful receipt was fabricated.
6. **Remaining identity/storage:** organization synchronization, Google sign-in and private Storage objects are incomplete/unverified. Today's Storage probe found zero buckets. Imported source uses PostgreSQL repository-grant RLS; that does not establish Storage isolation.
7. **Private AI:** private questions work through deterministic extractive retrieval. Voyage/DeepSeek are the only application AI providers, disabled by default. Private AI disclosure, operating-cost database reservations, durable AI traces and broader quality acceptance remain incomplete. Earlier paid AI evidence covers only an explicitly approved public-fixture workflow; no private source was sent to AI in this overhaul.
8. **Retention and scale:** history stops at 100 snapshots/1,000 jobs and 50 drafts per workspace. Administrator-approved retention is needed at capacity. Inputs above bounded parser/source limits remain unsupported; simulated sparse benchmarks do not establish production memory/throughput guarantees.

Release remains blocked. No hosted migration, external publication/deployment, real spending, mainnet operation or completed paid product is claimed. Local PostgreSQL concurrency could not be refreshed: no native server is installed and the Docker Desktop daemon did not become reachable; PGlite results stay explicitly single-backend.

## Verified safe external scope

On 2026-10-11, read-only probes returned success for Clerk development-instance metadata, Supabase Auth/Storage, certificate/hostname-verified PostgreSQL, GitHub App metadata/repository-list access and configured DeepSeek model availability. They performed no source downloads, model inference, migrations, payment or signed-in import acceptance. See [integration probes](evidence/integration-probes.json).

Separate checks used fresh sessions for the existing development account and freshly authorized actual GitHub source reads. [The real import report](evidence/overhaul-real-import.json) validates the updated pipeline and source evidence locally without hosted writes or AI egress. The two development sign-in browser controls retain simulated commerce/wallet transport; neither is a real purchase.

## Historical accepted scope

Dated 2026-10-07 reports cover actual development sign-in/native Supabase JWTs, personal workspace, private GitHub import and source/answers/browser, separate-backend RLS/reservations, private draft administration and provider replay/quote/claim storage. Their generated records and owned verification sessions were cleaned as reported. They are retained as historical evidence and do not close the new deployment/payment gates.

## Agent configuration

The user's 2026-10-11 correction requires **gpt-6.1-sol / max**, without fallbacks, for the lead and all six custom roles. The current overhaul actually delegated all six named roles; task handles and results are recorded in [TASKS.json](TASKS.json) and [AGENT-RUNS.jsonl](AGENT-RUNS.jsonl). Configuration, role names and an agent's self-report do not independently expose backend model/effort. Observed fields remain null; no model execution is fabricated.
