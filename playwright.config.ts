import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  use: {
    headless: true,
  },
  webServer: {
    command: 'node scripts/run-vite.mjs --host 127.0.0.1 --strictPort',
    url: 'http://127.0.0.1:5173',
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
