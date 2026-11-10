// The web access wire protocol (design-web.md §3): one WebSocket per remote view, JSON text
// frames, at most MAX_FRAME_BYTES each. Pure functions and types only (no `ws`, no Electron), so
// the gateway, the connection and the tests share one definition and the browser bridge (plan
// Task 7) mirrors it.
//
// Frames of plan Task 6 (later tasks add `port.*`, `term.*` and `settled`):
//   client -> main  { t: 'hello', v, project }        once, first; binds the view to that window
//                   { t: 'invoke', id, ch, p }        an IPC invoke, answered by a `result`
//   main -> client  { t: 'ready', v, view, snapshot } once, after a good hello
//                   { t: 'result', id, ok: true, v } | { t: 'result', id, ok: false, err }
//                   { t: 'event', ch, p }             an IPC event (ViewRegistry, view-registry.ts)
//
// `Uint8Array` values travel as `{ $bytes: <base64> }` both ways (JSON has no bytes). Everything a
// client frame holds is untrusted text: the shape is checked here, the channel against the
// allow-list and remote class (`invokeAllowed`) before the router sees it, and again in the router.

import type { InvokeChannel, LayoutView, OverlayInfo, TabInfo } from '../../shared/ipc'
import { EVENT_CHANNELS, INVOKE_CHANNELS, remoteAllowed } from '../../shared/ipc'
import type { ViewId } from '../../shared/views'

/** Bumped on any incompatible frame change; a client speaking another version is closed. */
export const PROTOCOL_VERSION = 1

/**
 * Largest frame either way (design-web.md §3): a 1 MiB panel message wrapped in a frame must fit.
 * `ws` enforces it on what a view sends (gateway.ts `maxPayload`, close 1009); main checks its own
 * frames before sending (connection.ts).
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** Close codes main uses (4000-4999 is the application range of RFC 6455). */
export const CLOSE = Object.freeze({
  /** A frame that is not one of ours: binary, not JSON, a wrong shape, or out of order. */
  badFrame: 4400,
  /** No `hello` in time. */
  noHello: 4401,
  /** The project named in `hello` has no open window (or it is not a project window). */
  noProject: 4404,
  /** The view's window closed. */
  windowClosed: 4410,
  /** A frame main had to send was over MAX_FRAME_BYTES; the view reconnects to a fresh snapshot. */
  tooLarge: 4413,
  /** The client speaks another protocol version (a stale page after an app update). */
  version: 4426,
  /** The snapshot could not be built (the project record went away mid-handshake). */
  failed: 4500
})

/**
 * What a joining view gets in `ready` (design-web.md §5.1): enough to draw the window without a
 * round trip. Tasks 17, 23 and 24 extend it (panel headers and slot frames, pending asks, held
 * pages), each with its own snapshot test. `tabs` is the plain list, not `tabs.list`: that call
 * resets terminal flow (TabManager.attach), which a remote view must never do to the desktop.
 */
export interface WebSnapshot {
  tabs: TabInfo[]
  layout: LayoutView
  overlays: OverlayInfo[]
}

export type HelloFrame = { t: 'hello'; v: number; project: string }
export type InvokeFrame = { t: 'invoke'; id: number; ch: string; p: unknown }
export type ClientFrame = HelloFrame | InvokeFrame

export type ReadyFrame = { t: 'ready'; v: number; view: ViewId; snapshot: WebSnapshot }
export type ResultFrame = { t: 'result'; id: number; ok: true; v: unknown } | { t: 'result'; id: number; ok: false; err: string }
export type EventFrame = { t: 'event'; ch: string; p: unknown }
export type ServerFrame = ReadyFrame | ResultFrame | EventFrame

/** A project id is main's own (a short id); anything longer is not one, and is not looked up. */
const MAX_PROJECT_ID = 200
/** Longer than any channel name; a longer `ch` is refused without a lookup. */
const MAX_CHANNEL = 64
/** Strict base64 (linear: one class, one optional tail). */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

const invokeChannels: ReadonlySet<string> = new Set(INVOKE_CHANNELS)
const eventChannels: ReadonlySet<string> = new Set(EVENT_CHANNELS)

/**
 * Whether a remote view may invoke `ch`: an invoke channel (the preload's allow-list) whose remote
 * class is not `no`. `overlays.message` is both an invoke and an event name; this checks the invoke
 * list, so an event-only name is refused here.
 */
export function invokeAllowed(ch: string): ch is InvokeChannel {
  return invokeChannels.has(ch) && remoteAllowed(ch)
}

/** Whether main may send event `ch` to a remote view: an event channel whose class is not `no`. */
export function eventAllowed(ch: string): boolean {
  return eventChannels.has(ch) && remoteAllowed(ch)
}

/** The frame as JSON text, each Uint8Array (a Buffer too) as `{ $bytes }`. */
export function encodeFrame(frame: ServerFrame | ClientFrame): string {
  // A function replacer sees `this[key]`, the value before `toJSON`: a Buffer's own toJSON would
  // otherwise turn it into `{ type: 'Buffer', data: [...] }` before the check.
  return JSON.stringify(frame, function (this: Record<string, unknown>, key: string, value: unknown) {
    const raw = this[key]
    if (raw instanceof Uint8Array) return { $bytes: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64') }
    return value
  })
}

/** JSON text with every `{ $bytes: <base64> }` (exactly that one key) turned back into a Uint8Array. */
export function decodeJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    const keys = Object.keys(value)
    if (keys.length !== 1 || keys[0] !== '$bytes') return value
    const b64 = (value as { $bytes: unknown }).$bytes
    if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !BASE64.test(b64)) return value
    // A copy, not a view: a small Buffer sits in Node's shared pool, which a handler must not see.
    return new Uint8Array(Buffer.from(b64, 'base64'))
  })
}

/** UTF-8 size of an encoded frame, for the MAX_FRAME_BYTES check. */
export function frameBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * A client frame from socket text, or the reason it is not one (the connection closes then). Checks
 * the shape only; whether `ch` may be called is `invokeAllowed`, answered per call with an error
 * result, as an IPC invoke of a refused channel rejects.
 */
export function parseClientFrame(text: string): ClientFrame | { error: string } {
  let value: unknown
  try {
    value = decodeJson(text)
  } catch {
    return { error: 'not JSON' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'not an object' }
  const f = value as Record<string, unknown>
  if (f.t === 'hello') {
    if (typeof f.v !== 'number' || !Number.isSafeInteger(f.v)) return { error: 'bad hello' }
    if (typeof f.project !== 'string' || f.project === '' || f.project.length > MAX_PROJECT_ID) return { error: 'bad hello' }
    return { t: 'hello', v: f.v, project: f.project }
  }
  if (f.t === 'invoke') {
    if (typeof f.id !== 'number' || !Number.isSafeInteger(f.id) || f.id < 0) return { error: 'bad invoke id' }
    if (typeof f.ch !== 'string' || f.ch.length === 0 || f.ch.length > MAX_CHANNEL) return { error: 'bad invoke channel' }
    // Only the payload is passed on, never the frame: nothing else in it reaches a handler.
    return { t: 'invoke', id: f.id, ch: f.ch, p: f.p }
  }
  return { error: 'unknown frame' }
}
