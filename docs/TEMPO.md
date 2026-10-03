# Tempo / MPP implementation plan

Status: **not integrated**. No valid network addresses, credentials, payment challenges or receipts are bundled.

## Implemented but unwired testnet adapter

`apps/provider/src/tempo-adapter.ts` uses mppx 0.13.1 official one-time charge.
It supports only the viem Tempo Moderato chain definition. Token, recipient,
decimals, origin and secret are required; there are no RPC/address defaults.
It forces pull mode and waitForConfirmation:true, with sponsorship, machine
tokens and splits disabled. No route or environment flag enables it.

The factory requires durable authorization, immutable quote, purchase lookup,
atomic claim, authoritative settlement verification, persistence, unknown-state
handling, resumable delivery, AtomicStore and an RPC client. Production adapters
remain unavailable. Pending/unknown purchases cannot automatically charge again;
settled delivery can resume after quote expiry.

`packages/sdk/src/payment-policy.ts` validates the official challenge against
approved terms, observed provider origin, body digest, exact version,
network/token/recipient, integer amount, expiry and idempotency. The caller owns
the official prepared payment and signer; no global fetch patch, key loading or
signing retry. SQL stores the SDK's sha-256=base64 request digest, while the
complete-terms fingerprint remains SHA-256 hex.

Twelve offline policy/adapter tests pass, including a genuine SDK-generated 402
challenge. No signed payment credential is submitted and no RPC call is made. Real settlement,
finality and recovery remain unverified; test data are not transaction receipts.

Research current official MPP and Tempo documentation in SOURCES. Pin a tested SDK. Use documented one-time charge/paid MCP behavior; no custom protocol, escrow, token or automatic refund promise.

Payments purchase independently operated code-intelligence context, not access to a generic chatbot and not repairs. Start with direct provider settlement. Platform fee/split follows only after a real core flow.

Before execution validate access/version/request, freeze quote terms and reserve the external-service allowance in a serializable/appropriately locked transaction. Generate/validate cryptographic request binding in the trusted integration. The starter termsIdentity string is a comparison helper, not payment verification.

Track draft/approved/reserved/pending/unknown/settled/failed/expired separately from delivery and evidence sufficiency. Persist idempotency keys. Unknown is not failed; no blind resubmission. Resume paid delivery without another charge. If a provider does not support safe reconciliation, expose that limitation and stop.

Real integration acceptance: authorize testnet-only signer and recipient, complete a supported provider request, retain actual receipt/transaction metadata, verify returned context, interrupt delivery and recover it without a second purchase. Two provider instances must use independent configured recipients before the demonstration claims independent settlement.

Never enable live mode merely because env variables are present. Require passing checks and explicit mainnet authorization. Audit gas/fees separately; the retrieval allowance is not a universal hard total-cost limit.
