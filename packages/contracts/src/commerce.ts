import type { ContextBundle, PaymentState, DeliveryState } from './index.ts';
import type { PublicationProposal, PublicationPreview } from './publication.ts';

export const MODERATO_NETWORK = 'eip155:42431' as const;
export const MODERATO_PATHUSD = '0x20c0000000000000000000000000000000000000' as const;
export type CatalogProvider = Readonly<{
  id: string; packageName: string; version: string; endpoint: string; realm: string;
  accessPolicy: 'private' | 'authenticated' | 'public'; network: typeof MODERATO_NETWORK;
  token: string; recipient: string; atomicPrice: string; tokenDecimals: 6;
  commitSha: string; snapshotId: string; publicationDigest: string; rightsStatement: string;
}>;
/** An explicitly selected immutable export. A provider installs this in its own database. */
export type PublicationArtifact = Readonly<{
  schemaVersion: 1; mode: 'tempo-testnet'; id: string; draftRevision: number; termsDigest: string;
  repositoryId: string; snapshotId: string; commitSha: string;
  proposal: PublicationProposal; preview: PublicationPreview;
  files: readonly Readonly<{ path: string; text: string; lineCount: number }>[];
  context: ContextBundle;
  sourceSignatures: Readonly<Record<string,string>>;
  graphSignatures: Readonly<{ nodes: Readonly<Record<string,string>>; edges: Readonly<Record<string,string>> }>;
}>;
export type SignedPublicationArtifact = Readonly<{ artifact: PublicationArtifact; signature: string }>;
export type ActivePublication = CatalogProvider & Readonly<{
  state: 'active' | 'revoked'; revision: number; activatedAt: string; updatedAt: string;
}>;
export type PurchaseRecord = Readonly<{
  id: string; providerId: string; packageName: string; version: string; network: typeof MODERATO_NETWORK;
  token: string; recipient: string; atomicAmount: string;
  paymentState: Exclude<PaymentState, 'draft' | 'approved'>;
  deliveryState: Exclude<DeliveryState, 'not-started'>;
  receiptReference: string | null; createdAt: string; updatedAt: string;
}>;
export type PurchaseBudget = Readonly<{
  network: typeof MODERATO_NETWORK; token: string; allowance: string; reserved: string; spent: string;
}>;
/** Short-lived audience-scoped delegation. This is never a Clerk session token. */
export type ProviderGrant = Readonly<{
  schemaVersion: 1; issuer: string; providerId: string; principalId: string; sessionId: string;
  workspaceId: string; permissionRevision: string; publicationDigest: string;
  packageName: string; version: string; requestDigest: string; idempotencyKey: string;
  expiresAtMs: number;
}>;
/** Issuer-signed activation probe; a nonce alone never authorizes private discovery. */
export type PublicationControlProof = Readonly<{
  schemaVersion: 1; purpose: 'activation-control'; publicationId: string; draftRevision: number;
  termsDigest: string; providerOrigin: string; nonce: string; expiresAtMs: number;
}>;
