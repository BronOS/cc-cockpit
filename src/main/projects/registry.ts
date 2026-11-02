// Project registry: one record per folder in `<data>/projects/<projectId>.json`, plus the
// open/recent lists in `<data>/app.json`. Pure Node (no Electron) so unit tests load it.
//
// A project IS its real folder path: the id is a hash of the symlink-resolved path, so the same
// folder reached via a symlink, a trailing slash or `..` is one project. main is the only caller;
// renderers and plugins never pass a path or id that is trusted without going through here.
import * as nodeFs from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { dataPaths, PROJECT_ID_PATTERN, projectFile, projectId } from '../paths'
import { JsonFile, type FsOps } from '../store/json-file'
import { isPlainObject } from '../../shared/guards'
import { defaultLayout, normalizeLayout, type LayoutState } from '../../shared/layout'
import { projectColorOf } from '../../shared/project-color'
import { SERVICE_NAME_PATTERN } from '../../shared/manifest'
import type { AppSettings, ProjectRecord, ProjectView } from '../../shared/types'

/** How many entries `recentProjects` keeps; the picker never shows more than this. */
export const MAX_RECENT_PROJECTS = 20

/** The only file names that count as project records in `projects/` (ignores .tmp, .corrupt-*). */
const RECORD_FILE = /^([0-9a-f]{16})\.json$/
// One pattern for every id check (paths.ts): it is also what keeps `plugin-data/_app` apart.
const ID_PATTERN = PROJECT_ID_PATTERN

export interface RegistryOptions {
  dataDir: string
  debounceMs?: number
  /** Store-level fs, injectable for failure tests. */
  fs?: FsOps
  log?: (message: string) => void
  now?: () => number
  /**
   * A project was forgotten: its secret project settings go too (PluginSecrets.forgetProject drops
   * every plugin's `setting:project:<id>:*` keys). Called from forget() itself, so every way of
   * forgetting (the picker, restore's forgetMissing) takes them along.
   */
  onForget?: (id: string) => void
}

const defaultAppSettings = (): AppSettings => ({
  schemaVersion: 1,
  openProjects: [],
  recentProjects: [],
  keyOverrides: {},
  pluginSettings: {}
})

export class ProjectRegistry {
  /** app.json; exposed so later tasks (theme, key overrides) share the one debounced writer. */
  readonly app: JsonFile<AppSettings>

  private readonly files = new Map<string, JsonFile<ProjectRecord>>()
  private readonly dataDir: string
  private readonly projectsDir: string
  private readonly options: RegistryOptions
  private readonly now: () => number

  constructor(options: RegistryOptions) {
    this.options = options
    this.dataDir = options.dataDir
    this.projectsDir = dataPaths(options.dataDir).projectsDir
    this.now = options.now ?? Date.now
    this.app = new JsonFile<AppSettings>({
      filePath: dataPaths(options.dataDir).appJson,
      defaults: defaultAppSettings,
      debounceMs: options.debounceMs,
      fs: options.fs,
      log: options.log,
      now: options.now
    })
    // app.json is user-writable and JsonFile only shallow-merges defaults, so a damaged file can
    // hold `"recentProjects": null` (or a string, an object). Every list method below calls array
    // methods on these fields: unrepaired, each openPath would throw (no project could be opened,
    // the picker's recent list fails) and markOpen would throw after the window exists, leaving it
    // without a plugin host. Repaired in memory only; the next real update writes the clean lists.
    const app = this.app.data
    app.openProjects = stringList(app.openProjects)
    app.recentProjects = stringList(app.recentProjects)
  }

  /**
   * Open (or re-open) a folder: resolve the real path, find or create its record, bump recents.
   * Throws when there is no record yet and the path is not an existing directory (nothing sensible
   * to create). A known project whose folder vanished is returned with `missing: true` so the UI
   * can offer relink or forget.
   */
  openPath(path: string): ProjectView {
    const real = realPathOf(path)
    const existing = this.findByRealPath(real)
    if (existing) {
      existing.update((r) => {
        r.lastOpenedAt = this.now()
      })
      this.touchRecent(existing.data.id)
      return this.view(existing.data)
    }
    if (!isDirectory(real)) throw new Error(`not a directory: ${path}`)
    const record = this.createRecord(this.freeId(real), real)
    this.touchRecent(record.data.id)
    return this.view(record.data)
  }

  /** The record for an id, or undefined when unknown (or the file was unusable). */
  get(id: string): ProjectView | undefined {
    const file = this.load(id)
    return file ? this.view(file.data) : undefined
  }

  /**
   * The record for a folder path, without side effects: no record is created and recents do not
   * move (unlike openPath). The socket server resolves `--project <path>` with it.
   */
  findByPath(path: string): ProjectView | undefined {
    const file = this.findByRealPath(realPathOf(path))
    return file ? this.view(file.data) : undefined
  }

  /** Every readable record, most recently opened first. */
  list(): ProjectView[] {
    const views: ProjectView[] = []
    for (const id of this.knownIds()) {
      const view = this.get(id)
      if (view) views.push(view)
    }
    return views.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  }

  /**
   * Point an existing record at a new folder, keeping its id, settings and tabs. Refuses a target
   * that is not a directory, or that already belongs to another record (two records for one folder
   * would break the "one window per folder" rule).
   */
  relink(id: string, newPath: string): ProjectView {
    const file = this.load(id)
    if (!file) throw new Error(`unknown project: ${id}`)
    const real = realPathOf(newPath)
    if (!isDirectory(real)) throw new Error(`not a directory: ${newPath}`)
    const other = this.findByRealPath(real)
    if (other && other.data.id !== id) {
      throw new Error(`that folder is already a project (${other.data.id})`)
    }
    file.update((r) => {
      r.path = real
      r.name = basename(real)
    })
    return this.view(file.data)
  }

  /** Delete the record and drop the id from the open/recent lists. */
  forget(id: string): void {
    if (!ID_PATTERN.test(id)) return
    // Flush first: a pending debounced write would otherwise recreate the file after the unlink.
    this.files.get(id)?.flush()
    this.files.delete(id)
    try {
      // Through the injectable fs like every other store write.
      ;(this.options.fs ?? nodeFs).unlinkSync(projectFile(this.dataDir, id))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    this.app.update((a) => {
      a.openProjects = a.openProjects.filter((x) => x !== id)
      a.recentProjects = a.recentProjects.filter((x) => x !== id)
    })
    // Last, and never thrown: the record is already gone, and a secrets write failing must not
    // leave the project half-forgotten in the lists above.
    try {
      this.options.onForget?.(id)
    } catch (err) {
      ;(this.options.log ?? ((m) => console.error(m)))(`forgetting ${id}: cleanup failed: ${String(err)}`)
    }
  }

  /** Remember that this project has a window (restored at next start). Unknown ids are ignored. */
  markOpen(id: string): void {
    if (!this.load(id)) return
    if (this.app.data.openProjects.includes(id)) return
    this.app.update((a) => {
      a.openProjects.push(id)
    })
  }

  markClosed(id: string): void {
    if (!this.app.data.openProjects.includes(id)) return
    this.app.update((a) => {
      a.openProjects = a.openProjects.filter((x) => x !== id)
    })
  }

  /** Ids to restore at start, minus records that no longer exist. */
  openIds(): string[] {
    // Already a string[]: the constructor repairs a damaged value (stringList).
    return this.app.data.openProjects.filter((id) => this.load(id) !== undefined)
  }

  /** Recently opened projects, newest first, skipping records that no longer exist. */
  recent(): ProjectView[] {
    const views: ProjectView[] = []
    for (const id of this.app.data.recentProjects) {
      const view = this.get(id)
      if (view) views.push(view)
    }
    return views
  }

  /** Mutate a record through the store (window bounds, tabs, ...). Unknown ids are ignored. */
  update(id: string, mutate: (record: ProjectRecord) => void): void {
    this.load(id)?.update(mutate)
  }

  /**
   * Take a plugin off every project's enabled list and have it on disk when this returns, or throw.
   * The caller is about to record a replacement that must not start: a restart starts what the record
   * files say, so the debounce window (or a write that fails) would run it with the old switch.
   *
   * Every known record is written, also one where memory no longer lists the plugin: a debounced
   * change may not have reached the file yet. A failed write puts the list back in memory, so memory
   * says what the file says and a retry still sees the old enablement. A file that can only be
   * read later (written by a newer app, EACCES) may list the plugin, and that cannot be undone from
   * here: refuse as well.
   */
  disablePluginEverywhere(pluginId: string): void {
    if (this.recordsHidden()) throw new Error(`cannot turn ${pluginId} off: the project files cannot be listed`)
    for (const id of this.knownIds()) {
      const file = this.load(id)
      if (this.unreadable(id)) throw new Error(`cannot turn ${pluginId} off: project file ${id} cannot be written`)
      if (!file) continue
      const before = file.data.enabledPlugins
      const listed = Array.isArray(before) && before.includes(pluginId)
      if (listed) file.update((r) => void (r.enabledPlugins = before.filter((x) => x !== pluginId)))
      file.flush()
      if (!file.pending) continue
      if (listed) file.data.enabledPlugins = before
      throw new Error(`cannot turn ${pluginId} off: the record of ${file.data.path} could not be written`)
    }
  }

  /**
   * Whether a plugin is, or may be, on in some project. A record this run cannot read counts as yes:
   * it comes back when its permissions do (or with the newer app), and a restart then starts whatever
   * it lists. Answering no would skip disablePluginEverywhere for a replacement from another repo, the
   * one call that refuses over such a file, and the replacement would start with the old switch.
   */
  pluginMayBeEnabled(pluginId: string): boolean {
    if (this.recordsHidden()) return true
    for (const id of this.knownIds()) {
      const file = this.load(id)
      if (this.unreadable(id)) return true
      const enabled: unknown = file?.data.enabledPlugins
      if (Array.isArray(enabled) && enabled.includes(pluginId)) return true
    }
    return false
  }

  /**
   * Record the repository a plugin id came from, on disk when it returns, or throw. A debounced write
   * whose failure is swallowed left history at A with B installed: after a restart, uninstalling B and
   * reinstalling A looked like no repository change, and A started with B's enablements and data
   * (review finding). A failed write goes back out of memory, so that memory goes on saying what the
   * file says; the rest of app.json stays pending (flush dropped its timer, hence the save).
   */
  rememberPluginRepo(pluginId: string, repo: string): void {
    // JsonFile.save only logs on a read-only file, and flush then reports nothing pending.
    if (this.app.readOnly) throw new Error(`cannot record the repository of ${pluginId}: app.json cannot be written`)
    const before = this.app.data.pluginRepos
    // app.json is user-writable: a damaged value is replaced rather than written into.
    const repos = isPlainObject(before) ? before : {}
    this.writePluginRepos(pluginId, { ...repos, [pluginId]: repo })
  }

  /**
   * Drop an id's repository history, on disk when it returns, or throw. For a link: installing A,
   * uninstalling, linking B under the id and uninstalling B left history saying A, so a reinstall of A
   * saw no repository change and started with B's enablements and data (review finding). No history,
   * no write: linking must not start needing a writable app.json.
   */
  forgetPluginRepo(pluginId: string): void {
    const before = this.app.data.pluginRepos
    if (!isPlainObject(before) || !Object.hasOwn(before, pluginId)) return
    if (this.app.readOnly) throw new Error(`cannot record the repository of ${pluginId}: app.json cannot be written`)
    const repos = { ...before }
    delete repos[pluginId]
    this.writePluginRepos(pluginId, repos as Record<string, string>)
  }

  private writePluginRepos(pluginId: string, repos: Record<string, string>): void {
    const before = this.app.data.pluginRepos
    this.app.update((a) => void (a.pluginRepos = repos))
    this.app.flush()
    if (!this.app.pending) return
    if (before === undefined) delete this.app.data.pluginRepos
    else this.app.data.pluginRepos = before
    this.app.save()
    throw new Error(`cannot record the repository of ${pluginId}: app.json could not be written`)
  }

  /**
   * Replace a project's zone layout (Task 17). Goes through the record's debounced writer like
   * every other record change. Pass the result of the pure layout operations; it is re-validated
   * here so a bad value from a caller can never reach the file.
   */
  setLayout(id: string, layout: LayoutState): void {
    this.update(id, (r) => {
      r.layout = normalizeLayout(layout)
    })
  }

  /** The project's service provider picks (a copy); none for an unknown project. */
  serviceProviders(id: string): Record<string, string> {
    return { ...(this.load(id)?.data.serviceProviders ?? {}) }
  }

  /**
   * Set (or with null clear) the pick for one service. Returns whether the record changed, so the
   * caller restarts the host only for a real change. The caller has checked the names.
   */
  setServiceProvider(id: string, service: string, pluginId: string | null): boolean {
    const file = this.load(id)
    if (!file) throw new Error(`unknown project: ${id}`)
    const current = file.data.serviceProviders ?? {}
    const before = Object.hasOwn(current, service) ? current[service] : undefined
    if ((before ?? null) === pluginId) return false
    file.update((r) => {
      // A fresh object built from entries: a key is only ever set as an own data property.
      const entries = Object.entries(r.serviceProviders ?? {}).filter(([k]) => k !== service)
      if (pluginId !== null) entries.push([service, pluginId])
      if (entries.length === 0) delete r.serviceProviders
      else r.serviceProviders = Object.fromEntries(entries)
    })
    return true
  }

  /** Write everything pending now (call on quit). */
  flushAll(): void {
    for (const file of this.files.values()) file.flush()
    this.app.flush()
  }

  private touchRecent(id: string): void {
    this.app.update((a) => {
      a.recentProjects = [id, ...a.recentProjects.filter((x) => x !== id)].slice(
        0,
        MAX_RECENT_PROJECTS
      )
    })
  }

  private view(record: ProjectRecord): ProjectView {
    // Deep copy: a caller (soon IPC handlers) mutating a view must not touch the live store data.
    return { ...structuredClone(record), missing: !isDirectory(record.path) }
  }

  /** Ids of records on disk plus ones created this session that the debounce has not written yet. */
  private knownIds(): Set<string> {
    const ids = new Set<string>(this.files.keys())
    let names: string[] = []
    try {
      names = nodeFs.readdirSync(this.projectsDir)
    } catch {
      /* no projects dir yet */
    }
    for (const name of names) {
      const match = RECORD_FILE.exec(name)
      if (match) ids.add(match[1]!)
    }
    return ids
  }

  /** `projects/` exists but cannot be listed (EACCES): knownIds sees nothing of what it holds. */
  private recordsHidden(): boolean {
    try {
      nodeFs.readdirSync(this.projectsDir)
      return false
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== 'ENOENT'
    }
  }

  /**
   * A record file is there and this run cannot know what it says. Call after load(), which keeps every
   * file it could open. Asked of the store, not of load()'s answer: opening the folder of such a record
   * makes a file with a path (createRecord), in memory only, that load() then returns like any other.
   * Not in `files` after a load: listed but not reachable (a folder with no search permission). A
   * corrupt file does not count: it is quarantined, and nothing ever reads its list again.
   */
  private unreadable(id: string): boolean {
    const file = this.files.get(id)
    return file === undefined || file.readOnly
  }

  /**
   * The record whose path is `real`. The computed id is tried first (the common case); the scan
   * covers relinked records, whose id no longer matches the hash of their path.
   */
  private findByRealPath(real: string): JsonFile<ProjectRecord> | undefined {
    const direct = this.load(projectId(real))
    if (direct?.data.path === real) return direct
    for (const id of this.knownIds()) {
      const file = this.load(id)
      if (file?.data.path === real) return file
    }
    return undefined
  }

  /**
   * An id for a new record at `real`: the path hash, unless a usable record already uses it (an unusable file is replaced). That
   * happens after a relink (record A keeps hash(P1) but points at P2; opening P1 again must not
   * adopt A's file). Salting with a counter keeps ids deterministic and unique.
   */
  private freeId(real: string): string {
    let id = projectId(real)
    for (let n = 1; this.load(id) !== undefined; n++) {
      id = projectId(`${real}\0${n}`)
    }
    return id
  }

  /** Load a record file without creating it. Unknown / unusable ids give undefined. */
  private load(id: string): JsonFile<ProjectRecord> | undefined {
    if (!ID_PATTERN.test(id)) return undefined
    let file = this.files.get(id)
    if (!file) {
      if (!nodeFs.existsSync(projectFile(this.dataDir, id))) return undefined
      file = this.open(id, '')
      // Records written before Task 17 hold `layout: {}`; a damaged file can hold anything.
      file.data.layout = normalizeLayout(file.data.layout)
      // The same for the colour: a hand-edited `"color": "Blue"` or `5` reads as none (repaired in
      // memory; the next real update writes the clean record), and a `#ABCDEF` as its lower case,
      // so every view, snapshot and CSS value sees only what the setter could have stored.
      const color = projectColorOf(file.data.color)
      if (color === undefined) delete file.data.color
      else file.data.color = color
      // Service picks: only `{ name: pluginId }` string pairs with a valid service name survive; a
      // value that is not a plain object reads as no picks (repaired in memory, like the colour).
      const picks = serviceProvidersOf(file.data.serviceProviders)
      if (picks === undefined) delete file.data.serviceProviders
      else file.data.serviceProviders = picks
      this.files.set(id, file)
    }
    // An unusable file loads as defaults with an empty path: not a project.
    return file.data.path ? file : undefined
  }

  private createRecord(id: string, real: string): JsonFile<ProjectRecord> {
    const file = this.open(id, real)
    this.files.set(id, file)
    file.save()
    return file
  }

  private open(id: string, real: string): JsonFile<ProjectRecord> {
    return new JsonFile<ProjectRecord>({
      filePath: projectFile(this.dataDir, id),
      defaults: () => ({
        schemaVersion: 1,
        id,
        path: real,
        name: basename(real),
        enabledPlugins: [],
        pluginSettings: {},
        layout: defaultLayout(),
        tabs: [],
        lastOpenedAt: this.now()
      }),
      debounceMs: this.options.debounceMs,
      fs: this.options.fs,
      log: this.options.log,
      now: this.options.now
    })
  }
}

/**
 * The canonical absolute path. `realpathSync.native` returns the on-disk case on case-insensitive
 * macOS volumes (the JS version keeps the caller's case, so /Users/me/Foo and /users/me/foo would
 * be two projects). For a missing folder the nearest existing ancestor is resolved and the rest
 * appended, so a vanished folder still hashes like the record made while it existed.
 */
export function realPathOf(path: string): string {
  const abs = resolve(path)
  const tail: string[] = []
  let cur = abs
  for (;;) {
    try {
      return join(nodeFs.realpathSync.native(cur), ...tail)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return abs
      tail.unshift(basename(cur))
      cur = parent
    }
  }
}

/** A user-writable picks map: string pairs with a valid service name, or undefined for none. */
function serviceProvidersOf(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined
  const entries = Object.entries(value).filter(
    (e): e is [string, string] => SERVICE_NAME_PATTERN.test(e[0]) && typeof e[1] === 'string' && e[1] !== ''
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/** A user-writable list as `string[]`: anything not an array is empty, non-string entries go. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
}

function isDirectory(path: string): boolean {
  try {
    return nodeFs.statSync(path).isDirectory()
  } catch {
    return false
  }
}
