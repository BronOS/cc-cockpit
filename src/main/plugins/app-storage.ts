// `ctx.appStorage`: the per-plugin, APP-WIDE key-value store (plan friction-round-1 Task 5). One JSON
// file per plugin, `<data>/plugin-data/_app/<pluginId>/storage.json` (paths.ts pluginAppDataDir),
// written through JsonFile (tmp + fsync + rename: a crash never leaves half a file), opened the
// first time a plugin uses it.
//
// Why main owns it, unlike `ctx.storage`: each project window runs its own plugin host, so an
// app-wide file written by the hosts themselves would have one writer per window, and two windows
// doing read-modify-write (a monthly usage cap counted from every window) would lose updates. Main
// is ONE process with one thread, and every method here is synchronous: from the first read to
// the last change of the in-memory object nothing can run in between. So calls from any number of
// hosts apply one at a time, in the order main receives them, and `increment` is atomic across
// windows. The file write is debounced (JsonFile's window) and flushed at quit (index.ts
// will-quit); the in-memory object is the truth all hosts read in the meantime.
//
// Keys, value caps and the `__proto__`-safe bookkeeping are ctx.storage's (src/shared/
// plugin-storage.ts), except that a value is capped a little lower to fit in one RPC message
// (MAX_APP_VALUE_LENGTH says why). Errors never echo a key or a value.
//
// Kept on uninstall and on project forget, like the per-project plugin data: nothing in main
// deletes `plugin-data/` (only a plugin's secrets go on uninstall, plugin-secrets.ts). `_app` is
// never a project id (paths.ts APP_DATA_FOLDER), so no project folder can collide with it.
//
// No Electron import: unit tests run it in plain Node on a temp dir.
import { join } from 'node:path'
import type { JsonValue } from '../../sdk/types'
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN } from '../../shared/manifest'
import {
  checkStorageKey,
  MAX_APP_KEYS_LENGTH,
  MAX_APP_VALUE_LENGTH,
  StorageValues,
  storageValueText,
  storedValues
} from '../../shared/plugin-storage'
import { pluginAppDataDir, STORAGE_FILE_NAME } from '../paths'
import { JsonFile, type FsOps, type Versioned } from '../store/json-file'

const WHAT = 'appStorage'

interface AppStorageFile extends Versioned {
  values: Record<string, JsonValue>
}

/** What host-api.ts needs: the plugin-facing calls, for a plugin id main already checked. */
export interface AppStorageApi {
  /** `{ value }` when the key is set, null when not (null itself is a value a plugin may store). */
  get(pluginId: string, key: unknown): { value: JsonValue } | null
  set(pluginId: string, key: unknown, value: unknown): void
  delete(pluginId: string, key: unknown): void
  keys(pluginId: string): string[]
  /** Adds `by` to the number under `key` (absent counts as 0) and returns the new value. */
  increment(pluginId: string, key: unknown, by: unknown): number
}

export interface AppStorageOptions {
  dataDir: string
  /** JsonFile save window; tests pass a small one. */
  debounceMs?: number
  fs?: FsOps
  log?: (message: string) => void
}

interface Opened {
  file: JsonFile<AppStorageFile>
  values: StorageValues
}

/** The file of one plugin's app storage (for tests and the guide's layout). */
export function appStorageFile(dataDir: string, pluginId: string): string {
  return join(pluginAppDataDir(dataDir, pluginId), STORAGE_FILE_NAME)
}

export class AppStorage implements AppStorageApi {
  private readonly opened = new Map<string, Opened>()
  private readonly log: (message: string) => void

  constructor(private readonly options: AppStorageOptions) {
    this.log = options.log ?? ((m) => console.warn(m))
  }

  get(pluginId: string, key: unknown): { value: JsonValue } | null {
    const k = checkStorageKey(key, WHAT)
    const { values } = this.open(pluginId)
    // A copy, though the RPC copies it again: a caller inside main must not alias the store either.
    return values.has(k) ? { value: values.copy(k) as JsonValue } : null
  }

  set(pluginId: string, key: unknown, value: unknown): void {
    const k = checkStorageKey(key, WHAT)
    const text = storageValueText(value, WHAT, MAX_APP_VALUE_LENGTH)
    const f = this.writable(pluginId)
    f.values.checkRoom(k, text, MAX_APP_KEYS_LENGTH)
    f.values.put(k, text)
    f.file.save()
  }

  delete(pluginId: string, key: unknown): void {
    const k = checkStorageKey(key, WHAT)
    const f = this.writable(pluginId)
    if (f.values.remove(k)) f.file.save()
  }

  keys(pluginId: string): string[] {
    return this.open(pluginId).values.keys()
  }

  increment(pluginId: string, key: unknown, by: unknown): number {
    const k = checkStorageKey(key, WHAT)
    // Absent (the host sends none for the default) is 1. NaN and the infinities are refused: JSON
    // would store them as null, and the counter would be gone.
    const step = by === undefined ? 1 : by
    if (typeof step !== 'number' || !Number.isFinite(step)) throw new TypeError(`${WHAT}.increment: by must be a finite number`)
    const f = this.writable(pluginId)
    const current = f.values.raw(k)
    if (current !== undefined && typeof current !== 'number') {
      throw new TypeError(`${WHAT}.increment: the stored value is not a number`)
    }
    const next = (current ?? 0) + step
    if (!Number.isFinite(next)) throw new RangeError(`${WHAT}.increment: the result is not a finite number`)
    const text = JSON.stringify(next)
    f.values.checkRoom(k, text, MAX_APP_KEYS_LENGTH)
    f.values.put(k, text)
    f.file.save()
    return next
  }

  /** Write every pending change now (quit). */
  flush(): void {
    for (const { file } of this.opened.values()) file.flush()
  }

  /**
   * The plugin's store, opened on first use (most plugins never use it, and one that does not
   * gets no file or folder). The id becomes a path segment: host-api.ts only passes ids of the
   * asking host's plugins, and the manifest pattern is checked again here (no `/`, no `..`).
   */
  private open(pluginId: string): Opened {
    if (typeof pluginId !== 'string' || pluginId.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(pluginId)) {
      throw new Error(`${WHAT}: not a plugin id`)
    }
    const known = this.opened.get(pluginId)
    if (known) return known
    const file = new JsonFile<AppStorageFile>({
      filePath: appStorageFile(this.options.dataDir, pluginId),
      defaults: () => ({ schemaVersion: 1, values: {} }),
      ...(this.options.debounceMs !== undefined ? { debounceMs: this.options.debounceMs } : {}),
      ...(this.options.fs ? { fs: this.options.fs } : {}),
      log: this.log
    })
    // A hand-edited file may hold anything under `values`; only a plain object is kept.
    file.data.values = storedValues(file.data.values)
    const opened = { file, values: new StorageValues(file.data.values, WHAT) }
    this.opened.set(pluginId, opened)
    return opened
  }

  /** Like ctx.storage: a write JsonFile would silently not save (a newer or unreadable file) is refused. */
  private writable(pluginId: string): Opened {
    const f = this.open(pluginId)
    if (f.file.readOnly) throw new Error(`${WHAT} is read-only: its file cannot be written (see the app log)`)
    return f
  }
}
