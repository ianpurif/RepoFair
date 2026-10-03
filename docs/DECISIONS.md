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
