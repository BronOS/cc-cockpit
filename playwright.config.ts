import { defineConfig } from '@playwright/test'

// E2E specs live in test/e2e and launch the built app (out/) through _electron.launch via the
// harness in test/e2e/fixtures.ts. `npm run test:e2e` builds first so out/ is fresh.
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  workers: 1,
  reporter: 'list'
})
