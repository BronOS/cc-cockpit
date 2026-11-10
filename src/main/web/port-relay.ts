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
// No Electron import: the port is whatever the hub made (MessagePortMain in the app), checked for
// the four calls used; tests pass Node's own MessagePort.

import { errorText } from '../../shared/error-text'
import { PANEL_PORT_CHANNEL } from '../../shared/ipc'
import { MAX_PORT_KEY_LENGTH, MAX_PORT_MESSAGE_LENGTH, type PortCloseFrame, type PortMsgFrame, type PortOpenFrame } from '../../shared/web-protocol'

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

export interface PortRelayDeps {
  /** A frame to the browser; false when it did not go out (socket closing, or over the frame cap). */
  send(frame: PortOpenFrame | PortMsgFrame | PortCloseFrame): boolean
  /** Bytes the socket has not sent yet (`ws` bufferedAmount). */
  buffered(): number
  log(message: string): void
}

interface Held {
  nonce: number
  port: RelayPort
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

  constructor(private readonly deps: PortRelayDeps) {}

  /**
   * The view's sink `postPort` (ViewRegistry.postPort from PanelPortHub's toRenderer). Throws when
   * it cannot take the port, so the hub closes both ends and answers the connect with false.
   */
  take(channel: string, payload: unknown, port: unknown): void {
    if (this.closed) throw new Error('the view is gone')
    if (channel !== PANEL_PORT_CHANNEL) throw new Error(`not a panel port channel: ${channel.slice(0, 64)}`)
    const p = payload as { panelKey?: unknown; nonce?: unknown } | null
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
    this.ports.set(key, held)
    port.on('message', (e) => {
      if (this.ports.get(key) !== held) return
      // The host posts one JSON string per message (encodePortMessage); anything else is not ours.
      if (typeof e.data !== 'string' || e.data.length > MAX_PORT_MESSAGE_LENGTH) return
      if (this.deps.buffered() > RELAY_HIGH_WATER) {
        this.deps.log(`web access: panel ${key}: the view is ${RELAY_HIGH_WATER} bytes behind, its port closed`)
        this.drop(key, nonce, true)
        return
      }
      if (!this.deps.send({ t: 'port.msg', key, nonce, m: e.data })) this.drop(key, nonce, true)
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
    for (const key of [...this.ports.keys()]) this.drop(key, undefined, false)
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
