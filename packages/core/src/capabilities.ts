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
