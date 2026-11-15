// The folder walk behind a download's zip (design-download.md §1.4): which entries a folder's zip holds,
// under which names, and what was left out and why. Two users:
//   - the counting pass (`countFolder`) before a view gets anything: the caps checked up front ("too large",
//     "too many files to count" past DOWNLOAD_WALK_MS), and for a `ccc download` offer both totals, without
//     and with `.git` / `node_modules`, so the dialog can show both sizes beside its checkbox;
//   - the zip writer (`walkFolder`), which streams the same entries in the same order and opens each file
//     through `openVerified` (the walk's lstat is the `expect`, so a file swapped meanwhile is refused).
//
// Never follows a link: every entry is `lstat`ed and a symlink is skipped, not resolved (following them
// means cycles, duplicates, and a link inside the project leading to `~/.ssh`). The root is the caller's
// realpath, so every path below it is real too and the outside rule and the data-dir rule can be applied
// to it as is (both want real paths). Depth is bounded (DOWNLOAD_WALK_MAX_DEPTH), so a hostile tree cannot
// exhaust the stack. Every fs call is raced against the signal: a hung `lstat` on a dead network mount
// would otherwise hold the walk (and the 10 s bound) forever; the call itself is left to finish on the
// thread pool. Names are read as bytes (`readdir` with `encoding: 'buffer'`): one that is not UTF-8 would
// be decoded lossily as a string and then name a different file, or none. A folder is re-`lstat`ed after
// its listing and must be the same dev and inode, so one swapped for a link in between is skipped; a file
// the process cannot read is still counted here (the writer's open skips it, a counted `unreadable` skip).
//
// Pure Node, no Electron (the plan's rule for `main/files/downloads.ts` and its helpers).
import type { Stats } from 'node:fs'
import { lstat as fsLstat, opendir as fsOpendir } from 'node:fs/promises'
import path from 'node:path'
import {
  DOWNLOAD_FALLBACK_NAME,
  DOWNLOAD_WALK_MAX_DEPTH,
  DOWNLOAD_WALK_MS,
  DOWNLOAD_ZIP_MAX_BYTES,
  DOWNLOAD_ZIP_MAX_ENTRIES,
  type DownloadSkipped,
  type DownloadSkipReason,
  type DownloadTotals,
} from '../../shared/downloads'
import { dataDirRefused, outsideRefused, type OutsideEnv } from '../../shared/outside-paths'
import { CONTROL } from '../../shared/session-name'
import { ZipCapError } from './zip-writer'

/** The folders a zip leaves out below its root unless the person includes them (the root itself always works). */
export const EXCLUDED_FOLDER_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules'])

/** The fs calls the walk makes; tests swap in a slow one (the 10 s bound). */
export interface WalkFs {
  lstat(p: string): Promise<Stats>
  readdir(p: string): Promise<Buffer[]>
}

// Names only, then an lstat each: readdir's `withFileTypes` would save the lstat, but its type is the
// folder listing's, and the lstat is also the `expect` the writer's openVerified checks against.
const nodeFs: WalkFs = {
  lstat: (p) => fsLstat(p),
  // `opendir`, stopping past the entry cap: a folder with more names than a zip may hold is over the cap
  // by itself, and `readdir` would load every name into main's memory first. The listing it returns is
  // then cut short, so the walk treats more than DOWNLOAD_ZIP_MAX_ENTRIES names as an overflow, never as
  // the folder's contents (`overflowed`).
  readdir: async (p) => {
    const dir = await fsOpendir(p, { encoding: 'buffer' as unknown as BufferEncoding })
    const names: Buffer[] = []
    try {
      for await (const d of dir) {
        names.push(d.name as unknown as Buffer)
        if (names.length > DOWNLOAD_ZIP_MAX_ENTRIES) break
      }
    } finally {
      await dir.close().catch(() => undefined)
    }
    return names
  },
}

export interface WalkOptions {
  /** The folder's realpath (absolute). The caller has already checked it (inside the project or allowed outside, not the data dir, not `/` or the home). */
  root: string
  /** The name the zip's entries start with: the basename of the path as named (a link's name, not its target's). */
  rootName: string
  /** Walk into `.git` and `node_modules` folders below the root (the person's choice). */
  includeAll: boolean
  /** The root lies outside the project: every entry must pass the outside rule too (naming the parent must not skip it). */
  outside: boolean
  env: OutsideEnv
  /** The realpath of the app's data dir: skipped wherever it lies, inside a project as much as outside. */
  dataDir: string
  signal?: AbortSignal
  /** Tests only. */
  fs?: WalkFs
}

export interface WalkEntry {
  kind: 'file' | 'folder'
  /** The entry on disk: below the root with no link on the way. */
  path: string
  /** Its name in the zip: `<root name>/<relative>` with `/`; a folder's ends in `/`. */
  name: string
  /** The walk's `lstat`: size, mode and mtime for the zip, dev and inode for `openVerified`'s `expect`. */
  stat: Stats
}

type Item =
  | { type: 'entry'; entry: WalkEntry; within: boolean }
  | { type: 'skip'; reason: DownloadSkipReason; within: boolean }
  /** A `.git` / `node_modules` folder below the root, found while not walking into them (`excluded` for the plain totals). */
  | { type: 'excluded' }
  /**
   * A folder with more names than a zip may hold (its listing was cut there): over the entry cap. Never
   * a skip: the names past the cut were not read, and many of the ones read may be skipped links, so a
   * zip of what was read would leave out files without counting them.
   */
  | { type: 'overflow'; within: boolean }

/**
 * Whether a name read from a folder is one a receiving system reads as written: valid UTF-8 (the bytes
 * as read; otherwise null), no `\` (a separator on Windows, where `a\..\..\x` leaves the extracted
 * folder), no control, bidi or invisible format characters (a U+202E shows the rest reversed in a file
 * manager). `/` cannot occur in a name read from a folder.
 */
export function walkName(raw: Buffer): string | null {
  let name: string
  try {
    name = UTF8.decode(raw)
  } catch {
    return null
  }
  return nameAllowed(name) ? name : null
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function nameAllowed(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('\\') && !name.includes('/') && !CONTROL.test(name)
}

/** The zip's root name: the named folder's basename, or `download` when it fails the name filter (or is empty, as `/`'s is). */
export function zipRootName(name: string): string {
  return nameAllowed(name) ? name : DOWNLOAD_FALLBACK_NAME
}

/** `p` rejected when `signal` aborts first, with the signal's reason; the fs call itself is not stopped. */
function raced<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p
  if (signal.aborted) {
    p.catch(() => undefined) // already started: its failure must not be unhandled
    signal.throwIfAborted()
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/** Whether a folder's listing was cut at the cap (`nodeFs.readdir` stops one past it). */
function overflowed(names: Buffer[]): boolean {
  return names.length > DOWNLOAD_ZIP_MAX_ENTRIES
}

/** Whether `p` is still the folder `before` was (not swapped for a link or another folder since). */
async function sameFolder(fs: WalkFs, p: string, before: Stats, signal: AbortSignal | undefined): Promise<boolean> {
  const now = await raced(fs.lstat(p), signal)
  return now.isDirectory() && now.dev === before.dev && now.ino === before.ino
}

/** Control the walker reads between items: set by the counting pass once the "with" totals are over a cap. */
interface Steering {
  /** Stop walking into `.git` / `node_modules` (their totals no longer matter). */
  pruneWithin: boolean
}

/**
 * The walk itself: every entry below the root, depth-first, each folder's entry before its contents,
 * names in sorted order (a fixed tree always gives the same zip). `markWithin`: walk into `.git` /
 * `node_modules` but tell their entries apart (the counting pass's two totals); otherwise
 * `opts.includeAll` decides. Throws when the root cannot be listed, and the signal's reason on abort.
 */
async function* walkItems(opts: WalkOptions, markWithin: boolean, steer: Steering): AsyncGenerator<Item> {
  const fs = opts.fs ?? nodeFs
  const signal = opts.signal
  const rootName = zipRootName(opts.rootName)
  const rootStat = await raced(fs.lstat(opts.root), signal)
  if (!rootStat.isDirectory()) throw new Error('not a folder')
  const names = await raced(fs.readdir(opts.root), signal)
  if (!(await sameFolder(fs, opts.root, rootStat, signal))) throw new Error('not a folder')
  if (overflowed(names)) {
    yield { type: 'overflow', within: false }
    return
  }
  yield { type: 'entry', entry: { kind: 'folder', path: opts.root, name: `${rootName}/`, stat: rootStat }, within: false }
  yield* walkChildren(opts.root, `${rootName}/`, names, 1, false)

  async function* walkChildren(dir: string, prefix: string, raw: Buffer[], depth: number, within: boolean): AsyncGenerator<Item> {
    const named: string[] = []
    for (const r of raw) {
      const name = walkName(r)
      if (name === null) yield { type: 'skip', reason: 'name', within }
      else named.push(name)
    }
    // Code-unit order: fixed for a fixed tree, whatever order the filesystem lists in.
    named.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (const name of named) {
      signal?.throwIfAborted()
      if (within && steer.pruneWithin) return
      if (depth > DOWNLOAD_WALK_MAX_DEPTH) {
        yield { type: 'skip', reason: 'deep', within }
        continue
      }
      const abs = path.join(dir, name)
      // By path before any stat: a refused entry is not even looked at (and its subtree not walked).
      if (dataDirRefused(abs, opts.dataDir, opts.env.platform)) {
        yield { type: 'skip', reason: 'dataDir', within }
        continue
      }
      if (opts.outside && outsideRefused(abs, opts.env)) {
        yield { type: 'skip', reason: 'refused', within }
        continue
      }
      let st: Stats
      try {
        st = await raced(fs.lstat(abs), signal)
      } catch (err) {
        if (signal?.aborted) throw err
        yield { type: 'skip', reason: 'unreadable', within }
        continue
      }
      if (st.isSymbolicLink()) {
        yield { type: 'skip', reason: 'symlink', within }
        continue
      }
      if (st.isFile()) {
        yield { type: 'entry', entry: { kind: 'file', path: abs, name: prefix + name, stat: st }, within }
        continue
      }
      if (!st.isDirectory()) {
        yield { type: 'skip', reason: 'special', within }
        continue
      }
      // Below the root only: `.git` or `node_modules/foo` named as the root always works. One inside an
      // excluded folder is already `within` and not counted again.
      const excluded = EXCLUDED_FOLDER_NAMES.has(name) && !within
      if (excluded && markWithin) {
        yield { type: 'excluded' }
        if (steer.pruneWithin) continue
      } else if (excluded && !opts.includeAll) {
        yield { type: 'excluded' }
        continue
      }
      const childWithin = within || (markWithin && excluded)
      let children: Buffer[]
      try {
        // Listed before its entry is given: a folder that cannot be read is skipped whole, not zipped empty.
        children = await raced(fs.readdir(abs), signal)
        // lstat then readdir is a gap: a folder swapped for a link meanwhile was listed through it.
        if (!(await sameFolder(fs, abs, st, signal))) throw new Error('changed')
      } catch (err) {
        if (signal?.aborted) throw err
        yield { type: 'skip', reason: 'unreadable', within: childWithin }
        continue
      }
      if (overflowed(children)) {
        yield { type: 'overflow', within: childWithin }
        continue
      }
      yield { type: 'entry', entry: { kind: 'folder', path: abs, name: `${prefix}${name}/`, stat: st }, within: childWithin }
      yield* walkChildren(abs, `${prefix}${name}/`, children, depth + 1, childWithin)
    }
  }
}

/**
 * The zip's entries, streamed (the zip writer's input): the root folder first, then depth-first in
 * sorted order. Skips are added up in `skipped` as they happen. Throws when the root cannot be listed,
 * and the signal's reason on abort (the writer's `pipeline` aborts it when the browser goes away).
 * The caps are the writer's to enforce mid-stream; the counting pass checked them before. A folder
 * with more names than the cap (grown since the count) throws ZipCapError: the zip is cut, never sent
 * complete without the names past the listing's cut.
 */
export async function* walkFolder(opts: WalkOptions, skipped: DownloadSkipped = {}): AsyncGenerator<WalkEntry> {
  for await (const item of walkItems(opts, false, { pruneWithin: false })) {
    if (item.type === 'entry') yield item.entry
    else if (item.type === 'overflow') throw new ZipCapError('entries')
    else bump(skipped, item.type === 'excluded' ? 'excluded' : item.reason)
  }
}

export type CountProblem =
  /** Past DOWNLOAD_ZIP_MAX_BYTES of file bytes or DOWNLOAD_ZIP_MAX_ENTRIES entries. */
  | 'too-large'
  /** The walk did not finish in DOWNLOAD_WALK_MS ("too many files to count"). */
  | 'timeout'

/**
 * Which cap a too-large count passed. Carried, not re-derived from the totals: a folder whose listing
 * overflowed stops the count with totals far under both caps (20,001 empty names, never added), and
 * the refusal must still name the entry limit.
 */
export type CountCap = ZipCapError['cap']

export type FolderCount =
  | {
      ok: true
      /** Without `.git` / `node_modules` below the root. */
      plain: DownloadTotals
      /**
       * With them; equal to `plain` when the tree holds neither. When `allOver` is set the walk stopped
       * counting them past a cap (`allCap`), so these are a lower bound and the include choice is too large.
       */
      all: DownloadTotals
      allOver?: CountProblem
      allCap?: CountCap
      skipped: { plain: DownloadSkipped; all: DownloadSkipped }
    }
  /** `cap` is set with `too-large`. */
  | { ok: false; problem: CountProblem; cap?: CountCap; plain: DownloadTotals }

export interface CountOptions extends Omit<WalkOptions, 'includeAll'> {
  /** Tests only: the bound instead of DOWNLOAD_WALK_MS. */
  timeoutMs?: number
  /** Tests only: the caps instead of the shared ones. */
  maxBytes?: number
  maxEntries?: number
}

/**
 * The counting pass before a view gets anything: both totals (without and with `.git` /
 * `node_modules`), bounded by the caps and by DOWNLOAD_WALK_MS. The plain totals over a cap (or the
 * time running out) fail the whole count: no choice would fit. The "with" totals over a cap only stop
 * counting them (`allOver`): the plain download still works, and walking a huge `node_modules` to the
 * end would spend the 10 s for nothing. Throws when the root cannot be listed, and the caller's abort
 * reason on its abort.
 */
export async function countFolder(opts: CountOptions): Promise<FolderCount> {
  const maxBytes = opts.maxBytes ?? DOWNLOAD_ZIP_MAX_BYTES
  const maxEntries = opts.maxEntries ?? DOWNLOAD_ZIP_MAX_ENTRIES
  const timer = new AbortController()
  const timeout = setTimeout(() => timer.abort(new CountTimeout()), opts.timeoutMs ?? DOWNLOAD_WALK_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timer.signal]) : timer.signal
  const plain: DownloadTotals = { files: 0, folders: 0, bytes: 0 }
  const all: DownloadTotals = { files: 0, folders: 0, bytes: 0 }
  const skipped = { plain: {} as DownloadSkipped, all: {} as DownloadSkipped }
  const steer: Steering = { pruneWithin: false }
  let allOver: CountProblem | undefined
  let allCap: CountCap | undefined
  const over = (t: DownloadTotals): CountCap | undefined =>
    t.files + t.folders > maxEntries ? 'entries' : t.bytes > maxBytes ? 'bytes' : undefined
  try {
    for await (const item of walkItems({ ...opts, includeAll: true, signal }, true, steer)) {
      if (item.type === 'excluded') {
        bump(skipped.plain, 'excluded')
        continue
      }
      if (item.type === 'overflow') {
        // Over the cap whatever else the folder holds: a plain one fails the count, one inside `.git` /
        // `node_modules` only makes the include choice too large.
        if (!item.within) return { ok: false, problem: 'too-large', cap: 'entries', plain }
        allOver = 'too-large'
        allCap = 'entries'
        steer.pruneWithin = true
        continue
      }
      if (item.type === 'skip') {
        bump(skipped.all, item.reason)
        if (!item.within) bump(skipped.plain, item.reason)
        continue
      }
      const add = (t: DownloadTotals): void => {
        if (item.entry.kind === 'file') {
          t.files++
          t.bytes += item.entry.stat.size
        } else t.folders++
      }
      if (allOver === undefined) add(all)
      if (!item.within) add(plain)
      const plainCap = over(plain)
      if (plainCap) return { ok: false, problem: 'too-large', cap: plainCap, plain }
      const cap = allOver === undefined ? over(all) : undefined
      if (cap) {
        allOver = 'too-large'
        allCap = cap
        steer.pruneWithin = true
      }
    }
  } catch (err) {
    // Only our own timer's abort is a count result; the caller's abort and fs errors are the caller's.
    if (timer.signal.aborted && !opts.signal?.aborted && err === timer.signal.reason) return { ok: false, problem: 'timeout', plain }
    throw err
  } finally {
    clearTimeout(timeout)
  }
  return allOver === undefined ? { ok: true, plain, all, skipped } : { ok: true, plain, all, allOver, allCap, skipped }
}

class CountTimeout extends Error {
  constructor() {
    super('too many files to count')
    this.name = 'CountTimeout'
  }
}

function bump(skipped: DownloadSkipped, reason: DownloadSkipReason): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1
}
