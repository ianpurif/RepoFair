import { parseAtomic, assertPositiveAtomic } from './amounts.ts';
import { AtlasError, requireCondition } from './errors.ts';
export type Reservation = Readonly<{ key: string; units: string; state: 'reserved' | 'unknown' | 'settled' | 'released' }>;
export type Budget = Readonly<{ limit: string; entries: readonly Reservation[] }>;
/** Pure reducer only: production callers MUST lock and persist the ledger transactionally. */
export function usedBudget(b: Budget): bigint {
  parseAtomic(b.limit);
  const keys = new Set<string>();
  let used = 0n;
  for (const entry of b.entries) {
    requireCondition(Boolean(entry.key) && !keys.has(entry.key), 'INVALID_LEDGER', 'Duplicate or empty reservation key.');
    keys.add(entry.key);
    const units = assertPositiveAtomic(entry.units);
    if (entry.state !== 'released') used += units;
  }
  requireCondition(used <= parseAtomic(b.limit), 'OVER_BUDGET', 'Ledger exceeds the permitted amount.');
  return used;
}
export function reserve(b: Budget, key: string, units: string): Budget {
  const used = usedBudget(b);
  requireCondition(key.length > 0, 'INVALID_KEY', 'An idempotency key is required.');
  const amount = assertPositiveAtomic(units);
  const existing = b.entries.find(e => e.key === key);
  if (existing) {
    requireCondition(existing.units === units && existing.state !== 'released', 'IDEMPOTENCY_CONFLICT', 'Reservation terms changed.');
    return b;
  }
  requireCondition(used + amount <= parseAtomic(b.limit), 'BUDGET_EXCEEDED', 'The external-service allowance is insufficient.');
  return { ...b, entries: [...b.entries, {key, units, state: 'reserved'}] };
}
export function reconcile(b: Budget, key: string, next: 'unknown' | 'settled' | 'released'): Budget {
  usedBudget(b);
  const entry = b.entries.find(e => e.key === key);
  if (!entry) throw new AtlasError('UNKNOWN_RESERVATION', 'Unknown reservation.');
  if (entry.state === next) return b;
  // Unknown cannot be released without a separate verified-outcome path implemented by the payment adapter.
  const permitted = entry.state === 'reserved' || (entry.state === 'unknown' && next === 'settled');
  requireCondition(permitted, 'INVALID_TRANSITION', 'Cannot release/reuse uncertain or settled funds.');
  return { ...b, entries: b.entries.map(e => e.key === key ? {...e, state: next} : e) };
}
