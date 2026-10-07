# Decision log

## D001 — Product scope (user-approved direction)
General codebase intelligence, provider publishing, version-correct federation and Tempo purchases. Reject payment-security scanners, repair marketplaces and Solana integration.

## D002 — Requested agents
Primary Astra medium; six named subagents using Astra medium for reading/review and Sol xhigh for implementation/verification. Two concurrent spawned agents. No silent fallback or pretend delegation.

## D003 — Starter boundary
Provide full prompt, coordination harness, source scaffold, original fixtures and deterministic helpers. Mark unimplemented live capabilities as unavailable. No fake lockfile or payment receipt.

## D004 — Minimal architecture
One web app, worker, standalone provider runtime and PostgreSQL. Use node/edge tables first. No extra graph database, queue product, autonomous router or distributed marketplace until justified.

## D005 — Payment safety
Off by default. No signer shipped. Testnet requires explicit configuration; mainnet requires consent. Pure reducers are validation building blocks only; final persistence must enforce concurrent invariants.

Append new decisions with date, evidence, alternatives, consequence and verification requirement. Never silently overwrite historical decisions.

## D006 — Fixture scope and parser isolation (2026-10-03)
Architect review accepted a public catalog-only fixture boundary while auth is
unconfigured. Server ignores caller tenant identity and never accepts arbitrary
filesystem paths or repositories. In-memory ts-morph parsing consumes bounded,
digest-checked bytes. npm v3 local links resolve only against trusted catalog
metadata. Source graphs remain snapshot scoped and structurally validated.

## D007 — Persistence gate (2026-10-03)
PostgreSQL schema uses Clerk text subjects, membership-based read policies and
server-only mutations. Budgets serialize on the allowance row; unknown payments
retain reservations. SQL is not a claimed payment verifier. Docker is unavailable;
database concurrency/RLS acceptance stays unverified rather than inferred from
pure helpers. Live adapters stay disabled until independently tested.

## D008 — Exclusive application AI providers (2026-10-07)

Explicit user decision: Voyage AI owns embeddings and semantic retrieval/reranking; DeepSeek owns all LLM/chat/reasoning/generation. Use native REST and fixed endpoints, with no alternate provider dependency or fallback. Existing deterministic source navigation is a separate local operation. AI disclosure must bind to the current question and snapshot. Local server enablement and both credentials are required; hosted AI remains gated on authorization and usage controls. See AI.md for interfaces and acceptance boundaries.

## D009 — Private proposals and independent payment state (2026-10-07)

Private publication drafts require both workspace administration and fresh GitHub
personal ownership or repository administration. Read access is insufficient.
Proposals start with no exposed paths and private access; exact commit, exposure
and terms bind to a revision digest. Database constraints forbid this draft table
from claiming publication, approval, endpoint proof or enabled payment. Rights
are a declaration and accuracy remains unverified.

The architecture review separated buyer budgets from independent provider sale
state. Providers own their replay/quote/settlement/delivery persistence and never
receive buyer database credentials. The first durable component is a namespaced
PostgreSQL AtomicStore, verified on separate hosted connections. Payment and
publication acceptance still require their actual external flows.
