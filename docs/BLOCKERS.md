# Current integration blockers

Updated 2026-10-07 from actual service, database, HTTP and browser checks. Credentials being present is not acceptance evidence.

## Resolved setup and verification blockers

- Real Clerk development sign-in, anonymous API denial, native Clerk session JWT acceptance by Supabase and personal workspace provisioning passed. The user's linked GitHub identity and authenticated private repository authorization passed.
- Supabase's project pooler connects with certificate and hostname verification using the official CA. Eleven Atlas tables are present. Separate-backend tenant isolation, transaction-local repository grants, membership revocation, concurrent reservations and idempotency passed; generated audit records were cleaned.
- The GitHub App RSA file is valid, with Contents/Metadata read permissions and one installation. The linked personal owner's numeric GitHub identity is checked against both installation account and repository owner; an installation alone does not authorize arbitrary users.
- Real RepoFair import, durable persistence and authenticated source/answer retrieval passed: 144 files, 1,831 nodes, 7,399 edges and two original-source citations. The user identity and immutable Git commit are preserved. Fixed the old 64-file and 100,000-AST-node caps to bounded 192/200,000 limits; retained 256 MB heap, 10-second checked/15-second hard parsing limits. Source rows publish atomically in one database batch.
- Real signed-in browser acceptance passed: exact source display, progressive graph expansion, complete accessible graph list, relationship origins, question submission, eight original-source citations and citation navigation. Keyboard controls, 390 px layout, anonymous denial and authenticated 400/413/403 request validation passed. Only the verifier's new session was revoked; existing user sessions were preserved.
- Webhook HMAC, event/body validation, concurrent deduplication, immutable jobs, revocation and job cancellation passed 16 local tests and 17 hosted/HTTP checks. This includes actual signed localhost ping persistence, invalid signature rejection and oversized-body rejection.
- Voyage document/query embeddings, reranking and DeepSeek grounded generation passed a four-request public-fixture workflow with eight source citations. Estimated cost US$0.00068157 against the approved US$1 limit. No private RepoFair source was sent to AI; no alternative provider or fallback exists.
- Independent payment-adapter review completed. Saved purchase terms now survive changes to current provider pricing/recipient without requoting. This does not establish settlement.

## Still open

1. **Remote GitHub webhooks:** the App reports no event subscriptions and its webhook configuration request returns HTTP 404. Configure a reachable approved HTTPS deployment, matching secret and events, then verify an actual GitHub delivery and revocation. Local handler checks do not close this blocker.
2. **Remaining identity/storage scope:** organization membership/synchronization, Google sign-in acceptance and private Storage object isolation remain unverified or incomplete. Storage currently has zero buckets. Current imported source is stored in PostgreSQL under repository-grant RLS; service-key access is not Storage-isolation evidence.
3. **Publishing:** administrative publishing authority, endpoint control, exposure preview and durable publication/revocation remain incomplete. Read-only repository authorization and fixture providers do not satisfy this gate.
4. **Tempo settlement:** testnet RPC chain 42431 and configured token contract/6 decimals are verified. No testnet signer, second independent recipient or complete durable payment/delivery integration is configured. Actual testnet settlement, interrupted delivery recovery and no-double-charge acceptance remain open.
5. **Private AI and agent access:** authenticated private AI disclosure, operating-cost reservations, durable traces and authenticated SDK/MCP paths remain incomplete. Existing live AI evidence covers only approved public fixtures. AI remains disabled by default.
6. **Release:** full product acceptance remains blocked. No public deployment, mainnet payment, package publication or full completion is claimed.

Evidence is under `docs/evidence`: `private-import.json`, `private-repository-ui.json`, `integration-probes.json`, `clerk-session.json`, `hosted-database.json`, `hosted-import-locks.json`, `webhook-verification.json`, `ai-live.json` and `browser-verification.json`. Completed setup failures have been removed from the active list; historical outcomes remain in PROGRESS.md.
