// Bundles the editor's file tab page into plugins/editor/dist/pages (committed, since a plugin ships
// built files and the app runs no build at install; dist/ is what the packaging filter ships). The
// host (plugins/editor/dist/host.js, dist/lib) is plain JS and needs no build. One bundle:
//   file.bundle.js  the page (src/page/file.js), loaded by dist/pages/file.html.
// Usage: node scripts/build-editor.mjs [outdir].
//
// Deterministic on purpose, as build-reviewer.mjs is: test/unit/reviewer-plugin.test.ts rebuilds into
// a temp dir and compares bytes with the committed file. A fixed target, `absWorkingDir` set to the
// plugin folder so no absolute path or user name lands in the bundle, no legal comments (the
// CodeMirror and lezer packages are MIT, whose notices travel in node_modules). A classic script
// (IIFE): the page loads it without type="module", and a sandboxed frame with an opaque origin is
// no place for module chunks. Minified: the page loads it at every mount.
import { build } from 'esbuild'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'editor')
const outDir = resolve(process.argv[2] ?? join(pluginDir, 'dist', 'pages'))

await build({
  absWorkingDir: pluginDir,
  entryPoints: ['src/page/file.js'],
  outfile: join(outDir, 'file.bundle.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  legalComments: 'none',
  logLevel: 'error'
})
