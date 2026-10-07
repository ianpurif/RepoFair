/** Private administrative proposals. These contracts never authorize a sale. */
export type PublicationAccessPolicy = 'private' | 'authenticated' | 'public';
export type PublicationTestnetTerms = Readonly<{
  network: 'eip155:42431'; operation: 'context.retrieve'; token: string; recipient: string; atomicPrice: string;
}>;
export type PublicationProposal = Readonly<{
  packageName: string; version: string; exports: Readonly<Record<string, string>>;
  exposedPaths: readonly string[]; rightsStatement: string; accessPolicy: PublicationAccessPolicy;
  proposedEndpoint: string | null; testnetTerms: PublicationTestnetTerms | null;
}>;
export type PublicationPreview = Readonly<{
  snapshotId: string; commitSha: string; files: readonly Readonly<{ path: string; lines: number; bytes: number; sourceDigest: string }>[];
  fileCount: number; totalBytes: number;
}>;
export type PublicationDraft = Readonly<{
  schemaVersion: 1; id: string; workspaceId: string; repositoryId: string; snapshotId: string; commitSha: string;
  revision: number; termsDigest: string; state: 'draft' | 'revoked'; proposal: PublicationProposal; preview: PublicationPreview;
  published: false; approval: null; endpointProof: 'unverified'; payment: 'disabled';
  administration: Readonly<{ status: 'verified'; basis: 'personal-owner' | 'repository-admin'; checkedAt: string }>;
  rights: 'declared' | 'not-declared'; accuracy: 'unverified';
  createdAt: string; updatedAt: string;
}>;
