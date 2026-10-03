# Provider publishing specification

This is a milestone specification, not an active service.

Verify repository administrative authority and endpoint control separately. Show authorized exposure before publication. Store declared rights/licensing and accuracy status separately; don't award an all-purpose trusted badge.

The manifest maps each supported package version to an immutable repository snapshot and explicit exports. Metadata has its own access policy; do not leak private file paths through discovery.

Independent provider process: distinct identity, endpoint, configuration, authorized index access, price and recipient. The starter health services deliberately do not accept payments. Implement context.retrieve with bounded inputs/results and document its supported version schema.

Before payment: validate caller entitlement, operation, version and availability. Paid request binds exact terms. Return source passages with source ranges, limited subgraph, provenance and limitations. Validate provider output as untrusted JSON at the buyer.

Unpublishing revokes new service access and server-side reuse. It cannot erase bytes already legitimately delivered. Document result caching/reuse rights before selling it. Decline unsupported versions rather than charging for a latest-version substitute.
