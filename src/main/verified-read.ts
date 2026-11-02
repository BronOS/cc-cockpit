// Read a file through a descriptor that was checked, not through its name a second time. The
// protocols that serve files to a page (cc-preview://, cc-plugin://) and the manifest reads first
// prove a path is a regular file inside its folder (validate.ts resolveInside: realpath, stat),
// then read it. Reading by name again reopens it: a file or an ancestor folder swapped for a
// symlink between the check and the read would hand the page a file outside the folder (review
// finding: a preview page reading ~/.ssh). So the read goes through one descriptor, verified:
// - opened with O_NOFOLLOW (the last component swapped for a symlink fails with ELOOP) and
//   O_NONBLOCK (a FIFO swapped in does not block the open: it is then refused as not a file);
// - fstat on that descriptor: a regular file (and the caller's dev/inode when it has them);
// - the name still leads to that very file with no symlink on the way: realpath(name) is the name
//   itself (an ancestor turned into a symlink after the check changes it) and stat(name) has the
//   descriptor's dev/inode;
// - the bytes come from the descriptor, at most `maxBytes` (a file growing meanwhile is cut off
//   and refused, not read whole).
// What this cannot prove: Node has no openat() or F_GETPATH, so an ancestor flipped to a symlink
// for the open and back again before the recheck is not caught. The checks narrow that to the
// microseconds between two system calls, for someone already able to write inside the folder.
// skill-files.ts does the same, synchronously, for the skill copy (its build must be synchronous).
// Pure Node, no Electron.
import { constants, type Stats } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'

/** Flags of every verified open. O_NOFOLLOW/O_NONBLOCK are POSIX; 0 where a platform lacks them. */
export const VERIFIED_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

export type VerifiedProblem =
  /** Gone (or a folder on the way is), at the open. */
  | 'missing'
  /** The last component is a symlink now. */
  | 'symlink'
  /** Not a regular file now (a folder, a FIFO, a device). */
  | 'not-file'
  /** The name no longer leads to the file opened (an ancestor became a symlink, the file was replaced). */
  | 'changed'
  | 'too-large'

export type VerifiedRead = { ok: true; data: Buffer } | { ok: false; problem: VerifiedProblem }

/** The words of a VerifiedProblem, for a log line or an error message. */
export function verifiedProblemText(problem: VerifiedProblem): string {
  switch (problem) {
    case 'missing':
      return 'file not found'
    case 'symlink':
      return 'became a symlink while it was read'
    case 'not-file':
      return 'is not a regular file'
    case 'changed':
      return 'changed while it was read'
    case 'too-large':
      return 'is too large'
  }
}

/** The same file: device and inode. */
export function sameFile(a: Pick<Stats, 'dev' | 'ino'>, b: Pick<Stats, 'dev' | 'ino'>): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/**
 * The bytes of `real` (absolute, already realpath'd and checked by the caller), read as above.
 * `expect`: the dev/inode the caller's own stat saw, when it has one. Throws only for an fs error
 * other than the refusals (EACCES, EIO): the callers already treat a failed read as one.
 */
export async function readVerified(real: string, maxBytes: number, expect?: Pick<Stats, 'dev' | 'ino'>): Promise<VerifiedRead> {
  let handle: FileHandle
  try {
    handle = await open(real, VERIFIED_OPEN_FLAGS)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, problem: 'missing' }
    if (code === 'ELOOP') return { ok: false, problem: 'symlink' }
    throw err
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) return { ok: false, problem: 'not-file' }
    if (expect !== undefined && !sameFile(st, expect)) return { ok: false, problem: 'changed' }
    if (!(await namesFile(real, st))) return { ok: false, problem: 'changed' }
    if (st.size > maxBytes) return { ok: false, problem: 'too-large' }
    const data = await readCapped(handle, Math.min(st.size, maxBytes), maxBytes)
    return data === null ? { ok: false, problem: 'too-large' } : { ok: true, data }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** `real` still resolves to itself (no symlink anywhere on it) and names the file `st` describes. */
async function namesFile(real: string, st: Stats): Promise<boolean> {
  try {
    if ((await realpath(real)) !== real) return false
    return sameFile(await stat(real), st)
  } catch {
    return false
  }
}

/**
 * Read from `handle` until the end: null past `maxBytes`. `expected` sizes the buffer (fstat's size,
 * already capped); one byte more is room to see that the file grew past the cap.
 */
async function readCapped(handle: FileHandle, expected: number, maxBytes: number): Promise<Buffer | null> {
  let buf = Buffer.alloc(expected + 1)
  let length = 0
  for (;;) {
    if (length === buf.length) {
      if (length > maxBytes) return null
      // Grew since the fstat but may still fit: make room, up to one byte past the cap.
      const bigger = Buffer.alloc(Math.min(buf.length * 2, maxBytes + 1))
      buf.copy(bigger, 0, 0, length)
      buf = bigger
    }
    const { bytesRead } = await handle.read(buf, length, buf.length - length, length)
    if (bytesRead === 0) break
    length += bytesRead
  }
  return length > maxBytes ? null : buf.subarray(0, length)
}
