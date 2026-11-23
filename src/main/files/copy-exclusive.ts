// Placing a finished temp file at a name that must not exist yet, on a filesystem that may have no hard
// links: the remote window's save into Downloads (`main/remote/remote-downloads.ts`) and an upload's
// commit (`upload-writer.ts`, design-upload.md §2.4) both link first and copy only when the link is
// refused for want of hard links. One copy, so a fix to either reaches both. Pure Node, no Electron.
import { constants as fsConstants, type Stats } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import { codeOf } from '../../shared/error-text'
import { sameFile } from '../verified-read'

/** Link errors of a filesystem with no hard links (exFAT, FAT32, some SMB, NFS and FUSE mounts). */
export const NO_HARD_LINKS: ReadonlySet<string> = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'])

/** Remove `path`, quietly: gone already is fine, and a cleanup must never throw over the real outcome. */
export async function remove(path: string): Promise<void> {
  await unlink(path).catch(() => undefined)
}

/**
 * What `removeIfOwn` did: `removed` (the entry was ours and is gone), `absent` (nothing at the path),
 * `other` (an entry that is not ours: left alone) or `failed` (the lstat or the unlink was refused, for
 * any reason but ENOENT: whatever is there may still be ours). A caller that keeps a record of the
 * path (the upload temps, swept at the next start) keeps it on `failed` only.
 */
export type RemoveOutcome = 'removed' | 'absent' | 'other' | 'failed'

/**
 * Remove `path` only while it is still the entry `own` names (same dev and inode): what this placement
 * linked or created there, not a file another process had put at the name before the check. `own` must
 * come from the caller's own descriptor (an `fstat`), never from a later `lstat` of the path: that would
 * name whatever is there now, another process's file included. Never throws.
 * `unlinkPath`: a test seam (an unlink refused), default `unlink`.
 *
 * Not atomic, and accepted (design-upload.md §13 "Name-based deletes"): POSIX has no "unlink only if this
 * inode", so an entry renamed over `path` between the `lstat` and the `unlink` (two syscalls) is deleted.
 * Every caller's name is one this run made a moment before with an exclusive create or link (so it was
 * free then) and goes only on a cancel or a failure, or is a random hidden temp name: winning needs a
 * process of the same OS user (CLAUDE.md: a tab's processes are, and not a boundary) aiming a rename at
 * that name inside that gap, which could unlink the file itself. Moving the name aside first (a rename
 * to a fresh name, then the check) only moves the gap to the new name, and the not-ours restore cannot
 * work where `copyExclusive` runs (no hard links), stranding another's file under a hidden name.
 */
export async function removeIfOwn(
  path: string,
  own: Pick<Stats, 'dev' | 'ino'>,
  unlinkPath: (path: string) => Promise<void> = unlink
): Promise<RemoveOutcome> {
  let now: Stats
  try {
    now = await lstat(path)
  } catch (err) {
    return codeOf(err) === 'ENOENT' ? 'absent' : 'failed'
  }
  if (now.dev !== own.dev || now.ino !== own.ino) return 'other'
  try {
    await unlinkPath(path)
  } catch (err) {
    // Gone meanwhile (by whoever): nothing of ours is left there either.
    return codeOf(err) === 'ENOENT' ? 'absent' : 'failed'
  }
  return 'removed'
}

/** The copy's chunk: one read and one write at a time, so a file of gigabytes never sits in memory. */
const COPY_CHUNK_BYTES = 1024 * 1024

export interface CopyOptions {
  /** The cancel: checked after every await, and a copy cancelled before it finished removes its file. */
  signal?: AbortSignal
  /**
   * The file `temp` must be (dev, inode): the source is opened `O_NOFOLLOW` and its `fstat` checked
   * before a byte is read, so a temp swapped for a link (or another file) since the caller's check is
   * never copied: a link there would otherwise hand any file the user can read to the final name.
   */
  source?: Pick<Stats, 'dev' | 'ino'>
  /** After each chunk written: an upload's idle clock restarts (a 2 GiB copy on a slow mount is not idle). */
  onChunk?: () => void
}

/**
 * `temp` copied to a new `final`: created with O_CREAT|O_EXCL|O_NOFOLLOW first (EEXIST on any entry, a
 * dangling link included, and never followed), then filled. A copy that fails after the create (the
 * temp unreadable, not `source`, ENOSPC, EIO) removes `final` only while it is still the file this call
 * created (same dev and inode). `copyFile` could not promise that: its error does not say whether it
 * got as far as creating the destination (it can fail opening the source), so a file another process
 * put at the name after the failed link would have been deleted by the cleanup. Resolves with the
 * created file's `fstat` (what a later cleanup checks against).
 */
export async function copyExclusive(temp: string, final: string, mode: number, opts: CopyOptions = {}): Promise<Stats> {
  const { signal, source, onChunk } = opts
  const out = await open(final, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode)
  let made: Stats | undefined
  // Every await below is followed by a look at the signal (the loop's top one follows the read and
  // the writes; nothing they make needs more than the catch's removal): a cancel that came while one
  // ran sends the copy to the catch, which removes it.
  try {
    made = await out.stat()
    // A cancel while the destination was made (the create on a slow mount): it is ours and goes.
    signal?.throwIfAborted()
    const src = await open(temp, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      signal?.throwIfAborted()
      const from = await src.stat()
      signal?.throwIfAborted()
      if (!from.isFile() || (source !== undefined && !sameFile(from, source))) throw new Error('the file to copy changed since it was checked')
      const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
      for (;;) {
        // A cancel (the window closed, the server forgotten) between chunks: a copy of gigabytes on a
        // slow mount must not finish into a saved file after it.
        signal?.throwIfAborted()
        const { bytesRead } = await src.read(buf, 0, buf.length, null)
        if (bytesRead === 0) break
        for (let at = 0; at < bytesRead; ) at += (await out.write(buf, at, bytesRead - at)).bytesWritten
        onChunk?.()
      }
    } finally {
      await src.close().catch(() => undefined)
    }
    // The last chunk written and then a cancel: still not placed, so removed like a partial.
    signal?.throwIfAborted()
    await out.close()
    // A cancel while the close ran (it flushes, and on a network mount that can take a while): the
    // file is whole but the save was cancelled before it was placed, so it goes like a partial too.
    // A second close in the catch below is a no-op on a closed handle.
    signal?.throwIfAborted()
    return made
  } catch (err) {
    await out.close().catch(() => undefined)
    // An fstat that failed leaves no identity to check against: the file stays rather than risk another's.
    if (made) await removeIfOwn(final, made)
    throw err
  }
}
