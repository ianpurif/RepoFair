# Database boundary

`migrations/202610030001_atlas.sql` defines workspaces, memberships, immutable snapshot source/graphs, jobs, budgets and purchases. Mutations are service-only; authenticated reads use Clerk text subjects and membership policies. Nothing is represented as deployed.

`tests/database/migrations.test.ts` executes the actual SQL in disposable PostgreSQL-WASM with a test claim shim. It checks row isolation, denied direct mutations, integer reservations, null replay rejection, unknown settlement and revocation. It does not validate live JWT signatures, hosted Storage policies or concurrent PostgreSQL connections.

Before enabling private data, configure supported Clerk third-party Supabase auth, review and apply migrations to an isolated test database, and test two independently authenticated principals across every protected table/storage path. Complete service persistence and worker adapters before use. Never replace the production ledger with in-memory state.

The root release gate remains blocked on hosted integration and multi-connection acceptance tests.
