// The web access wire protocol's shared half (design-web.md §3): the constants and frame types both
// ends speak. Main's side (src/main/web/protocol.ts: parsing, the Node `$bytes` codec, the
// allow-list checks) and the browser bridge (src/renderer/web/bridge.ts) import them from here, so
// a frame or a close code cannot drift between the two. Types and plain values only: this file is
// bundled into the web shell, so no Node (`Buffer`) and no Electron.

import type { IpcEventMap, LayoutView, OverlayInfo, TabInfo } from './ipc'
import type { WebAccessMode } from './types'
import type { ViewId } from './views'

/** Bumped on any incompatible frame change; a client speaking another version is closed. */
export const PROTOCOL_VERSION = 1

/** Where the browser opens its one WebSocket per view (the gateway refuses an upgrade elsewhere). */
export const WS_PATH = '/ws'
/** What the page asks the gateway: the mode, and whether this browser is signed in (also used by the bridge after a drop). */
export const SESSION_PATH = '/auth/session'
/** The page posts the access link's token here (`{ token, name }`, JSON), and gets the device cookie. */
export const SIGN_IN_LINK_PATH = '/auth/link'
/** The page posts the password here (`{ password, name }`, JSON), and gets the device cookie. */
export const SIGN_IN_PASSWORD_PATH = '/auth/password'
/** The page asks for a desktop confirm here (`{ name }`, JSON); the answer is a `WebConfirmTicket`. */
export const CONFIRM_ASK_PATH = '/auth/confirm'
/** The page polls its ask here (`{ ticket }`, JSON); the answer is a `WebConfirmPoll`, with the cookie once allowed. */
export const CONFIRM_POLL_PATH = '/auth/confirm/poll'
/** The open project windows a signed-in browser may join (the web project picker, picker.tsx). */
export const PROJECTS_PATH = '/api/projects'

/**
 * Plugin files over HTTP (design-web.md §5.5): `/p/<token>/<pluginId>/<path>`, one token per
 * (device, plugin), served by main/web/plugin-pages.ts. The token is the only credential: a
 * sandboxed page's requests are cross-site and carry no device cookie.
 */
export const PLUGIN_PAGES_PATH = '/p/'
/** Inline overlay pages (`cc-overlay://<id>/` on the desktop): `/o/<token>/<overlayId>/`, while the overlay is open. */
export const OVERLAY_PAGES_PATH = '/o/'

/**
 * Where this view's browser loads plugin files and inline overlays (`ready.paths`, and a `paths`
 * frame when the installed plugins change): the prefix of each installed plugin
 * (`/p/<token>/<pluginId>/`) and of the device's inline overlays (`/o/<token>/`). Held by the web
 * shell only; a plugin page sees nothing but its own URL, so it learns only its own plugin's token.
 */
export interface WebPagePaths {
  plugins: Record<string, string>
  overlays: string
}

/**
 * Whether `id` is an overlay id: a lowercase UUID as main mints them (overlay-manager.ts
 * randomUUID), the `cc-overlay://` host and the `/o/<token>/<id>/` segment. A length and charset
 * loop, not a regex: the gateway's path parsing uses none (web/plugin-pages.ts).
 */
export function isOverlayId(id: string): boolean {
  if (id.length !== 36) return false
  for (let i = 0; i < 36; i++) {
    const c = id.charCodeAt(i)
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (c !== 0x2d) return false
    } else if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66))) return false
  }
  return true
}

/**
 * The HTTP path a desktop page URL is served at for this view: `cc-plugin://<id>/<rest>` under the
 * plugin's prefix (rest kept as main encoded it, query and fragment included), `cc-overlay://<id>/`
 * under the overlay prefix. Undefined for anything else, a plugin without a prefix, or no paths
 * (the image falls back, the frame stays empty). String operations, not `URL`: browsers disagree on
 * how a non-special scheme's host parses.
 */
export function webPageUrl(src: string, paths: WebPagePaths | undefined): string | undefined {
  if (!paths) return undefined
  const plugin = /^cc-plugin:\/\/([^/?#]+)\/(.*)$/s.exec(src)
  if (plugin) {
    const [, id = '', rest = ''] = plugin
    if (!Object.hasOwn(paths.plugins, id)) return undefined
    return `${paths.plugins[id]}${rest}`
  }
  const overlay = /^cc-overlay:\/\/([^/?#]+)\/$/.exec(src)
  if (overlay && isOverlayId(overlay[1] ?? '') && paths.overlays !== '') return `${paths.overlays}${overlay[1]}/`
  return undefined
}

/** The CONFIRM_ASK_PATH answer: the code the page shows, the ticket it polls with, when the ask lapses. */
export interface WebConfirmTicket {
  code: string
  ticket: string
  expiresAt: number
}

/**
 * The CONFIRM_POLL_PATH answer. `gone`: no ask holds this ticket any more (it lapsed, the mode
 * changed, another ask replaced a denied one). `allowed` comes with the device cookie.
 */
export type WebConfirmPoll =
  | { state: 'pending'; code: string; expiresAt: number }
  | { state: 'allowed'; device: { id: string; name: string } }
  | { state: 'denied' }
  | { state: 'gone' }

/** The SESSION_PATH answer: the auth mode, and this browser's device (null: not signed in). */
export interface WebSessionReply {
  mode: WebAccessMode
  device: { id: string; name: string } | null
}

/**
 * One row of the PROJECTS_PATH answer (`{ projects: [...] }`): a project that has a window open
 * on the desktop now. Only those: a remote view binds to an open window (design-web.md §2.1) and
 * never opens one on the host (`projects.openRecent` is `no`-class).
 */
export interface WebProjectEntry {
  id: string
  name: string
  path: string
}

/**
 * Largest frame either way (design-web.md §3): a 1 MiB panel message wrapped in a frame must fit.
 * `ws` enforces it on what a view sends (gateway.ts `maxPayload`, close 1009); main checks its own
 * frames before sending (connection.ts), and the bridge checks an invoke before sending it.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024

/**
 * UTF-8 size of a frame without building the encoded bytes: the bridge's MAX_FRAME_BYTES check.
 * Main counts with the native Buffer.byteLength (web/protocol.ts frameBytes, on every frame it
 * sends); the two must agree, a lone surrogate counting 3 (the U+FFFD it is sent as), so the cap is
 * the same on both ends (web-bridge.test.ts compares them).
 */
export function utf8Length(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4
        i++
      } else n += 3
    } else n += 3
  }
  return n
}

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
  /** Web access was turned off on the host (or set to something it refuses): retrying cannot help. */
  turnedOff: 4503,
  /**
   * The app is quitting on the host (design-web.md §5.6: quitting closes every view with a notice).
   * Not retried: nothing will answer until the person starts the app again, and a page retrying in
   * the background would read as "host unreachable", which is for a host asleep or off the network.
   */
  appQuit: 4504,
  /** The snapshot could not be built (the project record went away mid-handshake). */
  failed: 4500,
  /**
   * This device already has MAX_VIEWS_PER_DEVICE_WINDOW views of the window (browser tabs left
   * open): one more is refused rather than retried, the person closes one and reloads.
   */
  tooManyViews: 4429
})

/**
 * Live remote views one device may have of one window (connection.ts, at `hello`). Every view
 * holds its own port per panel and per slot frame in the plugin host (design-web.md §5.3), so the
 * views, not the panels, are what bound those; a person with a few browser tabs open is far below it.
 */
export const MAX_VIEWS_PER_DEVICE_WINDOW = 8

/** Longest port key (`<pluginId>/<panelId>`, `@slot/<id>`, `@settings/<pluginId>`) a port frame may name. */
export const MAX_PORT_KEY_LENGTH = 200

/**
 * Longest panel message a port frame carries, in UTF-16 units: the panel SDK's own cap
 * (src/sdk/panel-core.ts MAX_PANEL_MESSAGE_LENGTH, and the host's in host/ctx/ui.ts; a unit test
 * keeps the three equal). Its own constant here because main must not import panel-core (a module
 * main and the SDK share becomes a chunk the classic-script SDK cannot load, CLAUDE.md).
 */
export const MAX_PORT_MESSAGE_LENGTH = 1024 * 1024

/**
 * What a joining view gets in `ready` (design-web.md §5.1): enough to draw the window without a
 * round trip. Task 24 extends it (held pages) with its own snapshot test. `tabs` is the plain list, not `tabs.list`: that call resets terminal flow
 * (TabManager.attach), which a remote view must never do to the desktop.
 *
 * `layout` is main's LayoutService view, so it already carries every panel's header, badge and
 * error (`PanelInfo`), its slot frames (`PanelInfo.slots`) and the top bar's (`appSlots`), under
 * the same frame ids the desktop draws: a browser's frame of an id connects to its own instance of
 * that frame (`slots.connect`, keyed by view in panel-ports.ts). Placement params never travel.
 */
export interface WebSnapshot {
  tabs: TabInfo[]
  layout: LayoutView
  /**
   * The window's overlay stack. Terminal overlays are shared asks too (first answer wins): the
   * program's exit or the first ✕ from any view ends one for all, and `overlays.updated` drops it
   * on every view.
   */
  overlays: OverlayInfo[]
  /**
   * Plugin close asks still waiting for an answer (shared asks, close-asks.ts), oldest first: the
   * bridge hands them to the shell's `sessions.closeAsk` listener as if they had just arrived, so a
   * view joining mid-ask shows the dialog too; `sessions.closeSettled` takes them down.
   */
  closeAsks: Array<IpcEventMap['sessions.closeAsk']>
  /** `ccc plugin link` confirms still waiting (LinkAsks.pendingFor): replayed to the shell's `links.ask` listener like `closeAsks`. */
  linkAsks: Array<IpcEventMap['links.ask']>
}

export type HelloFrame = { t: 'hello'; v: number; project: string }
export type InvokeFrame = { t: 'invoke'; id: number; ch: string; p: unknown }

/**
 * Panel ports of a remote view (design-web.md §5.3; main/web/port-relay.ts, renderer/web/port-relay.ts).
 * The shell asks for a port as the desktop does (`panels.connect`, `slots.connect`,
 * `settingsPage.connect` with a nonce); main keeps the page end of the channel it made and says
 * `port.open` with the key and the nonce the shell asked with, and from then on both sides relay
 * that port's messages as `port.msg` and its end as `port.close`. `nonce` tells one load's port from
 * the next one's of the same key: a late frame of an old load never reaches or closes the new port.
 * `m` is the panel SDK's JSON text, at most MAX_PORT_MESSAGE_LENGTH.
 */
export type PortOpenFrame = { t: 'port.open'; key: string; nonce: number }
export type PortMsgFrame = { t: 'port.msg'; key: string; nonce: number; m: string }
export type PortCloseFrame = { t: 'port.close'; key: string; nonce: number }

export type ClientFrame = HelloFrame | InvokeFrame | PortMsgFrame | PortCloseFrame

/** `paths`: where this view loads plugin files and inline overlays (WebPagePaths). */
export type ReadyFrame = { t: 'ready'; v: number; view: ViewId; snapshot: WebSnapshot; paths: WebPagePaths }
/** The view's plugin paths changed (a plugin installed or removed); replaces the last `paths`. */
export type PathsFrame = { t: 'paths'; paths: WebPagePaths }
export type ResultFrame = { t: 'result'; id: number; ok: true; v: unknown } | { t: 'result'; id: number; ok: false; err: string }
export type EventFrame = { t: 'event'; ch: string; p: unknown }

/**
 * A tab's terminal as of item `seq` (design-web.md §3, §5.2), the start of the view's stream for
 * that tab: `term.data` items follow from `seq + 1`. A serialized screen with 5,000 lines of
 * scrollback can pass MAX_FRAME_BYTES, so it comes in `parts` frames (`part` 1..parts), sent back
 * to back with nothing of that tab between them; the page joins the `data` of all parts and writes
 * the whole into a fresh terminal of `cols` x `rows`. A part may end inside an escape sequence or a
 * surrogate pair: only the joined string is meaningful.
 */
export type TermSnapshotFrame = {
  t: 'term.snapshot'
  tabId: string
  seq: number
  cols: number
  rows: number
  part: number
  parts: number
  data: string
}

/**
 * One numbered item of a tab's stream after its snapshot: output (`data`, the flushed PTY chunk)
 * or the size the pty took (`cols`/`rows`), applied after the output before it so lines wrap as
 * on every other copy (§7a). `seq` is one more than the frame before it for that tab.
 */
export type TermDataFrame =
  | { t: 'term.data'; tabId: string; seq: number; data: string }
  | { t: 'term.data'; tabId: string; seq: number; cols: number; rows: number }

export type ServerFrame =
  | ReadyFrame
  | PathsFrame
  | ResultFrame
  | EventFrame
  | TermSnapshotFrame
  | TermDataFrame
  | PortOpenFrame
  | PortMsgFrame
  | PortCloseFrame
