import { formatEvent } from './format';
export function recordRetry(event: { jobId: string; attempt: number; retry: boolean }): string {
  return formatEvent(event.retry ? 'job.retry.planned' : 'job.retry.stopped', event);
}
