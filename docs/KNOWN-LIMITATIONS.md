# Known limitations

- Public authored fixtures and bounded GitHub imports have separate routes. Verified owner publication and endpoint ownership verification remain incomplete. GitHub imports require a linked user, a read-only App installation, workspace membership, an exact root package version and a running durable worker.
- Clerk/Supabase and GitHub App configuration is present and service access verified. Real Clerk sessions, personal workspaces, hosted RLS and multi-connection reservations have evidence; organization membership and private Storage isolation remain unverified.
- Tempo testnet settlement, interrupted paid delivery recovery and paid MCP transport remain unverified. No transaction hashes or receipts are fabricated.
- Local source excerpts are deterministic. Opt-in AI uses Voyage embeddings/reranking and DeepSeek generation; a bounded real public-fixture workflow passed. This does not establish general answer quality. Generated citations validate source identity, not semantic correctness. AI supports the loopback public-fixture workflow only.
- Parser supports bounded TS/JS, relative resolution, import aliases, supported re-exports and local declarations. tsconfig path aliases, dynamic imports and computed runtime dispatch remain unresolved.
- File/AST/graph limits and cooperative elapsed checks remain; Git imports additionally run in a child process with a hard timeout and memory ceiling. Oversized or unsupported source is rejected explicitly.
- PostgreSQL-WASM tests run real SQL with a local JWT-claim shim. They do not prove Clerk signature verification, hosted Supabase configuration or concurrent networked reservations.
- Federation joins exact packages and explicit exports. Cross-repository symbol calls remain unresolved. Buyer independently checks fixture source/graph and re-extracts citations; provider activity is not execution evidence.
- Fixture publication uses an explicit local process flag. Stop the process to revoke future requests; already delivered source cannot be erased.
- Browser activity history is device-local, not a durable tenant audit log.
- Evaluation uses tiny authored fixtures. Equal-access BM25 results support no general accuracy, latency or cost claims.

No public deployment, package publication, hackathon submission or mainnet spending has occurred. Release remains blocked.
