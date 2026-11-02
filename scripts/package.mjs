// `npm run package` after `npm run build`: electron-builder, then the host-arch node-pty restore.
//
// Building a non-host arch (for example linux x64 from an arm64 host; mac is arm64 only) rebuilds node-pty in node_modules/ for that arch
// and leaves it there, which breaks `npm run dev` and the e2e suite on the host arch. The restore
// (`install-app-deps`, the package.json postinstall) must therefore run even when electron-builder
// fails half way, after it already rebuilt for the other arch; plain `a && b` skipped it then.
// The exit status stays electron-builder's, unless it passed and the restore failed.
import { spawnSync } from 'node:child_process'

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const run = (args) => spawnSync(npx, args, { stdio: 'inherit' }).status ?? 1

const build = run(['electron-builder', '--publish', 'never'])
const restore = run(['electron-builder', 'install-app-deps'])
process.exit(build !== 0 ? build : restore)
