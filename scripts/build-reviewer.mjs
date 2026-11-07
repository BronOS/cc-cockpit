// Bundles the reviewer's overlay page into plugins/reviewer/overlay (committed, since a plugin ships
// built files and the app runs no build at install). The host (plugins/reviewer/dist) is plain JS and
// needs no build. Two bundles:
//   review.bundle.js  the page (src/page/review.js), loaded by overlay/review.html;
//   pdf.bundle.js     pdf.js and its worker code (src/page/pdf-entry.mjs), loaded by the page only
//                     when it shows a PDF.
// Usage: node scripts/build-reviewer.mjs [outdir].
//
// Deterministic on purpose, since test/unit/reviewer-plugin.test.ts rebuilds into a temp dir and
// compares bytes with the committed files: a fixed target, `absWorkingDir` set to the plugin folder so
// no absolute path or user name lands in a bundle, and no legal comments (the CodeMirror, lezer,
// markdown-it and pdf.js packages are MIT or Apache-2.0, whose notices travel in node_modules, not in a
// bundle line). Classic scripts (IIFE) because the overlay html loads them without type="module",
// and a sandboxed frame with an opaque origin is no place for module chunks. Minified: the page loads
// them on every open.
import { build } from 'esbuild'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'reviewer')
const outDir = resolve(process.argv[2] ?? join(pluginDir, 'overlay'))

const common = {
  absWorkingDir: pluginDir,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  legalComments: 'none',
  logLevel: 'error'
}

await build({ ...common, entryPoints: ['src/page/review.js'], outfile: join(outDir, 'review.bundle.js') })
// pdf.js: `import.meta.url` is only read on its Node.js path and by its WASM decoders, which the page
// turns off (useWasm: false), so the empty `import.meta` of an IIFE is fine; the warning is silenced.
await build({ ...common, entryPoints: ['src/page/pdf-entry.mjs'], outfile: join(outDir, 'pdf.bundle.js'), logOverride: { 'empty-import-meta': 'silent' } })
