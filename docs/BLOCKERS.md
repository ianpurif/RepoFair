# Current integration blockers

Audit in progress, 2026-10-07. Environment presence is not acceptance evidence.

## Resolved setup blockers

- Clerk development instance and real sign-in widget respond successfully; anonymous protected API requests return401. Signed-in acceptance is being tested.
- Supabase Auth and Storage APIs accept configured keys. Database pooler now connects with verified TLS after correcting endpoint, installing the official Supabase CA locally, and the user correcting the database password. Nine Atlas tables are present. Hosted RLS/concurrency verification is in progress.
- GitHub App RSA key file is valid. Contents/Metadata read permissions and one installation are confirmed after user configuration. The prior40-character value was not an App private key and is no longer used.
- Voyage document/query embeddings, reranking and DeepSeek grounded generation passed a real four-request workflow with eight canonical citations. Estimated cost belowUS$0.001 against approvedUS$1. No alternative AI provider or fallback.
- Independent payment-adapter review completed; the old agent scheduling blocker is obsolete. Saved purchase terms now survive changes to current provider pricing/recipient without requoting.

## Still open

1. **Authentication and tenant acceptance:** verify real signed-in session, personal workspace provisioning, Clerk third-party authentication in Supabase, and organization membership. The database transaction adapter and Clerk UI exist; these alone do not establish every flow.
2. **GitHub import and webhooks:** native App authorization/download/HMAC boundaries are implemented and tested. Durable import routes/jobs, real Git snapshot parsing, repository UI wiring and revocation processing are incomplete. App reports no event subscriptions; webhook configuration request returns404. Public webhook delivery requires a reachable approved deployment; localhost is not reachable by GitHub.
3. **Hosted persistence:** real RLS/concurrency audit is running. Storage currently has zero buckets; private object isolation is not configured or verified. Do not infer isolation from service-key access.
4. **Publishing:** repository administrative authority, endpoint control, exposure preview and durable publication/revocation remain incomplete. Fixture providers do not satisfy this gate.
5. **Tempo settlement:** RPC chain42431 and configured token contract/6decimals verified. No approved signer, second independent recipient or durable payment/replay/delivery route is configured. Real testnet settlement, interrupted delivery recovery and no-double-charge acceptance remain open.
6. **Production AI and agent access:** live AI verification uses authorized public fixture source. Private authenticated AI, operating-cost reservations, durable traces and authenticated SDK/MCP paths remain incomplete. AI is disabled by default and has no fallback.
7. **Release:** full product acceptance remains blocked. No public deployment, real-money Tempo payment, package publication or full completion is claimed.

Evidence: integration-probes.json, ai-live.json and browser-verification.json under docs/evidence. Completed setup failures are removed from the active list; historical evidence remains in PROGRESS.md.
