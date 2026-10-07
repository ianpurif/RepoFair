# Application AI: Voyage AI + DeepSeek

The application uses Voyage AI for embeddings and reranking, and DeepSeek for all generated answers and optional reasoning. Native HTTPS requests are used directly; no third-party model SDK or provider fallback is installed. Deterministic graph navigation and source excerpts remain available as explicit local operations.

## Local configuration

Set these server-only entries in `.env.local`:

```dotenv
ATLAS_AI_ENABLED=true
VOYAGE_API_KEY=your-voyage-key
VOYAGE_EMBEDDING_MODEL=voyage-code-3
VOYAGE_RERANK_MODEL=rerank-2.5
DEEPSEEK_API_KEY=your-deepseek-key
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_THINKING=disabled
```

Use `bun run dev` or `bun run start` from the repository root. Both launchers bind the web server to localhost and set an internal loopback marker. Do not manually set that marker or enable this unauthenticated fixture endpoint on a public server. Hosted AI requires authenticated tenant access and durable usage controls first.

In the workspace, select **AI answer with Voyage + DeepSeek**, review the disclosure and approve it for the current question. Editing the question or changing snapshots clears approval; submission consumes it. Missing keys, disabled enablement, invalid models, timeouts, rate limits and invalid generated evidence return errors. There is no automatic retry, model substitution, alternate provider or extractive answer fallback.

## Data flow

1. Validate the public catalog snapshot and explicit disclosure approval before source access or network calls.
2. Reject unsupported versions/runtime guarantees without a model call.
3. Send bounded original source passages to Voyage as documents, and the question as a query. Vectors have 1024 dimensions and are held only for this request.
4. Rank by vector similarity and use Voyage reranking on at most 16 candidates.
5. Send DeepSeek at most 8 canonical source passages and the question. Validate its structured claims and citation IDs; resolve each citation to original immutable source ranges.

A successful request normally makes four provider calls: document embeddings, query embeddings, reranking and generation. Usage is billable according to the configured provider accounts. This integration does not claim a monetary budget cap. No private repositories, external purchased provider context, secrets or wallet material enter this path. Generated text is displayed as escaped text. Citation validation verifies source identity, not semantic truth.

Supported generation models are `deepseek-flash` and `deepseek-v4-pro`; `DEEPSEEK_THINKING=enabled` uses DeepSeek reasoning. Supported embedding and rerank model allowlists are in `packages/core/src/ai/providers.ts`; unsupported values fail before requests. Endpoints are fixed to `api.voyageai.com` and `api.deepseek.com`; redirects are rejected. No endpoint override is exposed to the browser or environment.

## Verification

`bun run verify:ai` checks runtime source, manifests, lockfile, Supabase configuration and local environment variable names without printing secret values. `tests/ai` covers provider transport and the complete answer pipeline with mocked HTTP. Browser AI tests mock the answer transport to check consent, citation navigation and failure handling. These tests do not establish live account access or billing outcomes.

With the user's separate US$1 approval, one real public-fixture workflow passed on 2026-10-07: document/query embeddings, reranking and generation returned successfully with eight validated original-source citations. Estimated usage cost was US$0.00068157; this is an estimate, not an account billing statement. Evidence: `docs/evidence/ai-live.json`. Private RepoFair source was not sent to AI. The application remains disabled by default; this bounded verification does not authorize ongoing private-source disclosure or establish general answer quality.

Development-agent settings and historical build evidence describe the tools used to develop Atlas. They do not select application models, bundle SDKs or authorize runtime calls.

## Official interfaces verified 2026-10-07

- [Voyage embeddings](https://docs.voyageai.com/reference/embeddings-api): POST `https://api.voyageai.com/v1/embeddings`, document/query input types, explicit model, float output and no silent truncation.
- [Voyage reranking](https://docs.voyageai.com/reference/reranker-api): POST `https://api.voyageai.com/v1/rerank`, explicit model and index-based results.
- [DeepSeek chat completions](https://api-docs.deepseek.com/api/create-chat-completion/): POST `https://api.deepseek.com/chat/completions`, JSON object output, non-streaming final answer and explicit thinking setting.
- [DeepSeek supported models](https://api-docs.deepseek.com/quick_start/pricing/): current model names verified independently of account access.
