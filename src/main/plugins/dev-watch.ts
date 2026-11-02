// Dev reload of linked plugins (design §5 Lifecycle: "A linked dev folder is watched; a change
// reloads that plugin in every open host"; plan Task 29).
//
//   watch     one watcher per linked folder (the installer's index is the list; `sync()` opens the
//             missing ones and closes those of plugins unlinked or uninstalled since).
//   debounce  an editor save is several file events, a build writes dozens: they settle for 300 ms
//             before anything happens. `node_modules` and `.git` never count (an `npm install` or
//             a commit would reload the plugin for nothing, and could loop with a plugin that
//             writes there).
//   reload    re-validate the manifest (installer), then reload the plugin in every open host
//             (host-manager devReload: deactivate, forget its modules, activate; panels reload).
//             An invalid manifest takes the plugin down with the reason; fixing the file brings it
//             back, so the watcher stays on while a plugin is invalid.
//
// A change that arrives while a reload runs queues exactly one more run after it: the files the
// running reload read may already be stale.
//
// Failure containment: a watcher error is logged and never thrown (an `error` event with no
// listener would crash main); the real watcher falls back to polling when fs.watch fails. The
// services (installer, host manager, the OS watcher) are injected, so tests drive time with fake
// timers and a fake watcher.
import { createHash } from 'node:crypto'
import { existsSync, watch as fsWatch, statSync, promises as fs, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { errorText, toError } from '../../shared/error-text'

export const DEBOUNCE_MS = 300
export const POLL_INTERVAL_MS = 2000
/** The polling scan stops looking after this many files (a linked folder with a vendored tree). */
const MAX_POLLED_ENTRIES = 20_000

/**
 * Folders whose changes never reload a plugin. A plugin that writes into its own folder (logs,
 * cache, build output) outside these would reload itself after every activate: keep such files
 * in the plugin's data dir (ctx.dataDir lives under the app data dir, never in this folder).
 */
const IGNORED_DIRS = new Set(['node_modules', '.git'])

/**
 * True when `rel` (a path relative to the plugin folder, either separator) is inside an ignored
 * directory. A file NAMED like one (`node_modules`) is ignored too: no real plugin has one.
 */
export function isIgnoredPath(rel: string): boolean {
  return rel.split(/[\\/]+/).some((segment) => IGNORED_DIRS.has(segment))
}

/**
 * True when `rel` lies inside a nested folder (below the plugin root) that has its own
 * `plugin.json`: that is another plugin, with its own link and watcher, and its edits must not
 * reload this one (a parent around `jev-demo/` reloaded with every demo edit). The root's own
 * plugin.json is not a nested one: only the directories above the file count.
 */
export function isInNestedPlugin(root: string, rel: string): boolean {
  const parts = rel.split(/[\\/]+/).filter((p) => p !== '')
  let dir = root
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part)
    if (existsSync(join(dir, 'plugin.json'))) return true
  }
  // The event for the nested folder itself (created or removed with its manifest inside).
  return parts.length > 0 && existsSync(join(dir, parts[parts.length - 1] as string, 'plugin.json'))
}

export interface FolderWatch {
  close(): void
}

/** Starts watching `dir`; `onChange` gets the changed path relative to `dir` when known. */
export type FolderWatcherFactory = (
  dir: string,
  onChange: (relPath?: string) => void,
  onError: (err: Error) => void
) => FolderWatch

export interface LinkedPlugin {
  id: string
  /** The linked folder (absolute). */
  dir: string
}

export interface DevWatcherDeps {
  /** The linked plugins right now (PluginInstaller.list(), linked entries). */
  linked(): LinkedPlugin[]
  /**
   * Check the plugin's manifest again (PluginInstaller.revalidate). `{ ok: false, reason }` when it
   * is invalid; undefined when it is no longer a linked plugin.
   */
  revalidate(id: string): Promise<{ ok: true } | { ok: false; reason: string } | undefined>
  /** Reload it in every open host (HostManager.devReload); `problem` is the invalid reason. */
  reload(id: string, problem?: string): Promise<void>
  watch: FolderWatcherFactory
  debounceMs?: number
  log?: (message: string) => void
}

interface Watched {
  dir: string
  watch: FolderWatch
  timer?: ReturnType<typeof setTimeout>
  running: boolean
  /** A change arrived while a reload ran. */
  again: boolean
}

export class DevWatcher {
  private readonly watched = new Map<string, Watched>()
  private readonly debounceMs: number
  private readonly log: (message: string) => void
  private disposed = false

  constructor(private readonly deps: DevWatcherDeps) {
    this.debounceMs = deps.debounceMs ?? DEBOUNCE_MS
    this.log = deps.log ?? ((m) => console.warn(m))
  }

  /** Ids with an open watcher (tests and diagnostics). */
  watchedIds(): string[] {
    return [...this.watched.keys()]
  }

  /**
   * Make the open watchers those of the linked plugins now: new ones open, those of plugins that
   * are gone (or moved to another folder) close. Cheap and idempotent; the installer calls it
   * after every change to the plugin set.
   */
  sync(): void {
    if (this.disposed) return
    let linked: LinkedPlugin[]
    try {
      linked = this.deps.linked()
    } catch (err) {
      this.log(`dev watch: cannot list linked plugins: ${errorText(err)}`)
      return
    }
    const want = new Map(linked.map((l) => [l.id, l.dir]))
    for (const [id, w] of [...this.watched]) {
      if (want.get(id) !== w.dir) this.stop(id)
    }
    for (const [id, dir] of want) {
      if (!this.watched.has(id)) this.start(id, dir)
    }
  }

  /** Close every watcher and cancel pending reloads (app quit). */
  dispose(): void {
    this.disposed = true
    for (const id of [...this.watched.keys()]) this.stop(id)
  }

  private start(id: string, dir: string): void {
    let watch: FolderWatch
    try {
      watch = this.deps.watch(
        dir,
        (rel) => {
          if (rel !== undefined && (isIgnoredPath(rel) || isInNestedPlugin(dir, rel))) return
          this.changed(id)
        },
        (err) => this.log(`dev watch ${id}: ${errorText(err)}`)
      )
    } catch (err) {
      // Not watched until the next sync(); the plugin itself still works.
      this.log(`dev watch ${id}: cannot watch ${dir}: ${errorText(err)}`)
      return
    }
    this.watched.set(id, { dir, watch, running: false, again: false })
  }

  private stop(id: string): void {
    const w = this.watched.get(id)
    if (!w) return
    this.watched.delete(id)
    if (w.timer !== undefined) clearTimeout(w.timer)
    try {
      w.watch.close()
    } catch (err) {
      this.log(`dev watch ${id}: closing the watcher failed: ${errorText(err)}`)
    }
  }

  private changed(id: string): void {
    const w = this.watched.get(id)
    if (!w || this.disposed) return
    if (w.running) {
      w.again = true
      return
    }
    if (w.timer !== undefined) clearTimeout(w.timer)
    w.timer = setTimeout(() => {
      w.timer = undefined
      void this.run(id, w)
    }, this.debounceMs)
    // A pending reload must not keep main alive at quit.
    w.timer.unref?.()
  }

  private async run(id: string, w: Watched): Promise<void> {
    w.running = true
    try {
      const state = await this.deps.revalidate(id)
      // Unlinked while the debounce ran: nothing to reload.
      if (state === undefined || this.watched.get(id) !== w) return
      await this.deps.reload(id, state.ok ? undefined : state.reason)
    } catch (err) {
      this.log(`dev watch ${id}: reload failed: ${errorText(err)}`)
    } finally {
      w.running = false
      if (w.again && this.watched.get(id) === w) {
        w.again = false
        this.changed(id)
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The real watcher
// ---------------------------------------------------------------------------------------------

/**
 * `fs.watch` with `recursive` where Node supports it on the OS' native API (macOS, Windows);
 * polling elsewhere (Linux: inotify has no recursive mode of its own, and Node's emulation walks
 * the tree once up front, which a big dev folder pays for at every launch) and whenever fs.watch
 * fails or errors (too many open files, an unsupported filesystem).
 */
export function createFolderWatcher(platform: NodeJS.Platform = process.platform, pollMs = POLL_INTERVAL_MS): FolderWatcherFactory {
  return (dir, onChange, onError) => {
    const native = platform === 'darwin' || platform === 'win32'
    let poll: FolderWatch | undefined
    let fsw: FSWatcher | undefined
    let ino: number | undefined
    let closed = false
    const startPolling = (): void => {
      if (!closed && !poll) poll = pollFolder(dir, onChange, onError, pollMs)
    }
    if (native) {
      try {
        const open = (): void => {
          const opened = fsWatch(dir, { recursive: true, persistent: false }, (event, name) => {
            onChange(name?.toString())
            // The folder swapped for a new one (checkout, rsync --delete) leaves this watcher
            // on the dead inode, silently and without an 'error': on a rename, compare the
            // folder's identity and watch the new one.
            if (event === 'rename' && !closed && fsw === opened) reopenIfSwapped()
          })
          // Without a listener an 'error' event is an uncaught exception in main.
          opened.on('error', (err) => {
            onError(err)
            opened.close()
            if (fsw === opened) fsw = undefined
            startPolling()
          })
          fsw = opened
          try {
            ino = statSync(dir).ino
          } catch {
            ino = undefined
          }
        }
        const reopenIfSwapped = (): void => {
          let now: number
          try {
            now = statSync(dir).ino
          } catch {
            return // gone for now: the next event after it is recreated checks again
          }
          if (now === ino) return
          fsw?.close()
          fsw = undefined
          try {
            open()
          } catch (err) {
            onError(toError(err))
            startPolling()
          }
        }
        open()
      } catch (err) {
        onError(toError(err))
        startPolling()
      }
    } else {
      startPolling()
    }
    return {
      close: () => {
        closed = true
        fsw?.close()
        fsw = undefined
        poll?.close()
        poll = undefined
      }
    }
  }
}

/**
 * Poll the folder: a signature of every file's path, size and mtime (without `node_modules` and
 * `.git`, no symlink followed) every `intervalMs`; a different signature is a change. The first
 * scan is the baseline. A folder that disappears is a change too (the manifest check then says why
 * the plugin is invalid). `maxEntries` is the scan cap; injectable only so a test can pass the cap
 * with a few files instead of creating twenty thousand.
 */
export function pollFolder(
  dir: string,
  onChange: (relPath?: string) => void,
  onError: (err: Error) => void,
  intervalMs = POLL_INTERVAL_MS,
  maxEntries = MAX_POLLED_ENTRIES
): FolderWatch {
  let previous: string | undefined
  let scanning = false
  let closed = false
  let failing = false
  let warnedCap = false
  const tick = async (): Promise<void> => {
    if (scanning || closed) return
    scanning = true
    try {
      const { signature, truncated } = await folderSignature(dir, maxEntries)
      failing = false
      // Past the cap later entries are never seen: say so once instead of going quiet.
      if (truncated && !warnedCap) {
        warnedCap = true
        onError(new Error(`more than ${maxEntries} files: changes in later entries are not detected`))
      }
      if (closed) return
      if (previous !== undefined && signature !== previous) onChange()
      previous = signature
    } catch (err) {
      // Once per streak: a permanently unreadable folder must not log every second.
      if (!failing) onError(toError(err))
      failing = true
    } finally {
      scanning = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()
  return {
    close: () => {
      closed = true
      clearInterval(timer)
    }
  }
}

async function folderSignature(root: string, maxEntries: number): Promise<{ signature: string; truncated: boolean }> {
  const hash = createHash('sha1')
  let count = 0
  let truncated = false
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      // The root vanishing is a change ("missing"); anything deeper just means it was removed
      // between the listing and now, which the next scan sees.
      if (dir === root && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        hash.update('missing')
        return
      }
      if (dir === root) throw err
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue
      // A nested plugin folder is another plugin's: see isInNestedPlugin.
      if (e.isDirectory() && existsSync(join(dir, e.name, 'plugin.json'))) continue
      if (++count > maxEntries) {
        truncated = true
        return
      }
      const path = join(dir, e.name)
      const relPath = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        hash.update(`d ${relPath}\n`)
        await walk(path, relPath)
      } else {
        try {
          const st = await fs.lstat(path)
          hash.update(`f ${relPath} ${st.size} ${st.mtimeMs}\n`)
        } catch {
          // Removed since the listing.
        }
      }
    }
  }
  await walk(root, '')
  return { signature: hash.digest('hex'), truncated }
}
