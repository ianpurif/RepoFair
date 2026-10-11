import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { FIXTURE_PROVIDERS, parseFixtureId, parseQuestion } from '@atlas/contracts';
import type { FixtureProviderId, FixtureProviderResult } from '@atlas/contracts';
import { indexFixture } from '@atlas/worker/fixtures';
import { answerLocal } from '@atlas/core/local';

/** Independently configured, public fixture-only service. Never issues receipts. */
export function createFixtureProvider(providerId: FixtureProviderId, published = false) {
  const config = FIXTURE_PROVIDERS.find(p => p.providerId === providerId);
  if (!config || process.env.NODE_ENV==='production'||(process.env.NODE_ENV!=='test'&&process.env.ATLAS_FIXTURES_ENABLED!=='true')||(process.env.ATLAS_MODE ?? 'fixture') !== 'fixture') throw new Error('Only explicitly enabled development fixture providers are available');
  return createServer(async (request, response) => {
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Atlas-Mode': 'fixture' }); response.end(JSON.stringify(body)); };
    const host = request.headers.host ?? '';
    // Local server is not intended as a public service or arbitrary browser target.
    if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host) || request.headers.origin) { send(403, { error: 'Origin denied' }); return; }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/health') { send(200, { ...config, published, status: 'running' }); return; }
    if (request.method === 'GET' && path === '/.well-known/atlas-provider.json') {
      if (!published) { send(404, { error: 'Provider unavailable' }); return; }
      send(200, { ...config, published, schemaVersion: 1, manifest: 'Atlas fixture manifest', rightsStatement: 'Original Atlas demonstration source; not independent customer activity', operation: 'context.retrieve' }); return;
    }
    if (request.method !== 'POST' || path !== '/context/retrieve') { send(404, { error: 'Not found' }); return; }
    if (!published) { send(403, { error: 'Provider unpublished', charged: false }); return; }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 8192) { send(413, { error: 'Request too large', charged: false }); return; } chunks.push(bytes); }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid request');
      const value = input as Record<string, unknown>;
      if (value.packageName !== config.packageName || typeof value.version !== 'string' || !config.versions.includes(value.version)) { send(422, { error: 'Exact package version unavailable', charged: false }); return; }
      const question = parseQuestion(value.question);
      const repo = providerId === 'fixture-retry' ? 'retry-kit' : 'event-log';
      const index = await indexFixture(parseFixtureId(`${repo}@${value.version}`));
      const result: FixtureProviderResult = { schemaVersion: 1, mode: 'fixture', providerId, payment: 'not-attempted', index, answer: answerLocal(index, question) };
      send(200, result);
    } catch { send(400, { error: 'Invalid or unavailable fixture request', charged: false }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--identity'); const identity = process.argv[at + 1] as FixtureProviderId;
  const config = FIXTURE_PROVIDERS.find(p => p.providerId === identity);
  if (at < 0 || !config) throw new Error('Choose --identity fixture-retry or fixture-events');
  const published = process.argv.includes('--publish');
  const port = Number(new URL(config.endpoint).port);
  const server = createFixtureProvider(identity, published);
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.once('error', () => { console.error('Provider port unavailable'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`${identity} at ${config.endpoint}; fixture mode; published=${published}; no payments`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
