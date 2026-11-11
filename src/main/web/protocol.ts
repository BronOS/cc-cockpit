// The web access wire protocol (design-web.md §3): one WebSocket per remote view, JSON text
// frames, at most MAX_FRAME_BYTES each. Pure functions and types only (no `ws`, no Electron), so
// the gateway, the connection and the tests share one definition and the browser bridge (plan
// Task 7) mirrors it.
//
// Frames (shared asks settle through an ordinary event, `sessions.closeSettled`):
//   client -> main  { t: 'hello', v, project }        once, first; binds the view to that window
//                   { t: 'invoke', id, ch, p }        an IPC invoke, answered by a `result`
//                   { t: 'port.msg', key, nonce, m }  a panel page's message, for its port's host end
//                   { t: 'port.close', key, nonce }   the page's port ended (its frame unloaded)
//   main -> client  { t: 'ready', v, view, snapshot } once, after a good hello
//                   { t: 'result', id, ok: true, v } | { t: 'result', id, ok: false, err }
//                   { t: 'event', ch, p }             an IPC event (ViewRegistry, view-registry.ts)
//                   { t: 'term.snapshot', tabId, seq, cols, rows, part, parts, data }
//                   { t: 'term.data', tabId, seq, data } | { ..., cols, rows }
//                                                     a tab's terminal stream (view-terminals.ts)
//                   { t: 'port.open', key, nonce }    the port asked for with `nonce` (panels.connect, ...)
//                   { t: 'port.msg', key, nonce, m } | { t: 'port.close', key, nonce }
//                                                     a relayed panel port (port-relay.ts)
//
// `Uint8Array` values travel as `{ $bytes: <base64> }` both ways (JSON has no bytes). Everything a
// client frame holds is untrusted text: the shape is checked here, the channel against the
// allow-list and remote class (`invokeAllowed`) before the router sees it, and again in the router.

import type { InvokeChannel } from '../../shared/ipc'
import { EVENT_CHANNELS, INVOKE_CHANNELS, remoteAllowed } from '../../shared/ipc'
import type { ClientFrame, ServerFrame, TermDataFrame, TermSnapshotFrame } from '../../shared/web-protocol'
import { MAX_FRAME_BYTES, MAX_PORT_KEY_LENGTH } from '../../shared/web-protocol'
import type { MirrorItem, MirrorSnapshot } from '../terminals/mirror-protocol'

// The constants and frame types live in src/shared/web-protocol.ts, which the browser bridge
// (src/renderer/web/bridge.ts) imports too; re-exported so main's side has one import point.
export { CLOSE, MAX_FRAME_BYTES, PROTOCOL_VERSION, WS_PATH } from '../../shared/web-protocol'
export type {
  ClientFrame,
  EventFrame,
  HelloFrame,
  InvokeFrame,
  PortCloseFrame,
  PortMsgFrame,
  PortOpenFrame,
  ReadyFrame,
  ResultFrame,
  ServerFrame,
  TermDataFrame,
  TermSnapshotFrame,
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

/**
 * UTF-8 size of an encoded frame, for the MAX_FRAME_BYTES check. Native (every frame main sends
 * passes here, up to 4 MiB); the bridge's shared utf8Length counts the same, lone surrogates
 * included (web-bridge.test.ts).
 */
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
  if (f.t === 'port.msg' || f.t === 'port.close') {
    // Shape only: whether the view holds a port of that key and nonce is the relay's look-up, and
    // the message's length its check (a frame is already capped at MAX_FRAME_BYTES by `ws`).
    if (typeof f.key !== 'string' || f.key === '' || f.key.length > MAX_PORT_KEY_LENGTH) return { error: 'bad port key' }
    if (typeof f.nonce !== 'number' || !Number.isSafeInteger(f.nonce)) return { error: 'bad port nonce' }
    if (f.t === 'port.close') return { t: 'port.close', key: f.key, nonce: f.nonce }
    if (typeof f.m !== 'string') return { error: 'bad port message' }
    return { t: 'port.msg', key: f.key, nonce: f.nonce, m: f.m }
  }
  return { error: 'unknown frame' }
}

/**
 * UTF-8 bytes JSON.stringify writes for one UTF-16 code unit inside a string (a surrogate pair is
 * handled by the caller): `"` and `\` and the five short escapes take 2, other control characters
 * `\u00XX` 6, a lone surrogate `\uDXXX` 6 (well-formed JSON.stringify), the rest their UTF-8 size.
 */
function jsonUnitBytes(c: number): number {
  if (c === 0x22 || c === 0x5c) return 2
  if (c < 0x20) return c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d ? 2 : 6
  if (c < 0x80) return 1
  if (c < 0x800) return 2
  if (c >= 0xd800 && c <= 0xdfff) return 6
  return 3
}

/**
 * A snapshot as the `term.snapshot` frames a view gets, each at most `maxBytes` encoded. Split by
 * the exact JSON size of each character, not a worst case: terminal output is mostly escapes
 * (`\u001b`, 6 bytes for one character) and plain ASCII, so a fixed ratio would either waste most
 * of a frame or overrun one. Never splits a surrogate pair (only the joined string matters to the
 * page, but a part that stands alone as valid text is easier to debug). An empty screen is one part.
 */
export function termSnapshotFrames(tabId: string, snapshot: MirrorSnapshot, maxBytes = MAX_FRAME_BYTES): TermSnapshotFrame[] {
  const { seq, cols, rows, data } = snapshot
  // The frame around the data, with the widest part numbers it could carry.
  const shell = frameBytes(
    encodeFrame({ t: 'term.snapshot', tabId, seq, cols, rows, part: Number.MAX_SAFE_INTEGER, parts: Number.MAX_SAFE_INTEGER, data: '' })
  )
  const budget = maxBytes - shell
  // Room for at least one character of any kind (a pair is 4, an escape 6).
  if (budget < 6) throw new Error('frame cap too small for a terminal snapshot')
  const pieces: string[] = []
  let start = 0
  let used = 0
  for (let i = 0; i < data.length; ) {
    const c = data.charCodeAt(i)
    let units = 1
    let bytes: number
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < data.length) {
      const next = data.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        units = 2
        bytes = 4
      } else bytes = 6
    } else bytes = jsonUnitBytes(c)
    if (used + bytes > budget) {
      pieces.push(data.slice(start, i))
      start = i
      used = 0
    }
    used += bytes
    i += units
  }
  pieces.push(data.slice(start))
  return pieces.map((piece, n) => ({ t: 'term.snapshot', tabId, seq, cols, rows, part: n + 1, parts: pieces.length, data: piece }))
}

/** A stream item as its `term.data` frame; null for `close` (the view is told with `tabs.removed`). */
export function termDataFrame(tabId: string, item: MirrorItem): TermDataFrame | null {
  switch (item.kind) {
    case 'data':
      return { t: 'term.data', tabId, seq: item.seq, data: item.data }
    // A restart's spawn keeps the content (mirror-protocol.ts): for a view it is a size change.
    case 'spawn':
    case 'resize':
      return { t: 'term.data', tabId, seq: item.seq, cols: item.cols, rows: item.rows }
    case 'close':
      return null
  }
}
