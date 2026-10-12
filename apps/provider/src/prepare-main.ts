import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviderPreparationServer } from './preparation.ts';

/** Dedicated entry: its bundle contains only Node builtins and inactive readiness. */
export function startProviderPreparation(args: readonly string[], env: Readonly<Record<string, string | undefined>>) {
  if (args.length !== 0) throw new Error('Preparation entry accepts no runtime flags.');
  const port = Number(env.ATLAS_PROVIDER_PORT ?? '4311');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid preparation listener port.');
  const server = createProviderPreparationServer();
  server.once('error', () => { console.error('Provider preparation listener unavailable; check its configured port.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ service: 'atlas-provider', port, mode: 'tempo-testnet', status: 'awaiting-owner-approval', ready: false, payments: 'inactive' })));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { startProviderPreparation(process.argv.slice(2), process.env); }
  catch { console.error('Provider preparation unavailable; check its arguments and configured port.'); process.exitCode = 1; }
}
