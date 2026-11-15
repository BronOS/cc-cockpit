// The remote window's save of a download into the desktop's Downloads folder (design-download.md §3.3).
// No Electron import: the item comes through `RemoteDownloadItem` (electron-remote-window.ts wraps
// Electron's DownloadItem; test/unit/remote-windows.test.ts drives a fake against a temp dir).
//
// Which downloads may save at all (the server's own `/d/` link, a fresh click, one at a time, the
// budget) is remote-windows.ts's decision; this file is what happens once one may:
//  - `setSavePath` must be called inside `will-download` (else Electron shows its own save dialog), so
//    nothing can probe for a free name first. The item saves to a hidden temp name of our own in
//    Downloads (`.cc-download-<16 random hex>`), never to a name the page chose;
//  - on completion the temp is linked to the final name with `fs.link`, which fails with EEXIST on any
//    existing entry, a symbolic link included: an existing file is never overwritten and a link the
//    server (or anything else) left at the name is never followed. Then `name (1).ext`, up to `(99)`;
//  - the bytes are capped (DESKTOP_DOWNLOAD_MAX_BYTES), declared and received: a file has no cap on
//    the server and a zip is chunked with no length, so the received count is checked on every update;
//  - a cancel, an interrupt, a cap, a failed link and the window closing all delete the partial; the
//    saved file has no exec bit (whatever mode it was written with), so it never runs by a double click
//    on Linux.
import { randomBytes } from 'node:crypto'
import { chmod, link, lstat, open, readdir, unlink } from 'node:fs/promises'
import { constants as fsConstants, type Stats } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP_DOWNLOAD_MAX_BYTES, downloadSizeText } from '../../shared/downloads'
import { codeOf, errorText } from '../../shared/error-text'

/** What a download is, as the adapter hands it over (Electron's DownloadItem, wrapped). */
export interface RemoteDownloadItem {
  /** The URL the download is for (the last of the chain). */
  url(): string
  /** Every URL it went through: one entry when nothing redirected it. */
  urlChain(): string[]
  /** The name the page suggested (`<a download>`, Content-Disposition): the page's, never trusted. */
  filename(): string
  /** The declared size; 0 when unknown (a chunked zip). */
  totalBytes(): number
  receivedBytes(): number
  /** Where it saves. Only inside the `will-download` call: later, Electron has shown its own dialog. */
  setSavePath(path: string): void
  cancel(): void
  /**
   * More bytes came, or the transfer `interrupted`: Electron reports a resumable failure (network
   * loss, a body shorter than its length, a disk or file error) here and never emits `done` for it.
   */
  onUpdated(listener: (state: 'progressing' | 'interrupted') => void): void
  /** It ended, once. */
  onDone(listener: (state: 'completed' | 'cancelled' | 'interrupted') => void): void
}

/** The temp name's prefix in Downloads: hidden (a leading dot), and never a name `desktopSaveName` makes. */
export const DOWNLOAD_TEMP_PREFIX = '.cc-download-'
/** Numbered names tried after the plain one: `name (1).ext` up to this. */
export const MAX_NAME_NUMBER = 99

/**
 * `name` with ` (n)` before its last extension (`report (1).pdf`, `notes (2)`); n = 0 is the name
 * itself. A leading dot is not an extension's (`desktopSaveName` drops them anyway).
 */
export function numberedName(name: string, n: number): string {
  if (n === 0) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
}

/** A refusal of our own, whose text the notice shows as is (a system error's would name the temp path). */
class PlaceError extends Error {}

/** Remove `path`, quietly: gone already is fine, and a cleanup must never throw over the real outcome. */
async function remove(path: string): Promise<void> {
  await unlink(path).catch(() => undefined)
}

/** Link errors of a filesystem with no hard links (exFAT, FAT32, some SMB, NFS and FUSE mounts). */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'])

/** Temps older than this are a dead save's: a live one writes (or stalls) far sooner than a day. */
const STALE_TEMP_MS = 24 * 60 * 60 * 1000

/**
 * Remove the `.cc-download-*` temps (and Chromium's `.crdownload` beside them) a crash or a quit left
 * in `dir`: hidden partials of up to the cap the person cannot see. Only those untouched for a day, so
 * a save of another running instance is never cut. Never throws.
 */
export async function sweepDownloadTemps(dir: string, now: number = Date.now()): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((n) => n.startsWith(DOWNLOAD_TEMP_PREFIX))
      .map(async (n) => {
        const path = join(dir, n)
        const st = await lstat(path).catch(() => undefined)
        if (st?.isFile() && now - st.mtimeMs > STALE_TEMP_MS) await remove(path)
      })
  )
}

/** The copy's chunk: one read and one write at a time, so a file of gigabytes never sits in memory. */
const COPY_CHUNK_BYTES = 1024 * 1024

/**
 * `temp` copied to a new `final`: created with O_CREAT|O_EXCL|O_NOFOLLOW first (EEXIST on any entry, a
 * dangling link included, and never followed), then filled. A copy that fails after the create (the
 * temp unreadable, ENOSPC, EIO) removes `final` only while it is still the file this call created (same
 * dev and inode). `copyFile` could not promise that: its error does not say whether it got as far as
 * creating the destination (it can fail opening the source), so a file another process put at the name
 * after the failed link would have been deleted by the cleanup.
 */
async function copyExclusive(temp: string, final: string, mode: number): Promise<void> {
  const out = await open(final, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode)
  let made: Stats | undefined
  try {
    made = await out.stat()
    const src = await open(temp, 'r')
    try {
      const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, buf.length, null)
        if (bytesRead === 0) break
        for (let at = 0; at < bytesRead; ) at += (await out.write(buf, at, bytesRead - at)).bytesWritten
      }
    } finally {
      await src.close().catch(() => undefined)
    }
    await out.close()
  } catch (err) {
    await out.close().catch(() => undefined)
    // An fstat that failed leaves no identity to check against: the file stays rather than risk another's.
    const now = made && (await lstat(final).catch(() => undefined))
    if (made && now && now.dev === made.dev && now.ino === made.ino) await remove(final)
    throw err
  }
}

/**
 * The finished temp file placed at `name` in `dir`, or the first free numbered name: hard-linked
 * (EEXIST, a link at the name included, is never overwritten and never followed), then the temp
 * removed. Its exec bits are cleared first. On a filesystem with no hard links the file is copied
 * instead (`copyExclusive`: the same EEXIST on any entry, never followed, and a failed copy removes
 * only its own file). Rejects with the reason when it is not a regular file, every name up to `(99)`
 * is taken, or the write fails.
 */
export async function placeDownload(temp: string, dir: string, name: string): Promise<string> {
  try {
    const st = await lstat(temp)
    if (!st.isFile()) throw new PlaceError('what was saved is not a file')
    // Masked to rw for everyone at most: never an exec bit, whatever umask or mode it was written with.
    const mode = st.mode & 0o666
    await chmod(temp, mode)
    for (let n = 0; n <= MAX_NAME_NUMBER; n++) {
      const final = join(dir, numberedName(name, n))
      try {
        await link(temp, final).catch(async (err: unknown) => {
          if (!NO_HARD_LINKS.has(codeOf(err) ?? '')) throw err
          await copyExclusive(temp, final, mode)
        })
        return final
      } catch (err) {
        if (codeOf(err) !== 'EEXIST') throw err
      }
    }
    throw new PlaceError(`${name} and every name up to "${numberedName(name, MAX_NAME_NUMBER)}" are taken in Downloads`)
  } finally {
    await remove(temp)
  }
}

/** How a save ended: the final path, or the reason it did not save (main's own words, for the notice). */
export type DownloadOutcome = { saved: string } | { failed: string }

export interface SaveOptions {
  item: RemoteDownloadItem
  /** The desktop's Downloads folder. */
  dir: string
  /** `desktopSaveName` of the page's name: where it ends up (or its numbered form). */
  name: string
  /** The window's progress bar: a fraction, unknown size, or none (cleared). */
  progress(value: number | 'indeterminate' | undefined): void
  /** Called once, after the partial is removed (a failure) or the file placed (saved). */
  done(outcome: DownloadOutcome): void
  log(message: string): void
}

/** A save in progress: `cancel` stops it and removes the partial (the window closed, the server forgotten). */
export interface ActiveSave {
  cancel(reason: string): void
}

/**
 * Save `item` under a fresh temp name in `dir` and place it at `name` once it completes. Must be
 * called inside `will-download` (it calls `setSavePath`). A declared size over the cap is the
 * caller's refusal, before this; a received count over it cancels here.
 */
export function startSave(options: SaveOptions): ActiveSave {
  const { item, dir, name } = options
  const temp = join(dir, `${DOWNLOAD_TEMP_PREFIX}${randomBytes(8).toString('hex')}`)
  item.setSavePath(temp)
  /** Why we cancelled it, when we did: the outcome names it instead of "cancelled". */
  let stopped: string | undefined
  let ended = false
  const cap = (): boolean => item.receivedBytes() > DESKTOP_DOWNLOAD_MAX_BYTES || item.totalBytes() > DESKTOP_DOWNLOAD_MAX_BYTES
  const overText = `it is larger than ${downloadSizeText(DESKTOP_DOWNLOAD_MAX_BYTES)}`
  const stop = (reason: string): void => {
    if (ended || stopped !== undefined) return
    stopped = reason
    item.cancel()
  }
  const finish = (outcome: DownloadOutcome): void => {
    options.progress(undefined)
    options.done(outcome)
  }
  options.progress(item.totalBytes() > 0 ? 0 : 'indeterminate')
  item.onUpdated((state) => {
    if (ended || stopped !== undefined) return
    // A resumable interrupt never reaches `done` and nothing here resumes it: stop it, so the cancel's
    // `done` removes the partial and frees the server's one saving slot.
    if (state === 'interrupted') {
      stop('the download was interrupted')
      return
    }
    if (cap()) {
      stop(overText)
      return
    }
    const total = item.totalBytes()
    options.progress(total > 0 ? Math.min(1, item.receivedBytes() / total) : 'indeterminate')
  })
  item.onDone((state) => {
    if (ended) return
    ended = true
    // A completed item past the cap (the last bytes came with no update): deleted all the same.
    if (state === 'completed' && stopped === undefined && cap()) stopped = overText
    if (state !== 'completed' || stopped !== undefined) {
      const reason = stopped ?? (state === 'cancelled' ? 'the download was cancelled' : 'the download was interrupted')
      // The temp, and Chromium's own in-progress name beside it should a kill have left one (it removes
      // its own on a cancel).
      void Promise.all([remove(temp), remove(`${temp}.crdownload`)]).then(() => finish({ failed: reason }))
      return
    }
    placeDownload(temp, dir, name).then(
      (saved) => finish({ saved }),
      (err: unknown) => {
        options.log(`remote download: could not place ${name}: ${errorText(err)}`)
        finish({ failed: err instanceof PlaceError ? err.message : 'it could not be written to Downloads' })
      }
    )
  })
  return { cancel: stop }
}
