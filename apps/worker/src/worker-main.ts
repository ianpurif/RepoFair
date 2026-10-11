import { createAtlasDatabase, AtlasDatabaseError } from './database.ts';
import type { AtlasDatabase } from './database.ts';
import { createRepositoryService, RepositoryServiceError } from './repository-service.ts';

// Trusted launcher supplies environment and bundles this entry point for Node.
// Never log credentials, repository names, source, or unsanitized exceptions.
if ('bun' in process.versions) {
  console.error(JSON.stringify({ status: 'failed', code: 'worker-requires-node' })); process.exitCode = 1;
} else if (!process.argv.slice(2).every(value => value === '--once')) {
  console.error(JSON.stringify({ status: 'failed', code: 'invalid-worker-argument' })); process.exitCode = 1;
} else {
  let stopping = false; let wake: (() => void) | undefined;
  const controller = new AbortController();
  const stop = (): void => { stopping = true; controller.abort(); wake?.(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let database: AtlasDatabase | undefined;
  try {
    database = await createAtlasDatabase(process.env);
    const service = createRepositoryService(database, process.env);
    do {
      const start = performance.now();
      let result;
      try { result = await service.processOne({ signal: controller.signal }); }
      catch (error) {
        if (!(error instanceof AtlasDatabaseError) || !['connection','timeout','commit_unknown'].includes(error.code)) throw error;
        result = { status: 'unknown' as const, code: `database-${error.code}` };
      }
      if (result.status !== 'idle' || process.argv.includes('--once')) console.log(JSON.stringify({ ...result, durationMs: Math.round(performance.now() - start) }));
      if (process.argv.includes('--once') && (result.status === 'failed' || result.status === 'unknown')) process.exitCode = 1;
      if (process.argv.includes('--once') || stopping) break;
      if (result.status === 'idle' || result.status === 'unknown') await new Promise<void>(resolveWait => {
        const timer = setTimeout(() => { wake = undefined; resolveWait(); }, 5000);
        wake = () => { clearTimeout(timer); wake = undefined; resolveWait(); };
      });
    } while (!stopping);
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: error instanceof AtlasDatabaseError ? `database-${error.code}` : error instanceof RepositoryServiceError ? error.code : 'worker-failed' }));
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (database) try { await database.close(); } catch { console.error(JSON.stringify({ status: 'failed', code: 'database-close-failed' })); process.exitCode = 1; }
  }
}
