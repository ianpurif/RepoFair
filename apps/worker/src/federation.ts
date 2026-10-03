import { FIXTURE_PROVIDERS, parseFixtureId, parseQuestion } from '@atlas/contracts';
import type { FixtureId, FixtureProviderResult, FederationResult, ParsedEdge } from '@atlas/contracts';
import { validateLocalIndex } from '@atlas/core/local';
import { indexFixture } from './fixture-service.ts';

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty provider response');
  const parts: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) { await reader.cancel(); throw new Error('Provider response exceeds bounds'); } parts.push(value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
}
export async function discoverFixtureProviders() {
  return Promise.all(FIXTURE_PROVIDERS.map(async provider => {
    try { const response = await fetch(`${provider.endpoint}/.well-known/atlas-provider.json`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
      const data = await boundedJson(response) as Record<string, unknown>;
      return { ...provider, published: response.ok && data.providerId === provider.providerId && data.mode === 'fixture' && data.published === true };
    } catch { return { ...provider, published: false }; }
  }));
}
/** Approvals name only registered public fixtures. Local question/source is never forwarded. */
export async function federateFixture(fixtureId: FixtureId, approvedIds: readonly string[], externalQuestion: string): Promise<FederationResult> {
  if ((process.env.ATLAS_MODE ?? 'fixture') !== 'fixture') throw new Error('Fixture federation disabled');
  if (!Array.isArray(approvedIds) || approvedIds.length < 1 || approvedIds.length > 2 || new Set(approvedIds).size !== approvedIds.length
    || approvedIds.some(id => !FIXTURE_PROVIDERS.some(p => p.providerId === id))) throw new Error('Approve one or two registered providers');
  const question = parseQuestion(externalQuestion); const local = await indexFixture(parseFixtureId(fixtureId));
  const providers: FixtureProviderResult[] = []; const joins: ParsedEdge[] = [];
  for (const id of approvedIds) {
    const config = FIXTURE_PROVIDERS.find(p => p.providerId === id)!;
    const bindings = local.dependencies.filter(d => d.packageName === config.packageName && d.status === 'exact');
    const versions = [...new Set(bindings.map(d => d.version))];
    if (versions.length !== 1 || !versions[0] || !config.versions.includes(versions[0])) throw new Error('No matching exact dependency version');
    const version = versions[0];
    const response = await fetch(`${config.endpoint}/context/retrieve`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageName: config.packageName, version, question }), redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Provider unavailable; no payment attempted');
    const data = await boundedJson(response) as FixtureProviderResult;
    if (data.schemaVersion !== 1 || data.mode !== 'fixture' || data.providerId !== config.providerId || data.payment !== 'not-attempted') throw new Error('Provider identity mismatch');
    validateLocalIndex(data.index);
    if (data.index.packageName !== config.packageName || data.index.version !== version) throw new Error('Provider version mismatch');
    // Independent fixture source verification. A paid production provider would
    // retain provider-reported status until its source was independently checked.
    const expected = await indexFixture(parseFixtureId(`${id === 'fixture-retry' ? 'retry-kit' : 'event-log'}@${version}`));
    if (data.index.snapshot.revision !== expected.snapshot.revision || JSON.stringify(data.index.files) !== JSON.stringify(expected.files)
      || JSON.stringify(data.index.nodes) !== JSON.stringify(expected.nodes) || JSON.stringify(data.index.edges) !== JSON.stringify(expected.edges)) throw new Error('Provider source or graph mismatch');
    if (!data.answer || data.answer.mode !== 'extractive' || !Array.isArray(data.answer.citations)) throw new Error('Invalid provider answer');
    for (const citation of data.answer.citations) {
      const actual = data.index.evidence.find(e => e.id === citation.id);
      if (!actual || actual.original !== citation.original || JSON.stringify(actual.source) !== JSON.stringify(citation.source)) throw new Error('Invalid provider citation');
    }
    const boundary = local.nodes.find(n => n.localId === `package:${config.packageName}@${version}`);
    const target = data.index.nodes.find(n => n.localId === `package:${config.packageName}@${version}`);
    const exportEdge = data.index.edges.find(e => e.from === target?.id && e.extractionMethod === 'explicit-release-export');
    if (!boundary || !target || !exportEdge) throw new Error('Explicit package export mapping unavailable');
    joins.push({ id: JSON.stringify(['fixture-join', boundary.id, target.id]), from: boundary.id, to: target.id, relation: 'package-binding', provenance: 'parsed-source', extractionMethod: 'explicit-release-export', evidenceId: exportEdge.evidenceId });
    providers.push(data);
  }
  return { schemaVersion: 1, mode: 'fixture', local, providers, nodes: [...local.nodes, ...providers.flatMap(p => p.index.nodes)],
    edges: [...local.edges, ...providers.flatMap(p => p.index.edges), ...joins],
    citations: providers.flatMap(p => p.answer.citations.map(e => ({ ...e, providerId: p.providerId }))),
    limitations: ['Real HTTP requests to independent local fixture processes; external integration and purchases are simulated.', 'No payment attempted, no receipt or configured recipient.', 'Package joins use exact lockfile version and explicit package exports; symbol-level cross-repository calls remain unresolved.', 'Static graph relationships indicate potential impact, not confirmed breakage.'], payment: 'not-attempted' };
}
