// `ctx.appStorage`: the plugin's app-wide key-value store, the same keys in every project window.
// Main owns the file (src/main/plugins/app-storage.ts says why: one writer for all windows), so
// each method is one RPC; main checks the key, the value and the plugin id again. The checks here
// are the same shared ones (src/shared/plugin-storage.ts), run first so a bad call fails at the call
// site without a round trip and with the store's own message rather than a transport error.
import type { JsonValue, PluginAppStorage } from '../../sdk/types'
import { checkStorageKey, MAX_APP_VALUE_LENGTH, storageValueText } from '../../shared/plugin-storage'

const WHAT = 'appStorage'

export interface AppStorageDeps {
  pluginId: string
  call(method: string, params: unknown): Promise<unknown>
  /** Rejects once the plugin is deactivated, and turns a synchronous throw into a rejection. */
  guardAsync<T>(body: () => Promise<T>): Promise<T>
}

export function createAppStorageApi(deps: AppStorageDeps): PluginAppStorage {
  const { pluginId, call, guardAsync } = deps
  // `pluginId` is this plugin's own; main refuses an id its host does not run.
  const ask = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    guardAsync(() => call(method, { pluginId, ...params }))

  return Object.freeze({
    get: <T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> =>
      guardAsync(async () => {
        const k = checkStorageKey(key, WHAT)
        // `{ value }` or null: a stored null stays a value, distinct from "not set". The value came
        // through JSON, so it is the caller's own copy.
        const reply = (await ask('appStorage.get', { key: k })) as { value?: JsonValue } | null
        return reply === null || reply === undefined ? undefined : (reply.value as T)
      }),
    set: (key: string, value: JsonValue): Promise<void> =>
      guardAsync(async () => {
        const k = checkStorageKey(key, WHAT)
        storageValueText(value, WHAT, MAX_APP_VALUE_LENGTH)
        await ask('appStorage.set', { key: k, value })
      }),
    delete: (key: string): Promise<void> =>
      guardAsync(async () => {
        await ask('appStorage.delete', { key: checkStorageKey(key, WHAT) })
      }),
    keys: (): Promise<string[]> => ask('appStorage.keys', {}) as Promise<string[]>,
    increment: (key: string, by = 1): Promise<number> =>
      guardAsync(async () => {
        const k = checkStorageKey(key, WHAT)
        if (typeof by !== 'number' || !Number.isFinite(by)) throw new TypeError(`${WHAT}.increment: by must be a finite number`)
        return (await ask('appStorage.increment', { key: k, by })) as number
      })
  })
}
