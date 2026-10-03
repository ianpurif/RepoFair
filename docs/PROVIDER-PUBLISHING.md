# Provider publishing specification

The local fixture service below is implemented. Verified owner publication remains a milestone specification.

## Local implementation

`bun run provider:a` and `bun run provider:b` launch separately configured
fixture processes with explicit `--publish`. The reviewed exposure is the
authored retry-kit or event-log catalog snapshot; no arbitrary repository or
private paths can be selected. Without `--publish`, manifest/context access is
unavailable. This is a fixture publishing flag, not verified repository ownership.
Stopping/restarting without the flag revokes new requests. No result cache is
shared across buyers; previously delivered content cannot be recalled.

Each request validates package, exact version, body bounds and provider state
before indexing. Each response has provider identity, source snapshot and
fixture/no-payment fields. Provider origin/redirect handling uses a fixed
loopback allowlist in this mode. Production endpoint registration, administrative
authority and content-rights attestations still require implementation and tests.

Verify repository administrative authority and endpoint control separately. Show authorized exposure before publication. Store declared rights/licensing and accuracy status separately; don't award an all-purpose trusted badge.

The manifest maps each supported package version to an immutable repository snapshot and explicit exports. Metadata has its own access policy; do not leak private file paths through discovery.

Independent provider process: distinct identity, endpoint, configuration, authorized index access, price and recipient. The starter health services deliberately do not accept payments. Implement context.retrieve with bounded inputs/results and document its supported version schema.

Before payment: validate caller entitlement, operation, version and availability. Paid request binds exact terms. Return source passages with source ranges, limited subgraph, provenance and limitations. Validate provider output as untrusted JSON at the buyer.

Unpublishing revokes new service access and server-side reuse. It cannot erase bytes already legitimately delivered. Document result caching/reuse rights before selling it. Decline unsupported versions rather than charging for a latest-version substitute.
