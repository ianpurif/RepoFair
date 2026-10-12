import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PROVIDER_MIGRATIONS } from '../scripts/provider-migrations.mjs';
import { CENTRAL_MIGRATIONS } from '../scripts/central-migrations.mjs';

test('provider plan is ordered, independent of central SQL and requires no database credential', () => {
  assert.equal(PROVIDER_MIGRATIONS.length, 3);
  assert.ok(PROVIDER_MIGRATIONS.every(name => name.includes('_provider_')));
  assert.ok(PROVIDER_MIGRATIONS.every(name => !CENTRAL_MIGRATIONS.includes(name)));
  assert.ok(PROVIDER_MIGRATIONS.every(name => existsSync(`supabase/migrations/${name}`)));
  const result = spawnSync(process.execPath, ['--experimental-transform-types', 'scripts/migrate-provider.mjs', '--plan'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 3);
  for (const [index, line] of lines.entries()) assert.match(line, new RegExp(`^${PROVIDER_MIGRATIONS[index].replace('.', '\\.')} [a-f0-9]{64}$`));
  const runner = readFileSync('scripts/migrate-provider.mjs', 'utf8');
  assert.match(runner, /process\.env\.ATLAS_PROVIDER_DATABASE_URL/);
  assert.doesNotMatch(runner, /DATABASE_URL:\s*process\.env\.DATABASE_URL/);
  assert.match(runner, /central_exists/);
});
