export { retryDelay } from './backoff';

// 2.0.0: permanent errors are not retried.
export function shouldRetry(error: { permanent?: boolean }, attempt: number, maxRetries: number): boolean {
  if (error.permanent === true) return false;
  return attempt < maxRetries;
}
