import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
export default {
  output: 'standalone',
  outputFileTracingRoot: root,
  transpilePackages: ['@atlas/core', '@atlas/contracts'],
  turbopack: { root },
};
