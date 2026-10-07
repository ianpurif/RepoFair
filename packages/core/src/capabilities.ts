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
/** Locally implemented capabilities; no environment variable enables live access. */
export function applicationCapabilities(): Capabilities {
  const starter = starterCapabilities();
  return { ...starter, stage: 'local-fixture', capabilities: { ...starter.capabilities,
    'source-graph-parser': 'available', 'extractive-questions': 'available',
    'graph-grounded-generation': 'disabled', 'clerk-session': 'available',
    'fixture-provider-http': 'available', 'fixture-federation': 'available', 'fixture-mcp-stdio': 'available',
  }, limitations: ['Public catalog fixtures only; arbitrary repository import is unavailable.',
    'Voyage/DeepSeek generation is implemented and requires explicit local enablement and disclosure approval. Payments remain disabled.',
    'Extractive source retrieval is available without a generation model.',
    'Clerk session UI is implemented; hosted identity-to-tenant, RLS and concurrent database tests remain unverified.'] };
}
