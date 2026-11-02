// Bundles marketplace/tools/src/*.ts into marketplace/tools/dist/*.js (committed: the index repo's
// CI runs them with plain `node`, with no install step, so no dependency of a third party ever runs
// next to a merge token). Usage: node scripts/build-marketplace-tools.mjs [outdir].
//
// Deterministic on purpose, since test/unit/marketplace-tools.test.ts rebuilds into a temp dir and
// compares bytes with the committed files: see scripts/build-hello.mjs for the same choices.
import { build } from 'esbuild'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'marketplace', 'tools')
const outDir = resolve(process.argv[2] ?? join(toolsDir, 'dist'))

for (const tool of ['build-index', 'check-entry', 'auto-merge']) {
  await build({
    absWorkingDir: toolsDir,
    // The start-up call lives here, not in the module, so the tests can import the module without
    // it running as a command.
    stdin: {
      contents: `import { main } from './src/${tool}'\nimport { runCli } from './src/common'\nrunCli(main)\n`,
      resolveDir: toolsDir,
      loader: 'ts'
    },
    outfile: join(outDir, `${tool}.js`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    legalComments: 'none',
    logLevel: 'warning'
  })
}
