import type { Capabilities } from '../../contracts/src/index.ts';
/** Fail closed regardless of the presence of environment variables. */
export function starterCapabilities(): Capabilities {
  return {
    product: 'Chronos Atlas', stage: 'starter', mode: 'fixture', livePayments: false,
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
  return { ...starter, stage: 'local-fixture', capabilities: { ...starter.capabilities,
    'source-graph-parser': 'available', 'extractive-questions': 'available',
    'graph-grounded-generation': 'disabled', 'clerk-session': 'available',
    'github-import': 'available', 'clerk-supabase-auth': 'available', 'private-repository-source': 'available',
    'fixture-provider-http': 'available', 'fixture-federation': 'available', 'fixture-mcp-stdio': 'available',
  }, limitations: ['Fixture APIs accept public catalog IDs. Private GitHub routes require a verified session, linked GitHub authorization, workspace membership and a running worker.',
    'Voyage/DeepSeek generation is implemented and requires explicit local enablement and disclosure approval. Payments remain disabled.',
    'Extractive source retrieval is available without a generation model.',
    'Personal workspace and bounded Git imports are implemented; organizations, verified publishing, private AI and paid agent transport remain incomplete.',
    'Capability availability describes implementation, not the health or credentials of a particular deployment.'] };
}
