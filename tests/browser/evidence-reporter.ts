import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Collects results in the runner process, preserving failures across worker restarts. */
export default class BrowserEvidenceReporter implements Reporter {
  private startedAt = new Date().toISOString();
  private observations: { title: string; status: TestResult['status']; expectedStatus: TestCase['expectedStatus']; durationMs: number; errors: string[]; console: unknown }[] = [];
  onTestEnd(test: TestCase, result: TestResult): void {
    const attachment = result.attachments.find(item => item.name === 'browser-console');
    const consoleOutput: unknown = attachment?.body ? JSON.parse(attachment.body.toString('utf8')) : null;
    this.observations.push({ title: test.title, status: result.status, expectedStatus: test.expectedStatus,
      durationMs: result.duration, errors: result.errors.map(error => error.message ?? String(error)), console: consoleOutput });
  }
  async onEnd(result: FullResult): Promise<void> {
    await writeFile(resolve('docs/evidence/browser-verification.json'), JSON.stringify({
      schemaVersion: 1, startedAt: this.startedAt, finishedAt: new Date().toISOString(), exitStatus: result.status,
      command: 'Playwright test invocation with evidence reporter',
      url: 'http://localhost:3000', serverMode: 'externally started server; mode not independently detected',
      browser: process.platform === 'win32' ? 'Microsoft Edge via Playwright' : 'Playwright Chromium',
      payments: 'not attempted', providerEndpoints: ['http://127.0.0.1:4311', 'http://127.0.0.1:4312'],
      total: this.observations.length, passed: this.observations.filter(item => item.status === 'passed').length,
      failed: this.observations.filter(item => item.status === 'failed' || item.status === 'timedOut').length,
      skipped: this.observations.filter(item => item.status === 'skipped').length, observations: this.observations,
      developmentIdentityControlsEnabled: process.env.ATLAS_BROWSER_TEST_SESSION === 'true',
      identityScope: process.env.ATLAS_BROWSER_TEST_SESSION === 'true'
        ? 'Opt-in controls create and clean fresh sessions for the existing authorized development Clerk account; commerce and wallet transports remain fixtures.'
        : 'No opt-in development identity controls enabled.',
      limitations: ['Fixture/transport browser cases do not establish hosted RLS, real database concurrency, provider publication or Tempo settlement.',
        'Opt-in real development sign-in checks do not turn simulated catalog, purchase-history or wallet responses into real commerce evidence.',
        'The indexing recovery case deliberately aborts one browser request; the successful retry uses the actual server.'],
    }, null, 2) + '\n');
  }
}
