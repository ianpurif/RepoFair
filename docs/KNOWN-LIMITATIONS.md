# Known limitations of the supplied starter

This archive is an implementation harness, not a completed marketplace. It has not imported a GitHub repository, indexed a real graph, called an LLM, authenticated Clerk/Supabase, settled Tempo payments or exposed actual MCP tools.

The Next.js files are a source scaffold; a registry network connection is required to install dependencies and verify the full build. No dependency lockfile has been fabricated. P0 must verify peers, current advisories and the exact resolved toolchain.

Pure graph/evidence/version/budget helpers are unit-tested locally. They are not complete parsers, authorization services, DNS guards, cryptographic receipts or concurrent database ledgers. Scope objects must come from trusted server identity, not request JSON.

The provider sample serves only honest health and capability-unavailable responses. Live/payment/MCP behavior is disabled. The SDK only reads starter capabilities.

Agent settings are statically checked; account availability, workspace trust, effective UI overrides and real delegation must be checked in the user's Codex client. No agents were launched during packaging.
