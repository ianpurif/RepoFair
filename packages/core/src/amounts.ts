import { AtlasError } from './errors.ts';
/** Integer atomic units only. Network/token decimals are adapter configuration. */
export function parseAtomic(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) {
    throw new AtlasError('INVALID_ATOMIC_AMOUNT', 'Expected bounded unsigned integer atomic units.');
  }
  return BigInt(value);
}
export function sumAtomic(values: readonly string[]): string {
  return values.reduce((total, value) => total + parseAtomic(value), 0n).toString();
}
export function assertPositiveAtomic(value: string): bigint {
  const amount = parseAtomic(value);
  if (amount === 0n) throw new AtlasError('ZERO_PURCHASE', 'Paid purchases must be positive.');
  return amount;
}
