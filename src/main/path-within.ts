// Path containment: the one "is this path inside that folder" check main uses for plugin folders
// (validate.ts, installer.ts), skill folders (skill-files.ts) and preview roots (preview-protocol.ts,
// webview-target.ts). A plain `startsWith(root + sep)` written in each place would differ in its
// edge cases (a root ending in a separator, `..` as a whole segment); this one is shared instead.
// Pure Node, no Electron.
import { isAbsolute, relative, sep } from 'node:path'

/**
 * `child` is `parent` or inside it. Both absolute and already realpath'd (or otherwise canonical):
 * this compares spellings, it does not resolve symlinks.
 */
export function within(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
