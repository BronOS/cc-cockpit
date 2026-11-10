// The web access wire protocol's shared half (design-web.md §3): the constants and frame types both
// ends speak. Main's side (src/main/web/protocol.ts: parsing, the Node `$bytes` codec, the
// allow-list checks) and the browser bridge (src/renderer/web/bridge.ts) import them from here, so
// a frame or a close code cannot drift between the two. Types and plain values only: this file is
// bundled into the web shell, so no Node (`Buffer`) and no Electron.

import type { LayoutView, OverlayInfo, TabInfo } from './ipc'
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
/** The open project windows a signed-in browser may join (the web project picker, picker.tsx). */
export const PROJECTS_PATH = '/api/projects'

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

export type ServerFrame = ReadyFrame | ResultFrame | EventFrame | TermSnapshotFrame | TermDataFrame
