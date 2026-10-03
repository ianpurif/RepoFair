import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 45000, expect: { timeout: 15000 },
  fullyParallel: false, workers: 1, retries: 0, forbidOnly: true,
  reporter: [['list'], ['./tests/browser/evidence-reporter.ts']],
  use: { baseURL: 'http://localhost:3000', headless: true,
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  // Start the app and fixture providers explicitly. Never replace an occupied port.
});
