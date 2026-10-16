import { defineConfig } from '@playwright/test'

import { appUrl, playwrightPort } from './tests/playwright-app-url.ts'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  use: {
    headless: true,
  },
  webServer: {
    command: `node scripts/run-vite.mjs --host 127.0.0.1 --port ${playwrightPort} --strictPort`,
    url: appUrl,
    reuseExistingServer: process.env.PW_REUSE_SERVER === '1',
    timeout: 120_000,
    env: {
      ...process.env,
      // The dev server's initial watcher scan can spike past Node's default
      // ~4GB heap once runtime dirs (.chill-vibe, dist/release-*) accumulate
      // tens of thousands of files on this Windows setup.
      NODE_OPTIONS: '--max-old-space-size=8192',
    },
  },
})
