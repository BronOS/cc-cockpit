// The key-value rules shared by `ctx.storage` (host-local, per project: src/host/ctx/storage.ts) and
// `ctx.appStorage` (main-owned, app-wide: src/main/plugins/app-storage.ts). One module so the two
// stores cannot drift: the same key check, the same caps, the same bookkeeping.
//
// Keys come from plugin code and are untrusted. They are never path segments: all keys of a store
// live in ONE file, as properties of one object. That makes `../../x`, `a/b` or an empty-looking
// key harmless, but a plain object still has special names: assigning `values['__proto__']` would
// change a prototype instead of storing a value, so every write goes through defineProperty and
// every read through hasOwn. Size caps keep one plugin from filling the disk with a loop.
//
// Pure (no Node types): src/shared is type-checked for the renderer too.
import type { JsonValue } from '../sdk/types'

export const MAX_KEY_LENGTH = 200
/** Per value, as JSON text. */
export const MAX_VALUE_LENGTH = 1024 * 1024
/** Keys plus values of one plugin in one store, as JSON text. */
export const MAX_TOTAL_LENGTH = 16 * 1024 * 1024
/**
 * ctx.appStorage values and its key list cross the host/main RPC in ONE message, which is capped
 * at 1 MiB including its envelope (src/host/rpc.ts MAX_RPC_MESSAGE_LENGTH: id, method, plugin id
 * and a key escaped at worst 6 characters per character, under 2 KiB). A value of the full
 * MAX_VALUE_LENGTH would be refused by the transport with a size error that names no limit, so
 * the app store caps a little lower and says so. A unit test checks the worst case fits.
 */
export const APP_RPC_RESERVE = 8 * 1024
export const MAX_APP_VALUE_LENGTH = MAX_VALUE_LENGTH - APP_RPC_RESERVE
/** ctx.appStorage.keys() answers in one message too: the key list, as JSON, stays under this. */
export const MAX_APP_KEYS_LENGTH = MAX_VALUE_LENGTH - APP_RPC_RESERVE

/** `key` when it is a usable store key; `what` names the API in the error (`storage`, `appStorage`). */
export function checkStorageKey(key: unknown, what: string): string {
  if (typeof key !== 'string' || key === '') throw new TypeError(`${what} key must be a non-empty string`)
  if (key.length > MAX_KEY_LENGTH) throw new RangeError(`${what} key is longer than ${MAX_KEY_LENGTH} characters`)
  return key
}

/** The JSON text a value is stored as, checked: JSON at all, and at most `max` characters. */
export function storageValueText(value: unknown, what: string, max = MAX_VALUE_LENGTH): string {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    // A cycle or a BigInt: the same answer as a function or undefined, without the engine's text.
    text = undefined
  }
  if (text === undefined) throw new TypeError(`${what} value must be JSON`)
  if (text.length > max) throw new RangeError(`${what} value is larger than ${max} characters`)
  return text
}

/** A stored `values` object as loaded from disk: anything but a plain object (a hand edit) is empty. */
export function storedValues(raw: unknown): Record<string, JsonValue> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, JsonValue>) : {}
}

/**
 * One store's values object (owned by the caller's JsonFile, mutated in place) with its size
 * bookkeeping: key -> size of the key plus its JSON text, so the total cap is enforced without
 * re-serializing everything on each write. The caller marks its file dirty after `put`/`remove`.
 */
export class StorageValues {
  private readonly sizes = new Map<string, number>()
  private total = 0
  /** Sum of the keys' JSON lengths plus separators: the size of `keys()` as one JSON list. */
  private keysLength = 2

  constructor(
    readonly values: Record<string, JsonValue>,
    private readonly what: string
  ) {
    for (const [k, v] of Object.entries(values)) {
      const size = k.length + (JSON.stringify(v) ?? '').length
      this.sizes.set(k, size)
      this.total += size
      this.keysLength += keyListSize(k)
    }
  }

  has(key: string): boolean {
    return Object.hasOwn(this.values, key)
  }

  /** The stored value itself (callers that hand it out copy it: see `copy`). */
  raw(key: string): JsonValue | undefined {
    return Object.hasOwn(this.values, key) ? this.values[key] : undefined
  }

  /** A copy: the caller mutating a returned object must not change the stored one. */
  copy(key: string): JsonValue | undefined {
    return Object.hasOwn(this.values, key) ? (JSON.parse(JSON.stringify(this.values[key])) as JsonValue) : undefined
  }

  /**
   * Throws when storing `text` under `key` would pass the total cap, or (`maxKeysLength`) make
   * the key list longer than that. Changes nothing: callers check before they touch their file.
   */
  checkRoom(key: string, text: string, maxKeysLength?: number): void {
    const next = this.total - (this.sizes.get(key) ?? 0) + key.length + text.length
    if (next > MAX_TOTAL_LENGTH) throw new RangeError(`${this.what} would exceed ${MAX_TOTAL_LENGTH} characters in total`)
    if (maxKeysLength !== undefined && !this.has(key) && this.keysLength + keyListSize(key) > maxKeysLength) {
      throw new RangeError(`${this.what} keys would exceed ${maxKeysLength} characters as a list`)
    }
  }

  /** Store `text` (already checked) under `key`. */
  put(key: string, text: string): void {
    if (!this.has(key)) this.keysLength += keyListSize(key)
    Object.defineProperty(this.values, key, {
      value: JSON.parse(text) as JsonValue,
      enumerable: true,
      writable: true,
      configurable: true
    })
    const size = key.length + text.length
    this.total += size - (this.sizes.get(key) ?? 0)
    this.sizes.set(key, size)
  }

  /** False when there was nothing to remove. */
  remove(key: string): boolean {
    if (!this.has(key)) return false
    delete this.values[key]
    this.total -= this.sizes.get(key) ?? 0
    this.sizes.delete(key)
    this.keysLength -= keyListSize(key)
    return true
  }

  keys(): string[] {
    return Object.keys(this.values)
  }
}

/** A key's share of `JSON.stringify(keys())`: its quoted, escaped text and a comma. */
function keyListSize(key: string): number {
  return JSON.stringify(key).length + 1
}
