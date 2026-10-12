import type { Capabilities } from '../../contracts/src/index.ts';
/** Fail closed regardless of the presence of environment variables. */
export function starterCapabilities(): Capabilities {
  return {
    product: 'RepoFair', stage: 'starter', mode: 'fixture', livePayments: false,
    capabilities: {
      'domain-helpers': 'available', 'original-fixture-source': 'available',
      'github-import': 'not-implemented', 'source-graph-parser': 'not-implemented',
      'graph-grounded-generation': 'not-implemented', 'clerk-supabase-auth': 'not-implemented',
      'provider-publishing': 'not-implemented', 'tempo-settlement': 'disabled',
      'federated-investigation': 'not-implemented', 'mcp': 'not-implemented',
    },
    limitations: ['Development starter, not the completed product.', 'Domain helpers are not a payment verifier or authorization service.'],
  };
}
/** Implemented interfaces; protected routes still verify configured identity and access per request. */
export function applicationCapabilities(): Capabilities {
  const starter = starterCapabilities();
  return { ...starter, stage: 'application', mode: 'tempo-testnet', capabilities: { ...starter.capabilities,
    'source-graph-parser': 'available', 'extractive-questions': 'available',
    'graph-grounded-generation': 'disabled', 'clerk-session': 'available',
    'github-import': 'available', 'clerk-supabase-auth': 'available', 'private-repository-source': 'available',
    'provider-publishing': 'available', 'tempo-testnet-purchases': 'available', 'tempo-settlement': 'unverified',
    'authenticated-sdk': 'available', 'mcp': 'available', 'federated-investigation': 'available',
    'fixture-provider-http': 'disabled', 'fixture-federation': 'disabled', 'fixture-mcp-stdio': 'disabled',
  }, limitations: ['Private GitHub routes require a verified session, linked GitHub authorization and workspace membership. Imports advance in bounded requests while the repository workspace is open, or through an optional persistent worker.',
    'Only Tempo Moderato testnet chain 42431 and PathUSD are supported. Mainnet and real-money payments are unavailable. Paid delivery requires an independently configured active provider.',
    'Extractive source retrieval is available without a generation model.',
    'Personal workspaces and bounded Git imports are implemented. Organization synchronization and private generative AI remain unsupported.',
    'Capability availability describes implementation, not the health or credentials of a particular deployment.'] };
}
