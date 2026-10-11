# Tempo Moderato commerce

Updated 2026-10-11. Charge, receipt, authorization and recovery adapters are implemented and tested locally. **No real purchase, wallet signing, broadcast or settlement was performed in this overhaul.**

## Fixed network and protocol

The only supported network is Tempo Moderato, chain **42431** (`eip155:42431`). PathUSD is `0x20c0000000000000000000000000000000000000`, with six decimal places. Startup checks the actual RPC chain, and the client checks the signer RPC before signing. No automatic network switch, mainnet fallback, token swap or application-held wallet key exists.

The pinned integration is **mppx 0.13.1 / viem 2.57.2**, using the documented Tempo charge method in **pull** mode. The caller owns the wallet client and signs the prepared transaction; the provider processes the credential. `polyfill:false` avoids global fetch interception, `autoSwap:false` prevents implicit swaps, and expected chain/recipient constraints bind the official challenge.

Primary references checked during the overhaul:

- [Tempo connection details](https://tempo.xyz/developers/docs/quickstart/connection-details.md) and [testnet funding](https://tempo.xyz/developers/docs/quickstart/faucet.md).
- [MPP Tempo charge](https://mpp.dev/payment-methods/tempo/charge.md), [server charge API](https://mpp.dev/sdk/typescript/server/Method.tempo.charge.md), and [client setup](https://mpp.dev/sdk/typescript/client/Mppx.create).
- [MPP receipts](https://mpp.dev/protocol/receipts).

## Approval and one-time submission

1. An authenticated buyer chooses an exact accessible publication and question. Atlas gets an official unpaid quote, validates origin, realm, operation, release, body digest, token, integer amount, recipient and expiry, then atomically reserves the configured workspace allowance.
2. The SDK claims signing once in PostgreSQL **before** invoking the caller-owned signer. The browser separately requires a connected Moderato wallet and explicit exact-price approval. MCP exposes no new-purchase approval, allowance-change or signing tool.
3. Atlas inspects the signed Tempo transaction, freezes its hash/sender, and records the first credential dispatch before requesting the provider. Raw credentials and signing secrets are not stored.
4. Provider replay and immutable sale records are held in the provider's own database. Fresh issuer entitlement is checked before quoting, charging and returning context.
5. Both sides validate the authoritative RPC chain, canonical transaction/block/receipt and exact TIP-20 TransferWithMemo sender, token, recipient, amount and challenge attribution. A browser hash or SDK receipt alone is insufficient.
6. Source and graph members must match the owner's Ed25519 signatures and immutable publication digest before Atlas exposes delivered context.

An unknown/lost response retains its reservation and blocks new signing. **Resume checks the recorded transaction and retrieves existing delivery; it never rebroadcasts or forwards a second payment credential.** An unsigned reservation can be cancelled. Pending/unknown purchases cannot be cancelled as though no charge happened.

Payment, delivery and evidence sufficiency are independent. A settled payment can have failed/revoked/insufficient delivery. Revocation blocks new reads and reuse, including after an in-flight provider response; it cannot erase received bytes. No automatic refund is promised.

The PathUSD allowance covers the service price. It does not guarantee gas, wallet fees or infrastructure costs.

## Configuration and acceptance

Atlas needs the reviewed central migrations, HTTPS issuer origin and Ed25519 signing-key file. Each provider needs its own database, HTTPS origin, issuer public key, MPP secret file, fixed identity/price/recipient and Moderato RPC. See [PROVIDER-PUBLISHING.md](PROVIDER-PUBLISHING.md) and [.env.example](../.env.example).

The browser uses an injected EIP-1193 wallet supporting Tempo pull signing. Hardware/extension behavior remains unverified; unsupported signing fails explicitly. Headless callers supply their own signer through the authenticated SDK.

Adding Moderato to an ordinary EVM wallet does not establish this compatibility. With the pinned libraries, Atlas's browser pull mode requests `eth_signTransaction` with Tempo transaction fields. No real extension has passed that path. The first acceptance attempt can instead use the caller-owned local-account signer in `packages/sdk/examples/moderato.ts`; its key remains outside application configuration.

The example defaults to `--check`: actual RPC chain, authenticated account/catalog and existing allowance, with no reservation, key read or signing. `--purchase` separately requires the exact `--approve-atomic-amount`, an outside-checkout `--key-file` and stable `--idempotency-key`. It cannot increase allowance. `--resume <purchase UUID>` accepts no signer and never supplies another credential. Token files are reread per request; stdout omits private source and raw errors. An explicit outside-checkout output file is created exclusively. These CLI guards are checked with simulated transports, not live purchases.

The official Moderato RPC is `https://rpc.moderato.tempo.xyz`; its explorer is `https://explore.testnet.tempo.xyz`. The official test faucet accepts `POST https://tempo.xyz/developers/api/faucet` with an address-only JSON body. Test allocations can change; funding and fee sufficiency remain separate from workspace allowance. The default Tempo Wallet/CLI documentation uses mainnet and does not establish a configured Atlas Moderato browser signer.

Current evidence executes genuine SQL, official offline challenges, signed source/graph proofs, SDK/MCP transports, canonical-transfer validation and interrupted-delivery recovery against **explicit simulated identity/RPC/provider transports**. PGlite's serialized backend does not prove networked PostgreSQL concurrency.

Release still requires hosted migrations/TLS, real endpoint control, two independent operators/recipients, authorized testnet funding/signing, settlement, and delivery recovered without another charge. No approval to spend real money or deploy externally has been inferred.
