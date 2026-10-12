import { publicProviderUrl } from '../../worker/src/provider-http.ts';

type Environment = Readonly<Record<string, string | undefined>>;
type ProviderHandler = Readonly<{ handle(request: Request): Promise<Response> }>;
type ProviderFactory = (environment: Environment) => Promise<ProviderHandler>;

/** Exact fields only: prefix matching would admit future central/buyer credentials. */
const providerVariables = Object.freeze([
  'ATLAS_PROVIDER_DATABASE_URL', 'ATLAS_PROVIDER_DATABASE_SSL_CA_FILE', 'ATLAS_PROVIDER_DATABASE_SSL_CA',
  'ATLAS_PROVIDER_ID', 'ATLAS_PROVIDER_ORIGIN', 'ATLAS_PROVIDER_AUTHORIZATION_ISSUER',
  'ATLAS_PROVIDER_ISSUER_PUBLIC_KEY_FILE', 'ATLAS_PROVIDER_ISSUER_PUBLIC_KEY',
  'ATLAS_PROVIDER_MPP_SECRET_FILE', 'ATLAS_PROVIDER_MPP_SECRET',
  'ATLAS_PROVIDER_RECIPIENT', 'ATLAS_PROVIDER_PRICE_UNITS', 'ATLAS_PROVIDER_REALM',
  'TEMPO_RPC_URL', 'TEMPO_CHAIN_ID', 'TEMPO_TOKEN_ADDRESS',
] as const);

export function vercelProviderEnvironment(inherited: Environment): Environment {
  const selected: Record<string, string> = {};
  for (const name of providerVariables) if (typeof inherited[name] === 'string') selected[name] = inherited[name];
  return Object.freeze(selected);
}

const independentProvider: ProviderFactory = async environment => {
  const { createIndependentProvider } = await import('./runtime.ts');
  return createIndependentProvider(environment);
};

function unavailable(method: string): Response {
  return new Response(method === 'HEAD' ? null : JSON.stringify({ error: 'Independent provider unavailable', mode: 'tempo-testnet' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Atlas-Mode': 'tempo-testnet' },
  });
}

/** Node Web handler; imports no source artifact and leaves authorization/payment to the real runtime. */
export function createVercelProviderHandler(
  inherited: Environment,
  createProvider: ProviderFactory = independentProvider,
): (request: Request) => Promise<Response> {
  let initialization: Promise<Readonly<{ provider: ProviderHandler; origin: string }>> | undefined;
  function initialize() {
    if (!initialization) {
      initialization = Promise.resolve().then(async () => {
        const environment = vercelProviderEnvironment(inherited);
        const configured = environment.ATLAS_PROVIDER_ORIGIN;
        const origin = publicProviderUrl(configured ?? '').origin;
        if (origin !== configured) throw new Error('Exact provider origin required');
        return { provider: await createProvider(environment), origin };
      }).catch(error => {
        // A missing artifact/configuration can be corrected. Successful instances remain shared.
        initialization = undefined;
        throw error;
      });
    }
    return initialization;
  }
  return async request => {
    try {
      const { provider, origin } = await initialize();
      const incoming = new URL(request.url);
      const canonical = new URL(origin);
      // Assign path/query instead of resolving a relative URL: //host must remain a path.
      canonical.pathname = incoming.pathname;
      canonical.search = incoming.search;
      const init: RequestInit & { duplex?: 'half' } = {
        method: request.method, headers: request.headers, signal: request.signal,
        ...(request.body ? { body: request.body, duplex: 'half' as const } : {}),
      };
      // Stream original bytes. JSON reserialization would invalidate BodyDigest-bound payment terms.
      return await provider.handle(new Request(canonical, init));
    } catch {
      // Do not log errors, environment values, delegation credentials or private source.
      return unavailable(request.method);
    }
  };
}
