// The web shell's `window.cockpit` (design-web.md §2, §3): the same `invoke` / `on` the Electron
// preload (src/preload/index.ts) gives the shell, over the view's one WebSocket to the gateway.
// The React shell cannot tell the two apart; everything that differs lives here.
//
// - Allow-lists. Only the channels of src/shared/ipc.ts pass, as in the preload, and a channel
//   whose remote class is `no` is refused here before it is sent (design §3: "the browser bridge
//   checks them too"). Main checks every frame again (main/web/protocol.ts, the router); this is
//   the page's own review point, not the authority.
// - One socket, one view. The socket says `hello` with the project, main binds it to that project's
//   window and answers `ready` with a fresh view id and the window's snapshot. Nothing else in a
//   frame names a window or a project.
// - Drops. No resume tokens in v1 (design §3): a dropped view reconnects (with backoff) and gets a
//   fresh `ready`; whatever happened while away is in that snapshot, not replayed. While away the
//   status is `away` (the page shows "host unreachable"), calls in flight reject, and new calls
//   reject at once rather than wait: a click queued for minutes and replayed on reconnect could act
//   on a tab that is gone (and typing must never land late in a Claude session).
// - Events keep their listeners across reconnects: the page subscribes once, the bridge routes
//   every `event` frame of the current socket to the listeners of its channel.
// - Terminals (design §5.2): a remote view's tab output comes as `term.snapshot` (in parts, joined
//   here) and `term.data` frames, never as `tabs.data` events; the bridge hands them to the shell's
//   `tabs.data` listeners, a whole snapshot with `reset` (the terminal starts over with it, and the
//   shell does not ack it), so TerminalSession is the same in both shells. Size items go to the
//   same listeners as `tabs.data` with `cols`/`rows` and an empty `data` (in stream order), and a
//   snapshot carries its size: the page draws at the pty's size (per-view sizes, plan Task 15).
// - Panel ports (design §5.3): main's `port.open` / `port.msg` / `port.close` go to this socket's
//   PortRelay (port-relay.ts), which hands each port to the panel that asked (`onPort`, the panel
//   port bus) and relays its messages; a drop closes every port of the old socket.
// - Shared asks (design §5.1, main/sessions/close-asks.ts): plugin close asks pending when the view
//   joined come in `ready` (`closeAsks`); the bridge keeps the pending set (adding each
//   `sessions.closeAsk`, dropping each `sessions.closeSettled`) and hands it to every new
//   `sessions.closeAsk` listener as if the asks had just arrived. The shell subscribes when it
//   mounts, which is after `ready` (and again after each reconnect's remount), so without this a
//   view joining mid-ask would never show the dialog. The `ccc plugin link` confirm (`links.ask` /
//   `links.settled`, `ready`'s `linkAsks`, main/plugins/link-asks.ts) and the Move to Trash confirm
//   (`trash.ask` / `trash.settled`, `trashAsks`, main/files/trash-asks.ts) are the same (SHARED_ASKS).
//
// No DOM or WebSocket globals at module level: the socket factory and the timers are injected, so
// the unit tests (plain Node) drive the bridge with a fake socket and fake time.

import { EVENT_CHANNELS, INVOKE_CHANNELS, remoteAllowed, type CockpitApi } from '../../shared/ipc'
import {
  CLOSE,
  MAX_FRAME_BYTES,
  OVERLAY_PAGES_PATH,
  PLUGIN_PAGES_PATH,
  PROTOCOL_VERSION,
  type ClientFrame,
  type ReadyFrame,
  type WebPagePaths,
  type WebSnapshot,
  utf8Length
} from '../../shared/web-protocol'
import type { ViewId } from '../../shared/views'
import { PortRelay, type ChannelLike } from './port-relay'

/** The parts of a browser WebSocket the bridge uses (`WebSocket` itself fits). */
export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

/** `WebSocket.OPEN`. */
const OPEN = 1

/**
 * Where the page stands with the host:
 * - `connecting`: the first connection, before any `ready` (the page draws nothing yet);
 * - `ready`: bound to the window as `view`, `generation` counting the `ready`s of this page (1 is
 *   the first; a higher one is a reconnect, after which the page redraws from fresh state);
 * - `away`: the socket dropped (or never opened); the next attempt is due at `retryAt`;
 * - `gone`: main said this view cannot come back by retrying (the project window closed or is not
 *   open, or the page is from another app version); `reason` is for the person, `code` the close
 *   code main sent (absent when the page found itself signed out).
 */
export type BridgeStatus =
  | { state: 'connecting' }
  | { state: 'ready'; view: ViewId; generation: number }
  | { state: 'away'; retryAt: number; attempt: number }
  | { state: 'gone'; reason: string; code?: number }

/**
 * Whether a page that is `gone` goes straight back to the project list instead of saying why. Only a
 * server's browser view (`server`: the `ready` snapshot's hint) whose window was closed: there a
 * close is a browser's Close project, for every device (design-web.md §9.8), and the picker is
 * where every view of that project goes next. On the desktop the message stays: the person at the
 * host closed it, and the browser should say so.
 */
export function backToPicker(status: BridgeStatus, server: boolean): boolean {
  return server && status.state === 'gone' && status.code === CLOSE.windowClosed
}

export interface Timers {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface WebBridgeOptions {
  /** The socket's URL (`ws(s)://<host>/ws`, `socketUrl`). */
  url: string
  /** The project this page shows; main binds the view to the window that has it open. */
  project: string
  createSocket(url: string): SocketLike
  timers?: Timers
  /** Delay before reconnect attempt n (1-based); default `reconnectDelay`. */
  delay?(attempt: number): number
  /** How long after the socket opens `ready` may take before the bridge gives up on that socket. */
  readyTimeoutMs?: number
  /**
   * Asked once per drop: is this browser still signed in (the gateway's `/auth/session`)? A revoked
   * or expired device gets the same 1006 as a network drop (the upgrade is refused), so without this
   * the page would say "host unreachable" and retry forever. Resolves false only on a definite
   * "signed out"; a failed request (host really unreachable) must resolve true or reject.
   */
  checkSession?(): Promise<boolean>
  /** How long a `ready` connection must stay up before the backoff starts over; default `STABLE_MS`. */
  stableMs?: number
  /**
   * Where this view loads plugin files and inline overlays: from every `ready`, and again from a
   * `paths` frame (a plugin installed or removed). Malformed paths are passed as none.
   */
  onPagePaths?(paths: WebPagePaths): void
  /**
   * A panel, slot or settings page port main opened for this view (`port.open`): hand it to the
   * request that asked with `key` and `nonce` (panel-port-bus.ts deliverPanelPort); false when none
   * waits. Absent: every port is refused (closed at once).
   */
  onPort?(key: string, nonce: number, port: MessagePort): boolean
  /** The channel factory for relayed ports (tests); `new MessageChannel()` by default. */
  createChannel?(): ChannelLike
}

/** A close ask from main (an event or `ready`'s list), checked; undefined when malformed. */
function closeAskOf(value: unknown): { requestId: string; tabId: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { requestId, tabId } = value as Record<string, unknown>
  return typeof requestId === 'string' && typeof tabId === 'string' ? { requestId, tabId } : undefined
}

/** A `links.ask` from main (an event or `ready`'s list), checked; undefined when malformed. */
function linkAskOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const caller = v.caller
  if (typeof v.requestId !== 'string' || typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.path !== 'string') return undefined
  if (caller !== 'tab' && caller !== 'project') return undefined
  return { requestId: v.requestId, id: v.id, name: v.name, path: v.path, caller }
}

/** A `trash.ask` from main (an event or `ready`'s list), checked; undefined when malformed. */
function trashAskOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.requestId !== 'string' || typeof v.path !== 'string' || typeof v.pluginId !== 'string') return undefined
  if (v.kind !== 'file' && v.kind !== 'folder') return undefined
  return { requestId: v.requestId, path: v.path, kind: v.kind, pluginId: v.pluginId }
}

/**
 * The shared asks the bridge keeps for a late subscriber (see the top of the file): the event that
 * opens one, the one that settles it, `ready`'s list and the checker of an item.
 */
const SHARED_ASKS: ReadonlyArray<{
  ask: string
  settled: string
  field: 'closeAsks' | 'linkAsks' | 'trashAsks'
  parse(value: unknown): { requestId: string } | undefined
}> = [
  { ask: 'sessions.closeAsk', settled: 'sessions.closeSettled', field: 'closeAsks', parse: closeAskOf },
  { ask: 'links.ask', settled: 'links.settled', field: 'linkAsks', parse: (v) => linkAskOf(v) as { requestId: string } | undefined },
  { ask: 'trash.ask', settled: 'trash.settled', field: 'trashAsks', parse: (v) => trashAskOf(v) as { requestId: string } | undefined }
]

/** Main's paths, checked: string prefixes under the gateway's own paths only, else none. */
export function pagePathsOf(value: unknown): WebPagePaths {
  const none: WebPagePaths = { plugins: {}, overlays: '' }
  if (typeof value !== 'object' || value === null) return none
  const v = value as Record<string, unknown>
  if (typeof v.plugins !== 'object' || v.plugins === null || Array.isArray(v.plugins)) return none
  // fromEntries defines own properties: an id like `__proto__` cannot reach the prototype.
  const plugins = Object.fromEntries(
    Object.entries(v.plugins).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].startsWith(PLUGIN_PAGES_PATH))
  )
  const overlays = typeof v.overlays === 'string' && v.overlays.startsWith(OVERLAY_PAGES_PATH) ? v.overlays : ''
  return { plugins, overlays }
}

export interface WebBridge {
  /** What `window.cockpit` is set to. */
  readonly api: CockpitApi
  status(): BridgeStatus
  /** The latest `ready` snapshot (undefined before the first). */
  snapshot(): WebSnapshot | undefined
  /** Be told of every status change; returns the unsubscribe function. */
  onStatus(listener: (status: BridgeStatus) => void): () => void
  /** Skip the wait and try now (the "host unreachable" notice's Retry). Only while `away`. */
  retryNow(): void
  /** Close for good (page unload); nothing reconnects after this. */
  close(): void
}

/** Error text of a call that could not reach the host (the page shows it as any IPC error). */
export const UNREACHABLE = 'host unreachable'

/** Backoff: 0.5 s, 1 s, 2 s, ... capped at 10 s. A LAN drop comes back fast; a sleeping host is not hammered. */
export function reconnectDelay(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** Math.max(0, Math.min(attempt - 1, 10)))
}

/**
 * A connection that main accepts and closes at once (a `tooLarge` on every join) must not reset the
 * backoff, or the page would reconnect and remount the whole shell every 0.5 s forever.
 */
export const STABLE_MS = 10_000

/** From the socket's creation to `ready`: it covers a TCP connect that hangs (a host asleep, a phone changing networks) as well as a hung handshake. */
export const READY_TIMEOUT_MS = 10_000

/**
 * Close codes after which retrying cannot help (CLOSE, shared/web-protocol.ts), with what the
 * person is told. Everything else (a network drop, a restart of the app, a refused upgrade,
 * `tooLarge`, which is defined as "reconnect to a fresh snapshot") is retried. So is
 * `CLOSE.serverStop` on purpose: a server mode stop (systemd, an update, a reboot) comes back by
 * itself, so the page shows the host as away and reconnects, where a desktop quit (`appQuit`) waits
 * for a person and says "Reload this page".
 */
const FINAL_CLOSES: ReadonlyMap<number, string> = new Map([
  [CLOSE.noProject, 'This project is not open on the host.'],
  [CLOSE.windowClosed, 'The project window was closed on the host.'],
  [CLOSE.version, 'The cockpit on the host was updated. Reload the page.'],
  [CLOSE.turnedOff, 'Web access was turned off on the host.'],
  [CLOSE.appQuit, 'cc-cockpit was quit on the host. Reload this page once it runs again.'],
  [CLOSE.tooManyViews, 'This browser has too many views of this project open. Close one, then reload this page.']
])

/**
 * Which mounted shell (the `ready` generation it was mounted for) the web root draws now; 0 for
 * none. The last state stays up while the host is away or the socket reconnects (its calls fail
 * then), but not once a newer `ready` arrived: until the shell is mounted afresh for it (after the
 * resync), the old one would act on the new view. A tab picked there has main send its snapshot to
 * terminals the remount then drops, and main does not send it again when the new shell picks the
 * same tab (the view already follows it), so the new terminal could stay blank.
 */
export function shellToDraw(status: BridgeStatus, shown: number): number {
  if (status.state === 'ready' && status.generation !== shown) return 0
  return shown
}

/** The socket URL for a page loaded from `location` (same host, ws or wss to match http or https). */
export function socketUrl(location: { protocol: string; host: string }, path: string): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`
}

/** A terminal size in a frame from main: whole numbers in the pty's bounds (PtyService), else ignored. */
function sizeOf(cols: unknown, rows: unknown): { cols: number; rows: number } | undefined {
  const ok =
    typeof cols === 'number' &&
    typeof rows === 'number' &&
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 1 &&
    rows >= 1 &&
    cols <= 1000 &&
    rows <= 1000
  return ok ? { cols, rows } : undefined
}

const invokeChannels: ReadonlySet<string> = new Set(INVOKE_CHANNELS)
const eventChannels: ReadonlySet<string> = new Set(EVENT_CHANNELS)

/** Strict base64 (linear: one class, one optional tail), as main's decoder. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function bytesToBase64(bytes: Uint8Array): string {
  // btoa takes a "binary string"; built in chunks so a large payload does not overflow the
  // argument list of String.fromCharCode.
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** A client frame as JSON text, each Uint8Array as `{ $bytes }` (main's decodeJson turns it back). */
export function encodeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame, (_key, value: unknown) =>
    value instanceof Uint8Array ? { $bytes: bytesToBase64(value) } : value
  )
}

/** Server JSON with every `{ $bytes: <base64> }` (exactly that one key) back as a Uint8Array. */
export function decodeServerJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    const keys = Object.keys(value)
    if (keys.length !== 1 || keys[0] !== '$bytes') return value
    const b64 = (value as { $bytes: unknown }).$bytes
    if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !BASE64.test(b64)) return value
    return base64ToBytes(b64)
  })
}

const defaultTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
}

export function createWebBridge(options: WebBridgeOptions): WebBridge {
  const timers = options.timers ?? defaultTimers
  const delay = options.delay ?? reconnectDelay
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
  const stableMs = options.stableMs ?? STABLE_MS

  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const statusListeners = new Set<(status: BridgeStatus) => void>()
  // Calls of the current socket only: a drop rejects them all, so an id is never answered by
  // another socket's result (ids restart nowhere: one counter for the page's life).
  const pending = new Map<number, Pending>()
  let nextId = 1
  let status: BridgeStatus = { state: 'connecting' }
  let snapshot: WebSnapshot | undefined
  let generation = 0
  let attempt = 0
  let socket: SocketLike | undefined
  let retryTimer: unknown
  let readyTimer: unknown
  let closed = false
  let readyAt: number | undefined
  // Bumped on every drop and connect, so a late session answer never acts on a newer state.
  let epoch = 0
  // Snapshot parts received so far per tab (the current socket's; a new socket starts empty).
  let snapParts = new Map<string, { seq: number; parts: number; cols: number; rows: number; data: string[] }>()
  // The current socket's relayed panel ports (a new socket starts with none).
  let ports: PortRelay | undefined
  // Plugin close asks of this window still waiting, by request id (see the top of the file).
  const sharedAsks = new Map<string, Map<string, { requestId: string }>>(SHARED_ASKS.map((k) => [k.ask, new Map()]))

  const setStatus = (next: BridgeStatus): void => {
    status = next
    for (const listener of [...statusListeners]) {
      try {
        listener(next)
      } catch (err) {
        console.error('web bridge: status listener failed', err)
      }
    }
  }

  const rejectAll = (): void => {
    const calls = [...pending.values()]
    pending.clear()
    for (const call of calls) call.reject(new Error(UNREACHABLE))
  }

  const clearReadyTimer = (): void => {
    if (readyTimer !== undefined) timers.clearTimeout(readyTimer)
    readyTimer = undefined
  }

  const scheduleRetry = (): void => {
    attempt += 1
    const wait = delay(attempt)
    setStatus({ state: 'away', retryAt: timers.now() + wait, attempt })
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined
      connect()
    }, wait)
  }

  /** The current socket ended (closed by either side, or failed to open). */
  const dropped = (s: SocketLike, code: number): void => {
    if (s !== socket) return
    socket = undefined
    clearReadyTimer()
    rejectAll()
    ports?.closeAll()
    ports = undefined
    // Asks held for a late subscriber: the next `ready` carries the live set again, and until then
    // a remount would be shown a dialog main may already have settled.
    for (const m of sharedAsks.values()) m.clear()
    epoch += 1
    if (readyAt !== undefined && timers.now() - readyAt >= stableMs) attempt = 0
    readyAt = undefined
    if (closed) return
    const final = FINAL_CLOSES.get(code)
    if (final !== undefined) {
      setStatus({ state: 'gone', reason: final, code })
      return
    }
    scheduleRetry()
    askSession()
  }

  /** After a drop: a signed-out browser cannot retry its way back, so it stops and says so. */
  const askSession = (): void => {
    if (!options.checkSession) return
    const mine = epoch
    options.checkSession().then(
      (signedIn) => {
        if (signedIn || closed || mine !== epoch || status.state !== 'away') return
        if (retryTimer !== undefined) timers.clearTimeout(retryTimer)
        retryTimer = undefined
        setStatus({ state: 'gone', reason: 'This browser is signed out of the host. Sign in again.' })
      },
      () => undefined
    )
  }

  /** Follow the window's pending close asks from the events, before the listeners hear them. */
  const trackAsk = (channel: string, payload: unknown): void => {
    for (const kind of SHARED_ASKS) {
      if (channel === kind.ask) {
        const ask = kind.parse(payload)
        if (ask) sharedAsks.get(kind.ask)!.set(ask.requestId, ask)
      } else if (channel === kind.settled) {
        const id = (payload as { requestId?: unknown } | null)?.requestId
        if (typeof id === 'string') sharedAsks.get(kind.ask)!.delete(id)
      }
    }
  }

  const emit = (channel: string, payload: unknown): void => {
    const set = listeners.get(channel)
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener(payload)
      } catch (err) {
        console.error(`web bridge: listener of ${channel} failed`, err)
      }
    }
  }

  /** A `term.snapshot` part or a `term.data` item, as the shell's `tabs.data` (see the header). */
  const onTerminalFrame = (f: Record<string, unknown>): void => {
    const tabId = f.tabId
    if (typeof tabId !== 'string' || typeof f.seq !== 'number' || !Number.isSafeInteger(f.seq)) return
    if (f.t === 'term.data') {
      if (typeof f.data === 'string') emit('tabs.data', { tabId, data: f.data })
      // A size item: the pty took this size here in the stream (an empty `data` carries it, in order).
      else {
        const size = sizeOf(f.cols, f.rows)
        if (size) emit('tabs.data', { tabId, data: '', ...size })
      }
      return
    }
    const { part, parts, data } = f
    const size = sizeOf(f.cols, f.rows)
    if (typeof part !== 'number' || typeof parts !== 'number' || typeof data !== 'string' || !size) return
    if (!Number.isSafeInteger(parts) || parts < 1 || !Number.isSafeInteger(part) || part < 1 || part > parts) return
    let got = snapParts.get(tabId)
    if (part === 1) snapParts.set(tabId, (got = { seq: f.seq, parts, ...size, data: [] }))
    // Main sends the parts back to back; anything else is a broken stream, dropped whole.
    if (!got || got.seq !== f.seq || got.parts !== parts || got.data.length !== part - 1) {
      snapParts.delete(tabId)
      console.warn('web bridge: terminal snapshot out of order')
      return
    }
    got.data.push(data)
    if (part < parts) return
    snapParts.delete(tabId)
    // The screen was serialized at cols x rows: the terminal takes that size before parsing it.
    emit('tabs.data', { tabId, data: got.data.join(''), reset: true, cols: got.cols, rows: got.rows })
  }

  const onFrame = (s: SocketLike, data: unknown): void => {
    if (s !== socket) return
    if (typeof data !== 'string') return
    let frame: unknown
    try {
      frame = decodeServerJson(data)
    } catch {
      console.warn('web bridge: frame is not JSON')
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    const f = frame as Record<string, unknown>
    if (f.t === 'ready') {
      if (status.state === 'ready' || f.v !== PROTOCOL_VERSION || typeof f.view !== 'string') return
      clearReadyTimer()
      const ready = f as unknown as ReadyFrame
      snapshot = ready.snapshot
      // The snapshot's list replaces the old socket's: asks settled while away are not in it.
      for (const kind of SHARED_ASKS) {
        const held = sharedAsks.get(kind.ask)!
        held.clear()
        const list: unknown = ready.snapshot?.[kind.field]
        if (Array.isArray(list)) {
          for (const item of list as unknown[]) {
            const ask = kind.parse(item)
            if (ask) held.set(ask.requestId, ask)
          }
        }
      }
      // Before the status change: the shell mounts on `ready` and draws plugin images at once.
      options.onPagePaths?.(pagePathsOf(ready.paths))
      readyAt = timers.now()
      generation += 1
      setStatus({ state: 'ready', view: ready.view, generation })
      return
    }
    if (f.t === 'paths') {
      if (status.state === 'ready') options.onPagePaths?.(pagePathsOf(f.paths))
      return
    }
    if (f.t === 'result') {
      if (typeof f.id !== 'number') return
      const call = pending.get(f.id)
      if (!call) return
      pending.delete(f.id)
      if (f.ok === true) call.resolve(f.v)
      // As the preload: main's error message only (never a stack), as an Error.
      else call.reject(new Error(typeof f.err === 'string' ? f.err : 'failed'))
      return
    }
    if (f.t === 'event') {
      // Main sends only allowed events (protocol.ts eventAllowed); the page checks again, as the
      // preload's `on` refuses a channel outside the shared list.
      if (status.state !== 'ready' || typeof f.ch !== 'string' || !eventChannels.has(f.ch) || !remoteAllowed(f.ch)) return
      trackAsk(f.ch, f.p)
      emit(f.ch, f.p)
      return
    }
    if (f.t === 'term.snapshot' || f.t === 'term.data') {
      if (status.state === 'ready') onTerminalFrame(f)
      return
    }
    if (status.state !== 'ready' || !ports) return
    if (f.t === 'port.open') ports.open(f.key, f.nonce)
    else if (f.t === 'port.msg') ports.message(f.key, f.nonce, f.m)
    else if (f.t === 'port.close') ports.remoteClosed(f.key, f.nonce)
  }

  /** A port frame on socket `s`; false when it did not go out (the socket is not this one or not open, or over the cap). */
  const sendPortFrame = (s: SocketLike, frame: ClientFrame): boolean => {
    if (s !== socket || s.readyState !== OPEN) return false
    const text = encodeClientFrame(frame)
    // Main would close the socket (1009) on a frame this big; only this message is lost.
    if (utf8Length(text) > MAX_FRAME_BYTES) return false
    try {
      s.send(text)
      return true
    } catch {
      return false
    }
  }

  const connect = (): void => {
    if (closed) return
    let s: SocketLike
    try {
      s = options.createSocket(options.url)
    } catch (err) {
      // A malformed URL or a blocked scheme throws synchronously; treated like a failed open.
      console.warn('web bridge: socket failed', err)
      scheduleRetry()
      return
    }
    socket = s
    epoch += 1
    snapParts = new Map()
    ports?.closeAll()
    ports = new PortRelay({
      send: (frame) => sendPortFrame(s, frame),
      deliver: (key, nonce, port) => options.onPort?.(key, nonce, port) ?? false,
      ...(options.createChannel ? { createChannel: options.createChannel } : {})
    })
    readyTimer = timers.setTimeout(() => {
      readyTimer = undefined
      if (s === socket) s.close()
    }, readyTimeoutMs)
    s.onopen = () => {
      if (s !== socket) return
      s.send(encodeClientFrame({ t: 'hello', v: PROTOCOL_VERSION, project: options.project }))
    }
    s.onmessage = (ev) => onFrame(s, ev.data)
    s.onclose = (ev) => dropped(s, ev.code)
    // `error` is always followed by `close`; nothing to do here.
    s.onerror = () => undefined
  }

  const api: CockpitApi = {
    invoke: (channel, ...payload) => {
      // The page is untrusted JS as far as main is concerned, but this check is the page's own:
      // the same refusal the preload gives, plus the remote class.
      if (typeof channel !== 'string' || !invokeChannels.has(channel)) {
        return Promise.reject(new Error('invalid channel'))
      }
      if (!remoteAllowed(channel)) return Promise.reject(new Error('not available in a remote view'))
      const s = socket
      if (status.state !== 'ready' || !s || s.readyState !== OPEN) return Promise.reject(new Error(UNREACHABLE))
      const id = nextId++
      let text: string
      try {
        text = encodeClientFrame({ t: 'invoke', id, ch: channel, p: payload[0] })
      } catch {
        return Promise.reject(new Error('payload is not serializable'))
      }
      // Main would close the socket (1009) on a frame this big, dropping every other call with it.
      if (utf8Length(text) > MAX_FRAME_BYTES) return Promise.reject(new Error('payload too large'))
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          s.send(text)
        } catch {
          pending.delete(id)
          reject(new Error(UNREACHABLE))
        }
      }) as ReturnType<CockpitApi['invoke']>
    },
    on: (channel, listener) => {
      if (typeof channel !== 'string' || !eventChannels.has(channel)) throw new Error('invalid channel')
      // A `no`-class event (window.state, the update notice, ...) is never sent to a remote view.
      // The shared shell subscribes to some of them unconditionally, so this is a listener that
      // never fires rather than a throw that would break the page.
      if (!remoteAllowed(channel)) return () => undefined
      const fn = listener as (payload: unknown) => void
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      set.add(fn)
      const held = sharedAsks.get(channel)
      if (held !== undefined && held.size > 0) {
        // A turn later, as an event would come: the subscriber's own setup has finished. Only to a
        // listener still subscribed then (StrictMode subscribes, drops and subscribes again), and
        // only asks still pending then (a settle may have come in between).
        const asks = [...held.keys()]
        queueMicrotask(() => {
          if (!set.has(fn)) return
          for (const id of asks) {
            const ask = held.get(id)
            if (!ask) continue
            try {
              fn({ ...ask })
            } catch (err) {
              console.error(`web bridge: listener of ${channel} failed`, err)
            }
          }
        })
      }
      return () => {
        set.delete(fn)
      }
    }
  }

  connect()

  return {
    api,
    status: () => status,
    snapshot: () => snapshot,
    onStatus(listener) {
      statusListeners.add(listener)
      return () => {
        statusListeners.delete(listener)
      }
    },
    retryNow() {
      if (closed || status.state !== 'away') return
      if (retryTimer !== undefined) {
        timers.clearTimeout(retryTimer)
        retryTimer = undefined
      } else if (socket) {
        // A connect that hangs: drop it (its late events are ignored, `s !== socket`) and start again.
        const old = socket
        socket = undefined
        clearReadyTimer()
        try {
          old.close()
        } catch {
          // already dead
        }
      } else return
      connect()
    },
    close() {
      if (closed) return
      closed = true
      if (retryTimer !== undefined) timers.clearTimeout(retryTimer)
      retryTimer = undefined
      clearReadyTimer()
      const s = socket
      socket = undefined
      rejectAll()
      ports?.closeAll()
      ports = undefined
      s?.close()
    }
  }
}
