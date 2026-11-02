// Bundles src/host.ts into dist/host.js. A plugin ships built JavaScript and the app never compiles
// anything on install, so commit dist/host.js with every change. Usage: node build.mjs [outfile].
import { build } from 'esbuild'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

await build({
  // Set so the paths esbuild writes into the bundle are relative: no user name or local path in it.
  absWorkingDir: root,
  entryPoints: ['src/host.ts'],
  outfile: resolve(process.argv[2] ?? join(root, 'dist', 'host.js')),
  bundle: true,
  platform: 'node',
  // The plugin host loads `main` with require(), so CommonJS.
  format: 'cjs',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning'
})
