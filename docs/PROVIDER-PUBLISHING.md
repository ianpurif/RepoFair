# Provider publishing specification

Private administrative drafts and the local fixture service are implemented.
External publication remains unavailable pending endpoint control, explicit
approval and the independent provider delivery/payment integration.

## Private administrative drafts

The signed-in `/app/publish` page uses `/api/publications` and the durable
`atlas.publication_drafts` table. Creation, reads, saves and revocation require
workspace owner/admin status plus fresh GitHub personal ownership or repository
administration. Repository read permission is insufficient. Every mutation
rechecks membership and repository revisions after acquiring locks.

Drafts start private with no exposed files, endpoint or payment terms. The
preview contains exact selected paths, line/byte counts and source digests bound
to an immutable commit. Package export mappings must match explicit package.json
entries; a module's exported symbol is not proof of a package subpath export.
Updates require the expected revision. Every exposure/terms change changes the
revision digest. A newer imported snapshot requires a new draft. Fifty retained
drafts per workspace bound the history; revoked records remain readable.

Administration, declared rights, accuracy, endpoint proof, publication and
payment are separate fields. Database constraints prevent a draft from becoming
a publication or enabling payment. Saving proposed public access is still a
private draft mutation and does not disclose source to an external provider.

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
loopback allowlist in this mode. Production endpoint registration, publication
approval and independent paid delivery still require implementation and tests.

Verify repository administrative authority and endpoint control separately. Show authorized exposure before publication. Store declared rights/licensing and accuracy status separately; don't award an all-purpose trusted badge.

The manifest maps each supported package version to an immutable repository snapshot and explicit exports. Metadata has its own access policy; do not leak private file paths through discovery.

Independent provider process: distinct identity, endpoint, configuration, authorized index access, price and recipient. The starter health services deliberately do not accept payments. Implement context.retrieve with bounded inputs/results and document its supported version schema.

Before payment: validate caller entitlement, operation, version and availability. Paid request binds exact terms. Return source passages with source ranges, limited subgraph, provenance and limitations. Validate provider output as untrusted JSON at the buyer.

Unpublishing revokes new service access and server-side reuse. It cannot erase bytes already legitimately delivered. Document result caching/reuse rights before selling it. Decline unsupported versions rather than charging for a latest-version substitute.
