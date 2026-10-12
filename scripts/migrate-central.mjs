import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';
import { CENTRAL_MIGRATIONS } from './central-migrations.mjs';
import { loadDatabasePoolConfiguration } from '../apps/worker/src/database.ts';

const mode = process.argv[2];
if (!['--plan', '--apply'].includes(mode) || process.argv.length !== 3) {
  console.error('Use node --experimental-transform-types scripts/migrate-central.mjs --plan|--apply');
  process.exit(2);
}
const migrations = CENTRAL_MIGRATIONS.map(name => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8');
  return { name, sql, digest: createHash('sha256').update(sql).digest('hex') };
});
if (mode === '--plan') {
  for (const item of migrations) console.log(`${item.name} ${item.digest}`);
} else {
  // Only an empty Atlas schema or this command's own digest journal may advance.
  // A pre-existing unjournaled installation needs a separate schema audit.
  const require = createRequire(new URL('../apps/worker/src/database.ts', import.meta.url));
  const { Pool } = require('pg');
  let pool; let client;
  try {
    pool = new Pool({ ...await loadDatabasePoolConfiguration(process.env), max: 1 });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='180s'");
    await client.query('SELECT pg_advisory_xact_lock($1,$2)', [1723531925, 42431]);
    const existing = await client.query("SELECT to_regclass('supabase_migrations.atlas_central_setup') IS NOT NULL AS journal, EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='atlas') AS atlas_exists");
    if (existing.rows[0]?.atlas_exists && !existing.rows[0]?.journal) throw new Error('Unjournaled Atlas schema exists; audit it before applying migrations.');
    await client.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations');
    await client.query('CREATE TABLE IF NOT EXISTS supabase_migrations.atlas_central_setup(version text PRIMARY KEY,digest text NOT NULL CHECK(length(digest)=64),applied_at timestamptz NOT NULL DEFAULT now())');
    for (const item of migrations) {
      const stored = await client.query('SELECT digest FROM supabase_migrations.atlas_central_setup WHERE version=$1', [item.name]);
      if (stored.rows[0]) {
        if (stored.rows[0].digest !== item.digest) throw new Error(`Migration digest differs: ${item.name}`);
        continue;
      }
      await client.query(item.sql);
      await client.query('INSERT INTO supabase_migrations.atlas_central_setup(version,digest) VALUES($1,$2)', [item.name,item.digest]);
    }
    await client.query('COMMIT');
    console.log(`Central Atlas migration journal verified: ${migrations.length} exact migrations.`);
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(error instanceof Error && /^(Unjournaled Atlas schema|Migration digest differs)/.test(error.message) ? error.message : 'Central migration failed or commit outcome is unknown; inspect the database journal before retrying.');
    process.exitCode = 1;
  } finally { client?.release(); await pool?.end(); }
}
