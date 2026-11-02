// Bundles the reviewer's overlay page (plugins/reviewer/src/page/review.js) into
// plugins/reviewer/overlay/review.bundle.js (committed, since a plugin ships built files and the app
// runs no build at install). The host (plugins/reviewer/dist) is plain JS and needs no build.
// Usage: node scripts/build-reviewer.mjs [outfile].
//
// Deterministic on purpose, since test/unit/reviewer-plugin.test.ts rebuilds into a temp dir and
// compares bytes with the committed file: a fixed target, `absWorkingDir` set to the plugin folder so
// no absolute path or user name lands in the bundle, and no legal comments (the CodeMirror and lezer
// packages are MIT, whose notice travels in node_modules, not in a bundle line). The page is a
// classic script (IIFE) because the overlay html loads it without type="module". Minified: the
// unminified bundle is several times larger and the page loads it on every open.
import { build } from 'esbuild'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'reviewer')

await build({
  absWorkingDir: pluginDir,
  entryPoints: ['src/page/review.js'],
  outfile: resolve(process.argv[2] ?? join(pluginDir, 'overlay', 'review.bundle.js')),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning'
})
