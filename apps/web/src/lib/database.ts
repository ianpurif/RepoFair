import 'server-only';
import { attachDatabasePool } from '@vercel/functions';
import { createAtlasDatabase } from '@atlas/worker/database';
import { Pool } from 'pg';

let database:ReturnType<typeof createAtlasDatabase>|undefined;
/** One bounded pool per application process; service modules share this connection boundary. */
export function workspaceDatabase() {
  return database ??= createAtlasDatabase(process.env, {
    poolFactory: configuration => {
      const pool = new Pool({ ...configuration, idleTimeoutMillis: 5000 });
      attachDatabasePool(pool);
      return pool;
    },
  }).catch(error => { database = undefined; throw error; });
}
