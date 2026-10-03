# Database boundary

No application schema or RLS policies are represented as deployed. P0/P1 must create migrations for trusted Clerk identity, organization/repository scope, immutable source graphs, jobs, providers, quotes, reservations and deliveries.

Use the current supported Clerk third-party Supabase integration. Test actual policies with at least two independently scoped principals and attempts against every protected table/storage path. A pure sameScope unit test is not an RLS test.

Payment reservations need atomic locking/unique idempotency. Do not implement the production ledger as an in-memory object. The root release gate remains blocked until database tests run.
