// Panel ports of one remote view, relayed over its socket (design-web.md §5.3 "Main side"; plan Task 22).
//
// A desktop page gets the page end of each panel's MessageChannelMain posted into its webContents
// (ViewRegistry.postPort). A browser cannot take a MessagePortMain, so for a remote view that end
// stays here: PanelPortHub's `toRenderer` reaches the view's sink, whose `postPort` is `take` below.
// It keeps the port under its key (`<pluginId>/<panelId>`, `@slot/<id>`, `@settings/<pluginId>`)
// and the nonce the shell asked with, and tells the browser `port.open`; from then on the port's
// messages go out as `port.msg` and the browser's `port.msg` come back into it. The browser shell
// pipes those into a MessageChannel whose other end the sandboxed frame got (renderer/web/port-relay.ts),
// so the panel SDK and the plugin host see a port as on the desktop.
//
// Ends. The browser says `port.close` when its frame unloads (a browser MessagePort has no
// reliable close event, so the shell says it): the port is closed here and the host's end hears it,
// which detaches only this view's port (host/ctx/ui.ts PanelPorts). The host's end closing (the
// host restarted, the plugin stopped, a slot frame dropped) closes this end: the browser is told
// `port.close`. A view leaving (`closeAll`, the connection's viewGone) closes every end it held, so
// no host keeps a per-view port of a view that is gone (panel-ports.ts viewGone relies on this).
//
// Bounds. Only JSON text within MAX_PORT_MESSAGE_LENGTH passes either way (the host posts one
// string per message, encodePortMessage). A view whose socket already buffers more than
// RELAY_HIGH_WATER does not get the message queued behind it: the port it was for is closed both
// ways instead (the per-panel queue limit; its panel reconnects on its next load), so a panel
// posting faster than a slow phone reads never grows main's memory. The same for a message whose
// frame would be over MAX_FRAME_BYTES (a 1 Mi-unit string of escapes): that port closes, never
// the whole view. A refused connect never reaches here: the hub answers the shell's
// `panels.connect` with false and makes no channel, as on the desktop.
//
// Page tabs (`@tab/<id>`, design-editor.md §1 "Relay backlog") are not closed at the high water: a
// page tab holds unsaved text, and closing its port would leave it cut off (its frame never reloads
// to reconnect). Their high water is RELAY_PAGE_TAB_HIGH_WATER, far above a panel's: a page tab's
// answer comes in one burst of parts (the editor posts a whole file at once, up to 16 MB of text,
// more on the wire after two JSON escapes), and pausing in the middle of it would only have the
// resynced page ask for the same burst again, pause again, and after the hub's connect cap the tab
// would have no port at all. Past that high water its port is PAUSED: every message the host sends
// it from then on is dropped, nothing queued. Once the socket has drained below RELAY_LOW_WATER
// (checked every RELAY_DRAIN_CHECK_MS while anything is paused) the browser is told `port.resync`,
// and the frame asks for a new port without loading again; over it the page and the plugin each
// re-send what they hold, so the dropped messages are never needed (the editor's page then asks
// for the file's head only, and for its text only when the disk changed meanwhile). A message the socket cannot carry at all (a
// frame over the cap: 1 Mi characters of quote-heavy JSON can pass 4 MiB once escaped) is dropped
// alone and logged once per port, never a pause: the plugin would re-send the same message over the
// resynced port, pause it again, and after the hub's connect cap the tab would have no port at all.
//
// No Electron import: the port is whatever the hub made (MessagePortMain in the app), checked for
// the four calls used; tests pass Node's own MessagePort.

import { errorText } from '../../shared/error-text'
import { PANEL_PORT_CHANNEL } from '../../shared/ipc'
import { isPageTabPortKey } from '../../shared/page-tabs'
import { MAX_PORT_KEY_LENGTH, MAX_PORT_MESSAGE_LENGTH, type PortCloseFrame, type PortMsgFrame, type PortOpenFrame, type PortResyncFrame } from '../../shared/web-protocol'

/** The parts of a MessagePortMain the relay uses. */
export interface RelayPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  start(): void
  close(): void
}

/**
 * Bytes a view's socket may hold unsent before a panel message is no longer queued behind them (the
 * spike's value: a few seconds of a busy terminal on a slow link, far above a panel's state push).
 */
export const RELAY_HIGH_WATER = 8 * 1024 * 1024
/**
 * Bytes a view's socket may hold unsent before a page tab port is paused (see the header): room for
 * the editor's largest answer (a 16 MB read-only file, its JSON escapes, the parts' heads) on top of a
 * panel's backlog. Still a bound on what main holds for a view that stopped reading.
 */
export const RELAY_PAGE_TAB_HIGH_WATER = 64 * 1024 * 1024
/** A paused page tab port is resynced once the socket holds no more than this unsent (half the panels' high water). */
export const RELAY_LOW_WATER = RELAY_HIGH_WATER / 2
/** How often a relay with a paused port looks whether its socket has drained. */
export const RELAY_DRAIN_CHECK_MS = 250

export interface PortRelayDeps {
  /** A frame to the browser; false when it did not go out (socket closing, or over the frame cap). */
  send(frame: PortOpenFrame | PortMsgFrame | PortCloseFrame | PortResyncFrame): boolean
  /** Bytes the socket has not sent yet (`ws` bufferedAmount). */
  buffered(): number
  log(message: string): void
  /** Timers for the drain check (tests); the global ones by default. */
  setTimeout?(fn: () => void, ms: number): unknown
  clearTimeout?(handle: unknown): void
}

interface Held {
  nonce: number
  port: RelayPort
  /** A page tab port at the high water: host messages are dropped until the browser resyncs it. */
  paused?: 'waiting' | 'told'
  /** A page tab message too big to send was dropped and logged (once per port). */
  oversizeLogged?: boolean
  /**
   * D-17: a read guest's port to a plugin that is not guest-aware (PanelPortPayload.oneWay): host to page
   * only. The page's messages are dropped here, in main, so a plugin that never heard of guests cannot be
   * driven by one (a read guest pressing its buttons would act as the owner).
   */
  oneWay?: true
  /** A dropped page message of a one-way port was logged (once per port). */
  oneWayLogged?: boolean
}

function isRelayPort(value: unknown): value is RelayPort {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return typeof p.postMessage === 'function' && typeof p.on === 'function' && typeof p.start === 'function' && typeof p.close === 'function'
}

function closeQuietly(port: RelayPort): void {
  try {
    port.close()
  } catch {
    // Already closed.
  }
}

export class PortRelay {
  /** key -> the port of the latest load of that key in this view. */
  private readonly ports = new Map<string, Held>()
  private closed = false
  /** The pending drain check while a page tab port waits to be resynced. */
  private drainTimer: unknown

  constructor(private readonly deps: PortRelayDeps) {}

  /**
   * The view's sink `postPort` (ViewRegistry.postPort from PanelPortHub's toRenderer). Throws when
   * it cannot take the port, so the hub closes both ends and answers the connect with false.
   */
  take(channel: string, payload: unknown, port: unknown): void {
    if (this.closed) throw new Error('the view is gone')
    if (channel !== PANEL_PORT_CHANNEL) throw new Error(`not a panel port channel: ${channel.slice(0, 64)}`)
    const p = payload as { panelKey?: unknown; nonce?: unknown; oneWay?: unknown } | null
    const key = p?.panelKey
    const nonce = p?.nonce
    if (typeof key !== 'string' || key === '' || key.length > MAX_PORT_KEY_LENGTH) throw new Error('bad panel key')
    if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce)) throw new Error('bad nonce')
    if (!isRelayPort(port)) throw new Error('not a port')
    // The same panel loaded again in this view: the previous load's port ends (the host replaces
    // this view's port anyway; closing it here frees main's end and tells the browser).
    this.drop(key, undefined, true)
    // Told before the port is kept: a socket that cannot carry `port.open` gets no port.
    if (!this.deps.send({ t: 'port.open', key, nonce })) throw new Error('the view cannot be told')
    const held: Held = { nonce, port }
    // Anything but a plain `false`/absent counts as one-way: a malformed flag fails closed.
    if (p?.oneWay !== undefined && p.oneWay !== false) held.oneWay = true
    this.ports.set(key, held)
    port.on('message', (e) => {
      if (this.ports.get(key) !== held) return
      // The host posts one JSON string per message (encodePortMessage); anything else is not ours.
      if (typeof e.data !== 'string' || e.data.length > MAX_PORT_MESSAGE_LENGTH) return
      // Paused (a page tab behind): dropped until the browser takes a new port and both ends re-send.
      if (held.paused !== undefined) return
      const pageTab = isPageTabPortKey(key)
      if (this.deps.buffered() > (pageTab ? RELAY_PAGE_TAB_HIGH_WATER : RELAY_HIGH_WATER)) {
        if (pageTab) return this.pause(key, held, `the view is ${RELAY_PAGE_TAB_HIGH_WATER} bytes behind`)
        this.deps.log(`web access: panel ${key}: the view is ${RELAY_HIGH_WATER} bytes behind, its port closed`)
        this.drop(key, nonce, true)
        return
      }
      if (this.deps.send({ t: 'port.msg', key, nonce, m: e.data })) return
      // Not behind, yet not sent: a frame over the cap (or the socket closing, and the view with it).
      if (!pageTab) return this.drop(key, nonce, true)
      if (held.oversizeLogged) return
      held.oversizeLogged = true
      this.deps.log(`web access: page tab ${key}: a message of ${e.data.length} characters did not go out (over the frame limit), dropped; later messages still flow`)
    })
    port.on('close', () => {
      // The host's end went (or this end was closed here, already dropped): the browser lets go.
      if (this.ports.get(key) !== held) return
      this.ports.delete(key)
      this.deps.send({ t: 'port.close', key, nonce })
    })
    port.start()
  }

  /** `port.msg` from the browser: into the port of that key and nonce, if this view still holds it. */
  fromPage(key: string, nonce: number, m: string): void {
    if (this.closed || m.length > MAX_PORT_MESSAGE_LENGTH) return
    const held = this.ports.get(key)
    if (!held || held.nonce !== nonce) return
    if (held.oneWay) {
      if (!held.oneWayLogged) {
        held.oneWayLogged = true
        this.deps.log(`web access: panel ${key}: a read guest's message to a plugin that is not guest-aware dropped (one-way port)`)
      }
      return
    }
    try {
      held.port.postMessage(m)
    } catch (err) {
      this.deps.log(`web access: panel ${key}: relaying a page message failed: ${errorText(err)}`)
      this.drop(key, nonce, true)
    }
  }

  /** `port.close` from the browser: its frame unloaded; the host's end hears the close. */
  closeFromPage(key: string, nonce: number): void {
    this.drop(key, nonce, false)
  }

  /**
   * The view left: every end it held closes, so each host detaches this view's ports. Nothing is
   * sent (the socket is gone), and nothing is taken from here on.
   */
  closeAll(): void {
    this.closed = true
    this.clearDrain()
    for (const key of [...this.ports.keys()]) this.drop(key, undefined, false)
  }

  /** Whether the port of `key` is paused now (tests). */
  paused(key: string): boolean {
    return this.ports.get(key)?.paused !== undefined
  }

  /** A page tab port fell behind: drop the host's messages from now on, and resync once the socket drained. */
  private pause(key: string, held: Held, why: string): void {
    held.paused = 'waiting'
    this.deps.log(`web access: page tab ${key}: ${why}, its port paused until the view catches up`)
    this.scheduleDrain()
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== undefined || this.closed) return
    const set = this.deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    this.drainTimer = set(() => {
      this.drainTimer = undefined
      this.drainCheck()
    }, RELAY_DRAIN_CHECK_MS)
  }

  /**
   * Drained enough: each paused port that has not been told is resynced (`port.resync`): the browser
   * frame asks for a new port with no reload, and this one is replaced by it (`take`). Until then it
   * stays paused: a message the host sends meanwhile would reach a page that is about to re-send.
   */
  private drainCheck(): void {
    if (this.closed) return
    let waiting = false
    for (const [key, held] of this.ports) {
      if (held.paused !== 'waiting') continue
      if (this.deps.buffered() > RELAY_LOW_WATER) {
        waiting = true
        continue
      }
      // Not sent (the socket is closing): the view goes, and this relay with it.
      if (this.deps.send({ t: 'port.resync', key, nonce: held.nonce })) held.paused = 'told'
      else waiting = true
    }
    if (waiting) this.scheduleDrain()
  }

  private clearDrain(): void {
    if (this.drainTimer === undefined) return
    const clear = this.deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
    clear(this.drainTimer)
    this.drainTimer = undefined
  }

  /** Ports held now (tests, and the view's own bound). */
  size(): number {
    return this.ports.size
  }

  /** Close the port of `key` (of `nonce`, when given); `tell`: say `port.close` to the browser. */
  private drop(key: string, nonce: number | undefined, tell: boolean): void {
    const held = this.ports.get(key)
    if (!held || (nonce !== undefined && held.nonce !== nonce)) return
    this.ports.delete(key)
    closeQuietly(held.port)
    if (tell && !this.closed) this.deps.send({ t: 'port.close', key, nonce: held.nonce })
  }
}
