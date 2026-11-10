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

import type { InvokeChannel } from '../../shared/ipc'
import { EVENT_CHANNELS, INVOKE_CHANNELS, remoteAllowed } from '../../shared/ipc'
import type { ClientFrame, ServerFrame } from '../../shared/web-protocol'

// The constants and frame types live in src/shared/web-protocol.ts, which the browser bridge
// (src/renderer/web/bridge.ts) imports too; re-exported so main's side has one import point.
export { CLOSE, MAX_FRAME_BYTES, PROTOCOL_VERSION, WS_PATH } from '../../shared/web-protocol'
export type {
  ClientFrame,
  EventFrame,
  HelloFrame,
  InvokeFrame,
  ReadyFrame,
  ResultFrame,
  ServerFrame,
  WebSnapshot
} from '../../shared/web-protocol'

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
