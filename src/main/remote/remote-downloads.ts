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
//  - a cancel, an interrupt, a cap, a failed link and the window closing all delete the partial (the
//    window closing or the server forgotten during the placement too: a copy is checked between chunks
//    and removed, and only a placement that already finished stays); on macOS a Downloads folder with
//    no hard links refuses the save (a copy would drop the quarantine mark, see `placeDownload`); the
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

/**
 * Remove `path` only while it is still the entry `own` names (same dev and inode): what this placement
 * linked or created there, never a file another process put at the name meanwhile. Never throws.
 */
async function removeIfOwn(path: string, own: Pick<Stats, 'dev' | 'ino'>): Promise<void> {
  const now = await lstat(path).catch(() => undefined)
  if (now && now.dev === own.dev && now.ino === own.ino) await remove(path)
}

/** Link errors of a filesystem with no hard links (exFAT, FAT32, some SMB, NFS and FUSE mounts). */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'])

/** Why a macOS save to a Downloads folder with no hard links is refused (the notice's words). */
export const NO_QUARANTINE_TEXT = "the Downloads folder is on a drive with no hard links, and a copy there would lose macOS's download warning"

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
async function copyExclusive(temp: string, final: string, mode: number, signal: AbortSignal | undefined): Promise<void> {
  const out = await open(final, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode)
  let made: Stats | undefined
  // Every await below is followed by a look at the signal (the loop's top one follows the read and
  // the writes; nothing they make needs more than the catch's removal): a cancel that came while one
  // ran sends the copy to the catch, which removes it.
  try {
    made = await out.stat()
    // A cancel while the destination was made (the create on a slow mount): it is ours and goes.
    signal?.throwIfAborted()
    const src = await open(temp, 'r')
    try {
      signal?.throwIfAborted()
      const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
      for (;;) {
        // A cancel (the window closed, the server forgotten) between chunks: a copy of gigabytes on a
        // slow mount must not finish into a saved file after it.
        signal?.throwIfAborted()
        const { bytesRead } = await src.read(buf, 0, buf.length, null)
        if (bytesRead === 0) break
        for (let at = 0; at < bytesRead; ) at += (await out.write(buf, at, bytesRead - at)).bytesWritten
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
  } catch (err) {
    await out.close().catch(() => undefined)
    // An fstat that failed leaves no identity to check against: the file stays rather than risk another's.
    if (made) await removeIfOwn(final, made)
    throw err
  }
}

export interface PlaceOptions {
  /** The save's cancel (the window closed, the server forgotten). */
  signal?: AbortSignal
  /** Tests only: default `process.platform` (macOS refuses the copy fallback). */
  platform?: NodeJS.Platform
}

/**
 * The finished temp file placed at `name` in `dir`, or the first free numbered name: hard-linked
 * (EEXIST, a link at the name included, is never overwritten and never followed), then the temp
 * removed. Its exec bits are cleared first. On a filesystem with no hard links the file is copied
 * instead (`copyExclusive`: the same EEXIST on any entry, never followed, and a failed copy removes
 * only its own file), except on macOS, where that is refused: Chromium marked the temp with
 * `com.apple.quarantine` (Gatekeeper's check on first open), a hard link keeps it (the same inode and
 * its xattrs), and a byte copy would not, so a copied app or script would open with no warning.
 * Copying the xattr needs a native call (`copyfile(3)`); refusing is the smaller, safe answer (the
 * person moves Downloads, or saves from a browser). Rejects with the reason when it is not a regular
 * file, every name up to `(99)` is taken, the write fails or a macOS copy is refused, and with
 * `signal`'s reason when it aborts first (checked after every await: before each name, after a link,
 * after a copy's create, source open, chunks and close): the temp and any link or copy this call made
 * at the name are removed (only while still the same inode); one that finished before the abort is the
 * placed file and stays. Not raced: each fs call is awaited, so `done` comes after the cleanup.
 */
export async function placeDownload(temp: string, dir: string, name: string, opts: PlaceOptions = {}): Promise<string> {
  const { signal } = opts
  const platform = opts.platform ?? process.platform
  try {
    const st = await lstat(temp)
    if (!st.isFile()) throw new PlaceError('what was saved is not a file')
    // Masked to rw for everyone at most: never an exec bit, whatever umask or mode it was written with.
    const mode = st.mode & 0o666
    // A cancel during the lstat or the chmod: they touch only the temp, which the finally removes;
    // the loop's first look at the signal follows them.
    await chmod(temp, mode)
    for (let n = 0; n <= MAX_NAME_NUMBER; n++) {
      signal?.throwIfAborted()
      const final = join(dir, numberedName(name, n))
      try {
        let linked = true
        await link(temp, final).catch(async (err: unknown) => {
          if (!NO_HARD_LINKS.has(codeOf(err) ?? '')) throw err
          if (platform === 'darwin') throw new PlaceError(NO_QUARANTINE_TEXT)
          linked = false
          await copyExclusive(temp, final, mode, signal)
        })
        // A cancel while the link ran and it succeeded anyway (a slow mount): not placed, so the name
        // goes, while it is still the temp's inode (a link shares it; a file someone put there after
        // is not ours). The throw is the reason's, never EEXIST, so no other name is tried.
        if (linked && signal?.aborted) {
          await removeIfOwn(final, st)
          signal.throwIfAborted()
        }
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
/**
 * How a save ended. `placement`: it failed while placing the completed file in Downloads (the names
 * taken, a write error), a reason that speaks of the folder's contents, so it is never shown to the
 * server's page (remote-windows.ts `showNotice`).
 */
export type DownloadOutcome = { saved: string } | { failed: string; placement?: true }

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
  /** Tests only: placeDownload's platform. */
  platform?: NodeJS.Platform
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
  /**
   * The placement after the item completed (a link, or on a filesystem with no hard links a copy of up
   * to the cap): `stop` aborts it, so the window closing during a copy of gigabytes saves nothing.
   */
  let placing: AbortController | undefined
  const cap = (): boolean => item.receivedBytes() > DESKTOP_DOWNLOAD_MAX_BYTES || item.totalBytes() > DESKTOP_DOWNLOAD_MAX_BYTES
  const overText = `it is larger than ${downloadSizeText(DESKTOP_DOWNLOAD_MAX_BYTES)}`
  const stop = (reason: string): void => {
    if (stopped !== undefined) return
    if (ended) {
      // Done already: only a placement still running can be stopped (a finished one, or a failed
      // item's cleanup, has nothing left to cancel).
      if (!placing) return
      stopped = reason
      placing.abort(new PlaceError(reason))
      return
    }
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
    const placement = new AbortController()
    placing = placement
    placeDownload(temp, dir, name, { signal: placement.signal, platform: options.platform }).then(
      // Placed before the cancel could stop it: the file is there, and saved is the truth.
      (saved) => {
        placing = undefined
        finish({ saved })
      },
      (err: unknown) => {
        placing = undefined
        if (placement.signal.aborted && stopped !== undefined) {
          finish({ failed: stopped })
          return
        }
        options.log(`remote download: could not place ${name}: ${errorText(err)}`)
        finish({ failed: err instanceof PlaceError ? err.message : 'it could not be written to Downloads', placement: true })
      }
    )
  })
  return { cancel: stop }
}
