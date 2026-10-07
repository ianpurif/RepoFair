/** Public domain contracts. Runtime service integration is milestone work. */
export * from './local.ts';
export * from './federation.ts';
export * from './publication.ts';
export type Mode = 'fixture' | 'tempo-testnet' | 'live';
export type EvidenceState = 'sufficient' | 'insufficient' | 'unknown';
export type AnswerStatus = 'evidence_ready' | 'answered' | 'clarification_needed' | 'abstained' | 'unavailable' | 'denied';
export type Scope = Readonly<{ tenantId: string; principalId: string; permissionRevision: string }>;
export type Snapshot = Readonly<{ repositoryId: string; snapshotId: string; kind: 'git' | 'fixture'; revision: string }>;
export type SourceLocator = Snapshot & Readonly<{ path: string; startLine: number; endLine: number }>;
export type SourceEvidence = Readonly<{
  id: string; scope: Scope; source: SourceLocator; original: string;
  providerId: string | null; observedAt: string;
  provenance: 'parsed-source' | 'provider-reported';
}>;
export type GraphNode = Readonly<{
  id: string; repositoryId: string; snapshotId: string; localId: string;
  kind: 'file' | 'symbol' | 'package'; label: string;
}>;
export type GraphEdge = Readonly<{
  id: string; from: string; to: string;
  relation: 'imports' | 'exports' | 'references' | 'resolved-call' | 'package-binding';
  provenance: 'parsed-source' | 'provider-reported'; evidenceId: string;
}>;
export type ReleaseMapping = Readonly<{
  packageName: string; version: string; repositoryId: string; snapshotId: string;
  exports: Readonly<Record<string, string>>;
}>;
export type ContextBundle = Readonly<{
  schemaVersion: 1; providerId: string; packageName: string; version: string;
  evidenceState: EvidenceState; evidence: readonly SourceEvidence[];
  nodes: readonly GraphNode[]; edges: readonly GraphEdge[]; limitations: readonly string[];
}>;
export type PaymentState = 'draft' | 'approved' | 'reserved' | 'pending' | 'unknown' | 'settled' | 'failed' | 'expired';
export type DeliveryState = 'not-started' | 'awaiting-payment' | 'running' | 'ready' | 'failed' | 'revoked';
export type CapabilityState = 'available' | 'not-implemented' | 'unverified' | 'disabled';
export type Capabilities = Readonly<{
  product: 'Chronos Atlas'; stage: 'starter' | 'local-fixture'; mode: 'fixture';
  capabilities: Readonly<Record<string, CapabilityState>>;
  livePayments: false; limitations: readonly string[];
}>;
export type ProviderManifest = Readonly<{
  schemaVersion: 1; providerId: string; endpoint: string; releases: readonly ReleaseMapping[];
  operation: 'context.retrieve'; network: string | null; token: string | null;
  recipient: string | null; atomicPrice: string | null;
  published: boolean; rightsStatement: string;
}>;
export type PurchaseTerms = Readonly<{
  providerId: string; operation: 'context.retrieve'; requestDigest: string;
  packageName: string; version: string; network: string; token: string;
  recipient: string; atomicAmount: string; expiresAtMs: number;
}>;
