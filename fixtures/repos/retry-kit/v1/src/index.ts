export { retryDelay } from './backoff';

// 1.0.0: all errors share the retry policy.
export function shouldRetry(error: { permanent?: boolean }, attempt: number, maxRetries: number): boolean {
  void error;
  return attempt < maxRetries;
}
