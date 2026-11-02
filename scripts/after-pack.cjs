// electron-builder afterPack hook: drop group and other write access from everything in the packed app.
//
// node_modules/electron/dist can carry 777/666 modes, and electron-builder copies them into the app. In
// the .deb that left the v0.1.0 binary world-writable under /opt, owned by root: any local user could
// replace the app another user runs. It runs before signing and before the installers are made, so on a
// Mac the signature covers the final modes, and every target gets the same files.
const { lstatSync, readdirSync, chmodSync } = require('node:fs')
const { join } = require('node:path')

/** Clears the group and other write bits under `dir`. Symlinks are skipped: chmod would follow them out. */
function dropSharedWrite(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) continue
    if (stat.mode & 0o022) chmodSync(path, stat.mode & 0o7755)
    if (stat.isDirectory()) dropSharedWrite(path)
  }
}

exports.default = async (context) => dropSharedWrite(context.appOutDir)
exports.dropSharedWrite = dropSharedWrite
