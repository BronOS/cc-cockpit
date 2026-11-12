// The web access wire protocol's shared half (design-web.md §3): the constants and frame types both
// ends speak. Main's side (src/main/web/protocol.ts: parsing, the Node `$bytes` codec, the
// allow-list checks) and the browser bridge (src/renderer/web/bridge.ts) import them from here, so
// a frame or a close code cannot drift between the two. Types and plain values only: this file is
// bundled into the web shell, so no Node (`Buffer`) and no Electron.

import type { IpcEventMap, LayoutView, OverlayInfo, TabInfo } from './ipc'
import type { ProjectColor } from './project-color'
import type { WebAccessMode } from './types'
import type { ViewId } from './views'

/**
 * Bumped on any incompatible frame change; a client speaking another version is closed. 2: the first
 * binary frame (a streamed webview's JPEG, `encodeWebviewFrame`); a page that predates it would drop
 * every frame, so it is closed with `CLOSE.version` and reloads instead.
 */
export const PROTOCOL_VERSION = 2

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
/**
 * The header the page sends its origin key in (main/web/auth.ts, design-web.md §4.1 "Origin-bound
 * device") on every request behind sign-in and on SESSION_PATH: the device cookie alone signs nothing
 * in. The key is answered once, in a sign-in's JSON body (`key`), and kept in the origin's
 * localStorage, which unlike a cookie is port-scoped. Lower case, as Node reads header names.
 */
export const DEVICE_KEY_HEADER = 'x-cc-device-key'
/** The WebSocket subprotocol the page asks for and the gateway answers with (it must answer one the page offered). */
export const WS_PROTOCOL = 'cc-cockpit'
/**
 * The origin key on the upgrade: a second offered subprotocol `cc-key.<key>` (a browser cannot set a
 * header on a WebSocket, and a query string ends up in proxy logs). Never answered back.
 */
export const WS_KEY_PROTOCOL_PREFIX = 'cc-key.'

/** The subprotocols a page offers: WS_PROTOCOL, and its origin key when it has one. */
export function socketProtocols(key: string | undefined): string[] {
  return key === undefined || key === '' ? [WS_PROTOCOL] : [WS_PROTOCOL, `${WS_KEY_PROTOCOL_PREFIX}${key}`]
}

/** A sign-in's answer (SIGN_IN_LINK_PATH, SIGN_IN_PASSWORD_PATH, an allowed CONFIRM_POLL_PATH): the device, and its origin key. */
export interface WebSignInReply {
  device: { id: string; name: string }
  key: string
}

/** The open project windows a signed-in browser may join (the web project picker, picker.tsx). */
export const PROJECTS_PATH = '/api/projects'
/**
 * Server mode's folder browser (design-web.md §9.8): the subfolders of one folder on the server, for
 * the picker's Open folder and Relink. A POST (`WebFoldersRequest`, JSON), though it changes nothing:
 * it reads the server's file tree, so it gets the Origin check every state-changing request gets, and
 * the path travels in the body rather than in a URL a log or a history could keep.
 */
export const FOLDERS_PATH = '/api/folders'
/**
 * Server mode's session counts (design-remote-desktop.md §4.1): how many Claude tabs of the server
 * wait for the person, work, or idle (`WebSessionCounts`), for the desktop app's one chip per server
 * in its sessions strip. A GET for a signed-in device, as PROJECTS_PATH; 404 off server mode (a
 * desktop with web access has no desktop app asking it, and an old server answers 404 the same way,
 * which the poller reads as "no counts"). Counts only: no title, tool or project crosses machines.
 */
export const SESSIONS_PATH = '/api/sessions'

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
 * One row of the PROJECTS_PATH answer's `projects`: a project that has a window open now. A remote
 * view binds to an open window (design-web.md §2.1). On the desktop that is all a browser gets: it
 * never opens one on the host (`projects.openRecent` is `no`-class). Server mode adds `recent` and
 * the POST below (§9.8).
 */
export interface WebProjectEntry {
  id: string
  name: string
  path: string
  /** The project's colour (Settings › This project), checked by main as for the desktop picker; absent = none. */
  color?: ProjectColor
}

/**
 * A recent project in server mode's list: `missing` when its folder is gone (relink or forget it from
 * the picker), `lastOpenedAt` (epoch ms) for the row's "opened 3 days ago".
 */
export interface WebRecentProject extends WebProjectEntry {
  missing: boolean
  lastOpenedAt?: number
}

/**
 * Which server a browser is on (server mode's picker: the first-run welcome, `~` in paths): the host
 * name, the OS user cc-cockpit runs as, and that user's home folder (its real path, as project paths
 * are). Nothing a signed-in device could not learn from a terminal tab.
 */
export interface WebServerHost {
  name: string
  user: string
  home: string
}

/**
 * The PROJECTS_PATH answer. `server` and `recent` only in server mode (design-web.md §9.8): the
 * recent projects that have no window open, newest first. `server` is a UI hint (which items the
 * picker shows); the POST's 404 off server mode is main's own decision.
 */
export interface WebProjectsReply {
  projects: WebProjectEntry[]
  server?: true
  recent?: WebRecentProject[]
  /** Server mode only: which server this is (absent when main could not read it). */
  host?: WebServerHost
}

/**
 * The SESSIONS_PATH answer: every Claude tab of the server in exactly one count (the gateway's
 * `sessionCounts` says which status goes where). Non-negative integers; a reader still checks them,
 * since the answer crosses machines.
 */
export interface WebSessionCounts {
  waiting: number
  working: number
  idle: number
}

/**
 * The PROJECTS_PATH POST body (server mode only): exactly one of `open` (an absolute path to an
 * existing folder on the server; nothing is created), `reopen` (a project id, looked up in main's
 * own recent list only), `relink` (a recent project whose folder is gone, with `path`, its new
 * folder: absolute and existing, as `open`'s; the project is then opened there) or `forget` (a recent
 * project whose folder is gone: its record and saved tabs are removed). Relink and forget are the
 * desktop picker's (restore.ts relinkMissing / forgetMissing), with its checks. Capped as the sign-in
 * bodies (MAX_SIGN_IN_BODY).
 */
export type WebOpenProjectRequest = { open: string } | { reopen: string } | { relink: string; path: string } | { forget: string }

/**
 * The POST's answer: the project's id (200: opened, reopened or relinked and opened; for `forget` the
 * id that was forgotten), or the error text (4xx).
 */
export type WebOpenProjectReply = { id: string } | { error: string }

/**
 * The FOLDERS_PATH POST body (server mode only). `path`: an absolute folder on the server; absent or
 * empty, the start folder (`ccc web set --start-folder`, else the home folder). `hidden`: list
 * folders whose name starts with a dot too. Capped as the sign-in bodies.
 */
export interface WebFoldersRequest {
  path?: string
  hidden?: boolean
}

/**
 * A subfolder in a FOLDERS_PATH answer. `git`: it holds a `.git` (a repo, a worktree or a
 * submodule); `project`: it is already a cc-cockpit project (a record's folder); `link`: a symbolic
 * link to a folder, listed and entered but never marked (list-folders.ts says why).
 */
export interface WebFolderEntry {
  name: string
  git?: true
  project?: true
  link?: true
}

/**
 * The FOLDERS_PATH answer (200 for any folder main could look at, readable or not). `path` is the
 * folder shown, absolute and normalized; `parent` the one above it (null at `/`); `home` the server
 * user's home folder. Readable: its subfolders, sorted, at most MAX_FOLDER_ENTRIES (`truncated`
 * says there were more), how many dot folders were left out (`hidden` false), the marks of the
 * folder itself (`here`), and a `note` when the start folder was not usable and the home folder is
 * shown instead. Not readable (`error`: permission denied, gone, not a folder): the text, shown in
 * place of the list, with `parent` so the browser can still go up.
 */
export type WebFoldersReply =
  | {
      path: string
      parent: string | null
      home: string
      folders: WebFolderEntry[]
      hiddenCount: number
      truncated: boolean
      here: { git: boolean; project: boolean }
      note?: string
    }
  | { path: string; parent: string | null; home: string; error: string }

/** Most subfolders one FOLDERS_PATH answer lists (a home folder has tens; `/nix/store` has many thousands). */
export const MAX_FOLDER_ENTRIES = 1000

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

/**
 * Binary frames (server -> browser only; the gateway closes a client that sends one, connection.ts).
 * Layout, big-endian, nothing after the JPEG:
 *
 *   u8 kind (`FRAME_KIND_WEBVIEW`) | u8 keyLength | key (UTF-8, <= MAX_FRAME_KEY_BYTES) |
 *   u32 seq | u16 width | u16 height | u16 scale x 100 | JPEG bytes
 *
 * `width` x `height` are the encoded image's pixels; `scale` is the encoded size over the page's CSS
 * size (1 = not downscaled), so input maps back through it. There is no mime byte: a webview frame is
 * always a JPEG (design-web-browser.md §3.3). Pure over `Uint8Array` / `DataView` / `TextEncoder`, so
 * main and the browser bridge share one definition with no `Buffer`.
 */
export const FRAME_KIND_WEBVIEW = 1

/** Longest panel key (UTF-8 bytes) in a binary frame: MAX_PORT_KEY_LENGTH (a key is a port key), spelled out because that constant is declared further down. */
export const MAX_FRAME_KEY_BYTES = 200

/** Bytes of a webview frame before its key: kind and key length. */
const FRAME_PREFIX_BYTES = 2
/** Bytes after the key: seq (4), width (2), height (2), scale (2). */
const FRAME_FIXED_BYTES = 10

/**
 * Largest webview frame a browser view's sink sends, header included. A frame already on the socket
 * cannot be pre-empted, and terminal output is written straight to the same socket behind it, so this
 * is what one frame can delay a keystroke's echo by (design-web-browser.md §3.3). 1 MiB: a ~2 MP page
 * at JPEG q75 is typically a few hundred KB, a busy one under a MB; four times under MAX_FRAME_BYTES
 * (`ws` would refuse more) and thirty-two times under SOCKET_HIGH_WATER (connection.ts), so a frame
 * that passes can never tip a healthy view into the "closed to resync" path. Over it the frame is
 * dropped and the view stays connected: the next paint is smaller, or the encoder lowers its quality.
 */
export const MAX_WEBVIEW_FRAME_BYTES = 1024 * 1024

/**
 * A view's socket counts as drained for the next frame when it holds at most this many unsent bytes
 * (`bufferedAmount`): "back near zero" (design-web-browser.md §3.3), with room for a small terminal
 * chunk that was written right behind the last frame.
 */
export const FRAME_DRAINED_BYTES = 64 * 1024

/** A decoded webview frame. `jpeg` is a view into the buffer it was decoded from, not a copy. */
export interface WebviewFrame {
  key: string
  seq: number
  width: number
  height: number
  /** Encoded size over page size (the header holds it x 100, so two decimals). */
  scale: number
  jpeg: Uint8Array
}

const textEncoder = new TextEncoder()
const fatalDecoder = new TextDecoder('utf-8', { fatal: true })

/**
 * The binary webview frame for `frame`. Throws RangeError for a field the layout cannot hold (the
 * caller is main's own code, so a throw is a bug, not input): a key that is empty or over
 * MAX_FRAME_KEY_BYTES, `seq` not a u32, a size not in 1..65535, a scale that rounds outside 0.01..655.35,
 * or an empty JPEG. Size is not capped here; the sink does that (`MAX_WEBVIEW_FRAME_BYTES`).
 */
export function encodeWebviewFrame(frame: WebviewFrame): Uint8Array {
  const key = textEncoder.encode(frame.key)
  if (key.length === 0 || key.length > MAX_FRAME_KEY_BYTES) throw new RangeError('frame key length')
  const scale = Math.round(frame.scale * 100)
  const ok = (n: number, max: number, min: number): boolean => Number.isInteger(n) && n >= min && n <= max
  if (!ok(frame.seq, 0xffff_ffff, 0)) throw new RangeError('frame seq')
  if (!ok(frame.width, 0xffff, 1) || !ok(frame.height, 0xffff, 1)) throw new RangeError('frame size')
  if (!ok(scale, 0xffff, 1)) throw new RangeError('frame scale')
  if (frame.jpeg.length === 0) throw new RangeError('frame image is empty')
  const out = new Uint8Array(FRAME_PREFIX_BYTES + key.length + FRAME_FIXED_BYTES + frame.jpeg.length)
  const view = new DataView(out.buffer)
  out[0] = FRAME_KIND_WEBVIEW
  out[1] = key.length
  out.set(key, FRAME_PREFIX_BYTES)
  const at = FRAME_PREFIX_BYTES + key.length
  view.setUint32(at, frame.seq)
  view.setUint16(at + 4, frame.width)
  view.setUint16(at + 6, frame.height)
  view.setUint16(at + 8, scale)
  out.set(frame.jpeg, at + FRAME_FIXED_BYTES)
  return out
}

/**
 * Decode a binary frame from main, or undefined for anything malformed: too short for its header, a
 * kind that is not ours, a key length of 0 or over MAX_FRAME_KEY_BYTES or past the buffer, a key that
 * is not valid UTF-8, a zero size or scale, no image bytes. The browser treats a frame as untrusted
 * input like any other (the bridge drops the bad one and keeps the socket).
 */
export function decodeWebviewFrame(bytes: Uint8Array): WebviewFrame | undefined {
  if (bytes.length < FRAME_PREFIX_BYTES || bytes[0] !== FRAME_KIND_WEBVIEW) return undefined
  const keyLength = bytes[1]!
  if (keyLength === 0 || keyLength > MAX_FRAME_KEY_BYTES) return undefined
  const at = FRAME_PREFIX_BYTES + keyLength
  // At least one image byte after the fixed fields.
  if (bytes.length < at + FRAME_FIXED_BYTES + 1) return undefined
  let key: string
  try {
    key = fatalDecoder.decode(bytes.subarray(FRAME_PREFIX_BYTES, at))
  } catch {
    return undefined
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint16(at + 4)
  const height = view.getUint16(at + 6)
  const scale = view.getUint16(at + 8)
  if (width === 0 || height === 0 || scale === 0) return undefined
  return { key, seq: view.getUint32(at), width, height, scale: scale / 100, jpeg: bytes.subarray(at + FRAME_FIXED_BYTES) }
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
  /**
   * Server mode stopped (SIGTERM from systemd, `ccc web stop`; design-web.md §9.1). Retried with
   * backoff, unlike `appQuit`: a server comes back by itself (a restart, an update, a reboot), and the
   * page shows the host as away meanwhile.
   */
  serverStop: 4505,
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
  /**
   * ctx.files.trash confirms still waiting (TrashAsks.pendingFor), replayed to the shell's `trash.ask`
   * listener the same way. Absent (an older fixture) reads as none.
   */
  trashAsks?: Array<IpcEventMap['trash.ask']>
  /**
   * In-page notices still up (server mode, notifier.ts PageNoticeBackend.pendingFor: the window's and
   * the app-wide ones, oldest first), replayed to the shell's `notices.show` listener like `closeAsks`;
   * `notices.gone` takes them down. Absent (an older fixture, the desktop) reads as none.
   */
  notices?: Array<IpcEventMap['notices.show']>
  /**
   * Plugin sign-ins of the window still waiting for their redirect (server mode, PluginOAuth.pendingFor,
   * design-web.md §9.9): replayed to the shell's `app.linkNotice` listener with `replayed`, so a shell
   * remounted by a reconnect (or a view joining mid-sign-in) keeps the paste box main would still
   * settle; `oauth.signInEnded` takes them down. Absent (the desktop, an older fixture) reads as none.
   */
  signIns?: Array<{ url: string; signIn: string }>
  /**
   * The app runs as a server (design-web.md §9, main's `server` flag): every signed-in view is the
   * owner and may Allow an approval (§9.6). A UI hint only, so the dialog offers Allow instead of
   * "Approve on the desktop": main decides who may answer from its own flag, never from this. Absent
   * reads as false.
   */
  server?: boolean
}

/**
 * `dark`: the browser's `prefers-color-scheme` now (design-web.md §5.7), so the view's first
 * `theme.get` already answers by its own appearance; later changes go as `theme.scheme`. Only picks
 * between the two built-ins for this view when nothing is picked. Absent (or not a boolean): not
 * reported, the OS rule applies.
 */
export type HelloFrame = { t: 'hello'; v: number; project: string; dark?: boolean }
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
