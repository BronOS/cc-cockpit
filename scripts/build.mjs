// Bundles the overlay page into one classic script (IIFE) next to its html. The host needs no
// build; run this after editing src/page/. The bundle is committed: the app runs no build at install.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/page/review.js'],
  outfile: 'overlay/review.bundle.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  legalComments: 'linked',
  logLevel: 'info',
})
