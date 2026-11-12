// A remote server's origin key as main reads and checks it (design-web.md §4.1 "Origin-bound device",
// design-remote-desktop.md §4). No Electron import: the adapter (electron-remote-window.ts) runs the
// script, remote-windows.ts keeps the key, both test without Electron.
//
// The gateway answers a sign-in's origin key in the JSON body only; the server's web client keeps it in
// its origin's localStorage (renderer/web/device-key.ts) and sends it on every request behind sign-in.
// Main's own requests through a remote window's partition (the session check, the project list and its
// reopen POST, the machine poll) carry the partition's cookie but nothing of the page's storage, so a
// cookie alone is refused. So main reads the key from the page itself:
//  - in an isolated world of its own (REMOTE_KEY_WORLD_ID): the page's scripts can neither see the
//    script nor replace `localStorage.getItem` for it. The window has no preload and no bridge; this
//    world is main's only way in, and it only reads;
//  - checked as the gateway mints it (`isOriginKey`): the server's page writes that entry, so anything
//    else in it is refused, never sent and never logged;
//  - kept in main's memory only, per server: never written to disk by main (the page's own
//    localStorage, which is on disk in the `persist:` partition, is the one copy, as in any browser
//    profile; design-web.md §4.1 accepts it), never logged, never in an event or a reply.
import { DEVICE_KEY_STORAGE, ORIGIN_KEY_LENGTH } from '../../shared/web-protocol'

/**
 * The isolated world main reads a remote window's page in. Not WEBVIEW_WORLD_ID (1717, the streamed
 * webviews' world, webview-input.ts): one world per purpose, so a script of one never meets the
 * other's globals. Electron's own worlds are 0 (main) and 999 (context isolation).
 */
export const REMOTE_KEY_WORLD_ID = 1718

/** How long a read of the page may take: a page mid-navigation may never answer it. */
export const KEY_READ_TIMEOUT_MS = 2_000

/**
 * The read, as source text. The entry's value or null; undefined when the page's storage cannot be read
 * at all (an opaque origin: the error page, an empty window), which is "could not tell", not "none".
 */
export const READ_KEY_SCRIPT = `(() => { try { return localStorage.getItem(${JSON.stringify(DEVICE_KEY_STORAGE)}) } catch { return undefined } })()`

/** A key as the gateway mints it: exactly ORIGIN_KEY_LENGTH base64url characters. */
export function isOriginKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== ORIGIN_KEY_LENGTH) return false
  for (const ch of value) {
    const ok = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_'
    if (!ok) return false
  }
  return true
}
