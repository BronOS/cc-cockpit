// `ctx.storage`: the per-plugin, per-project key-value store (design §5). One JSON file
// (`<data>/plugin-data/<projectId>/<pluginId>/storage.json`, the path comes from main) written
// through the same atomic, debounced JsonFile as every other state file.
//
// Keys come from plugin code and are untrusted. They are never path segments: all keys live in
// ONE file, as properties of one object. That makes `../../x`, `a/b` or an empty-looking key
// harmless, but a plain object still has special names: assigning `values['__proto__']` would
// change a prototype instead of storing a value, so every write goes through defineProperty and
// every read through hasOwn. Size caps keep one plugin from filling the disk with a loop.
import { JsonFile, type FsOps, type Versioned } from '../../main/store/json-file'
import type { JsonValue, PluginStorage } from '../../sdk/types'
import { toError } from '../../shared/error-text'

export const MAX_KEY_LENGTH = 200
/** Per value, as JSON text. */
export const MAX_VALUE_LENGTH = 1024 * 1024
/** Keys plus values of one plugin in one project, as JSON text. */
export const MAX_TOTAL_LENGTH = 16 * 1024 * 1024

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

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || key === '') throw new TypeError('storage key must be a non-empty string')
  if (key.length > MAX_KEY_LENGTH) throw new RangeError(`storage key is longer than ${MAX_KEY_LENGTH} characters`)
  return key
}

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
  /** key -> size of the key plus its JSON text, to enforce the total cap without re-serializing. */
  const sizes = new Map<string, number>()
  let total = 0

  const open = (): JsonFile<StorageFile> => {
    if (file) return file
    const opened = new JsonFile<StorageFile>({
      filePath: options.file,
      defaults: () => ({ schemaVersion: 1, values: {} }),
      ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
      ...(options.fs ? { fs: options.fs } : {}),
      log: options.log
    })
    // A hand-edited file may hold anything under `values`; only a plain object is kept.
    const values = opened.data.values as unknown
    if (typeof values !== 'object' || values === null || Array.isArray(values)) opened.data.values = {}
    for (const [k, v] of Object.entries(opened.data.values)) {
      const size = k.length + (JSON.stringify(v) ?? '').length
      sizes.set(k, size)
      total += size
    }
    file = opened
    return opened
  }

  /**
   * JsonFile goes read-only for a file it must not overwrite (a newer schemaVersion, an unreadable
   * file, a corrupt one it could not back up) and then only logs "not saving". A write that seemed
   * to succeed would be lost on the next start without the plugin ever knowing: reject it instead.
   */
  const writable = (): JsonFile<StorageFile> => {
    const f = open()
    if (f.readOnly) throw new Error(`storage is read-only: ${options.file} cannot be written (see the plugin log)`)
    return f
  }

  const storage: PluginStorage = {
    get: <T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> =>
      run(() => {
        const k = checkKey(key)
        const values = open().data.values
        // A copy: the caller mutating a returned object must not change the stored one.
        return Object.hasOwn(values, k) ? (JSON.parse(JSON.stringify(values[k])) as T) : undefined
      }),
    set: (key, value) =>
      run(() => {
        const k = checkKey(key)
        const text = JSON.stringify(value)
        if (text === undefined) throw new TypeError('storage value must be JSON')
        if (text.length > MAX_VALUE_LENGTH) {
          throw new RangeError(`storage value is larger than ${MAX_VALUE_LENGTH} characters`)
        }
        const f = writable()
        const size = k.length + text.length
        const next = total - (sizes.get(k) ?? 0) + size
        if (next > MAX_TOTAL_LENGTH) throw new RangeError(`storage would exceed ${MAX_TOTAL_LENGTH} characters in total`)
        f.update((data) => {
          Object.defineProperty(data.values, k, {
            value: JSON.parse(text) as JsonValue,
            enumerable: true,
            writable: true,
            configurable: true
          })
        })
        sizes.set(k, size)
        total = next
      }),
    delete: (key) =>
      run(() => {
        const k = checkKey(key)
        const f = writable()
        if (!Object.hasOwn(f.data.values, k)) return
        f.update((data) => {
          delete data.values[k]
        })
        total -= sizes.get(k) ?? 0
        sizes.delete(k)
      }),
    keys: () => run(() => Object.keys(open().data.values))
  }
  return {
    storage,
    flush: () => file?.flush()
  }
}
