import { createHash } from 'node:crypto';
import type { Store } from 'mppx';
import type { AtlasDatabase, AtlasTransaction } from '../../worker/src/database.ts';

/** Provider-owned store; supply the provider's database, never buyer credentials. */
export function createPostgresReplayStore(database: AtlasDatabase, namespace: string): Store.AtomicStore {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(namespace)) throw new Error('Invalid replay namespace');
  function identity(key: string) {
    if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 4096) throw new Error('Invalid replay key');
    const digest = createHash('sha256').update(key).digest('hex');
    const lock = createHash('sha256').update(JSON.stringify(['atlas-provider-replay', namespace, digest])).digest().readBigInt64BE().toString();
    return { digest, lock };
  }
  function encode(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized) > 65536) throw new Error('Replay value must be bounded JSON');
    return serialized;
  }
  async function locked<Result>(key: string, operation: (tx: AtlasTransaction, digest: string) => Promise<Result>): Promise<Result> {
    const { digest, lock } = identity(key);
    return database.withAdminTransaction(async tx => {
      // Row locks cannot protect a missing key. Every writer takes this same
      // transaction-scoped lock before reading or inserting that key.
      await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [lock]);
      return operation(tx, digest);
    });
  }
  const update: Store.Update = async (key, change) => locked(key, async (tx, digest) => {
    const row = (await tx.query<{ value: unknown }>('SELECT value FROM atlas_provider.replay WHERE namespace=$1 AND key_digest=$2', [namespace, digest])).rows[0];
    const action = change(row?.value ?? null);
    if (!action || !['noop', 'set', 'delete'].includes(action.op)) throw new Error('Invalid atomic replay change');
    if (action.op === 'set') await tx.query('INSERT INTO atlas_provider.replay(namespace,key_digest,value) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,key_digest) DO UPDATE SET value=excluded.value,updated_at=now()', [namespace, digest, encode(action.value)]);
    else if (action.op === 'delete') await tx.query('DELETE FROM atlas_provider.replay WHERE namespace=$1 AND key_digest=$2', [namespace, digest]);
    return action.result;
  });
  return {
    get: async key => {
      const { digest } = identity(key);
      return database.withAdminTransaction(async tx => (await tx.query<{ value: unknown }>('SELECT value FROM atlas_provider.replay WHERE namespace=$1 AND key_digest=$2', [namespace, digest])).rows[0]?.value ?? null);
    },
    put: async (key, value) => { await update(key, () => ({ op: 'set', value, result: undefined })); },
    delete: async key => { await update(key, () => ({ op: 'delete', result: undefined })); },
    update,
  };
}
