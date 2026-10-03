# P1 interface lease — schema 1

2026-10-03: Architecture review accepted. Shared types live in
`packages/contracts/src/local.ts`; lead owns changes.

Engineer owns `packages/core/src/local/` (pure parser/retrieval),
`apps/worker/src/fixture-service.ts` (bounded trusted fixture I/O), and
`tests/local/`. No imported code or configuration is executed. Use in-memory
ts-morph source files, with no filesystem dependency resolution. Fixture file
links are resolved through catalog metadata only. All edge evidence is checked.

Worker exports async `indexFixture(id: FixtureId): Promise<LocalIndex>`.
Core exports `answerLocal(index: LocalIndex, question: string): LocalAnswer` and
`lookupSource(index: LocalIndex, path: string, startLine: number, endLine: number): SourceEvidence`.
Keep these exports at `packages/core/src/local/index.ts`; lead adds package exports.
The worker accepts only catalog fixture identifiers; no caller tenant or path.

Frontend owns web UI under `apps/web/src/`, excluding `app/api/`, with
GET `/api/fixtures?id=<FixtureId>` -> LocalIndex;
POST `/api/questions` `{fixtureId,question}` -> LocalAnswer;
GET `/api/source?fixtureId=...&path=...&startLine=...&endLine=...` -> SourceEvidence.
Errors use `{error:string}` and appropriate HTTP status. No private imports.
Lead implements these route handlers and owns dependency manifests.

The first slice is explicitly fixture/extractive. No generation model call,
authentication claim, payment claim or production authorization bypass is allowed.
All broader integrations remain visible as unavailable until separately tested.
