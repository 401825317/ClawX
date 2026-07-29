import { defineConfig } from '@playwright/test';
import path from 'node:path';

const reportDir = process.env.UCLAW_REGRESSION_REPORT_DIR
  ? path.resolve(process.env.UCLAW_REGRESSION_REPORT_DIR)
  : path.resolve('release', 'regression', 'manual');

export default defineConfig({
  testDir: './tests/packaged-e2e',
  testMatch: /portable-regression\.spec\.ts/u,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30 * 60_000,
  globalTimeout: 45 * 60_000,
  expect: {
    timeout: 30_000,
  },
  outputDir: path.join(reportDir, 'artifacts'),
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(reportDir, 'playwright-results.json') }],
    ['html', { outputFolder: path.join(reportDir, 'html'), open: 'never' }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
