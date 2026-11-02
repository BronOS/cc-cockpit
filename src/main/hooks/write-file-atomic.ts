import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Write `text` to `path` through a temp file and a rename, with the exact `mode` (the umask would
 * otherwise strip bits from an executable's 0755). Rename is atomic on one filesystem: a `claude`
 * reading hooks.json, or a hook executing `bin/ccc`, while the app regenerates it sees the old or
 * the new file, never a half-written one. The temp name carries the pid so two writers never share one.
 */
export function writeFileAtomic(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text, { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // never created, or already renamed
    }
    throw err
  }
}
