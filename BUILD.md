# Build Chronos Atlas from the Ground Up

You are Codex acting as the lead engineer, product designer, and implementation coordinator.

Build **Chronos Atlas** from the ground up in the current directory. This is an implementation task—not a request for another proposal, a static mockup, or a boilerplate that stops before the core functionality works.

Inspect the directory before making changes. This distribution contains an intentional starter scaffold. Preserve useful files and user changes; complete its missing functionality rather than erasing it.

This file contains the complete product build prompt from the conversation, with the requested Astra-medium/Sol-extra-high agent configuration and starter-entry clarifications. Current account access and integrations must be checked locally. Sources are listed in `docs/SOURCES.md`; legacy product concepts are not active requirements.

## 1. Product Definition

**Chronos Atlas turns repositories into interactive codebase maps and lets authorized repository owners publish their code intelligence as services that coding agents can purchase through Tempo.**

Humans explore the map. Agents retrieve structured, source-backed context. Independent providers receive payment for operating their knowledge services.

### Core experience

A developer connects an ordinary TypeScript repository, explores its architecture, and asks questions about its code.

When a question requires knowledge about an external dependency, Atlas can discover an opted-in provider, obtain the developer's approval, purchase the relevant version-specific context, and expand the map with the returned evidence.

### Product positioning

> **Map your code. Connect the knowledge.**

### Critical boundaries

This is a **general codebase-intelligence product**. Repositories do not need blockchain code.

Do not turn it into:

- A Tempo payment-security scanner.
- A transaction-debugging application.
- A repair marketplace or autonomous coding agent.
- A generic document-chat interface with a crypto checkout.
- A token project, speculative marketplace, or Solana application.

Tempo belongs in the product because agents purchase services from independent providers—not because Atlas analyzes payment functions.

The paid service is maintained indexing, retrieval, and contextualization. Do not imply that public source code becomes proprietary or that paying automatically grants access to private source.

## 2. Codex Working Instructions

Work through **research → architecture → implementation → testing → review → refinement**.

Do not stop after producing a plan. Continue through the implementation milestones without repeatedly requesting approval for ordinary, reversible engineering decisions.

Ask only when a required credential, spending authorization, destructive operation, or genuinely unresolved product decision blocks progress. Continue all independent work while that item is blocked.

### Agent coordination

Use the following exact requested models and effort levels:

| Role | Model | Reasoning | Responsibility |
|---|---|---|---|
| Primary coordinator | `gpt-6-astra` | `medium` | Own architecture, integration, progress, and final acceptance. |
| `atlas_architect` | `gpt-6-astra` | `medium` | Read-only architecture, scope, and milestone review. |
| `atlas_researcher` | `gpt-6-astra` | `medium` | Read-only verification of official APIs and compatibility. |
| `atlas_security` | `gpt-6-astra` | `medium` | Read-only authorization, payment, and data-boundary review. |
| `atlas_engineer` | `gpt-6.1-sol` | `xhigh` | Indexing, graph retrieval, providers, data, payments, and SDK. |
| `atlas_frontend` | `gpt-6.1-sol` | `xhigh` | Workspace, graph interactions, publishing, accessibility. |
| `atlas_verifier` | `gpt-6.1-sol` | `xhigh` | Independent automated and browser verification. |

`xhigh` is the configuration token for the user's **Extra high** request. Do not replace it with `high`, `extrahigh`, `max`, or a different model.

Verify the selected models are available in the installed client/account. Use actual Codex subagents where supported, with at most two concurrent subagents and non-overlapping file ownership. Standalone TOML custom-agent files are supplied in `.codex/agents/`; verify installed-client compatibility before relying on them. Do not claim delegation occurred when it did not.

If the requested model or multi-agent feature is unavailable, report that exact blocker. Do not simulate the missing role or silently substitute another model. Active UI/session or administrator settings may override a requested project setting; reading this prompt does not change the current model. The optional project launcher makes the lead model/effort explicit.

Keep the application's runtime model configuration separate from the models used to develop it. Application AI uses Voyage AI for embeddings/retrieval and DeepSeek for all LLM responses, reasoning and generation. No other model provider, SDK, endpoint or fallback is permitted in the application.

Create and maintain:

- `AGENTS.md`: project rules, architecture boundaries, and verification commands.
- `docs/PLAN.md`: milestones, dependencies, and acceptance criteria.
- `docs/PROGRESS.md`: completed, partial, blocked, and next actions.
- `docs/DECISIONS.md`: consequential decisions and rejected alternatives.

Use project-local configuration. Do not modify global Codex settings, global Git identity, or unrelated machine configuration.

## 3. Verify Integrations Before Depending on Them

Research the current official documentation for the chosen frameworks and integrations before installing packages or implementing their APIs.

Prioritize:

- Voyage AI embeddings/reranking and DeepSeek generation API documentation.
- Codex configuration documentation applies only to development tooling.
- Next.js, TypeScript, ts-morph, and React Flow.
- Clerk and Supabase's current authentication integration.
- GitHub Apps, repository permissions, and webhook verification.
- Tempo and MPP, including `mppx`, one-time charges, receipts, discovery, and MCP transport.

Record verified package versions, relevant documentation URLs, access dates, and unresolved assumptions in `docs/INTEGRATIONS.md`.

Do not copy undocumented APIs from earlier discussion. Do not invent SDK methods, payment-token addresses, network identifiers, or model capabilities.

Recheck the Crypto World's Fair official rules and exact submission cutoff. The planning date from the product conversation is **October 12, 2026**; do not treat that as permanently current or assign nonexistent remaining days. Organize the build around a complete core workflow before optional features and target readiness one day before the verified cutoff. If the cutoff has passed when this starter is opened, continue building without inventing hackathon eligibility.

Avoid hardcoded prize claims or promises of winning in the product.

## 4. Technology and Project Structure

Use this stack unless a verified incompatibility requires a documented adjustment:

| Area | Choice |
|---|---|
| Web application | Next.js App Router, TypeScript |
| Styling | Tailwind CSS, shadcn/ui |
| Feedback and icons | Sonner, Lucide |
| Graph interface | React Flow with an appropriate layout engine |
| Source analysis | ts-morph |
| Authentication and organizations | Clerk |
| Database and storage | Supabase PostgreSQL, Storage, and pgvector where useful |
| Background work | A separate TypeScript worker with a PostgreSQL-backed queue |
| Payments | MPP through `mppx`, settling on Tempo |
| Agent interface | TypeScript SDK and an actual MCP integration |
| Testing | Vitest, integration tests, Playwright |
| Optional observability | LangSmith, disabled unless configured |

Use Bun for workspace/package management and a compatible Node.js runtime for services. Pin versions and generate a real lockfile. The supplied dependency-free Node tests protect the starter foundations; retain their coverage while adding the requested product test stack.

Keep the structure small:

```text
apps/
  web/
  worker/
  provider/
packages/
  contracts/
  core/
  sdk/
fixtures/
supabase/
docs/
```

The provider application must be runnable independently. Do not create numerous packages or microservices without a clear need.

Use Clerk's current supported Supabase third-party authentication integration with appropriate row-level security—not the deprecated shared-secret JWT-template approach. Verify the current procedure before writing policies.

Default development URL: **http://localhost:3000**. Do not silently launch duplicate application servers when the port is occupied.

## 5. User Experience and Visual Design

Build a minimalist developer tool with a restrained visual identity.

The main workspace—not the landing page—is the product.

### Visual direction

Use a neutral palette, one restrained accent, readable typography, subtle borders, and consistent spacing. Support light and dark themes.

Avoid oversized gradients, decorative dashboards, fake terminal animations, constant motion, excessive glass effects, and cryptocurrency-trading aesthetics.

Use motion only to communicate a real transition: indexing progress, graph expansion, selected evidence, or a completed operation.

### Main workspace

Create a resizable three-panel layout:

**Repository explorer → graph canvas → source and evidence inspector**

Include a compact question composer, repository/version selector, graph search, and activity indicator.

The graph should initially show modules or folders, not thousands of nodes. Expand progressively. Keep layouts stable when external evidence arrives.

Selecting a file highlights its direct relationships and opens the source. Selecting a citation opens its exact line range. Selecting a provider-owned node shows the provider, repository, version, source, and access status.

Provide keyboard navigation, visible focus, accessible contrast, reduced-motion behavior, and a list-based alternative to navigating the graph.

Use Sonner for brief feedback. Long-running jobs belong in a compact status indicator with a persistent history view—not a succession of toasts.

### Pages

Implement:

```text
/
/sign-in
/app
/app/repositories/[id]
/app/providers
/app/providers/[id]
/app/publish
/app/activity
/app/settings
/demo
```

Keep onboarding short. Use Google sign-in through Clerk, create a personal workspace automatically, and support organization membership. Connecting GitHub is a separate authorization step.

Never render a button as functional when its integration is unavailable. Explain the missing setup inline.

## 6. Repository Ingestion and Code Graph

### Import flow

Support a public GitHub repository URL and authorized private repositories through a read-only GitHub App.

Resolve each import to an immutable commit. Display the branch or tag separately from the resolved commit.

Index supported TypeScript and JavaScript source, relevant configuration, package metadata, and one explicitly documented lockfile format initially.

Do not execute imported repositories. Do not run their package scripts, install dependencies, load plugins, initialize submodules, or trust repository configuration as executable instructions.

Exclude secrets, dependency directories, generated files, binaries, oversized files, and ignored paths. Bound total files, bytes, parser time, and memory.

### Graph extraction

Use ts-morph for supported source relationships. Its import APIs are a foundation for extraction—not proof of complete runtime behavior.

Represent:

- Files, modules, symbols, packages, and repository snapshots.
- Imports, exports, references, and statically resolved calls.
- External dependencies and unresolved references.
- Cross-repository links backed by explicit version and export mappings.

Every edge needs an origin and extraction method. Separate parsed relationships from provider assertions and model-generated interpretations.

Handle aliases and re-exports within the declared support boundary. Mark unsupported or ambiguous resolution as unresolved.

Never advertise **“exactly what breaks.”** Use **“potentially affected”** unless independent execution evidence establishes a narrower result. This MVP does not execute application code.

### Version correctness

Do not treat a dependency range as the installed version.

Cross-repository resolution requires an exact supported version and an explicit mapping to a provider snapshot. Never silently substitute the latest release.

Indexing should be resumable, idempotent, and visible through honest job states. Re-index into a new snapshot; do not mutate evidence belonging to an older commit.

## 7. Graph-Grounded RAG

Implement actual retrieval over indexed source and graph relationships.

The normal flow is:

**Authorize → identify files/symbols → retrieve source → expand relevant graph neighborhood → identify missing evidence → optionally consult providers → generate a cited answer.**

Use exact search for symbols and paths, lexical retrieval for precise terms, and semantic retrieval when useful. Bound candidates, graph depth, context size, and model calls.

Do not require embeddings before basic navigation and source search work.

### Answer requirements

Return:

- An answer or explicit limitation.
- Commit-specific source citations.
- Relevant graph nodes and edges.
- Source/provider versions.
- Missing evidence and unresolved relationships.
- Actual usage and purchase records.

Treat summaries as navigation aids. Cite original source, not a generated summary.

Preserve provenance, authorization scope, freshness, conflicts, and explicit insufficient/unknown outcomes. These retain the original ChronosRAG evidence-contract principles without importing its superseded product scope.

Validate that cited identifiers and line ranges exist and were authorized for that request. Do not claim this structural validation proves semantic correctness.

Allow one targeted repair round for missing evidence. Avoid unbounded research loops.

The activity view must show real tool calls, sources retrieved, graph expansion, timings, and purchases. Do not fabricate an agent's reasoning narrative.

Without a configured generation model, source search and graph exploration must remain usable. Label extractive results honestly; do not pretend they are live AI answers.

## 8. Publish a Code-Intelligence Service

Implement a short publishing flow for authorized repository owners or administrators.

The publisher selects the repository snapshot, package identity, supported release mappings, exposed paths, access policy, fixed request price, and Tempo recipient.

Show an exposure preview before publication. Private repositories must never become public by default.

GitHub read access is not sufficient to claim ownership or publish on behalf of a project. Verify the relevant administrative permission. For external provider registration, also verify endpoint control.

Keep these claims distinct:

**Endpoint control · Repository administration · Declared content rights · Data accuracy**

Do not turn one verification into a blanket “trusted provider” badge.

### Provider manifest

Define a versioned Atlas manifest containing:

- Provider identity and endpoint.
- Repository/package identity.
- Supported release-to-commit mappings.
- Available tools and response schema version.
- Price, currency, network, recipient, and validity information.
- Access rules, licensing/attribution information, and service limits.

Label this an **Atlas manifest**, not an invented industry standard. Use documented MPP discovery separately where supported.

Metadata must not expose private paths, symbols, or repository existence to unauthorized users.

### Provider runtime

The standalone provider service must maintain its own configuration, authorization, index access, and payment recipient.

Implement one paid operation first: **retrieve a bounded context bundle for a specified package version and question**.

Return source passages, citations, and a limited subgraph. Do not charge separately for each edge traversed.

Support unpublishing and access revocation. Stop new access and invalidate relevant server-side reuse, while acknowledging that already delivered content cannot be remotely erased from a buyer's device.

## 9. Federated Investigation

This is the signature workflow.

A user asks a question about their application. Atlas investigates locally first.

When the graph reaches an external dependency, consult only approved provider registrations matching the package and exact version.

Present the relevant providers and proposed purchases before execution. The user may approve selected calls or a narrowly scoped spending policy.

Send only the external question and necessary public identifiers. Do not forward the buyer's private source, full prompt, or previous provider responses without explicit authorization.

After delivery:

1. Validate response structure, provider identity, version, source locators, and limits.
2. Preserve provider provenance and verification status.
3. Merge the authorized subgraph using repository-and-snapshot-scoped identifiers.
4. Create cross-repository edges only when the import/export mapping supports them.
5. Generate the final answer from the combined evidence.

Never join unrelated symbols merely because their names match.

Payment is not evidence that a provider's statements are true. Distinguish provider-reported information from independently checked source relationships.

Keep the MVP bounded to two external providers per investigation. Stop when evidence is sufficient; do not purchase merely to make the demo more impressive.

## 10. Tempo Payments

Use actual MPP one-time payments for provider requests. Implement against verified official APIs rather than inventing a payment protocol.

Start with direct settlement to each provider's configured recipient.

A platform fee may use the documented split-payment mechanism after the core flow works. Make the fee explicit. Defer it rather than introducing an unverified payment path.

### Payment flow

**Validate request/access/version → receive payment terms → approve and reserve budget → submit payment credential → verify settlement → deliver context → record receipt and outcome.**

Unsupported versions and unauthorized requests should be rejected before requesting payment.

Use the official SDK for protocol verification. Do not treat a supplied transaction hash as proof of payment.

Bind each purchase to the approved provider, operation, request content, version, amount, token, network, recipient, expiry, and idempotency identifier.

### Spending controls

Enforce limits in deterministic code outside the model.

Use integer token units, not floating-point currency arithmetic. Reserve spending atomically before parallel calls.

Track external-service spending separately from generation cost, indexing expense, platform fees, and transaction fees. A provider-budget limit is not automatically an all-inclusive operating-cost cap.

Unknown cost is unknown—not zero.

### Reliability

Persist purchases and deliveries durably.

Handle duplicate requests, refreshes, timeouts, worker crashes, expired offers, and uncertain settlement without blindly charging again.

A successful payment followed by failed delivery must remain visible and recoverable. Resume delivery for the same authorized purchase rather than requiring another payment.

Do not promise exactly-once charging across arbitrary providers, automatic refunds, or payment conditional on answer correctness.

### Wallet boundaries

Use an approved user-controlled signing integration for the browser. The headless SDK accepts a caller-provided signer.

Keep keys out of the database, client bundles, logs, prompts, and repository. Development test signers are explicitly local/testnet-only.

Default to testnet. Mainnet execution requires explicit user authorization, a reviewed spending limit, and verified configuration. Do not spend real funds merely to complete development.

## 11. Security, Authorization, and Caching

Tenant isolation is a release requirement.

Enforce authorization consistently across repository reads, graph queries, search, storage, provider responses, exports, histories, and traces.

Apply verified Clerk identity and organization scope through database policies and server checks. Workers using privileged credentials must receive constrained, validated job scope—not arbitrary client-supplied tenant identifiers.

Treat source files, comments, provider responses, metadata, and model outputs as untrusted input.

Protect against:

- Cross-tenant access and cached-data leaks.
- SSRF through provider and repository URLs.
- Path traversal, symlink escape, malicious archives, and oversized responses.
- Prompt injection that requests wider permissions or spending.
- Forged manifests, changed payment recipients, and replayed credentials.

Production provider endpoints must use HTTPS and pass destination checks. Permit local fixture endpoints only through an explicit development allowlist.

Cache reuse requires matching authorization, provider entitlement, query, dependency version, snapshot, and relevant policy revision. Recheck access before reuse.

Do not share purchased or private context across unrelated customers. Do not store raw private source or secrets on-chain.

## 12. Contracts and Agent Integration

Define shared schemas before connecting services.

Include contracts for repositories, snapshots, graph nodes/edges, source evidence, provider manifests, release mappings, investigation plans, quotes, budget reservations, purchases, deliveries, and citations.

Keep payment state separate from retrieval state.

For example, a purchase can be settled while delivery is unavailable; retrieval can succeed while the evidence remains insufficient for a complete answer.

Expose typed application operations for repository import, indexing status, graph exploration, source lookup, local questions, provider discovery, purchase approval, federated investigation, and purchase recovery.

Build an internal TypeScript SDK with usage examples and a genuine MCP server exposing the relevant capabilities.

Use the supported MCP SDK and MPP transport. Do not call an arbitrary JSON endpoint “MCP.”

Do not publish packages to npm or publicly expose services without authorization.

## 13. Demonstration and Development Modes

Create three original fixture repositories:

**One ordinary application and two small dependencies**, with a relevant behavior difference between two versions of one dependency.

Use a concrete question such as:

> “How does this application retry failed jobs, and what could be affected by changing that behavior?”

The fixture relationships must exist in actual source. Derive the graph with the production parser.

### Required demonstration

Import the application, ask the question, identify the two relevant dependencies, obtain approved context from two provider endpoints, and expand the graph with clickable evidence.

Then change one dependency version. Mark previous evidence as inapplicable and retrieve the matching version—or report that it is unavailable.

Do not precompute the final answer or hardcode the graph animation.

### Independent providers

Run two separately configured provider instances with different identities, endpoints, and recipient accounts.

Do not simulate independence by drawing two provider cards over one hidden internal retrieval call.

Fixture providers are demonstration providers, not real customers or actual maintainers of unrelated projects.

### Honest modes

Provide:

**Fixture mode:** Local source analysis and clearly labeled simulated external integrations.

**Tempo testnet mode:** Real provider requests and real testnet payment receipts.

**Live mode:** Enabled only after explicit credentials, authorization, and acceptance checks.

Never generate fake transaction hashes, explorer links, revenue, customer activity, or settlement confirmations.

Missing external credentials must not block local development, but they must remain visible integration blockers.

## 14. Implementation Milestones

Complete one working vertical slice before expanding.

| Milestone | Acceptance gate |
|---|---|
| **P0 — Foundation** | Verified dependencies, project structure, environment validation, database migrations, fixture setup, build commands. |
| **P1 — Local intelligence** | Import a fixture, parse the real graph, inspect source, search, and answer with valid citations. |
| **P2 — Provider publishing** | Publish an authorized snapshot and retrieve version-matched context from a standalone provider. |
| **P3 — Tempo purchase** | Complete one real testnet purchase and recover safely from interrupted delivery. |
| **P4 — Federation** | Join one buyer repository with two provider subgraphs under approved limits. |
| **P5 — Product experience** | Complete authentication, publishing, graph interactions, SDK/MCP, responsive states, and activity history. |
| **P6 — Verification** | Security tests, browser checks, integration evidence, documentation, and demonstration script. |

Review progress after each milestone. Reduce optional scope before compromising source correctness, permissions, or payment safety.

Make at least ten meaningful commits across genuine implementation units when Git author identity is configured. Do not create empty commits, backdate history, or artificially split trivial edits.

Do not push, deploy publicly, or submit to the hackathon automatically.

## 15. Testing and Evaluation

Write tests alongside implementation.

Cover graph parsing, aliases, re-exports, unresolved references, dependency-version matching, source citations, and cross-repository joins.

Test provider authorization, private metadata exposure, malformed responses, stale versions, revocation, and unsupported packages.

Test spending reservations, concurrent requests, changed recipients, wrong networks/tokens, duplicate credentials, pending settlement, and interrupted delivery.

Verify tenant isolation for graph data, search, purchases, cached evidence, and exports. Security failures cannot be bypassed by switching production paths to mocks.

Use Playwright to verify the main workspace, graph selection, source navigation, provider publication, approval flow, version changes, empty/error states, and fixture-mode labeling.

Evaluate RAG using questions with reviewed supporting files and relationships. Include unanswerable questions and similar questions targeting different versions.

Compare graph-grounded retrieval against a competent keyword/vector baseline using the same source access. Report actual results and limitations; do not invent accuracy, latency, or cost improvements.

## 16. Completion Criteria and Deliverables

Provide working source, migrations, seed fixtures, standalone provider instructions, SDK examples, MCP setup, and environment documentation.

Include:

```text
README.md
.env.example
docs/ARCHITECTURE.md
docs/INTEGRATIONS.md
docs/SECURITY.md
docs/PROVIDER-PUBLISHING.md
docs/TEMPO.md
docs/TESTING.md
docs/DEMO.md
docs/DEPLOYMENT.md
docs/KNOWN-LIMITATIONS.md
docs/PROGRESS.md
```

The README must explain the product, local startup, provider deployment, supported repository formats, authorization model, and exact limitations.

Document a practical deployment path for the web application, worker, provider service, and database. Do not assume background indexing fits inside a short-lived web request.

Run linting, type checking, unit tests, integration tests, production build, and browser checks where the environment permits.

Clearly distinguish:

**Implemented and tested · Implemented but unverified · Blocked · Not implemented**

Do not call the application complete while provider purchases or cross-repository retrieval are still simulated. A complete local fixture experience and an unverified live integration are different deliverables.

At the end, report the startup commands, application URL, actual verification results, remaining credentials/setup, known limitations, and last completed milestone. Do not expose secrets.

**Begin now: inspect the directory, verify the critical integrations, create the implementation plan, and build the first end-to-end repository-map-and-evidence workflow. Continue through the remaining milestones rather than stopping at the scaffold.**
