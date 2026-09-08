import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'visualizer.spec.ts',
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: Boolean(process.env.CI),
  outputDir: 'test-results/visualizer',
  reporter: [['list'], ['junit', { outputFile: 'test-results/visualizer-junit.xml' }]],
  timeout: 90000,
  use: {
    baseURL: process.env.MUSIMO_TEST_URL ?? 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--enable-unsafe-webgpu'] } },
    },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    { name: 'webgl', use: { ...devices['Desktop Chrome'] } },
  ],
})
