import { shouldRetry, retryDelay } from '@atlas-fixture/retry-kit';
import { recordRetry } from '@atlas-fixture/event-log';
import { jobPolicy } from './policy';

export function planFailure(jobId: string, error: { permanent?: boolean }, attempt: number) {
  const retry = shouldRetry(error, attempt, jobPolicy.maxRetries);
  const event = recordRetry({ jobId, attempt, retry });
  return { retry, delayMs: retry ? retryDelay(attempt) : null, event };
}
