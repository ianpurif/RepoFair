import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
export default {
  agentRules: false,
  devIndicators: false,
  outputFileTracingRoot: root,
  transpilePackages: ['@atlas/core', '@atlas/contracts', '@atlas/worker'],
  serverExternalPackages: ['ts-morph'],
  turbopack: { root },
};
