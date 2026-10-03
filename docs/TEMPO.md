# Tempo / MPP implementation plan

Status: **not integrated**. No valid network addresses, credentials, payment challenges or receipts are bundled.

Research current official MPP and Tempo documentation in SOURCES. Pin a tested SDK. Use documented one-time charge/paid MCP behavior; no custom protocol, escrow, token or automatic refund promise.

Payments purchase independently operated code-intelligence context, not access to a generic chatbot and not repairs. Start with direct provider settlement. Platform fee/split follows only after a real core flow.

Before execution validate access/version/request, freeze quote terms and reserve the external-service allowance in a serializable/appropriately locked transaction. Generate/validate cryptographic request binding in the trusted integration. The starter termsIdentity string is a comparison helper, not payment verification.

Track draft/approved/reserved/pending/unknown/settled/failed/expired separately from delivery and evidence sufficiency. Persist idempotency keys. Unknown is not failed; no blind resubmission. Resume paid delivery without another charge. If a provider does not support safe reconciliation, expose that limitation and stop.

Real integration acceptance: authorize testnet-only signer and recipient, complete a supported provider request, retain actual receipt/transaction metadata, verify returned context, interrupt delivery and recover it without a second purchase. Two provider instances must use independent configured recipients before the demonstration claims independent settlement.

Never enable live mode merely because env variables are present. Require passing checks and explicit mainnet authorization. Audit gas/fees separately; the retrieval allowance is not a universal hard total-cost limit.
