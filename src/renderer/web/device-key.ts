// This browser's origin key (design-web.md §4.1 "Origin-bound device", main/web/auth.ts): the second
// secret a sign-in answers in its JSON body, without which the device cookie signs nothing in.
//
// Kept in localStorage, which is per origin, port included, unlike a cookie: another server on the
// same host that this browser visits receives the device cookie but never this. Sent as
// DEVICE_KEY_HEADER on every request behind sign-in (`keyedFetch`) and as a WebSocket subprotocol on
// the upgrade (`socketProtocols`, bridge.ts has no headers to set). Storage that throws (a private
// window, blocked site data) is no key: the page then shows the sign-in, as for a browser never signed in.
import { DEVICE_KEY_HEADER, DEVICE_KEY_STORAGE, socketProtocols } from '../../shared/web-protocol'

/** The localStorage entry (shared: main reads it from a remote window's page). */
export { DEVICE_KEY_STORAGE }
/** Far above a 43-character key; anything longer is not one. */
const MAX_KEY_LENGTH = 256

/** What the key is kept in; the browser's localStorage fits it (tests pass a map). */
export interface KeyStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserStorage(): KeyStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** A key as the gateway hands it out: base64url, sane length. */
function isKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_LENGTH) return false
  for (const ch of value) {
    const ok = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_'
    if (!ok) return false
  }
  return true
}

/** The `key` of a sign-in's JSON answer (WebSignInReply, an allowed confirm poll), or undefined. */
export function deviceKeyOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const key = (body as Record<string, unknown>)['key']
  return isKey(key) ? key : undefined
}

/** The key this browser holds for this origin, or undefined. */
export function readDeviceKey(storage: KeyStorage | undefined = browserStorage()): string | undefined {
  try {
    const value = storage?.getItem(DEVICE_KEY_STORAGE)
    return isKey(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Keeps a new sign-in's key (it replaces an older device's). A storage that refuses keeps nothing. */
export function storeDeviceKey(key: string, storage: KeyStorage | undefined = browserStorage()): void {
  if (!isKey(key)) return
  try {
    storage?.setItem(DEVICE_KEY_STORAGE, key)
  } catch {
    // Not kept: the next page load shows the sign-in again.
  }
}

/** `init` with this browser's key as DEVICE_KEY_HEADER (unchanged when it has none). */
export function withDeviceKey(init: RequestInit | undefined, key: string | undefined = readDeviceKey()): RequestInit | undefined {
  if (key === undefined) return init
  const headers = new Headers(init?.headers)
  headers.set(DEVICE_KEY_HEADER, key)
  return { ...init, headers }
}

/** The browser's fetch with this browser's key: every request of the page behind sign-in goes through it. */
export function keyedFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, withDeviceKey(init))
}

/** The subprotocols the page's WebSocket offers: the app's, and this browser's key. */
export function pageSocketProtocols(): string[] {
  return socketProtocols(readDeviceKey())
}
