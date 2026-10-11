import { MODERATO_NETWORK, MODERATO_PATHUSD, type PurchaseBudget, type PurchaseRecord } from '@atlas/contracts';
import { objectValue } from './repository-browser';

const atomic = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function readPurchase(value: unknown): PurchaseRecord {
  const row = objectValue(value);
  if (typeof row.id !== 'string' || !row.id || typeof row.providerId !== 'string' || !row.providerId || typeof row.packageName !== 'string' || !row.packageName || typeof row.version !== 'string' || !row.version || !['reserved', 'pending', 'unknown', 'settled', 'failed', 'expired'].includes(String(row.paymentState)) || !['awaiting-payment', 'running', 'ready', 'failed', 'revoked'].includes(String(row.deliveryState)) || !atomic(row.atomicAmount) || row.atomicAmount === '0' || row.network !== MODERATO_NETWORK || String(row.token).toLowerCase() !== MODERATO_PATHUSD || !/^0x[0-9a-f]{40}$/i.test(String(row.recipient)) || !date(row.createdAt) || !date(row.updatedAt) || !(row.receiptReference === null || typeof row.receiptReference === 'string' && row.receiptReference.length > 0 && row.receiptReference.length <= 200)) throw new Error('The server returned an invalid Moderato purchase record.');
  return row as unknown as PurchaseRecord;
}

export function readPurchaseBudget(value: unknown): PurchaseBudget {
  const row = objectValue(value);
  if (row.network !== MODERATO_NETWORK || String(row.token).toLowerCase() !== MODERATO_PATHUSD || !atomic(row.allowance) || !atomic(row.reserved) || !atomic(row.spent)) throw new Error('The server returned an invalid workspace allowance.');
  return row as unknown as PurchaseBudget;
}

export function readPurchaseHistory(data: Record<string, unknown>): { purchases: PurchaseRecord[]; budgets: PurchaseBudget[] } {
  if (!Array.isArray(data.purchases) || data.purchases.length > 200 || !Array.isArray(data.budgets) || data.budgets.length > 100) throw new Error('The server did not return bounded purchase history and allowances.');
  const purchases = data.purchases.map(readPurchase); const budgets = data.budgets.map(readPurchaseBudget);
  if (new Set(purchases.map(item => item.id)).size !== purchases.length || new Set(budgets.map(item => `${item.network}:${item.token.toLowerCase()}`)).size !== budgets.length) throw new Error('The purchase history contains duplicate records.');
  return { purchases, budgets };
}

export function remainingAllowance(budget: PurchaseBudget): string {
  const remaining = BigInt(budget.allowance) - BigInt(budget.reserved) - BigInt(budget.spent);
  return (remaining > 0n ? remaining : 0n).toString();
}

export function formatPathUsd(amount: string): string {
  const padded = amount.padStart(7, '0'); const fraction = padded.slice(-6).replace(/0+$/, '');
  return `${padded.slice(0, -6)}${fraction ? `.${fraction}` : ''} PathUSD`;
}
