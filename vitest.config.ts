import { defineConfig } from 'vitest/config'

// Unit tests run in plain Node. Electron-only modules (node-pty, safeStorage, utilityProcess,
// BrowserWindow) are never imported here; they sit behind interfaces and are covered by e2e.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html']
    }
  }
})
