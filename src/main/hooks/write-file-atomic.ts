import { closeSync, constants, fchmodSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** A fresh temp file: never an existing one, never through a link (O_EXCL fails on a link too, O_NOFOLLOW to be sure). */
const TMP_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)

/**
 * Write `text` to `path` through a temp file and a rename, with the exact `mode` (the umask would
 * otherwise strip bits from an executable's 0755). Rename is atomic on one filesystem: a `claude`
 * reading hooks.json, or a hook executing `bin/ccc`, while the app regenerates it sees the old or
 * the new file, never a half-written one. The temp name carries the pid so two writers never share one.
 *
 * The temp file is made new (O_EXCL, O_NOFOLLOW): a plain write to the fixed name would follow a link planted there
 * (the room store writes text members choose under `<data>/rooms`), so whatever is left at that name (a crash's
 * leftover, a link) is unlinked first, which removes a link itself and never its target. The rename replaces a link
 * at `path` itself too, never what it points to.
 */
export function writeFileAtomic(path: string, text: string | Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    try {
      unlinkSync(tmp)
    } catch {
      // nothing left there
    }
    const fd = openSync(tmp, TMP_FLAGS, mode)
    try {
      writeFileSync(fd, text)
      fchmodSync(fd, mode)
    } finally {
      closeSync(fd)
    }
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
