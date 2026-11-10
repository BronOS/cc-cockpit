// The browser half of panel ports (design-web.md §5.3 "Browser side", §5.5 "Navigation"; plan Task 22).
//
// PortRelay. Main keeps the page end of each panel, slot and settings page channel it makes for a
// remote view and relays it as `port.*` frames (main/web/port-relay.ts). The shell asks for a port
// exactly as on the desktop (panel-port-bus.ts: `panels.connect` with a nonce); main's `port.open`
// with that key and nonce takes the place of the preload's posted port: a fresh MessageChannel is
// made here, port1 goes to the panel waiting for that nonce (and from there into its frame, with
// the SDK's `cc-plugin.port` message, as PluginFrame does on the desktop), and port2 is piped to the
// socket. The panel SDK cannot tell the difference. A `port.open` nobody waits for any more (the
// frame reloaded meanwhile) is answered with `port.close`, so main closes its end at once.
//
// Ends. A browser MessagePort has no close event to rely on, so the frame that got port1 says when
// its page is gone: `relayHandleOf(port1).release()` (FrameLoads below, on its next load or when it
// unmounts) closes port2 and tells main `port.close`, and the host's end hears it. Main closing its
// end (`port.close`) closes port2 and tells the handle's `onClosed`. A socket drop closes every
// port2 here (main closes its ends with the view); the shell starts over on the next `ready`.
//
// FrameLoads. The one place a plugin frame's loads are judged, for both shells (PluginFrame and the
// inline overlay). On the desktop main blocks a frame navigating anywhere (create-window.ts), so
// every load gets the theme and a port as before. In the web shell nothing can block it and the
// shell cannot read a sandboxed cross-origin frame's URL, so only a load the shell started (it set
// `src`) gets the theme and a port; any other load (the page navigated or reloaded itself, a link
// without a target) has `src` set back to the canonical path first, and only that load is served.
// A page that keeps navigating is stopped (blank) after MAX_FRAME_RESETS resets in
// FRAME_RESET_WINDOW_MS, rather than reloaded in a loop. What this cannot see: a page that
// navigates away before its first load event fires (its script runs before `load`), or a port
// that arrives in the instant between a navigation committing and its load event; both need the
// plugin's own page to do it, and the plugin's own backend is all its port reaches.
//
// DOM-free (the frame, the timers and the channel factory are passed in) so unit tests run it in
// plain Node, whose MessageChannel behaves as the browser's.

import { MAX_PORT_KEY_LENGTH, MAX_PORT_MESSAGE_LENGTH, type PortCloseFrame, type PortMsgFrame } from '../../shared/web-protocol'

/** What the frame that took a relayed port1 holds on to. */
export interface RelayHandle {
  /** The port key (`<pluginId>/<panelId>`, `@slot/<id>`, `@settings/<pluginId>`). */
  readonly key: string
  /** The page that had the port is gone: close port2 and tell main. Once; a no-op after any end. */
  release(): void
  /** Called once if main ends the port (not after `release`, nor on a socket drop). */
  onClosed(fn: () => void): void
}

/** port1 objects the relay made -> their handle. Weak: a port1 the frame dropped goes with it. */
const handles = new WeakMap<object, RelayHandle>()

/** The handle of a port1 the relay handed out; undefined for any other port (the desktop's, an overlay's own). */
export function relayHandleOf(port: object): RelayHandle | undefined {
  return handles.get(port)
}

export interface ChannelLike {
  port1: MessagePort
  port2: MessagePort
}

export interface PortRelayOptions {
  /** A frame to main; false when it did not go out (the socket dropped, or over the frame cap). */
  send(frame: PortMsgFrame | PortCloseFrame): boolean
  /** Hand port1 to whoever asked for `key` with `nonce` (panel-port-bus deliverPanelPort); false: nobody. */
  deliver(key: string, nonce: number, port: MessagePort): boolean
  createChannel?(): ChannelLike
}

interface Entry {
  readonly nonce: number
  readonly port: MessagePort
  closed?: () => void
}

export class PortRelay {
  /** key -> the port2 of the latest `port.open` of that key on this socket. */
  private readonly ports = new Map<string, Entry>()
  private closed = false

  constructor(private readonly options: PortRelayOptions) {}

  /** `port.open` from main: a port for whoever asked with this key and nonce. */
  open(key: unknown, nonce: unknown): void {
    if (this.closed || typeof key !== 'string' || key === '' || key.length > MAX_PORT_KEY_LENGTH) return
    if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce)) return
    // Main replaced this key's port (and said `port.close` for the old one first); defensive.
    this.end(key, undefined, false, false)
    const ch = this.options.createChannel?.() ?? new MessageChannel()
    const entry: Entry = { nonce, port: ch.port2 }
    this.ports.set(key, entry)
    // Assigning onmessage starts the port (in the browser and in Node).
    ch.port2.onmessage = (e: MessageEvent<unknown>) => {
      if (this.ports.get(key) !== entry) return
      // The SDK posts one JSON string per message (panel-core.ts); main checks it again.
      if (typeof e.data !== 'string' || e.data.length > MAX_PORT_MESSAGE_LENGTH) return
      if (!this.options.send({ t: 'port.msg', key, nonce, m: e.data })) console.warn(`web bridge: a message of ${key} was not sent`)
    }
    const handle: RelayHandle = {
      key,
      release: () => this.end(key, nonce, true, false),
      onClosed: (fn) => {
        if (this.ports.get(key) === entry) entry.closed = fn
      }
    }
    handles.set(ch.port1, handle)
    let taken = false
    try {
      taken = this.options.deliver(key, nonce, ch.port1)
    } catch (err) {
      console.warn(`web bridge: handing over the port of ${key} failed`, err)
    }
    if (!taken) {
      // Nobody waits for it (the frame loaded again or went away): main's end closes too.
      ch.port1.close()
      this.end(key, nonce, true, false)
    }
  }

  /** `port.msg` from main: into the frame's port, when it is still the one of that load. */
  message(key: unknown, nonce: unknown, m: unknown): void {
    if (typeof key !== 'string' || typeof m !== 'string' || m.length > MAX_PORT_MESSAGE_LENGTH) return
    const entry = this.ports.get(key)
    if (!entry || entry.nonce !== nonce) return
    entry.port.postMessage(m)
  }

  /** `port.close` from main: the host's end is gone (or main refused to keep it). */
  remoteClosed(key: unknown, nonce: unknown): void {
    if (typeof key !== 'string' || typeof nonce !== 'number') return
    this.end(key, nonce, false, true)
  }

  /** The socket dropped: every port2 closes; nothing is sent, nobody is told (the shell starts over). */
  closeAll(): void {
    this.closed = true
    for (const key of [...this.ports.keys()]) this.end(key, undefined, false, false)
  }

  /** Ports held now (tests). */
  size(): number {
    return this.ports.size
  }

  private end(key: string, nonce: number | undefined, tell: boolean, notify: boolean): void {
    const entry = this.ports.get(key)
    if (!entry || (nonce !== undefined && entry.nonce !== nonce)) return
    this.ports.delete(key)
    entry.port.onmessage = null
    entry.port.close()
    if (tell && !this.closed) this.options.send({ t: 'port.close', key, nonce: entry.nonce })
    if (notify) {
      try {
        entry.closed?.()
      } catch (err) {
        console.warn(`web bridge: the close of ${key} failed`, err)
      }
    }
  }
}

/** Resets of a frame's `src` allowed per FRAME_RESET_WINDOW_MS before the frame is stopped. */
export const MAX_FRAME_RESETS = 5
export const FRAME_RESET_WINDOW_MS = 10_000
/** After main ended a panel's port, its frame loads again this much later (a host restart's own reload usually comes first). */
export const PANEL_RECONNECT_MS = 2000
/** What a stopped frame shows. */
export const BLANK_URL = 'about:blank'

/** The frame as FrameLoads drives it (PluginFrame passes its iframe). */
export interface FrameTarget {
  /** Navigate the frame (set `src`). */
  load(url: string): void
  /** Post into the frame's current page; false when it has no window. */
  post(message: unknown, transfer?: MessagePort[]): boolean
}

export interface FrameLoadsOptions {
  target: FrameTarget
  /** Web shell: only loads the shell started are served (see the header); desktop: every load. */
  guard: boolean
  /** The message that hands the page its port (`cc-plugin.port`, `cc-overlay.port`). */
  portMessage: object
  /** The theme message for a page now; undefined: none (inline overlays, or no theme yet). */
  theme?(): object | undefined
  /** Posted just before the port on every served load (a slot frame's `cc-plugin.slot`). */
  intro?(): object | undefined
  /** Ask for this load's port; returns the clean-up for the load (PluginFrame's `connect`). */
  connect(deliver: (port: MessagePort) => void): () => void
  now?(): number
  setTimeout?(fn: () => void, ms: number): unknown
  clearTimeout?(handle: unknown): void
  log?(message: string): void
}

/** Whether a relayed port is a plugin panel's (a slot's or settings page's key starts with `@`). */
function isPanelKey(key: string): boolean {
  return !key.startsWith('@')
}

export class FrameLoads {
  private url: string | undefined
  /** The next load is one the shell started (it set `src`). */
  private expect = false
  /** Stopped after too many resets; loads are ignored until `started` again. */
  private stopped = false
  private resets: number[] = []
  /** The page in the frame now is one this served (theme and port). */
  private served = false
  /** Bumped on every load, so a late port or reconnect of an earlier load is dropped. */
  private load = 0
  private cleanup: (() => void) | undefined
  private handle: RelayHandle | undefined
  private reconnect: unknown

  constructor(private readonly o: FrameLoadsOptions) {}

  /** The shell set the frame's `src` to `url` (mount, or a new src); undefined: no page to load. */
  started(url: string | undefined): void {
    this.url = url
    this.expect = url !== undefined
    this.stopped = false
    this.resets = []
  }

  /** The frame fired `load`. */
  loaded(): void {
    this.load++
    // Whatever page had the port is gone now (a browser port has no close event: say it).
    this.endPage()
    if (this.o.guard) {
      if (this.stopped || this.url === undefined) return
      if (!this.expect) return this.reset()
      this.expect = false
    }
    this.served = true
    const theme = this.o.theme?.()
    if (theme) this.o.target.post(theme)
    const load = this.load
    this.cleanup = this.o.connect((port) => {
      // Only for the load that asked (its clean-up cancels a late port; this is the backstop).
      const handle = relayHandleOf(port)
      if (load !== this.load || !this.served) {
        port.close()
        handle?.release()
        return
      }
      const intro = this.o.intro?.()
      if (intro) this.o.target.post(intro)
      if (!this.o.target.post(this.o.portMessage, [port])) {
        port.close()
        handle?.release()
        return
      }
      if (!handle) return
      this.handle = handle
      // Main ended a panel's port (its host restarted, or the view fell behind): load the page again
      // so it connects again, unless another load came first. Not for a slot or a settings page:
      // main ends those on purpose (the frame left the layout, another view took the page), and a
      // reload would take them straight back.
      if (isPanelKey(handle.key)) handle.onClosed(() => this.scheduleReconnect(load))
    })
  }

  /** The theme changed: the served page gets it (a page the guard did not serve gets nothing). */
  themeChanged(message: object): void {
    if (this.o.guard && !this.served) return
    this.o.target.post(message)
  }

  /**
   * The frame unmounts: the page's port ends and a pending reconnect is dropped. Not final: React's
   * StrictMode runs an effect's clean-up and the effect again on the same component, and the frame's
   * next load is served as usual.
   */
  dispose(): void {
    this.endPage()
  }

  private endPage(): void {
    this.served = false
    this.clearReconnect()
    const cleanup = this.cleanup
    const handle = this.handle
    this.cleanup = undefined
    this.handle = undefined
    cleanup?.()
    handle?.release()
  }

  /** A load the shell did not start: back to the canonical path, or stop when it keeps happening. */
  private reset(): void {
    const url = this.url
    if (url === undefined) return
    const now = (this.o.now ?? Date.now)()
    this.resets = this.resets.filter((t) => now - t < FRAME_RESET_WINDOW_MS)
    if (this.resets.length >= MAX_FRAME_RESETS) {
      this.stopped = true
      this.o.log?.(`plugin frame ${url}: navigated away ${MAX_FRAME_RESETS} times in ${FRAME_RESET_WINDOW_MS / 1000} s, stopped`)
      this.o.target.load(BLANK_URL)
      return
    }
    this.resets.push(now)
    this.expect = true
    this.o.target.load(url)
  }

  private scheduleReconnect(load: number): void {
    const set = this.o.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    this.clearReconnect()
    this.reconnect = set(() => {
      this.reconnect = undefined
      if (load !== this.load || this.url === undefined) return
      this.expect = true
      this.o.target.load(this.url)
    }, PANEL_RECONNECT_MS)
  }

  private clearReconnect(): void {
    if (this.reconnect === undefined) return
    const clear = this.o.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
    clear(this.reconnect)
    this.reconnect = undefined
  }
}
