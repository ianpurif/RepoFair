# Known limitations

- Only public authored fixtures are supported. Arbitrary GitHub/private imports, verified owner publication, endpoint ownership verification and a durable PostgreSQL indexing worker are not implemented.
- Clerk/Supabase and GitHub App credentials are absent. Hosted authentication, Storage policies, organizations and live RLS integration remain unverified.
- Tempo testnet settlement, interrupted paid delivery recovery and paid MCP transport remain unverified. No transaction hashes or receipts are fabricated.
- Local source excerpts are deterministic. Opt-in AI uses Voyage embeddings/reranking and DeepSeek generation; live API access/quality is unverified. Generated citations validate source identity, not semantic correctness. AI supports the loopback public-fixture workflow only.
- Parser supports bounded TS/JS, relative resolution, import aliases, supported re-exports and local declarations. tsconfig path aliases, dynamic imports and computed runtime dispatch remain unresolved.
- File/AST/graph limits and cooperative elapsed checks exist; synchronous ts-morph has no hard interrupt. General imports require an isolated worker first.
- PostgreSQL-WASM tests run real SQL with a local JWT-claim shim. They do not prove Clerk signature verification, hosted Supabase configuration or concurrent networked reservations.
- Federation joins exact packages and explicit exports. Cross-repository symbol calls remain unresolved. Buyer independently checks fixture source/graph and re-extracts citations; provider activity is not execution evidence.
- Fixture publication uses an explicit local process flag. Stop the process to revoke future requests; already delivered source cannot be erased.
- Browser activity history is device-local, not a durable tenant audit log.
- Evaluation uses tiny authored fixtures. Equal-access BM25 results support no general accuracy, latency or cost claims.

No public deployment, package publication, hackathon submission or mainnet spending has occurred. Release remains blocked.
