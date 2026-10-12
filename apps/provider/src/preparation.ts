import { createServer } from 'node:http';

/** Generic inactive HTTP readiness only. No runtime, database, source or payment imports. */
export function createProviderPreparationServer() {
  const body = JSON.stringify({ mode: 'tempo-testnet', ready: false, publication: 'awaiting-owner-approval', payments: 'inactive' });
  const server = createServer({ maxHeaderSize: 16_384 }, (_incoming, outgoing) => {
    outgoing.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    outgoing.end(body);
  });
  server.headersTimeout = 10_000; server.requestTimeout = 15_000;
  return server;
}
