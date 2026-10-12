import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CENTRAL_MIGRATIONS } from '../scripts/central-migrations.mjs';

test('central migration plan is ordered, complete and excludes provider-owned payment tables', () => {
  assert.equal(CENTRAL_MIGRATIONS.length, 7);
  assert.deepEqual([...CENTRAL_MIGRATIONS].sort(), CENTRAL_MIGRATIONS);
  for (const file of CENTRAL_MIGRATIONS) {
    assert.ok(existsSync(join(import.meta.dirname, '../supabase/migrations', file)));
    assert.ok(!file.includes('provider_replay') && !file.includes('provider_ledger') && !file.includes('provider_delivery'));
  }
});
