// Bundles plugins/browser/src/host.ts into plugins/browser/dist/host.js (committed, because a plugin
// ships built JavaScript). Usage: node scripts/build-browser.mjs [outfile].
//
// Deterministic on purpose, since test/unit/browser-plugin.test.ts rebuilds into a temp dir and
// compares bytes with the committed file: a fixed target and format, no minifier, no legal
// comments, and `absWorkingDir` set to the plugin folder so the `// src/host.ts` markers esbuild
// writes are relative and the same on every machine (no absolute path or user name in the bundle).
import { build } from 'esbuild'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'browser')

await build({
  absWorkingDir: pluginDir,
  entryPoints: ['src/host.ts'],
  outfile: resolve(process.argv[2] ?? join(pluginDir, 'dist', 'host.js')),
  bundle: true,
  platform: 'node',
  // The plugin host loads `main` with require(), so CommonJS.
  format: 'cjs',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning'
})
