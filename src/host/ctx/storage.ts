// `ctx.storage`: the per-plugin, per-project key-value store (design §5). One JSON file
// (`<data>/plugin-data/<projectId>/<pluginId>/storage.json`, the path comes from main) written
// through the same atomic, debounced JsonFile as every other state file.
//
// Host-local on purpose: one project has one window and so one host, the only writer of this file.
// The app-wide store (`ctx.appStorage`) is shared by the hosts of every window and lives in main
// instead (src/main/plugins/app-storage.ts). Both take their key rules, caps and the
// `__proto__`-safe bookkeeping from src/shared/plugin-storage.ts.
import { JsonFile, type FsOps, type Versioned } from '../../main/store/json-file'
import type { JsonValue, PluginStorage } from '../../sdk/types'
import { toError } from '../../shared/error-text'
import { checkStorageKey, StorageValues, storageValueText, storedValues } from '../../shared/plugin-storage'

interface StorageFile extends Versioned {
  values: Record<string, JsonValue>
}

export interface StorageOptions {
  /** Absolute path of the plugin's storage.json (decided by main). */
  file: string
  log: (message: string) => void
  /** JsonFile save window; tests pass a small one. */
  debounceMs?: number
  fs?: FsOps
}

export interface StorageHandle {
  storage: PluginStorage
  /** Write any pending change now (deactivate, and before the host is killed). */
  flush(): void
}

const WHAT = 'storage'

/** A synchronous body as an async API: its throw is a rejection, never a throw at the call site. */
function run<T>(body: () => T): Promise<T> {
  try {
    return Promise.resolve(body())
  } catch (err) {
    return Promise.reject(toError(err))
  }
}

export function createStorage(options: StorageOptions): StorageHandle {
  // Opened on first use: most plugins never touch storage, and a plugin that does not should not
  // get a file or a data directory.
  let file: JsonFile<StorageFile> | undefined
  let values: StorageValues | undefined

  const open = (): { file: JsonFile<StorageFile>; values: StorageValues } => {
    if (file && values) return { file, values }
    const opened = new JsonFile<StorageFile>({
      filePath: options.file,
      defaults: () => ({ schemaVersion: 1, values: {} }),
      ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
      ...(options.fs ? { fs: options.fs } : {}),
      log: options.log
    })
    // A hand-edited file may hold anything under `values`; only a plain object is kept.
    opened.data.values = storedValues(opened.data.values)
    file = opened
    values = new StorageValues(opened.data.values, WHAT)
    return { file, values }
  }

  /**
   * JsonFile goes read-only for a file it must not overwrite (a newer schemaVersion, an unreadable
   * file, a corrupt one it could not back up) and then only logs "not saving". A write that seemed
   * to succeed would be lost on the next start without the plugin ever knowing: reject it instead.
   */
  const writable = (): { file: JsonFile<StorageFile>; values: StorageValues } => {
    const opened = open()
    if (opened.file.readOnly) throw new Error(`storage is read-only: ${options.file} cannot be written (see the plugin log)`)
    return opened
  }

  const storage: PluginStorage = {
    get: <T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> =>
      run(() => open().values.copy(checkStorageKey(key, WHAT)) as T | undefined),
    set: (key, value) =>
      run(() => {
        const k = checkStorageKey(key, WHAT)
        const text = storageValueText(value, WHAT)
        const f = writable()
        f.values.checkRoom(k, text)
        f.values.put(k, text)
        f.file.save()
      }),
    delete: (key) =>
      run(() => {
        const k = checkStorageKey(key, WHAT)
        const f = writable()
        if (f.values.remove(k)) f.file.save()
      }),
    keys: () => run(() => open().values.keys())
  }
  return {
    storage,
    flush: () => file?.flush()
  }
}
