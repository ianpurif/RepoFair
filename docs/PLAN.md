# Implementation plan

Follow dependency order. P0 is partial scaffolding only. Models and secrets are not assumed available.

## P0 — Foundation

- [ ] Confirm actual Codex model availability and real delegation.
- [ ] Verify dependency compatibility, install and commit real lockfile.
- [ ] Run starter and full type/build checks; add Vitest, ESLint and Playwright.
- [ ] Document authorization/migration implementation plan; no private-data bypass.

## P1 — Local intelligence

- [ ] Parse a fixture using ts-morph without running imported code.
- [ ] Display actual nodes/edges and open original source spans.
- [ ] Implement bounded graph-grounded retrieval and structural citation checking.
- [ ] Return explicit unknown/partial/unavailable outcomes.

## P2 — Provider publishing

- [ ] Verify publisher authority and endpoint control separately.
- [ ] Publish an exposure-reviewed manifest with exact release mappings.
- [ ] Run independently configured provider endpoint with bounded context retrieval.
- [ ] Deny unauthorized and unsupported requests before payment.

## P3 — Tempo purchase

- [ ] Implement verified MPP terms and real testnet settlement.
- [ ] Enforce transactional budget and idempotency.
- [ ] Persist unknown settlement and resume paid delivery without a second purchase.
- [ ] Keep signer outside source/model/log paths.

## P4 — Federation

- [ ] Use two actual provider endpoints for one authorized investigation.
- [ ] Verify exact package/snapshot mapping and source provenance.
- [ ] Merge only explicit relationships; maintain separately scoped identities.
- [ ] Invalidate inappropriate reuse after version/access changes.

## P5 — Product experience

- [ ] Complete Clerk/Supabase/GitHub authorization with actual RLS tests.
- [ ] Finish graph/navigation/publishing/approval/accessibility states.
- [ ] Expose typed SDK and actual MCP tools.
- [ ] Test failure recovery and source disclosure UI.

## P6 — Verification and delivery

- [ ] Run product unit/integration/security/browser checks and build.
- [ ] Evaluate against equal-access baseline without invented wins.
- [ ] Complete docs and recorded honest demo with actual testnet evidence.
- [ ] Resolve blocking reviews and verify release checklist.

## Suggested work waves

P0: architect + researcher, then lead integrates. P1: engineer parsing/retrieval + frontend against frozen contracts. P2: provider implementation + independent fixture tests. P3: engineer + read-only security review, then verifier adversarial persistence. P4: federation + UI after common contracts. P5: final UX/auth/MCP. P6: independent review and release gate.

Shared writes must never overlap. Preserve a working checkpoint after each phase and continue to the next gate rather than asking permission for every milestone.
