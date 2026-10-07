# Source and verification register

## Consulted while packaging — 2026-10-03

These sources support configuration syntax/model IDs. They do not establish the user's account access or prove live integrations.

| Source | URL | Used for |
|---|---|---|
| Official Codex subagent docs | https://developers.openai.com/codex/multi-agent | Standalone project agent TOML files, model/effort overrides, current thread-cap key. Redirects to official ChatGPT Learn. |
| Official Codex configuration reference | https://developers.openai.com/codex/config-reference | Model effort, subagent defaults, sandbox/approval settings. |
| Official Codex configuration basics | https://developers.openai.com/codex/config-basic | Project trust and configuration precedence. |
| Official Codex skills guide | https://developers.openai.com/codex/skills | Project-local `.agents/skills` layout. |
| Official AGENTS guide | https://developers.openai.com/codex/guides/agents-md | Repository instructions and scoped discovery. |
| Official Codex CLI reference | https://developers.openai.com/codex/cli/reference | Interactive launch flags and startup prompt. |
| Official model catalog | https://developers.openai.com/api/docs/models | `gpt-6-astra` and `gpt-6.1-sol` identifiers. |
| Official reasoning guide | https://developers.openai.com/api/docs/guides/reasoning | `medium` and `xhigh` effort tokens; availability remains model/client-specific. |
| Next publisher registry metadata | https://registry.npmjs.org/next/latest | Observed Next 16.3.8 source pin and engine/peer metadata. |
| React publisher registry metadata | https://registry.npmjs.org/react/latest | Observed React 19.3.0 source pin. |
| Tailwind publisher registry metadata | https://registry.npmjs.org/tailwindcss/latest | Observed Tailwind 4.3.3 source pin. |

Some scoped/version-specific registry pages were unavailable through the research tool. Container package downloads also failed DNS resolution. No installed-dependency compatibility is claimed. P0 resolves remaining pins and tests the actual combination.

## Product integration research targets — verify during implementation

These are reference starting points from the approved product brief, not a statement that their APIs were implemented or freshly checked in this archive.

- Next.js: https://nextjs.org/docs
- ts-morph: https://ts-morph.com/details/imports
- React Flow: https://reactflow.dev/learn
- Clerk: https://clerk.com/docs
- Supabase third-party Clerk integration: https://supabase.com/docs/guides/auth/third-party/clerk
- GitHub Apps: https://docs.github.com/en/apps/creating-github-apps
- MPP documentation: https://mpp.dev/llms.txt
- Tempo developer docs: https://tempo.xyz/developers/docs
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- LangSmith evaluation: https://docs.langchain.com/langsmith/evaluation
- Bun: https://bun.sh/docs
- Hackathon official site/rules entry: https://colosseum.com/worldsfair

## Source-derived versus proposed

The latest user-approved 16-section Atlas prompt controls the product scope. BUILD.md retains it with the requested multi-agent mapping and startup clarifications. Architecture choices, task decomposition, scaffold code and acceptance gates are implementation proposals, not competitor/performance claims.

The earlier user-supplied ChronosRAG whitepaper v2.1 is background only: source/evidence contracts (section 6), cache scope (section 7), bounded repair (section 8), unknown evidence (section 9), and data boundaries (section 14). Its original support-runtime focus and graph/payment exclusions are superseded by the user's later Atlas brief. The original DOCX is not bundled.

## Application AI interfaces verified — 2026-10-07

- https://docs.voyageai.com/reference/embeddings-api
- https://docs.voyageai.com/reference/reranker-api
- https://api-docs.deepseek.com/api/create-chat-completion/
- https://api-docs.deepseek.com/quick_start/pricing/

Verified native HTTP request shapes and model allowlists; account access and paid calls were not tested. See AI.md.
