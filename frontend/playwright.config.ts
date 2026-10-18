import { defineConfig, devices } from '@playwright/test'

import { BASE_URL } from './e2e/env'

// Firefox opens the profile named by XRE_PROFILE_PATH ahead of the one Playwright makes, and stops
// with "Could not find profile folder" when that folder is gone. Firefox sets these variables when
// it restarts itself, so a stale one can reach this shell. They are left out of its environment.
const firefoxEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('XRE_'),
  ),
)

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/setup.ts',
  // Settings and queue controls belong to the installation, so tests share one writer.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: Boolean(process.env.CI),
  timeout: 30_000,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],
  use: {
    baseURL: BASE_URL,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], launchOptions: { env: firefoxEnv } },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
})
