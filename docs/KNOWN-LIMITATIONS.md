# Known limitations

Updated 2026-10-11. Local implementation and externally accepted workflows are recorded separately.

- New import/commerce migrations have not been applied to hosted databases. Updated authenticated import, map, publication and purchase workflows need deployment verification. Historical 2026-10-07 private-import evidence covers the earlier revision.
- GitHub webhook subscriptions and an approved HTTPS callback are absent. Manual authorized imports/retries work without webhooks; automatic remote updates/revocation delivery remain unverified.
- Organization synchronization, Google sign-in acceptance and private Storage isolation remain incomplete/unverified. Imported source uses PostgreSQL repository-grant RLS; the hosted Storage probe found zero buckets.
- Real endpoint control, independent operators/recipients, wallet signing, Tempo settlement and interrupted paid delivery have not been exercised. Commerce tests use genuine code/SQL with simulated identity/RPC/HTTP transports.
- General repositories need no npm root. TS/JS supports declarations, relative imports/exports and supported static relationships. Python supports bounded declarations/relative imports. Other languages provide real file evidence only. Dynamic dispatch, tsconfig aliases, conditional/wildcard package exports, Python package resolution and cross-repository symbol calls remain unresolved.
- Git imports are bounded to 5,000 eligible files, 30 MB source, 262,144 characters/20,000 lines per file, 50,000 nodes and 150,000 edges/evidence records. The parser has a 768 MiB V8 heap ceiling and 60-second hard deadline. Larger inputs fail explicitly; unrestricted monorepo support is not claimed.
- Above 192 TS/JS files, expensive whole-program reference/call extraction is skipped and reported. Declarations/imports/exports remain available; missing relationships are not invented.
- Incremental ingestion reuses hash-verified blobs within the same authorized repository/workspace and index version. Parsing still rebuilds the bounded current graph; no per-symbol incremental compiler cache is claimed.
- Retained history is capped at 100 snapshots/1,000 jobs and 50 publication drafts per workspace, including cancelled/revoked history. Capacity errors are actionable. Administrator-approved retention is required at the cap; no source/audit history is silently deleted.
- Graph/source responses are progressively loaded and bounded. Neighborhoods may omit relationships. Static reachability means potential impact, not confirmed breakage.
- Private answers are deterministic/extractive. Fixture AI uses Voyage/DeepSeek only and defaults off. Private AI disclosure, database operating-cost reservations and general quality acceptance remain open.
- PostgreSQL-WASM runs actual SQL/RLS with a claim shim and serialized transactions. It does not prove hosted JWTs, TLS or multi-backend contention. Historical hosted concurrency evidence applies to its dated schema.
- Benchmarks use generated sparse source and simulated GitHub latency. Memory is RSS at return, not sampled peak. Real large repositories, network latency and compute/storage/hosting costs need measurement.
- Browser checks include explicit fixtures and commerce transport mocks. Opt-in controls use a real development sign-in and only new verifier-owned sessions; they still do not establish hosted paid delivery.
- Tempo hardware/extension pull signing remains unverified. Wrong-chain wallets are denied and unsupported signing fails explicitly.
- Paid evidence may be insufficient/inaccurate. Revocation prevents future reads/reuse, not erasure of received bytes. No refund, runtime-breakage guarantee, mainnet operation, external deployment or successful sale is claimed.

The release gate remains blocked. See [BLOCKERS.md](BLOCKERS.md).
