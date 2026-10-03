import type { LocalIndex, LocalAnswer, ParsedEdge } from './local.ts';
import type { GraphNode, SourceEvidence } from './index.ts';
export type FixtureProviderId = 'fixture-retry' | 'fixture-events';
export type FixtureProviderInfo = Readonly<{
  providerId: FixtureProviderId; endpoint: string; packageName: string;
  versions: readonly string[]; published: boolean; mode: 'fixture';
  payment: 'disabled'; recipient: null; price: null;
}>;
export type FixtureProviderResult = Readonly<{
  schemaVersion: 1; mode: 'fixture'; providerId: FixtureProviderId;
  payment: 'not-attempted'; index: LocalIndex; answer: LocalAnswer;
}>;
export type FederationResult = Readonly<{
  schemaVersion: 1; mode: 'fixture'; local: LocalIndex;
  providers: readonly FixtureProviderResult[]; nodes: readonly GraphNode[];
  edges: readonly ParsedEdge[]; citations: readonly SourceEvidence[];
  limitations: readonly string[]; payment: 'not-attempted';
}>;
/** Explicit development allowlist: user/model input cannot broaden destinations. */
export const FIXTURE_PROVIDERS: readonly FixtureProviderInfo[] = [
  { providerId: 'fixture-retry', endpoint: 'http://127.0.0.1:4311', packageName: '@atlas-fixture/retry-kit', versions: ['1.0.0','2.0.0'], published: false, mode: 'fixture', payment: 'disabled', recipient: null, price: null },
  { providerId: 'fixture-events', endpoint: 'http://127.0.0.1:4312', packageName: '@atlas-fixture/event-log', versions: ['1.0.0'], published: false, mode: 'fixture', payment: 'disabled', recipient: null, price: null },
];
