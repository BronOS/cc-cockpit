// The overlay stack of every project window (design §4). main owns it: plugins (Task 27) and the
// CLI (Task 21) ask for an overlay, the renderer only draws what main tells it and reports the ✕
// button, keys and a page's value back. Each `open` hands its caller a promise that settles
// exactly once, with what the overlay ended in:
//   terminal  { kind: 'exit', code }    the program ended (the overlay closes with it)
//   html      { kind: 'value', value }  the page posted a result through its MessagePort (inline
//                                        pages; a plugin's page posts `{ result }` with panel.js)
//   any       { kind: 'dismissed' }     ✕, Esc, Cmd+Shift+W, the window closed, the app quit
//   any       { kind: 'discussed', tabId, queued }  Discuss with Claude sent its text (see `discuss`)
//
// Messages (ctx.overlay.start, friction round 1 Task 13): an opener that passes an OverlayChannel
// talks to an html overlay's page while it is open. `post` goes to the page (queued here until the
// renderer says the page's port is up: `pageReady`), and what the page posts without a `result`
// key comes back through `pageMessage` to that channel only. The channel is the opener's own
// callback, kept on the overlay record: nothing a renderer sends can name another receiver, and a
// page can only reach the record through an id of its own window's stack.
//
// Views (design-web.md §5.4): a window can have several live views (its desktop page and browser
// views). Terminal overlays are shared by all of them (first answer wins), but an html overlay's
// page lives in ONE view, its `holder`: the opener's view (a plugin's origin view, else the
// desktop's), or the last view to take it over (`take`). Main has one `pageReady` flag and one
// outbox per overlay and plugins treat the page as one (the reviewer posts `init` once), so only
// the holder's page talks: `pageReady`, `pageLoaded`, `result` and `pageMessage` from any other view
// are dropped, and the opener's posts go to the holder's view only. The others show "Open on
// <device> — Take over" (`info.heldBy`, present when a browser holds it). A take, and the holder
// leaving (back to the desktop), reload the page as a desktop reload does: `pageReady` false, the
// loader back, the opener's posts queued again until the new page's port is up.
//
// Per-view copies (docs/design-overlay-views.md §5): an html overlay whose opener's manifest says
// `overlays.perView` has no holder. Every view that may see it loads its own copy of the page, each
// with a main-minted copy id (`connectCopy`), its own ready flag, loader and outbox, and the opener
// hears each copy come and go (OverlayChannel.onConnect / onDisconnect) and may post to one copy or to
// all. Everything a page then says for its copy names the id and is accepted only from that copy's
// view while it is that view's live copy, so a reloaded page's late traffic never lands on its
// successor. Take over, `heldBy` and `waiting` are the holder model's and never apply to these.
//
// Server mode (design-web.md §9.8): the desktop view is the hidden page nobody looks at, so it never
// holds a page (every browser would show "Open on Desktop — Take over" with nobody there to answer).
// With no browser origin the holder is the window's last-acting browser view, else its first live
// one (`browserViews`); with none attached the overlay has no holder and waits, its opener's posts
// queued, until the first browser lists the stack (`list`, every web shell's mount). A leaving holder
// passes the page to another browser the same way, and the hidden page can neither take it nor
// report for it.
//
// No Electron import: terminal overlays run on a PtyBackend (its own PtyService, separate from
// the tabs'), url overlays go through a UrlViewFactory (the WebContentsView adapter is
// electron-url-view.ts), and renderer events leave through `emit`. Unit tests pass fakes.
//
// Everything that arrives here is untrusted: a spec comes from a plugin or a CLI caller, an
// overlay id or a result value from a renderer. Specs are validated before anything is created
// (a `file:` URL is refused before a view exists), and every per-overlay call is scoped to the
// window main resolved for the caller, so an id from another window is simply unknown.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { DISCUSS_ASK_MS, type DiscussTarget } from '../../shared/discuss'
import { toError } from '../../shared/error-text'
import {
  OVERLAY_SIZES,
  type DiscussAnswer,
  type EventChannel,
  type IpcEventMap,
  type OverlayButtonInfo,
  type OverlayCopyRefusal,
  type OverlayInfo,
  type OverlayInfoBody,
  type OverlayKind,
  type OverlayReadyAnswer,
  type OverlaySize
} from '../../shared/ipc'
import { chordFromEvent } from '../../shared/keys'
import {
  OVERLAY_CLICK_TIMEOUT_MS,
  parseOverlayButtons,
  parseOverlayExtras,
  type CleanOverlayButton,
  type CleanOverlayExtras,
  type CleanOverlayType,
  type OverlayExtrasContext,
  type CleanTypeButton
} from '../../shared/overlay-buttons'
import { MAX_OVERLAY_MESSAGE_LENGTH } from '../../shared/overlay-message'
import { isPanelHeaderIcon } from '../../shared/panel-header'
import { within } from '../../shared/timeout'
import { PLUGIN_SCHEME, pluginFileUrl } from '../plugins/plugin-protocol'
import { exitStatus, type PtyBackend } from '../pty/pty-backend'
import {
  composeDiscuss,
  deliverDiscuss,
  discussContextOf,
  discussTargetProblem,
  DiscussSessionBudget,
  DiscussTooLong,
  GUEST_DISCUSS_CONTEXT_FAILED,
  GUEST_DISCUSS_REFUSED,
  GuestDiscussLost,
  type DiscussGuest,
  type DiscussNotes
} from './discuss'
import { PtyService } from '../pty/pty-service'
import { CONNECT_WINDOW_MS, MAX_CONNECTS_PER_PANEL } from '../plugins/panel-ports'
import { isPersonInput, stripQueryReplies } from '../sessions/terminal-reports'
import type { SendOrigin } from '../sessions/status-reducer'
import { desktopViewId, isRemoteViewId, type ViewId } from '../../shared/views'
import { ViewSizes } from '../views/view-sizes'
import { warnLog } from '../warn-log'
import type { NotesApi, SentNotes } from '../notes/notes-api'
import type { NotesSnapshot } from '../../shared/overlay-envelope'
import { partRefusal } from './overlay-parts'

/** `type`, `buttons`, `ready` and `discuss` of every kind (shared/overlay-buttons.ts). */
type OverlayBase = { title?: string; size?: OverlaySize } & CleanOverlayExtras

export type OverlaySpec =
  | ({ kind: 'terminal'; argv: string[]; cwd: string } & OverlayBase)
  | ({ kind: 'url'; url: string } & OverlayBase)
  | ({ kind: 'html'; html: string } & OverlayBase)
  /**
   * A plugin's own page at its `cc-plugin://` URL (host-api.ts builds it after checking the file
   * is inside the plugin's folder). Loaded like a panel, with the plugin's CSP and the panel SDK.
   */
  | ({ kind: 'html'; src: string } & OverlayBase)

export type OverlayResult =
  | { kind: 'exit'; code: number }
  | { kind: 'value'; value: unknown }
  | { kind: 'dismissed' }
  | { kind: 'discussed'; tabId: string; queued: boolean }

/** Where an overlay's page sits in the window, in DIPs (= CSS px at zoom 1). */
export interface ViewBounds {
  x: number
  y: number
  width: number
  height: number
}

/** A url overlay's native view (a WebContentsView in the real app). */
export interface UrlView {
  setBounds(bounds: ViewBounds): void
  /** A native view always paints above the renderer, so only the top overlay's may show. */
  setVisible(visible: boolean): void
  /** Give the view the keyboard (it is the top overlay now). */
  focus(): void
  /** Remove it from the window and close its page. Safe once the window is gone. */
  destroy(): void
}

export interface UrlViewFactory {
  /**
   * Create the view for an already validated http(s) URL, hidden behind zero bounds until the
   * renderer reports where the overlay's body is. `onChord` gets every key chord typed into the
   * page (the renderer never sees those); true means it was an overlay key and is consumed.
   * `onGone` fires when the page goes away by itself (its renderer crashed or was killed, the
   * page closed itself), so the overlay does not stay up over a dead view with its opener waiting.
   * It also fires after `destroy()`; the manager ignores that one (the overlay is already gone).
   * `onLoaded` fires when the first load ends, loaded or failed (`did-finish-load` /
   * `did-fail-load`): the overlay's loader goes then. Later loads may call it again; only the first
   * counts.
   */
  create(
    windowId: number,
    url: string,
    onChord: (chord: string) => boolean,
    onGone: () => void,
    onLoaded: () => void
  ): UrlView
  /** Hand the keyboard back to the window's own page (a url overlay on top just went away). */
  focusWindow(windowId: number): void
}

export interface OverlayManagerOptions {
  backend: PtyBackend
  views: UrlViewFactory
  /**
   * Whether `windowId` is a project window that is still open. An opener resolves the window and
   * then awaits (the login env), so the window may have closed in between: an overlay opened then
   * would never get closeWindow, its program would run unwatched and its opener wait forever.
   */
  isWindowOpen(windowId: number): boolean
  /**
   * The environment of a terminal overlay's program: the login env plus `token`, the overlay's
   * window token (minted here per overlay, see resolveToken), so a `ccc` run in it (lazygit's
   * custom command, a script started with `ccc overlay --terminal`) reaches this window without
   * `--project`. A window token, never a session one: the overlay is not a Claude tab.
   */
  env(token: string): Record<string, string>
  /** Send an event to a window's renderer (a closed window drops it). */
  emit<C extends EventChannel>(windowId: number, channel: C, payload: IpcEventMap[C]): void
  /**
   * Send an event to one view of a window (ViewRegistry.toView): an html overlay's messages go to
   * the view holding its page only. Absent: to the whole window (`emit`), as before web access.
   */
  emitToView?<C extends EventChannel>(viewId: ViewId, channel: C, payload: IpcEventMap[C]): boolean
  /**
   * Whether the remote `viewId` is still a live view of `windowId`. The opener checked it before
   * awaits (login env, file check); the browser may have left since, with `viewGone` already run
   * and nothing to hand the page back. Absent: trusted, as before web access.
   */
  isViewLive?(viewId: ViewId, windowId: number): boolean
  /** A view's device name for `info.heldBy` ("Desktop", a browser's device). Default: the view id. */
  deviceOf?(viewId: ViewId): string
  /** A view's lineage across a reconnect (TabManagerOptions.lineageOf), for the overlays' sizes. */
  lineageOf?(viewId: ViewId): string | undefined
  /**
   * The command a chord fires in this window (main's command registry with the user's overrides),
   * so `overlay.pop` / `overlay.closeTop` follow a rebinding in keys typed into a url view.
   */
  commandForChord(windowId: number, chord: string): string | undefined
  /**
   * The buttons other plugins add for an overlay's type (design-next §3.3): the window's plugin
   * host (HostApi.overlayButtons), resolved on every ask, since the host may have restarted. Absent
   * or undefined: a typed overlay shows only its opener's buttons.
   */
  typeButtons?(windowId: number): OverlayTypeButtons | undefined
  /** A plugin's title, which orders the type buttons' groups in the toolbar. Default: the id. */
  pluginTitle?(pluginId: string): string
  /** Where Discuss with Claude sends (design-next §3.5). Absent: Send always answers an error. */
  discuss?: DiscussSessions
  log?: (message: string) => void
  /**
   * Server mode (design-web.md §9.8): the desktop view is the hidden page, never a measured view of a
   * terminal overlay, so it never sizes the pty nor answers its queries; with no browser sizing the
   * overlay nobody answers (the program's query times out, as with no terminal at all). A url
   * overlay is refused at its open (§9.9): its page is a native view, which nobody on the server can
   * see and a browser cannot show.
   */
  server?: boolean
  /**
   * Server mode only: the window's live browser views that may hold an html overlay's page, best
   * first: the one that acted last (ViewSelections, design-web.md §5.1), then the others in the order
   * they attached. Main's own registry, never a payload; the desktop view is never one of them (and
   * is skipped if it were). Absent or empty: no browser is attached, so the page waits for one.
   */
  browserViews?(windowId: number): ViewId[]
  /**
   * Whether a view is the owner's (ViewRegistry.whoOf, design-guests §9): a guest's view never holds an html
   * overlay's page (its posts carry the opener's data). Required (03e D): a wiring that forgot it must not hand a
   * page to a guest's view.
   */
  ownerView(viewId: ViewId): boolean
  /**
   * Whether a view that is not the owner's may load a copy of this `perView` overlay (a guest's, by
   * design-overlay-views.md §4: the opener and every plugin it was opened for visible to it, its port
   * not `none`). Owner views never ask: they always may (D-1). Absent: no guest view ever gets a copy
   * (fail closed, as for `ownerView`).
   */
  mayConnectCopy?(windowId: number, overlayId: string, viewId: ViewId): boolean
  /**
   * The port a view that is not the owner's has to the opener for this overlay's copies, read live for every
   * page message (D-17, as panels: shared/guest-access.ts guestPort): `full` passes them to the opener; `oneWay`
   * (a read guest of a plugin that is not `guests.aware`) and anything else drops them, so a plugin that never
   * checks `access` cannot be driven by a watcher. The opener's posts still reach the copy. Absent: no guest
   * page's message ever reaches the opener (fail closed). Owner views never ask.
   */
  copyPort?(windowId: number, overlayId: string, viewId: ViewId): 'none' | 'oneWay' | 'full'
  /**
   * The guest behind a view (ViewRegistry.whoOf; main's own, never a payload's), undefined for the owner's and
   * a gone view: a guest's hide of a perView overlay is recorded under it, so the overlay stays off every view of
   * that guest, a reconnect's new view included. Absent: no hide is recorded (each hide only releases its copy).
   */
  guestOf?(viewId: ViewId): string | undefined
  /**
   * Main dropped a not-ready copy for its view (its queue overflowed, see `deliverToCopy`): that view's
   * shell reloads the page, which connects again as a new copy. Only for the overflow: a ready copy whose
   * send failed gets none, since that sink fails only for a closed view. Absent: the copy is only dropped,
   * and the view's page stays as it is until it reconnects by itself.
   */
  reloadCopy?(viewId: ViewId, windowId: number, overlayId: string, copy: string): void
  /**
   * The Notes service (shared/design.md §3) and the window's project, read at each use (the service is made after the
   * manager): Discuss sends an overlay's notes as their own part and removes them once delivered (task 03, `discuss()`).
   * Absent or undefined: no notes part.
   */
  notes?(windowId: number): { api: NotesApi; projectId: string } | undefined
}

/** What `start` / `open` know about the opener beyond the spec (main's own, never the spec's). */
export interface OverlayStartOptions {
  /**
   * The opening plugin's manifest says `overlays.perView` (host-api reads it, never the spec): an html
   * overlay gets per-view copies instead of one holder. Ignored for the other kinds.
   */
  perView?: boolean
  /**
   * Provenance (docs/design-overlay-views.md §4, D-4): the plugins this overlay is opened for, the opener's
   * service caller chain at its open plus any `addSources` / chained post made before the overlay existed.
   * host-api checked them (this host's plugins only). Set on the record before the overlay is first listed,
   * so no `overlays.updated` ever carries its title to a guest who may not see one of them. Any kind.
   */
  via?: Iterable<string>
}

/** Why `connectCopy` refused (the shell retries `cap` later; the others are final for that view). */
export type CopyRefusal = OverlayCopyRefusal

/** A copy as `copyState` / `copies` show it (no outbox). */
export interface CopyState {
  copy: string
  view: ViewId
  /** The opener's first post addressed to it went out: it gets broadcasts from then on. */
  joined: boolean
  /** Its page's port is up: posts go straight out instead of waiting in its outbox. */
  ready: boolean
  /** Its loader went (its port for `ready: 'load'`, its page's `ccPanel.ready()` for `manual`). */
  loaded: boolean
}

/** How many released copies an overlay remembers the view of (copyViewOf): the events about them go out at once. */
const RETIRED_COPIES = 32

/**
 * What opened an overlay (design-guests §9, spec-review 16): the tab a `ccc` call came from (CliCall.tabId, main's)
 * or the plugin that opened it. Main's own, never a payload's; a guest sees an overlay only when it sees one of
 * them, and one with neither (the desktop's own menu, an unknown caller) is hidden from guests.
 */
export interface OverlayOrigin {
  tabId?: string
  pluginId?: string
}

/** What a type-button provider is told about an overlay (the SDK's OverlayInfo). */
export interface OverlayTypeQuery {
  type: CleanOverlayType
  title: string
  /**
   * The opening plugin's id, `cli` or `core`: from `pluginId` of start(), the id HostApi checked
   * the request for, never from the spec. Providers trust it (a source shows its inbox-item buttons
   * only to itself and its reviewer), so it must stay main's record.
   */
  opener: string
}

/**
 * The window's host side of type buttons. `key` is the overlay's buttons key (minted here, not its
 * id, which never leaves main). Each answer was checked by HostApi: plugins of that host only.
 */
export interface OverlayTypeButtons {
  list(key: string, query: OverlayTypeQuery): Promise<CleanTypeButton[]>
  /**
   * Run one; `close` when its run answered `{ close: true }`. `view`: the remote view whose toolbar
   * was clicked (the caller main bound), absent for the desktop's: the run acts there.
   */
  click(key: string, pluginId: string, buttonId: string, query: OverlayTypeQuery, view?: ViewId): Promise<{ close: boolean }>
  /** The overlay went: the host forgets its runs. */
  ended(key: string): void
}

/**
 * main's sessions as Discuss needs them, all scoped to the overlay's window: the tab ids it names
 * came from a renderer and are checked here (isClaudeTab) before every use.
 */
export interface DiscussSessions {
  /** `tabId` is a Claude tab of `windowId`'s project that has not ended. */
  isClaudeTab(windowId: number, tabId: string): boolean
  /**
   * The tab is idle (an unclear SessionStart: compact outside a turn, fork): the gate would queue
   * the text and no Stop comes to deliver it until the person runs a prompt (renderer
   * discuss-tabs.ts, `not-ready`). A starting tab is not: SessionStart makes it sendable.
   */
  notReady(tabId: string): boolean
  /**
   * The send gate (SessionRegistry.send): typed now when the tab waits for input, else queued.
   * Throws when refused. Discuss passes `core`: the person clicked Send, so their typing in the
   * tab neither refuses the text nor drops it from the queue (send-gate.ts takenOver).
   */
  send(tabId: string, text: string, origin: SendOrigin, guestId?: string): { id: string; delivered: boolean }
  /**
   * The queued item `itemId` (a `send` that was not `delivered`) settled: typed into the tab (`delivered`) or
   * dropped from the queue (the tab ended, the person took it over, a guest's access ended). Discuss removes the notes
   * it sent only on `delivered` (shared/design.md §3, task 03; spec-review S12). Absent: the notes are kept.
   */
  onSettled?(itemId: string, fn: (how: 'delivered' | 'dropped') => void): void
  /**
   * Open a Claude tab in the window's project folder with `prompt` as its first prompt (main's own
   * open path, the ctx.sessions.open argument rule) and tell the window. Throws when refused.
   */
  openSession(windowId: number, prompt: string, guestId?: string): Promise<{ tabId: string }>
  /** The window's project's live tab ids (a guest's new session counts its open tabs, D-21). Absent: no guest opens one. */
  liveTabs?(windowId: number): string[]
  /** Close a tab of the window's project (a guest's new session whose access ended while it opened). */
  closeTab?(windowId: number, tabId: string): void
  /**
   * Select the tab in the window (the person sees where the text went). `view`: only that view selects it (a
   * guest's Discuss: its own view, never the owner's selection, design-guests §7).
   */
  selectTab(windowId: number, tabId: string, view?: ViewId): void
  /**
   * The person's closing prompt for the window's own project, resolved by main at send time
   * (effectiveDiscussPrompt), never taken from the renderer. Absent or undefined: none.
   */
  prompt?(windowId: number): string | undefined
}

/** A toolbar click as the renderer reports it: whose button, by id. */
export type OverlayButtonClick =
  | { source: 'opener'; buttonId: string }
  | { source: 'type'; pluginId: string; buttonId: string }

/** What opening a url overlay gets in server mode (design-web.md §9.9): no native view is made. */
export const URL_OVERLAY_SERVER_REFUSAL = 'overlay: url overlays are not available in server mode'
/** What the opener gets when the call came from a guest's view (03e): an overlay is never handed to the owner's screen. */
export const GUEST_ORIGIN_OVERLAY_REFUSAL = "overlay: refused from a guest's view"

/** Limits on what a caller may put in a spec. Generous for real use, small enough for IPC. */
export const MAX_URL_LENGTH = 8192
export const MAX_HTML_BYTES = 1024 * 1024
export const MAX_TITLE_LENGTH = 200
export const MAX_ARGV_ENTRIES = 1000
export const MAX_ARGV_CHARS = 128 * 1024
/** Largest html result value (as JSON); the CLI prints it, a plugin gets it over RPC. */
export const MAX_RESULT_BYTES = 1024 * 1024
/** Largest message either way between an html overlay's page and its opener, as JSON text. */
export { MAX_OVERLAY_MESSAGE_LENGTH }
/**
 * Messages an opener may post before the page can take them (it is loading, or the overlay is not
 * created yet: HostApi holds those). A page loads in well under a second; more is a loop.
 */
export const MAX_QUEUED_OVERLAY_MESSAGES = 100
/** ...and their JSON text together, so a queue of 100 one-MiB messages never sits in main. */
export const MAX_QUEUED_OVERLAY_LENGTH = 8 * 1024 * 1024

/**
 * The bounded queue of messages for a page that cannot take them yet. `push` throws, with the
 * limit in the message, when it is full: the opener hears it (its post fails) instead of the
 * message silently going nowhere.
 */
export class OverlayOutbox {
  private texts: string[] = []
  private length = 0

  push(text: string): void {
    if (this.texts.length >= MAX_QUEUED_OVERLAY_MESSAGES || this.length + text.length > MAX_QUEUED_OVERLAY_LENGTH) {
      throw new Error(
        `overlay: the page has not loaded yet and its queue is full (${MAX_QUEUED_OVERLAY_MESSAGES} messages or ${MAX_QUEUED_OVERLAY_LENGTH} chars)`
      )
    }
    this.texts.push(text)
    this.length += text.length
  }

  /** Everything queued, oldest first; the queue is empty after. */
  drain(): string[] {
    const out = this.texts
    this.texts = []
    this.length = 0
    return out
  }
}

/**
 * The opener's side of an html overlay's messages (HostApi for ctx.overlay.start). Called by the
 * manager only, never with anything a renderer chose but the page's own (checked) message.
 */
export interface OverlayChannel {
  /**
   * The overlay exists, with this id: called inside `start`, after the overlay is on its stack and
   * before `start` returns (so before any page could post). Called for every kind; the other
   * members matter for html overlays only.
   */
  onCreated?(overlayId: string): void
  /**
   * The page posted a message without a `result` key: plain JSON data, parsed from its text. `view`:
   * the remote view whose page posted it (main's own id, never the page's word), absent for the
   * desktop's; the opener runs its listeners in it (origin-view.ts), a hint for where they act.
   */
  onMessage(message: unknown, view?: ViewId, copy?: string): void
  /**
   * `perView` overlays: a view's copy connected (`connectCopy`), with the id main minted for it and its
   * view (main's own, the desktop's included). The opener answers with its starting state, a post
   * addressed to that copy, which is also what joins it to broadcasts.
   */
  onConnect?(copy: string, view: ViewId): void
  /**
   * `perView` overlays: a copy is gone (released by its shell, replaced by its view's next connect, its
   * view gone, or dropped by main for an overflowing queue). Called after it left the copies map, so a
   * post to it from inside the listener is already dropped. Not called when the overlay itself ends.
   */
  onDisconnect?(copy: string, view: ViewId): void
  /**
   * A click on one of the opener's own buttons (any kind of overlay): settles when its handlers
   * have. Absent: the opener cannot hear clicks, and they are refused. `view` as for onMessage: the
   * remote view whose toolbar was clicked, absent for the desktop's.
   */
  onButton?(buttonId: string, view?: ViewId): Promise<unknown>
  /**
   * Discuss with Claude asks the opener's `onDiscuss` handlers for the context (`{ text }` or null).
   * Asked only once the opener said it has a handler (setDiscussHandler). `view` as for onButton: the
   * remote view whose Send it was (the router's caller, an owner's browser included), absent for the
   * desktop's, so the opener knows who asked (docs/design-overlay-views.md §3).
   */
  onDiscuss?(view?: ViewId): Promise<unknown>
  /**
   * Ask (shared/design.md §5, spec-review S5): the opener's `onAsk` handlers for the document a chat is about
   * (`{ text }` or null; the first text wins, all null refuses, a throw refuses), within ASK_CONTEXT_MS
   * (shared/ask.ts). `view` and `copy`: the asking copy (main's own record), so a host answers about what that copy
   * shows. Absent: no Ask for this overlay.
   */
  onAsk?(view: ViewId, copy: string): Promise<unknown>
}

/**
 * A perView copy's life event, for main's Notes and Ask services (00 contract): `onCopyReady` when its port is up,
 * `onCopyEnd` when it is gone. `view` is main's own record of the copy's view.
 */
export interface CopyEvent {
  windowId: number
  overlayId: string
  copy: string
  view: ViewId
  /** The opener (main's record): a copy's notes and Ask are that plugin's. */
  pluginId?: string
}

/** attachPart's word from host-api on the part plugin (overlay-parts.ts PartRequest). */
export interface PartOptions {
  perView?: boolean
  /** The plugin is one this window's host runs; absent counts as no. */
  inHost?: boolean
}

/** A part drawn in a window (design-parts.md §2). */
export interface OverlayPartRef {
  overlayId: string
  pluginId: string
}

/** Re-exported: a dismissed terminal overlay's program gets SIGKILL after this (PtyService.terminate). */
export { KILL_GRACE_MS } from '../pty/pty-service'

/** A window token: 32 random bytes as lowercase hex, the format of a tab's (tab-manager.ts). */
const TOKEN_RE = /^[0-9a-f]{64}$/

/** A new PTY starts at this size until the renderer measured the overlay (as for tabs). */
const INITIAL_COLS = 80
const INITIAL_ROWS = 24

/**
 * The scheme an html overlay's page is served from (overlay-protocol.ts): `cc-overlay://<id>/`.
 * Not a data: URL or srcdoc: those inherit the shell page's CSP, whose `script-src 'self'` would
 * block the page's own script (seen in Chromium: inline script refused inside the data: frame).
 */
export const OVERLAY_SCHEME = 'cc-overlay'

/**
 * The CSP an html overlay's page is served with. Its own inline script and style run; it may load
 * nothing (no network, no other frames, no form posts), so what it was given stays in it except
 * the one value it posts through its port.
 */
export const OVERLAY_PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"

/**
 * The headers an inline overlay page is served with (`cc-overlay://` here, overlay-protocol.ts;
 * over HTTP, web/plugin-pages.ts adds the sandbox and framing rules a browser needs).
 */
export function overlayPageHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': OVERLAY_PAGE_CSP,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store'
  }
}

interface Overlay {
  id: string
  windowId: number
  info: OverlayInfo
  /** An html overlay's page, served at `info.src` while the overlay is open. */
  html?: string
  /** Who asked (a plugin id, `cli`, ...): only for the log, never an authority. */
  opener: string
  /** What opened it, for guests (OverlayOrigin); absent: hidden from every guest. */
  origin?: OverlayOrigin
  /**
   * The origin's `via` (docs/design-overlay-views.md §4, D-4): the plugins the overlay was opened or
   * filled for (a mail Gmail asks the Reviewer to show). Only ever grows (`addSources`); a guest gets the
   * overlay only when the origin rule passes AND every plugin here is visible to it (`visibleTo`). Never
   * in `info`: which plugins asked is main's to judge with, not the renderer's to show.
   */
  via: Set<string>
  settle: (result: OverlayResult) => void
  view?: UrlView
  /**
   * A terminal overlay's window token (resolveToken). It lives exactly as long as the record is
   * in `byId`: set before that, and finish() takes the record out, so every way an overlay ends
   * (its program exiting, ✕, Cmd+Shift+W, the window closing, quit) revokes it.
   */
  token?: string
  /**
   * Removes the listener on the opener's `peerGone` signal. A plugin host passes ONE signal that
   * lives as long as the host, so a listener left behind after a normal close would keep this
   * record (an html page of up to 1 MiB, a view) alive until the host exits, and from the 11th
   * overlay Node warns MaxListenersExceededWarning (task 27 review).
   */
  unlinkPeer?: () => void
  /**
   * The opener's channel (ctx.overlay.start); absent for the CLI's. Kept for every kind: its
   * buttons' clicks go there. Only an html overlay's page messages use the rest.
   */
  channel?: OverlayChannel
  /**
   * The renderer reported the page's port up (`pageReady`): posts go straight out. Until then they
   * wait in `outbox`. Cleared again when the window's renderer reloads (`list`), since the page
   * reloads with it and posts sent meanwhile would reach no port.
   */
  pageReady: boolean
  outbox: OverlayOutbox
  /**
   * An html overlay's view: the one whose page is the overlay's page (see the top of the file). Only
   * that view's page reports, answers and gets the opener's posts. Unused by the other kinds.
   */
  holder?: ViewId
  /**
   * When an html overlay's loader goes (spec `ready`): at the port (`load`, the default) or when the
   * page says so (`manual`). Unused by the other kinds, whose loader follows their view or program.
   */
  ready: 'load' | 'manual'
  /** The opening plugin (its `.svg` icons, its id in OverlayTypeQuery); absent for the CLI and core. */
  pluginId?: string
  /** What the overlay shows (spec `type`): other plugins' buttons are asked for it. */
  type?: CleanOverlayType
  /** The key the host knows this overlay's type buttons by; set with `type`. */
  buttonsKey?: string
  /** The opener's buttons (spec, then setButtons) and the type buttons, as checked. */
  openerButtons: CleanOverlayButton[]
  typeButtons: CleanTypeButton[]
  /** Clicks running now (`opener/<id>`, `type/<pluginId>/<id>`): shown busy, no second click. */
  running: Set<string>
  /** Bumped by every type-button ask: only the newest answer is applied. */
  typeAsk: number
  /** The spec's `discuss`: false hides Discuss, `{ tabId }` preselects a tab. */
  discussSpec?: false | { tabId?: string }
  /** The opener has an `onDiscuss` handler now (setDiscussHandler). */
  discussHandler: boolean
  /** Discuss is drawn as the primary button (setDiscussPrimary). */
  discussPrimary?: boolean
  /** A Send is under way: a second one is refused until it ends. */
  discussing: boolean
  /** Set for a `perView` html overlay (OverlayStartOptions): its copies replace holder, pageReady and outbox. */
  perView?: PerViewState
  /**
   * The spec's `notes.key` as the opener gave it (shared/design.md §3): only on a perView html overlay of a plugin
   * page (parseOverlayExtras refuses the rest). The store namespaces it with `pluginId`; `info.notes` says only that
   * there is one.
   */
  notesKey?: string
  /**
   * A part (design-parts.md §2): its parent's id. A part is in `byId` and never in `stacks`, so `pop`, `closeTop` and
   * `focus` act on the parent; it ends with the parent (finish ends a parent's parts first).
   */
  parentId?: string
  /** A parent's parts' ids, in attach order (at most MAX_PARTS). */
  parts?: string[]
  /** The opener announced what it shows (handle.announce): its consent to parts. Never undone. */
  announced?: boolean
}

/** One view's copy of a `perView` overlay's page (CopyState, plus its queue). */
interface OverlayCopy {
  id: string
  view: ViewId
  /**
   * In the copies map. Set false in the same step that takes it out, so a caller still holding the
   * record from before a release (a fan-out's snapshot, a listener that released it) delivers nothing.
   */
  live: boolean
  joined: boolean
  ready: boolean
  loaded: boolean
  /** Posts while its port is not up, with today's bounds (OverlayOutbox); drained at `copyReady`. */
  outbox: OverlayOutbox
  /** A page message it sent was dropped for its one-way port: logged once per copy. */
  oneWayLogged?: boolean
}

interface PerViewState {
  /** copy id -> copy; at most one per view (a view's next connect replaces its previous copy). */
  copies: Map<string, OverlayCopy>
  /** Recent connect times per view (the panel ports' cap, panel-ports.ts withinCap). */
  connects: Map<ViewId, { times: number[]; logged: boolean }>
  /** A release naming no live copy of that view was logged: once per overlay, so a loop is one line. */
  staleLogged: boolean
  /**
   * Guests (by id, OverlayManagerOptions.guestOf) who hid the overlay: a read guest's ✕ (`releaseCopy` with
   * `hide`) or the opener's `hideCopy` of a guest's copy. Keyed by the guest, not the view: a reconnect is a new
   * view id, and the overlay must not come back on it (docs/design-overlay-views.md §5 "✕ and results"). Lives
   * as long as the overlay; at most one entry per guest. Never set by a growth release (`addSources`), which is
   * visibility and lifts when the owner shows the plugin.
   */
  hiddenFrom: Set<string>
  /**
   * Owner views whose copy the opener hid (`hideCopy` of an owner's copy): the shell keeps the overlay off that
   * view's stack (OverlayStack `hiddenHere`), so the desktop's webview panels must not stay covered for it
   * (`coversDesktop`). Per view, not per person (D-1: the owner's other views still show it); cleared by that
   * view's next connect (a reload is a new copy, shown again) and when the view goes.
   */
  ownerHidden: Set<ViewId>
  /**
   * The views of the most recently released copies (copy id -> view, oldest first, RETIRED_COPIES at most): an
   * `overlays.hide` or `overlays.reload` goes out right after its copy is released, and the guest sink checks the
   * copy against the receiving view by this record (copyViewOf), never by the payload alone.
   */
  retired: Map<string, ViewId>
}

/** A click's key in `running`. */
function clickKey(click: OverlayButtonClick): string {
  return click.source === 'opener' ? `opener/${click.buttonId}` : `type/${click.pluginId}/${click.buttonId}`
}

export class OverlayManager {
  /** windowId -> its overlays, bottom first. */
  private readonly stacks = new Map<number, Overlay[]>()
  /** onCopyReady / onCopyEnd listeners (Notes and Ask services in main). */
  private readonly copyReadyListeners = new Set<(event: CopyEvent) => void>()
  private readonly copyEndListeners = new Set<(event: CopyEvent) => void>()
  private readonly byId = new Map<string, Overlay>()
  /** The top overlay each window had after its last change, to move focus only on a change. */
  private readonly lastTop = new Map<number, Overlay | undefined>()
  private readonly pty: PtyService
  private readonly options: OverlayManagerOptions
  private readonly log: (message: string) => void
  /**
   * A terminal overlay's size as each view last measured it, and the view whose size the pty has
   * (design-web.md §5.2 "Size"): the tab rule (views/view-sizes.ts, shared with TerminalSizes) with
   * the take on the person's key at once, no debounce. The first view to report sizes it, and the
   * person typing in another view moves it there. Without this a phone and the desktop showing the
   * same TUI (revdiff) resized the pty on every fit or rotation, each over the other. Hidden views
   * (a minimized or hidden-kept window, a background browser tab: the same `tabs.visibility` marks
   * TabManager gets) never take the size unless they are the overlay's only view, and a hidden
   * sizer hands it to the visible view active last: a hidden renderer is throttled, so its xterm
   * answers queries late, and it must not size, and so not answer, while a visible view can.
   */
  private readonly sizes: ViewSizes<string>
  /** Discuss's New session budget, per window. */
  private readonly discussSessions = new DiscussSessionBudget()

  constructor(options: OverlayManagerOptions) {
    this.options = options
    this.sizes = new ViewSizes<string>({
      apply: (overlayId, cols, rows) => this.pty.resize(overlayId, cols, rows),
      debounceMs: 0,
      ...(options.server === true ? { measured: (viewId: ViewId) => isRemoteViewId(viewId) } : {}),
      ...(options.lineageOf ? { lineage: (viewId: ViewId) => options.lineageOf?.(viewId) } : {})
    })
    this.log = options.log ?? warnLog
    this.pty = new PtyService({
      backend: options.backend,
      sink: {
        data: (id, data) => {
          const overlay = this.byId.get(id)
          if (!overlay) return
          this.options.emit(overlay.windowId, 'overlays.data', { overlayId: id, data })
          // The program's first output: its loader goes (after the data, so the frame never shows
          // an empty terminal between the two).
          this.loaded(overlay)
        },
        exit: (id, code, signal) => {
          // Killed by a signal: report it the way a shell does (128 + n), so a program the user
          // or the OS killed never reads as a clean 0. Not reached for ✕ / Cmd+Shift+W: those
          // settle as dismissed first, and the exit of an overlay that is gone is dropped here.
          const overlay = this.byId.get(id)
          if (overlay) this.finish(overlay, { kind: 'exit', code: exitStatus(code, signal) })
        }
      }
    })
  }

  /**
   * Open an overlay on top of `windowId`'s stack. The promise settles exactly once (see the top of
   * the file). It rejects, and nothing is created, for a bad spec or a program that cannot start.
   */
  open(
    windowId: number,
    spec: unknown,
    opener: string,
    peerGone?: AbortSignal,
    channel?: OverlayChannel,
    pluginId?: string,
    view?: ViewId,
    origin?: OverlayOrigin,
    options?: OverlayStartOptions
  ): Promise<OverlayResult> {
    try {
      return this.start(windowId, spec, opener, peerGone, channel, pluginId, view, origin, options)
    } catch (err) {
      return Promise.reject(toError(err))
    }
  }

  /**
   * `open`, but a bad spec or a program that cannot start THROWS here, before anything is created,
   * instead of rejecting the result. For an opener that does not wait for the result (a new-tab menu
   * entry opened as an overlay, design §3 Custom commands) yet must still tell the user it failed:
   * the promise of `open` settles only when the overlay closes, much too late to answer the click.
   *
   * `pluginId` is the plugin that opened it (absent for the CLI and core): its buttons' `.svg` icons
   * are files of that plugin's folder. The overlay goes on the stack here, at once, with a loader
   * (`info.loading`) until its body is ready (design-next §3.4; see `loaded`).
   *
   * `view` is the view the opening action came from (HostApi.originOf: a live remote view of THIS
   * window, checked by the caller): an html overlay's page opens there. Absent, or not a remote
   * view's id: the window's desktop view, or in server mode a browser's (see the top of the file).
   *
   * `options.perView` (the opener's manifest, host-api's word, never the spec's): an html overlay gets
   * per-view copies (`connectCopy`) instead of a holder, and `view` only says where the open came from.
   */
  start(
    windowId: number,
    spec: unknown,
    opener: string,
    peerGone?: AbortSignal,
    channel?: OverlayChannel,
    pluginId?: string,
    view?: ViewId,
    origin?: OverlayOrigin,
    options?: OverlayStartOptions
  ): Promise<OverlayResult> {
    return this.create(windowId, spec, opener, peerGone, channel, pluginId, view, origin, options)
  }

  /** `start`, and with `parent` a part of it (attachPart checked it may attach): never on the stack. */
  private create(
    windowId: number,
    spec: unknown,
    opener: string,
    peerGone?: AbortSignal,
    channel?: OverlayChannel,
    pluginId?: string,
    view?: ViewId,
    origin?: OverlayOrigin,
    options?: OverlayStartOptions,
    parent?: Overlay
  ): Promise<OverlayResult> {
    // The opener's perView is main's word (host-api's manifest read): a spec with `notes` from a plugin that is not
    // perView, or from the CLI or core, is refused here, before anything exists.
    const parsed = parseOverlaySpec(spec, { perView: options?.perView === true })
    // By main's own flag, before anything is created (whoever opens it: the CLI, a plugin, a menu).
    if (parsed.kind === 'url' && this.options.server === true) throw new Error(URL_OVERLAY_SERVER_REFUSAL)
    // Before anything is created: no program, no view, no stack for a window that is gone.
    if (!this.options.isWindowOpen(windowId)) throw new Error('overlay: the window is gone')
    // 03e (QA): an overlay opened by a call whose origin view is a guest's (a write guest's click that makes a plugin
    // open one) is refused, whatever its kind. A guest never holds an html page, so it would land on an owner's screen
    // as a modal that takes focus, repeatable by the guest; a terminal one would too. Any remote view that is not the
    // owner's counts, a gone one included (fail closed: an owner view gone mid-call costs only this overlay).
    // Best-effort: `view` is the plugin host's origin-view hint (10 s cap, none from a timer), so a plugin that opens
    // one later than that after a guest's click is not caught here and it lands on the owner's screen (design-guests §7).
    if (view !== undefined && isRemoteViewId(view) && !this.ownerView(view)) throw new Error(GUEST_ORIGIN_OVERLAY_REFUSAL)
    const id = randomUUID()
    let settle!: (result: OverlayResult) => void
    const promise = new Promise<OverlayResult>((resolve) => {
      settle = resolve
    })
    const overlay: Overlay = {
      id,
      windowId,
      info: infoOf(id, parsed, pluginId),
      opener,
      via: new Set(),
      settle,
      pageReady: false,
      outbox: new OverlayOutbox(),
      ready: parsed.ready ?? 'load',
      openerButtons: parsed.buttons ?? [],
      typeButtons: [],
      running: new Set(),
      typeAsk: 0,
      discussHandler: false,
      discussing: false
    }
    if (parsed.discuss !== undefined) overlay.discussSpec = parsed.discuss
    if (pluginId !== undefined) overlay.pluginId = pluginId
    // A part draws no toolbar of its own (design-parts.md §2): no Discuss (its onDiscuss text still goes into its
    // parent's, askParts), no buttons, no type buttons; the parent's toolbar is the window's.
    if (parent) {
      overlay.parentId = parent.id
      overlay.discussSpec = false
      overlay.openerButtons = []
    }
    // The opener's name for the note a guest sees where the page is not shown (docs/design-overlay-views.md §7:
    // "<Plugin> does not show its windows to guests"); main's own record, kept for a guest only while the
    // plugin is visible to it (guest-filter.ts guestOverlays).
    if (pluginId !== undefined && parsed.kind === 'html') {
      overlay.info = { ...overlay.info, pluginId, pluginTitle: this.options.pluginTitle?.(pluginId) ?? pluginId }
    }
    // A plugin's open is that plugin's even with no explicit origin; the CLI's needs the caller's tab (07).
    const from = { ...(origin?.tabId === undefined ? {} : { tabId: origin.tabId }), ...((origin?.pluginId ?? pluginId) === undefined ? {} : { pluginId: origin?.pluginId ?? pluginId }) }
    if (from.tabId !== undefined || from.pluginId !== undefined) overlay.origin = from
    // Before the first `changed` below: the overlay's first listing already honours whom it is opened for.
    // A part carries no via (it never widens who may see anything) and never grows its parent's.
    if (!parent) for (const id of options?.via ?? []) if (typeof id === 'string' && id !== '' && id !== overlay.origin?.pluginId) overlay.via.add(id)
    if (parsed.type && !parent) {
      overlay.type = parsed.type
      overlay.buttonsKey = randomUUID()
    }
    // Discuss shows for a typed overlay from the start; an onDiscuss handler adds it later.
    overlay.info = withDiscuss(overlay.info, overlay)
    if (parsed.kind === 'html' && 'html' in parsed) overlay.html = parsed.html
    if (parsed.kind === 'html' && options?.perView === true) {
      // No holder: each view's copy has its own loader (copyState), so the window-wide one never shows,
      // and nothing here may stamp `heldBy` or `waiting` (no view is "the" page's, D-1).
      overlay.perView = { copies: new Map(), connects: new Map(), staleLogged: false, hiddenFrom: new Set(), ownerHidden: new Set(), retired: new Map() }
      const info: OverlayInfo = { ...overlay.info, perView: true as const }
      delete info.loading
      // Notes (and Ask on them) need a plugin's page with copies; parseOverlaySpec refused every other case already.
      if (parsed.notes !== undefined && pluginId !== undefined) {
        overlay.notesKey = parsed.notes.key
        info.notes = true
      }
      overlay.info = info
    } else if (parsed.kind === 'html' && parent) {
      // attachPart checked the part plugin is perView; a part is never held.
      throw new Error('overlay.part: a part needs "overlays": { "perView": true } in plugin.json')
    } else if (parsed.kind === 'html') {
      const origin =
        view !== undefined && isRemoteViewId(view) && (this.options.isViewLive?.(view, windowId) ?? true) && this.ownerView(view) ? view : undefined
      // Server mode: never the hidden page; no browser at all leaves it waiting (holder undefined).
      this.hold(overlay, origin ?? (this.options.server === true ? this.browserHolder(windowId) : desktopViewId(windowId)))
    }
    // Every kind keeps it (its buttons' clicks go there); only an html page uses the messaging part.
    if (channel) overlay.channel = channel
    // A failed spawn or view throws out of here (open turns it into a rejection), before the
    // overlay is anywhere: nothing to undo.
    if (parsed.kind === 'terminal') {
      // Kept on the record only after a successful spawn (below): a program that never started
      // leaves no live token.
      const token = randomBytes(32).toString('hex')
      this.pty.spawn(id, parsed.argv, {
        cwd: parsed.cwd,
        env: this.options.env(token),
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS
      })
      overlay.token = token
    } else if (parsed.kind === 'url') {
      // Registered before the view exists: a chord can only arrive once it does, and it must
      // find this overlay (and its window) already on the stack. A page that dies settles the
      // overlay as dismissed; the `destroyed` that finish's own destroy() triggers finds the
      // overlay gone from byId and is a no-op.
      overlay.view = this.options.views.create(
        windowId,
        parsed.url,
        (chord) => this.handleChord(windowId, chord),
        () => this.finish(overlay, { kind: 'dismissed' }),
        () => this.loaded(overlay)
      )
    }
    if (parent) {
      const info: OverlayInfo = { ...overlay.info, partOf: parent.id }
      delete info.buttons
      delete info.typeButtons
      delete info.discuss
      delete info.notes
      overlay.info = info
    }
    this.byId.set(id, overlay)
    if (parent) {
      parent.parts = [...(parent.parts ?? []), id]
    } else {
      const stack = this.stacks.get(windowId) ?? []
      stack.push(overlay)
      this.stacks.set(windowId, stack)
    }
    this.changed(windowId)
    // The window's host is asked once now, and again after each click and on setButtons.
    this.askTypeButtons(overlay)
    // Before the peerGone check below may end it: an opener that queued posts or a close before the
    // overlay existed learns its id here, and a finish() right after makes those posts no-ops.
    try {
      channel?.onCreated?.(id)
    } catch (err) {
      this.log(`overlay ${id}: the opener's onCreated failed: ${String(err)}`)
    }
    // The opener (a `ccc overlay` that was killed or timed out) is gone: nobody waits for the
    // result, so do not leave the overlay (and a terminal one's program) behind. finish() is a
    // no-op when the overlay is already settled.
    if (peerGone?.aborted) this.finish(overlay, { kind: 'dismissed' })
    else if (peerGone) {
      const onGone = (): void => this.finish(overlay, { kind: 'dismissed' })
      peerGone.addEventListener('abort', onGone, { once: true })
      overlay.unlinkPeer = () => peerGone.removeEventListener('abort', onGone)
    }
    return promise
  }

  /**
   * The window whose open terminal overlay holds this token (socket-server.ts asks here after
   * TabManager), or undefined. Like a tab's lookup: every candidate is compared with
   * timingSafeEqual and the walk does not stop at a match. Main maps the window to its project;
   * the token is a window token and never names a session.
   */
  resolveToken(token: string): { windowId: number } | undefined {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return undefined
    const wanted = Buffer.from(token, 'hex')
    let found: Overlay | undefined
    for (const overlay of this.byId.values()) {
      if (overlay.token === undefined) continue
      if (timingSafeEqual(wanted, Buffer.from(overlay.token, 'hex')) && !found) found = overlay
    }
    return found ? { windowId: found.windowId } : undefined
  }

  /**
   * The window's overlays, bottom first. Also the re-attach point after a renderer reload; `viewId`
   * is the view that reloaded (the router's; default the desktop's).
   */
  list(windowId: number, viewId: ViewId = desktopViewId(windowId)): OverlayInfo[] {
    const stack = this.stacks.get(windowId) ?? []
    // The old page never acked what it was sent; a paused PTY would otherwise stay paused. Only for
    // the desktop's page: its acks are the overlay's flow (ack below), and a browser loading the
    // shell must not resume a PTY paused on a saturated desktop xterm (the tabs.list rule).
    if (viewId === desktopViewId(windowId)) for (const o of stack) if (o.info.kind === 'terminal') this.pty.resetFlow(o.id)
    // Server mode: an html page nobody holds (opened, or left, with no browser attached) goes to the
    // first browser to list the stack. The view is the router's caller, a live view of this window.
    let taken = false
    // Never a guest's view (design-guests §9): a guest listing the stack never picks up a waiting page.
    if (this.options.server === true && isRemoteViewId(viewId) && this.ownerView(viewId)) {
      for (const o of stack) {
        // A perView overlay has no holder by design, not one waiting for a browser: never held.
        if (o.info.kind !== 'html' || o.holder !== undefined || o.perView) continue
        this.hold(o, viewId)
        this.log(`overlay ${o.id}: its waiting page went to view ${viewId}`)
        taken = true
      }
    }
    // The html pages it holds reload with it: an opener's posts wait again until each one's port is
    // up, and the loader is back until the page is ready again (a `manual` page calls ready() once
    // more). A page another view holds did not reload. A url view and a PTY live in main and do
    // not reload with the renderer.
    for (const o of stack) if (o.info.kind === 'html' && o.holder === viewId) this.reloading(o)
    // The other views (the hidden page included) learn who holds it now.
    if (taken) this.changed(windowId)
    return this.infos(windowId)
  }

  /**
   * "Take over" (design-web.md §5.4): the html overlay's page moves to `viewId`, a view of the
   * window main resolved for the caller, and loads there as on a reload. True when it is open in
   * this window as an html overlay (also when the view already holds it: nothing changes then).
   */
  take(windowId: number, viewId: ViewId, overlayId: string): boolean {
    const overlay = this.find(windowId, overlayId)
    if (overlay?.info.kind !== 'html') return false
    // D-1: every owner view has its own copy already, so there is nothing to take. Thrown (not false,
    // which reads as "gone") so a stale shell that still offers the button shows why.
    if (overlay.perView) throw new Error('overlay: take over is not offered for an overlay shown in every view')
    // Server mode: the hidden page never holds a page (nothing there asks; refused all the same).
    if (this.options.server === true && !isRemoteViewId(viewId)) return false
    // A guest never takes a page over (design-guests §9): its posts carry the opener's data.
    if (!this.ownerView(viewId)) return false
    if (overlay.holder === viewId) return true
    this.hold(overlay, viewId)
    this.reloading(overlay)
    this.log(`overlay ${overlay.id}: its page moved to view ${viewId}`)
    this.changed(windowId)
    return true
  }

  /**
   * A view is gone (a browser left): the html pages it held go back to their window's desktop view,
   * which loads them, so an overlay is never left with nobody able to show or answer it. In server
   * mode they go to another browser of the window instead, else wait for the first to list them.
   */
  viewGone(viewId: ViewId): void {
    // Its copies of perView overlays go first, whatever the view (the opener hears each disconnect).
    for (const overlay of [...this.byId.values()]) {
      if (!overlay.perView) continue
      overlay.perView.ownerHidden.delete(viewId)
      for (const copy of [...overlay.perView.copies.values()]) if (copy.view === viewId) this.dropCopy(overlay, copy)
    }
    // A desktop view goes with its window (whose overlays close with it): only its hidden mark here.
    if (!isRemoteViewId(viewId)) {
      this.sizes.forgetHidden(viewId)
      return
    }
    // A departed sizer's size goes to the visible view active last (the desktop, when it is the only one left).
    this.sizes.viewGone(viewId)
    const touched = new Set<number>()
    for (const overlay of this.byId.values()) {
      if (overlay.holder !== viewId) continue
      this.hold(
        overlay,
        this.options.server === true ? this.browserHolder(overlay.windowId, viewId) : desktopViewId(overlay.windowId)
      )
      this.reloading(overlay)
      touched.add(overlay.windowId)
    }
    for (const windowId of touched) this.changed(windowId)
  }

  /**
   * `viewId` holds the html overlay's page now; `info.heldBy` names a browser, absent for the desktop.
   * Undefined (server mode, no browser attached): nobody holds it, so no view's reports count and the
   * opener's posts wait in the outbox (`pageReady` stays false) until a browser lists the stack.
   */
  private hold(overlay: Overlay, viewId: ViewId | undefined): void {
    if (viewId === undefined) delete overlay.holder
    else overlay.holder = viewId
    const info = { ...overlay.info }
    if (viewId !== undefined && isRemoteViewId(viewId)) info.heldBy = { viewId, device: this.options.deviceOf?.(viewId) ?? viewId }
    else delete info.heldBy
    if (viewId === undefined) info.waiting = true
    else delete info.waiting
    overlay.info = info
  }

  /**
   * Server mode: the browser view of `windowId` to hold a page (the last to act, else the first
   * attached), never `except` (the view leaving) nor a desktop view; undefined when none is attached.
   */
  private ownerView(viewId: ViewId): boolean {
    return this.options.ownerView(viewId)
  }

  private browserHolder(windowId: number, except?: ViewId): ViewId | undefined {
    for (const viewId of this.options.browserViews?.(windowId) ?? []) {
      if (viewId === except || !isRemoteViewId(viewId) || !this.ownerView(viewId)) continue
      if (this.options.isViewLive?.(viewId, windowId) ?? true) return viewId
    }
    return undefined
  }

  /** The html overlay's page loads anew (a reload, a take): posts wait for its port, the loader is back. */
  private reloading(overlay: Overlay): void {
    overlay.pageReady = false
    overlay.info = { ...overlay.info, loading: true }
  }

  /**
   * The page of an html overlay that `viewId` holds, else undefined: what any other view's renderer
   * says about the page (it has none, or a stale one from before a take) is dropped.
   */
  private held(windowId: number, overlayId: string, viewId: ViewId): Overlay | undefined {
    const overlay = this.find(windowId, overlayId)
    // A perView overlay has no holder: its pages speak through their copies (copyReady and the rest).
    return overlay?.info.kind === 'html' && !overlay.perView && overlay.holder === viewId ? overlay : undefined
  }

  /** An opener's post to its page: to the holding view only, when the shell can address one. */
  private toPage(overlay: Overlay, message: string): void {
    const payload = { overlayId: overlay.id, message }
    if (this.options.emitToView && overlay.holder !== undefined) {
      // False: the holder dropped and viewGone has not run yet. Queued, so the desktop's reload of
      // the page (pageReady) delivers it instead of it being lost with pageReady still true.
      if (!this.options.emitToView(overlay.holder, 'overlays.message', payload)) overlay.outbox.push(message)
    } else this.options.emit(overlay.windowId, 'overlays.message', payload)
  }

  /** The window's overlays, bottom first; a plain read (no flow-control reset). */
  infos(windowId: number): OverlayInfo[] {
    // Each parent, then its parts in attach order (`partOf` set): the shell draws them in the parent's body.
    const out: OverlayInfo[] = []
    for (const o of this.stacks.get(windowId) ?? []) {
      out.push(o.info)
      for (const id of o.parts ?? []) {
        const part = this.byId.get(id)
        if (part) out.push(part.info)
      }
    }
    return out
  }

  /**
   * The page of an open html overlay for its `cc-overlay://<id>/` URL, or undefined (unknown or
   * closed overlay, another path, another scheme). The id is a random UUID only main and the
   * owning window know, and the page goes away with the overlay.
   */
  pageHtml(url: string): string | undefined {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    if (parsed.protocol !== `${OVERLAY_SCHEME}:` || parsed.pathname !== '/') return undefined
    return this.byId.get(parsed.hostname)?.html
  }

  /**
   * An open html overlay's page by its id, with the window it belongs to, for the web gateway
   * (web/plugin-pages.ts `/o/…`), which checks the window against the asking device's views. A
   * URL overlay or a plugin page (`src` set, no `html`) has none.
   */
  inlinePage(overlayId: string): { windowId: number; html: string } | undefined {
    const overlay = this.byId.get(overlayId)
    return overlay?.html === undefined ? undefined : { windowId: overlay.windowId, html: overlay.html }
  }

  /** The kind of the window's top overlay, if it has any. */
  topKind(windowId: number): OverlayKind | undefined {
    return this.stacks.get(windowId)?.at(-1)?.info.kind
  }

  /** ✕ (or a key the renderer resolved): close that overlay, any kind, as dismissed. */
  close(windowId: number, overlayId: string): boolean {
    const overlay = this.find(windowId, overlayId)
    if (!overlay) return false
    this.finish(overlay, { kind: 'dismissed' })
    return true
  }

  /**
   * ctx.overlay.start's focus(): bring that overlay to the top of its window's stack (it shows and
   * takes the keyboard; the others stay open under it). True when it is open in this window, also
   * when it already was the top one (nothing changes then); false for an unknown or ended one.
   */
  focus(windowId: number, overlayId: string): boolean {
    const overlay = this.find(windowId, overlayId)
    if (!overlay) return false
    // A part is never on the stack: its window (the parent) comes to the top.
    if (overlay.parentId !== undefined) return this.focus(windowId, overlay.parentId)
    const stack = this.stacks.get(windowId)
    if (!stack || stack.at(-1) === overlay) return true
    stack.splice(stack.indexOf(overlay), 1)
    stack.push(overlay)
    this.changed(windowId)
    return true
  }

  /** Esc: dismiss the top overlay unless it is a terminal one (Esc belongs to its program). */
  pop(windowId: number): boolean {
    const top = this.stacks.get(windowId)?.at(-1)
    if (!top || top.info.kind === 'terminal') return false
    this.finish(top, { kind: 'dismissed' })
    return true
  }

  /** Cmd+Shift+W: dismiss the top overlay of any kind (a terminal's program is killed). */
  closeTop(windowId: number): boolean {
    const top = this.stacks.get(windowId)?.at(-1)
    if (!top) return false
    this.finish(top, { kind: 'dismissed' })
    return true
  }

  /**
   * A chord typed where the renderer cannot see it (a url overlay's page, an html overlay's
   * iframe). True when it was an overlay key and acted on, so the caller swallows it.
   */
  handleChord(windowId: number, chord: string | null): boolean {
    if (!chord || !this.stacks.get(windowId)?.length) return false
    const command = this.options.commandForChord(windowId, chord)
    if (command === 'overlay.pop') return this.pop(windowId)
    if (command === 'overlay.closeTop') return this.closeTop(windowId)
    return false
  }

  /**
   * The user typing into a terminal overlay, in `viewId`. The person's input (not a focus, mouse or
   * query report) from a view that has measured the overlay gives the pty that view's size.
   *
   * Query replies: every view with the shell loaded parses the overlay's output in its own xterm,
   * and each xterm answers the program's queries (DA1, CPR, DECRQM, OSC 10/11 colours) by itself.
   * Only one view may answer, or the program gets two replies to one query and reads the second
   * (late, from a background browser tab) as typed keys: `62;22c` at a readline prompt, OSC 11
   * letters in a bubbletea TUI. Tabs have main answer instead (tab-manager.ts viewInput); an
   * overlay has no headless copy, so the view whose size the pty has answers (a CPR then matches the
   * size), the desktop's until a view sizes it, and every other view's replies are stripped
   * (terminal-reports.ts stripQueryReplies; focus and mouse reports and keys pass). The sizer is
   * always a visible view when one has measured the overlay (viewVisible): a hidden desktop that
   * measured first (its local IPC beats the browser's WebSocket) answered ~1 s late, up to a minute
   * under Chromium's intensive throttling, and the late reply read as typed keys. With web access
   * off the desktop is the only view and always answers, hidden or not, so its input goes as it is.
   */
  input(windowId: number, overlayId: string, data: string, viewId: ViewId = desktopViewId(windowId)): void {
    const overlay = this.find(windowId, overlayId)
    if (overlay?.info.kind !== 'terminal') return
    // Server mode: the hidden page never answers, not even with no sizer (nobody looks at it, and a
    // browser that sizes later must not find a second answerer racing it).
    const answerer = this.sizes.sizerOf(overlay.id) ?? (this.options.server === true ? undefined : desktopViewId(windowId))
    const rest = viewId === answerer ? data : stripQueryReplies(data)
    if (rest.length > 0) this.pty.write(overlay.id, rest)
    // A view that measured the overlay and is visible takes the size at once (debounce 0).
    if (isPersonInput(rest)) this.sizes.typed(overlay.id, viewId)
  }

  /**
   * Whether a guest sees the overlay (design-guests §9): opened from a tab it sees, or by a plugin it sees; one
   * with no origin never. The router's `overlayVisible` (07 wires it with the guest's live checks), and through
   * it guest-filter's `guestOverlays` / `guestByOverlay` (the list, `overlays.data`, the `ready` snapshot).
   *
   * And every plugin of `via` must be visible too (docs/design-overlay-views.md §4, D-4): an overlay opened
   * or filled for a plugin hidden from the guest shows that plugin's content, so the guest gets neither its
   * copies nor its title (0.24.0 leaked a mail's subject: Gmail's mail in the Reviewer counted as the
   * Reviewer's). Checked for a tab origin too: a `ccc` overlay never has a `via`, so that rule is unchanged,
   * and one that ever did would fail closed.
   */
  visibleTo(windowId: number, overlayId: string, tabVisible: (tabId: string) => boolean, pluginVisible: (pluginId: string) => boolean): boolean {
    const overlay = this.find(windowId, overlayId)
    const origin = overlay?.origin
    if (!overlay || !origin) return false
    // A part (design-parts.md §3): visible only with its parent (an unknown parent is not visible) and its own
    // plugin (the origin rule below).
    if (overlay.parentId !== undefined && !this.visibleTo(windowId, overlay.parentId, tabVisible, pluginVisible)) return false
    const opened = origin.tabId !== undefined ? tabVisible(origin.tabId) : origin.pluginId !== undefined && pluginVisible(origin.pluginId)
    if (!opened) return false
    for (const pluginId of overlay.via) if (!pluginVisible(pluginId)) return false
    return true
  }

  /**
   * Provenance grows (docs/design-overlay-views.md §4 "Growth on a live overlay"): the overlay is now also
   * shown for these plugins (a chained post, `handle.addSources`, a main-routed open's `requestedBy`).
   * host-api checked the ids against its host's plugins; the set only grows, so a call can only narrow who
   * sees the overlay, never widen it. When it grew, in this one synchronous step and before the caller
   * delivers the post or buttons that carried the new content: every copy of a view that is not the
   * owner's and that `mayConnectCopy` no longer admits is released (its queue dropped, the opener hears its
   * disconnect, its view gets `overlays.hide`), and the window's list goes out again, which the guest
   * filter (`visibleTo`) now drops this overlay from. True when the set grew.
   */
  addSources(windowId: number, overlayId: string, pluginIds: Iterable<string>): boolean {
    const overlay = this.find(windowId, overlayId)
    if (!overlay) return false
    let grew = false
    for (const id of pluginIds) {
      if (typeof id !== 'string' || id === '' || id === overlay.origin?.pluginId || overlay.via.has(id)) continue
      overlay.via.add(id)
      grew = true
    }
    if (!grew) return false
    if (overlay.perView) {
      for (const copy of [...overlay.perView.copies.values()]) {
        // The desktop page is always the owner's (D-1); a remote view by main's own record.
        if (!isRemoteViewId(copy.view) || this.ownerView(copy.view)) continue
        // Fail closed: no rule wired, or one that throws, admits no guest copy (as connectCopy).
        let admitted = false
        try {
          admitted = this.options.mayConnectCopy?.(overlay.windowId, overlay.id, copy.view) === true
        } catch (err) {
          this.log(`overlay ${overlay.id}: checking view ${copy.view} after its sources grew failed: ${String(err)}`)
        }
        if (!admitted) this.hideCopyRecord(overlay, copy)
      }
    }
    this.changed(overlay.windowId)
    return true
  }

  /** A write guest's view measured a terminal overlay (D-14): remembered for its explicit take (typing) only. */
  guestResize(windowId: number, overlayId: string, cols: number, rows: number, viewId: ViewId): void {
    const overlay = this.find(windowId, overlayId)
    if (overlay?.info.kind !== 'terminal') return
    this.sizes.report(overlay.id, viewId, cols, rows, true)
  }

  /** A view measured a terminal overlay: remembered; the pty takes it when that view sizes it (input). */
  resize(windowId: number, overlayId: string, cols: number, rows: number, viewId: ViewId = desktopViewId(windowId)): void {
    const overlay = this.find(windowId, overlayId)
    if (overlay?.info.kind !== 'terminal') return
    this.sizes.report(overlay.id, viewId, cols, rows)
  }

  /**
   * A view was hidden or shown (TabManager.viewVisible's marks, the hidden-kept window's included):
   * a hidden sizer hands size and answering to the visible view active last; a view shown again
   * takes them when no visible view has them.
   */
  viewVisible(viewId: ViewId, visible: boolean): void {
    this.sizes.visible(viewId, visible)
  }

  /** The desktop page's ack (the router takes no other view's): the overlay's flow control. */
  ack(windowId: number, overlayId: string, count: number): void {
    const overlay = this.find(windowId, overlayId)
    if (overlay?.info.kind === 'terminal') this.pty.ack(overlay.id, count)
  }

  /** Where the renderer laid out a url overlay's body; the native view follows it. */
  setBounds(windowId: number, overlayId: string, bounds: ViewBounds): void {
    const overlay = this.find(windowId, overlayId)
    if (!overlay?.view) return
    const ok = [bounds.x, bounds.y, bounds.width, bounds.height].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100_000
    )
    if (!ok || bounds.width < 0 || bounds.height < 0) return
    overlay.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    })
  }

  /**
   * An html overlay's page posted its result (relayed by the renderer). The value is copied as
   * JSON: the opener prints or forwards it, so it must be plain data and bounded in size. False
   * for an unknown overlay, a non-html one, a view that does not hold its page, or a value that is
   * not JSON or too large. The first accepted result settles the opener; later ones find it gone.
   */
  result(windowId: number, overlayId: string, value: unknown, viewId: ViewId = desktopViewId(windowId)): boolean {
    const overlay = this.held(windowId, overlayId, viewId)
    if (!overlay) return false
    const clean = resultValue(value)
    if (!clean) return false
    this.finish(overlay, { kind: 'value', value: clean.value })
    return true
  }

  /**
   * The opener sends `text` (one JSON text, as the page's port carries it) to its html overlay's
   * page. True when it went out or was queued until the page has loaded; false for an overlay that
   * is gone, of another window, or opened without a channel (only the opener holds the id, and
   * HostApi looks it up by its own plugin and handle). Throws for a message over the limit or a
   * full queue.
   *
   * A `perView` overlay (docs/design-overlay-views.md §5): with `copy`, to that copy only (false when
   * it is gone: dropped, as a post to a gone copy is), and that first addressed post joins it to
   * broadcasts; without `copy`, to every live copy that has joined. A copy that has not had its
   * starting state yet gets no broadcast, not even queued: its starting state, sent after every earlier
   * broadcast by the host's in-order listeners, already reflects them. A full queue never throws here
   * (one slow copy must not fail the post for every other view): that copy is dropped and reloaded.
   * `copy` on an overlay that is not perView names nothing: dropped.
   */
  post(windowId: number, overlayId: string, text: string, options?: { copy?: string }): boolean {
    const overlay = this.find(windowId, overlayId)
    if (!overlay?.channel || overlay.info.kind !== 'html') return false
    if (typeof text !== 'string' || text.length > MAX_OVERLAY_MESSAGE_LENGTH) {
      throw new RangeError(`overlay post: message exceeds ${MAX_OVERLAY_MESSAGE_LENGTH} chars`)
    }
    const target = options?.copy
    if (overlay.perView) {
      if (target !== undefined) {
        const copy = typeof target === 'string' ? overlay.perView.copies.get(target) : undefined
        if (!copy) return false
        copy.joined = true
        return this.deliverToCopy(overlay, copy, text)
      }
      // A snapshot: an overflow below drops a copy from the map mid-walk.
      for (const copy of [...overlay.perView.copies.values()]) if (copy.joined) this.deliverToCopy(overlay, copy, text)
      return true
    }
    if (target !== undefined) return false
    if (overlay.pageReady) this.toPage(overlay, text)
    else overlay.outbox.push(text)
    return true
  }

  /**
   * The renderer handed an html overlay's page its port (on every page load): what the opener
   * posted before goes out now, in order. A no-op for an overlay without a channel, and from a view
   * that does not hold the page.
   */
  pageReady(windowId: number, overlayId: string, viewId: ViewId = desktopViewId(windowId)): void {
    const overlay = this.held(windowId, overlayId, viewId)
    if (!overlay) return
    // The page loaded and has its port: a `ready: 'load'` overlay is ready (an inline page reports
    // its load here too, with no channel behind it).
    if (overlay.ready === 'load') this.loaded(overlay)
    if (!overlay.channel) return
    overlay.pageReady = true
    for (const message of overlay.outbox.drain()) this.toPage(overlay, message)
  }

  /**
   * An html overlay's page says it has drawn (`ccPanel.ready()`): the loader goes, whatever its
   * `ready` mode (a `load` page calling it early changes nothing worse than an early port).
   */
  pageLoaded(windowId: number, overlayId: string, viewId: ViewId = desktopViewId(windowId)): void {
    const overlay = this.held(windowId, overlayId, viewId)
    if (overlay) this.loaded(overlay)
  }

  /**
   * An html overlay's page posted a message that is not a result (relayed by the renderer of the
   * window it is in). Only to the channel of the overlay's own opener; false (dropped, logged) for
   * an overlay of another window, one without a channel, a view that does not hold the page, or text
   * that is not JSON within the limit.
   */
  pageMessage(windowId: number, overlayId: string, text: unknown, viewId: ViewId = desktopViewId(windowId)): boolean {
    const overlay = this.held(windowId, overlayId, viewId)
    if (!overlay?.channel) return false
    if (typeof text !== 'string' || text.length > MAX_OVERLAY_MESSAGE_LENGTH) {
      this.log(`overlay ${overlay.id}: dropped a page message: not a JSON string of at most ${MAX_OVERLAY_MESSAGE_LENGTH} chars`)
      return false
    }
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      this.log(`overlay ${overlay.id}: dropped a page message: not JSON`)
      return false
    }
    try {
      if (isRemoteViewId(viewId)) overlay.channel.onMessage(message, viewId)
      else overlay.channel.onMessage(message)
    } catch (err) {
      this.log(`overlay ${overlay.id}: delivering a page message failed: ${String(err)}`)
    }
    return true
  }

  /**
   * A view's page of a `perView` overlay connected (docs/design-overlay-views.md §5): main mints the
   * copy's id (128 random bits, never reused) and the opener hears `onConnect`. `viewId` is the view
   * main resolved for the caller, never a payload's. A view has one copy per overlay: its previous one
   * (a reload, a reconnect) is released first, its disconnect before this connect. Refused for an
   * unknown overlay or one that is not perView, server mode's hidden page (nobody looks at it, and its
   * copy would run the page's code and take the opener's posts for nobody), a view that is not a live
   * view of this window, a view that may not see the overlay (owner views always may, D-1; any other
   * only by `mayConnectCopy`), and past the connect cap (`cap`: the shell tries again later).
   */
  connectCopy(windowId: number, overlayId: string, viewId: ViewId): { ok: true; copy: string } | { ok: false; reason: CopyRefusal } {
    const overlay = this.find(windowId, overlayId)
    if (!overlay) return { ok: false, reason: 'unknown' }
    if (!overlay.perView) return { ok: false, reason: 'not-per-view' }
    if (this.options.server === true && !isRemoteViewId(viewId)) return { ok: false, reason: 'hidden-page' }
    // The router binds the caller to its window; checked again here so no other path can hand a copy
    // to another window's view or to a browser that left during the caller's awaits.
    const ofWindow = isRemoteViewId(viewId) ? (this.options.isViewLive?.(viewId, windowId) ?? true) : viewId === desktopViewId(windowId)
    if (!ofWindow) return { ok: false, reason: 'not-allowed' }
    if (!this.ownerView(viewId)) {
      // A guest that hid it never gets it back (also in the wiring's rule; checked here so no wiring can skip it).
      const guest = this.options.guestOf?.(viewId)
      if (guest !== undefined && overlay.perView.hiddenFrom.has(guest)) return { ok: false, reason: 'not-allowed' }
      if (this.options.mayConnectCopy?.(windowId, overlay.id, viewId) !== true) return { ok: false, reason: 'not-allowed' }
    }
    if (!this.withinCopyCap(overlay, overlay.perView, viewId)) return { ok: false, reason: 'cap' }
    for (const old of [...overlay.perView.copies.values()]) if (old.view === viewId) this.dropCopy(overlay, old)
    // A new copy of an owner view the opener had hidden it from: shown there again, so it covers again.
    if (overlay.perView.ownerHidden.delete(viewId)) this.changed(windowId)
    const copy: OverlayCopy = {
      id: randomBytes(16).toString('hex'),
      view: viewId,
      live: true,
      joined: false,
      ready: false,
      loaded: false,
      outbox: new OverlayOutbox()
    }
    overlay.perView.copies.set(copy.id, copy)
    try {
      overlay.channel?.onConnect?.(copy.id, viewId)
    } catch (err) {
      this.log(`overlay ${overlay.id}: the opener's onConnect failed: ${String(err)}`)
    }
    return { ok: true, copy: copy.id }
  }

  /**
   * A perView page's `overlays.ready` (docs/design-overlay-views.md §5): its port is up, so its copy is
   * minted (connectCopy: the opener hears it and may answer with its starting state, queued until now)
   * and made ready at once (copyReady: the queue drains, in order). The answer is the channel's: the
   * copy id every later call of that page names, or why the view has none.
   */
  connectReady(windowId: number, overlayId: string, viewId: ViewId): OverlayReadyAnswer {
    const r = this.connectCopy(windowId, overlayId, viewId)
    if (!r.ok) return { refused: r.reason }
    this.copyReady(windowId, overlayId, viewId, r.copy)
    // The copy's loader is the shell's to draw (the info has none for perView): gone already for a `ready: 'load'`
    // overlay, else at that copy's `overlays.loaded`.
    return this.copyState(windowId, overlayId, viewId, r.copy)?.loaded === true ? { copy: r.copy, loaded: true } : { copy: r.copy }
  }

  /**
   * The shell let go of a copy (its page unmounted or reloads): the opener hears its disconnect. Only a
   * release, for every caller, a read guest's included: a hide is its own call (guestHide). True when it was
   * `viewId`'s live copy; anything else (gone, replaced, another view's, made up) is a no-op, logged once per
   * overlay so a looping page is one line.
   */
  releaseCopy(windowId: number, overlayId: string, viewId: ViewId, copy: unknown): boolean {
    const found = this.liveCopy(windowId, overlayId, viewId, copy)
    if (found) {
      this.dropCopy(found.overlay, found.copy)
      return true
    }
    const perView = this.find(windowId, overlayId)?.perView
    if (perView && !perView.staleLogged) {
      perView.staleLogged = true
      this.log(`overlay ${String(overlayId)}: a release named no live copy of view ${viewId}; dropped (logged once)`)
    }
    return false
  }

  /**
   * A copy's page has its port: what was queued for it goes out, in order, and later posts go straight
   * out. For a `ready: 'load'` overlay its loader goes too (a `manual` page says so itself, copyLoaded).
   * Dropped (false) unless `copy` is `viewId`'s live copy of this overlay.
   */
  copyReady(windowId: number, overlayId: string, viewId: ViewId, copy: unknown): boolean {
    const found = this.liveCopy(windowId, overlayId, viewId, copy)
    if (!found) return false
    const { overlay, copy: c } = found
    if (overlay.ready === 'load') c.loaded = true
    c.ready = true
    // deliverToCopy sends now (ready); one that fails drops the copy and the rest finds it dead.
    for (const message of c.outbox.drain()) this.deliverToCopy(overlay, c, message)
    // After the opener's queued starting state: Ask's history push (D14) lands behind it, on a port that is up.
    if (c.live) this.emitCopy(this.copyReadyListeners, overlay, c)
    return true
  }

  /**
   * A copy's page says it has drawn (`ccPanel.ready()`): that copy's loader goes, no other's (a guest's
   * page never clears the owner's loader). Dropped (false) unless it is `viewId`'s live copy.
   */
  copyLoaded(windowId: number, overlayId: string, viewId: ViewId, copy: unknown): boolean {
    const found = this.liveCopy(windowId, overlayId, viewId, copy)
    if (!found) return false
    found.copy.loaded = true
    return true
  }

  /**
   * A copy's page posted a message that is not a result: to the opener's channel with the copy's id,
   * as pageMessage does for a holder (`view` only for a remote view, the onMessage convention). Dropped
   * silently (false) unless `copy` is `viewId`'s live copy, so a replaced page is never heard as its
   * successor; text that is not JSON within the limit is dropped and logged.
   */
  copyMessage(windowId: number, overlayId: string, viewId: ViewId, copy: unknown, text: unknown): boolean {
    const found = this.liveCopy(windowId, overlayId, viewId, copy)
    if (!found?.overlay.channel) return false
    const { overlay } = found
    // D-17, read live for every message: a guest's copy talks to the opener only over a full port. A one-way
    // copy (a read guest of a plugin that is not guests.aware) still gets the opener's posts.
    if (!this.ownerView(viewId)) {
      let port: string | undefined
      try {
        port = this.options.copyPort?.(windowId, overlay.id, viewId)
      } catch (err) {
        this.log(`overlay ${overlay.id}: reading view ${viewId}'s port failed: ${String(err)}`)
      }
      if (port !== 'full') {
        if (!found.copy.oneWayLogged) {
          found.copy.oneWayLogged = true
          this.log(`overlay ${overlay.id}: copy ${found.copy.id} of view ${viewId} is one-way; dropped its page messages (logged once)`)
        }
        return false
      }
    }
    if (typeof text !== 'string' || text.length > MAX_OVERLAY_MESSAGE_LENGTH) {
      this.log(`overlay ${overlay.id}: dropped a page message: not a JSON string of at most ${MAX_OVERLAY_MESSAGE_LENGTH} chars`)
      return false
    }
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      this.log(`overlay ${overlay.id}: dropped a page message: not JSON`)
      return false
    }
    try {
      overlay.channel?.onMessage(message, isRemoteViewId(viewId) ? viewId : undefined, found.copy.id)
    } catch (err) {
      this.log(`overlay ${overlay.id}: delivering a page message failed: ${String(err)}`)
    }
    return true
  }

  /**
   * A copy's page posted its result: the overlay ends with it, for every view, as `result` does for a
   * holder. Dropped (false) unless `copy` is `viewId`'s live copy, or for a value that is not JSON or
   * too large. Owner views only (design-overlay-views.md §5 "✕ and results"): a guest's copy exists once
   * mayConnectCopy admits it, and the value settles the opener, so a wiring that forgot the router's rule
   * must still not let a guest choose it (a read guest's becomes a hide in its shell, a write guest's a
   * plain close, both decided before this).
   */
  copyResult(windowId: number, overlayId: string, viewId: ViewId, copy: unknown, value: unknown): boolean {
    const found = this.liveCopy(windowId, overlayId, viewId, copy)
    if (!found || !this.ownerView(viewId)) return false
    const clean = resultValue(value)
    if (!clean) return false
    this.finish(found.overlay, { kind: 'value', value: clean.value })
    return true
  }

  /** `viewId`'s live copy `copy` of a perView overlay as it stands (its loader, ready, joined), else undefined. */
  copyState(windowId: number, overlayId: string, viewId: ViewId, copy: unknown): CopyState | undefined {
    const found = this.liveCopy(windowId, overlayId, viewId, copy)
    return found ? stateOf(found.copy) : undefined
  }

  /** Every live copy of a perView overlay (empty for an unknown overlay or one that is not perView). */
  copies(windowId: number, overlayId: string): CopyState[] {
    return [...(this.find(windowId, overlayId)?.perView?.copies.values() ?? [])].map(stateOf)
  }

  /**
   * Whether `overlayId` is an open `perView` overlay of this window: the router's switch between the
   * copy calls and the holder's (main's own flag from the opener's manifest, never a payload's `copy`).
   */
  isPerView(windowId: number, overlayId: unknown): boolean {
    return this.find(windowId, overlayId)?.perView !== undefined
  }

  /**
   * A read guest's hide (its ✕ or its page's result: `overlays.release { hide: true }`, the router's, which
   * checked the role live; docs/design-overlay-views.md §5, D-2): recorded under the guest `viewId` belongs to
   * (recordHide), so the overlay leaves every view of that guest, their copies released with `overlays.hide`, and
   * does not come back on a list or a reconnect. With or without a live copy in `viewId`: a ✕ while the copy was
   * dropped and reloads, was refused at the cap, or before `overlays.ready` answered must still hide. A hide only
   * narrows the caller's own access, so no copy id is needed, and no port either: an overlay in the guest's list
   * whose opener's guest port is `none` (a shared tab's, its opener hidden) has no copy to connect, yet its ✕
   * must take it off. Whether the guest may see the overlay at all is the router's gate (the overlay target,
   * guest-wiring.ts overlayVisible) before this. Never for an owner's view. True when the guest has it hidden.
   */
  guestHide(windowId: number, overlayId: string, viewId: ViewId): boolean {
    const overlay = this.find(windowId, overlayId)
    const perView = overlay?.perView
    if (!overlay || !perView || this.ownerView(viewId)) return false
    const guest = this.options.guestOf?.(viewId)
    if (guest === undefined) return false
    if (perView.hiddenFrom.has(guest)) return true
    this.recordHide(overlay, viewId)
    return true
  }

  /**
   * The opener hides one copy in its own view (handle.hide: the Reviewer's read guest's in-page Close,
   * docs/design-overlay-views.md §3): the copy is released (the opener hears its disconnect) and
   * `overlays.hide` goes to that copy's view only, which unloads it and takes the overlay off its stack.
   * Looked up by the copy id alone: the opener names copies, not views, and the view is the copy's own
   * record. Released even when the view cannot take the event (it is going anyway). False for an
   * overlay that is gone or not perView, or a copy that is not live. A guest's copy: the hide is recorded
   * for that guest (recordHide), so the overlay stays off its stack, on every view and after a reconnect. An
   * owner's copy is only released: the owner's views get every overlay (D-1), and the shell keeps its own hide.
   */
  hideCopy(windowId: number, overlayId: string, copy: unknown): boolean {
    const overlay = this.find(windowId, overlayId)
    const c = typeof copy === 'string' ? overlay?.perView?.copies.get(copy) : undefined
    if (!overlay || !c?.live) return false
    this.hideCopyRecord(overlay, c)
    if (!this.ownerView(c.view)) this.recordHide(overlay, c.view)
    else if (overlay.perView && !overlay.perView.ownerHidden.has(c.view)) {
      // The shell takes it off that view's stack: the window's covered state is decided again (coversDesktop).
      overlay.perView.ownerHidden.add(c.view)
      this.changed(overlay.windowId)
    }
    return true
  }

  /**
   * Whether the guest `guestId` hid this perView overlay (a read guest's ✕, the opener's hideCopy of its copy).
   * The wiring's visibility rule reads it (guest-wiring.ts overlayVisible), so the guest's list, `ready`
   * snapshot, events and connects all drop the overlay alike. False for an unknown overlay or one not perView.
   */
  hiddenFrom(windowId: number, overlayId: unknown, guestId: string): boolean {
    return this.find(windowId, overlayId)?.perView?.hiddenFrom.has(guestId) === true
  }

  /**
   * The plugin that opened the overlay (main's record, from the host call it checked; never the spec): the one
   * whose guest port decides a guest's copy (guest-wiring.ts mayConnectCopyOf). Undefined for the CLI's, core's
   * and an unknown overlay.
   */
  openerPluginOf(windowId: number, overlayId: unknown): string | undefined {
    return this.find(windowId, overlayId)?.pluginId
  }

  /**
   * Whether the window's desktop view shows any overlay: one the opener hid from the desktop's copy
   * (`ownerHidden`) is off that view's stack, so it does not keep the desktop's webview panels hidden
   * (webviews.setWindowCovered). Server mode never covers (its webviews are streamed), so only the desktop counts.
   */
  coversDesktop(windowId: number): boolean {
    const desktop = desktopViewId(windowId)
    // The stack `overlays.updated` carries (infos), so the decision matches the list it goes out with.
    return (this.stacks.get(windowId) ?? []).some((o) => o.perView?.ownerHidden.has(desktop) !== true)
  }

  /**
   * The view a copy of this perView overlay belongs to, live or among the last released (RETIRED_COPIES): the
   * guest sink passes `overlays.message`, `.hide` and `.reload` to a view only for its own copies, decided by this
   * record rather than by the event's payload (`overlays.hide` goes out after its copy is released).
   */
  copyViewOf(windowId: number, overlayId: unknown, copy: unknown): ViewId | undefined {
    const perView = this.find(windowId, overlayId)?.perView
    if (!perView || typeof copy !== 'string') return undefined
    return perView.copies.get(copy)?.view ?? perView.retired.get(copy)
  }

  // ---- Notes, Ask and parts (00 contract: shared/design.md §3-§5, design-parts.md; the services live elsewhere) ----

  /**
   * Main's own push (a notes or Ask envelope, shared/overlay-envelope.ts) to one live copy: `overlays.message` with
   * `envelope: true`, to that copy's view only. Fail closed: false, nothing sent, for an overlay that is gone, of
   * another window or not perView, a copy that is not live (released, replaced or retired), a copy whose port is not
   * up, or a guest's copy that the wiring's rule (`mayConnectCopy`: the opener and every `via` plugin visible, not
   * hidden by that guest) no longer admits, read now. Never sets `joined` (that is the opener's first addressed post,
   * which orders its broadcasts, see `post`), and shares the copy's queue rules: a failed send drops the copy.
   * Throws a RangeError for a text over MAX_OVERLAY_MESSAGE_LENGTH, as `post` does.
   */
  postEnvelope(windowId: number, overlayId: string, copy: string, text: string): boolean {
    if (typeof text !== 'string' || text.length > MAX_OVERLAY_MESSAGE_LENGTH) {
      throw new RangeError(`overlay envelope: message exceeds ${MAX_OVERLAY_MESSAGE_LENGTH} chars`)
    }
    const overlay = this.find(windowId, overlayId)
    const perView = overlay?.perView
    const c = typeof copy === 'string' ? perView?.copies.get(copy) : undefined
    if (!overlay || !perView || !c?.live) return false
    if (!this.ownerView(c.view)) {
      const guest = this.options.guestOf?.(c.view)
      if (guest !== undefined && perView.hiddenFrom.has(guest)) return false
      let admitted = false
      try {
        admitted = this.options.mayConnectCopy?.(windowId, overlay.id, c.view) === true
      } catch (err) {
        this.log(`overlay ${overlay.id}: the copy rule threw for an envelope: ${String(err)}; dropped`)
      }
      if (!admitted) return false
    }
    return this.deliverToCopy(overlay, c, text, true)
  }

  /**
   * The view a LIVE copy of this perView overlay belongs to, or undefined (gone, another window's overlay, not
   * perView, a released or replaced copy). Unlike `copyViewOf`, never a retired copy's view: Notes and Ask act for
   * the caller only while its copy is live.
   */
  copyOwner(windowId: number, overlayId: unknown, copy: unknown): ViewId | undefined {
    if (typeof copy !== 'string') return undefined
    const c = this.find(windowId, overlayId)?.perView?.copies.get(copy)
    return c?.live === true ? c.view : undefined
  }

  /** The live copies of this perView overlay and their views (none for an unknown, other-window or holder overlay). */
  copiesOf(windowId: number, overlayId: unknown): { copy: string; view: ViewId }[] {
    const perView = this.find(windowId, overlayId)?.perView
    if (!perView) return []
    return [...perView.copies.values()].filter((c) => c.live).map((c) => ({ copy: c.id, view: c.view }))
  }

  /**
   * The open overlays of `windowId` that `pluginId` opened with notes key `key` (a store change goes to each one's
   * copies). Matched on the opener (main's record) AND the key: two plugins with one key never share notes.
   */
  overlaysWithNotes(windowId: number, pluginId: string, key: string): string[] {
    return (this.stacks.get(windowId) ?? []).filter((o) => o.notesKey === key && o.pluginId === pluginId).map((o) => o.id)
  }

  /** The overlay's notes key and its opener, when it has one (the handlers' lookup; never from a payload). */
  notesOf(windowId: number, overlayId: unknown): { pluginId: string; key: string } | undefined {
    const overlay = this.find(windowId, overlayId)
    if (!overlay?.perView || overlay.notesKey === undefined || overlay.pluginId === undefined) return undefined
    return { pluginId: overlay.pluginId, key: overlay.notesKey }
  }

  /**
   * Ask (shared/design.md §5, task 02): the opener's `onAsk` answer about the asking copy (`{ text }` or null, the
   * host's first-text rule), or undefined when the overlay is gone, of another window or not perView, the copy is not
   * live in `view`, or the opener set no handler. A part is asked the same way on its own overlay id. The caller bounds
   * the wait (ASK_CONTEXT_MS); a rejection is the handler's.
   */
  askContext(windowId: number, overlayId: string, view: ViewId, copy: string): Promise<unknown> {
    const overlay = this.find(windowId, overlayId)
    const c = typeof copy === 'string' ? overlay?.perView?.copies.get(copy) : undefined
    const onAsk = overlay?.channel?.onAsk
    if (!overlay?.channel || !onAsk || c?.live !== true || c.view !== view) return Promise.resolve(undefined)
    const channel = overlay.channel
    return Promise.resolve().then(() => onAsk.call(channel, view, copy))
  }

  /** A copy's port came up (`copyReady`), after the opener's queued posts went out. Returns the disposer. */
  onCopyReady(listener: (event: CopyEvent) => void): () => void {
    this.copyReadyListeners.add(listener)
    return () => this.copyReadyListeners.delete(listener)
  }

  /**
   * A copy is gone: released, replaced by its view's next connect, its view gone, hidden, no longer admitted, dropped
   * for an overflow (all through `dropCopy`), or the overlay closed (`finish`). Returns the disposer.
   */
  onCopyEnd(listener: (event: CopyEvent) => void): () => void {
    this.copyEndListeners.add(listener)
    return () => this.copyEndListeners.delete(listener)
  }

  private emitCopy(listeners: Set<(event: CopyEvent) => void>, overlay: Overlay, copy: OverlayCopy): void {
    const event: CopyEvent = { windowId: overlay.windowId, overlayId: overlay.id, copy: copy.id, view: copy.view }
    if (overlay.pluginId !== undefined) event.pluginId = overlay.pluginId
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (err) {
        this.log(`overlay ${overlay.id}: a copy listener failed: ${String(err)}`)
      }
    }
  }

  /**
   * Whether `url` is the page of an open html overlay a plugin opened in `windowId` (its `cc-plugin://` `info.src`;
   * the mail-frame link rule, spec-review S9). Compared by scheme, host and path (a page may set its own hash or
   * query). False for a closed overlay, another window's, an inline (`cc-overlay://`) page, a terminal or url
   * overlay, an unparsable URL, or anything that throws.
   */
  isOverlayPage(windowId: number, url: unknown): boolean {
    try {
      if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return false
      const target = new URL(url)
      if (target.protocol !== `${PLUGIN_SCHEME}:`) return false
      for (const overlay of this.byId.values()) {
        if (overlay.windowId !== windowId || overlay.info.kind !== 'html' || overlay.pluginId === undefined) continue
        const src = new URL(overlay.info.src)
        if (src.protocol === target.protocol && src.host === target.host && src.pathname === target.pathname) return true
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * Parts (design-parts.md §1): the opener announced what this overlay shows (`handle.announce`), its consent to parts.
   * Recorded for good (a new announce replaces the old one's refs, never the consent). False for an overlay that is
   * not open in this window and for a part (a part announces nothing).
   */
  markAnnounced(windowId: number, overlayId: string): boolean {
    const overlay = this.find(windowId, overlayId)
    if (!overlay || overlay.parentId !== undefined) return false
    overlay.announced = true
    return true
  }

  /**
   * What the window's onAnnounce listeners hear of an announced overlay (design-parts.md §1): main's own record, its
   * title and type, never the opener's words. Undefined unless it is open in this window and announced.
   */
  announceRecord(windowId: number, overlayId: string): { title: string; type?: { name: string; data: unknown } } | undefined {
    const overlay = this.find(windowId, overlayId)
    if (!overlay || overlay.announced !== true) return undefined
    return { title: overlay.info.title, ...(overlay.type ? { type: { name: overlay.type.name, data: overlay.type.data } } : {}) }
  }

  /**
   * Parts (design-parts.md §2): open `pluginId`'s part, an ordinary perView html overlay with a parent, in overlay
   * `parentId`. overlay-parts.ts decides (announced, not a part, html, this window's plugin, perView, no notes, one
   * per plugin, at most two); a refusal rejects before anything exists. The part's origin is its own plugin, its `via`
   * empty, and the parent's `via` never changes. `peerGone` is the part plugin's host copy: a dispose dismisses it.
   */
  attachPart(
    windowId: number,
    parentId: string,
    pluginId: string,
    spec: unknown,
    channel: OverlayChannel,
    options: PartOptions,
    peerGone?: AbortSignal
  ): Promise<OverlayResult> {
    try {
      const parent = this.find(windowId, parentId)
      const refusal = partRefusal(
        parent && {
          isPart: parent.parentId !== undefined,
          announced: parent.announced === true,
          kind: parent.info.kind,
          parts: this.partsOf(windowId, parent.id)
        },
        { pluginId, perView: options.perView === true, inHost: options.inHost === true, spec }
      )
      if (refusal !== undefined || !parent) throw new Error(refusal ?? 'overlay.part: that overlay is not open in this window')
      return this.create(windowId, spec, `plugin ${pluginId}`, peerGone, channel, pluginId, undefined, { pluginId }, { perView: true }, parent)
    } catch (err) {
      return Promise.reject(toError(err))
    }
  }

  /** Parts: the parts drawn in overlay `overlayId`, in attach order (none for a part or an unknown overlay). */
  partsOf(windowId: number, overlayId: string): OverlayPartRef[] {
    const overlay = this.find(windowId, overlayId)
    if (!overlay) return []
    const refs: OverlayPartRef[] = []
    for (const id of overlay.parts ?? []) {
      const part = this.byId.get(id)
      if (part?.pluginId !== undefined) refs.push({ overlayId: id, pluginId: part.pluginId })
    }
    return refs
  }

  /**
   * A guest hid the overlay from `viewId`: recorded under the guest (not the view, which a reconnect replaces),
   * that guest's other copies released with `overlays.hide` to their views, and the list sent again, which the
   * guest filter now drops it from for that guest. No-op for an owner's view or with no `guestOf` wired.
   */
  private recordHide(overlay: Overlay, viewId: ViewId): void {
    const perView = overlay.perView
    const guest = this.options.guestOf?.(viewId)
    if (!perView || guest === undefined || perView.hiddenFrom.has(guest)) return
    perView.hiddenFrom.add(guest)
    for (const other of [...perView.copies.values()]) if (this.options.guestOf?.(other.view) === guest) this.hideCopyRecord(overlay, other)
    this.changed(overlay.windowId)
  }

  /** hideCopy's work on a live copy: released, then `overlays.hide` to its view only (also addSources' release). */
  private hideCopyRecord(overlay: Overlay, c: OverlayCopy): void {
    // Out first: anything the page still sends for it from here on is a stale copy's, dropped.
    this.dropCopy(overlay, c)
    const payload = { overlayId: overlay.id, copy: c.id }
    try {
      if (this.options.emitToView) this.options.emitToView(c.view, 'overlays.hide', payload)
      // No per-view addressing (no web access wiring): the window's one page routes it by `copy`.
      else this.options.emit(overlay.windowId, 'overlays.hide', payload)
    } catch (err) {
      this.log(`overlay ${overlay.id}: telling view ${c.view} to hide its copy failed: ${String(err)}`)
    }
  }

  /** The perView overlay's copy `copy` if it is `viewId`'s and live (the one binding rule, §5 "Copy binding"). */
  private liveCopy(windowId: number, overlayId: unknown, viewId: ViewId, copy: unknown): { overlay: Overlay; copy: OverlayCopy } | undefined {
    if (typeof copy !== 'string') return undefined
    const overlay = this.find(windowId, overlayId)
    const c = overlay?.perView?.copies.get(copy)
    if (!overlay || !c?.live || c.view !== viewId) return undefined
    return { overlay, copy: c }
  }

  /**
   * Take a copy out (map first, `live` false, queue dropped) and then tell the opener, so a post from
   * inside its onDisconnect already finds the copy gone. No-op for a copy already out.
   */
  private dropCopy(overlay: Overlay, copy: OverlayCopy): void {
    if (!copy.live || overlay.perView?.copies.get(copy.id) !== copy) return
    overlay.perView.copies.delete(copy.id)
    const retired = overlay.perView.retired
    retired.set(copy.id, copy.view)
    for (const old of retired.keys()) {
      if (retired.size <= RETIRED_COPIES) break
      retired.delete(old)
    }
    copy.live = false
    copy.outbox.drain()
    try {
      overlay.channel?.onDisconnect?.(copy.id, copy.view)
    } catch (err) {
      this.log(`overlay ${overlay.id}: the opener's onDisconnect failed: ${String(err)}`)
    }
    // Every way a copy ends but the overlay's own end comes through here (release, replace, view gone, hide, the
    // admission re-check, overflow); finish() reports the rest.
    this.emitCopy(this.copyEndListeners, overlay, copy)
  }

  /**
   * One message for one copy: out now when its port is up, else into its outbox. Never throws. A full
   * outbox (a page that never comes up while the opener keeps posting) drops that copy and has its view
   * reload the page as a new copy, whose starting state comes from the opener's onConnect again; the
   * other copies are untouched. A ready copy whose view cannot take the event is dropped too, with no
   * reload: unlike a holder's, its queue would never be drained again (copyReady comes only once per copy).
   * That send fails only for a closed view (a browser's sink never throws: filters, oversize frames and slow
   * sockets return true or close the socket; the desktop's send throws once its page is destroyed), so a
   * reload over the same sink could never arrive; the view's next connect is a new copy.
   */
  private deliverToCopy(overlay: Overlay, copy: OverlayCopy, text: string, envelope = false): boolean {
    if (!copy.live) return false
    // Main's own pushes never wait in a copy's outbox (it holds plain texts, no mark): a copy is made ready in the same
    // step it connects (connectReady), its page lists its notes on start, and Ask's history goes at onCopyReady.
    if (envelope && !copy.ready) return false
    if (!copy.ready) {
      try {
        copy.outbox.push(text)
        return true
      } catch {
        this.log(`overlay ${overlay.id}: copy ${copy.id} of view ${copy.view} did not come up and its queue is full; reloading it`)
        this.dropCopy(overlay, copy)
        try {
          this.options.reloadCopy?.(copy.view, overlay.windowId, overlay.id, copy.id)
        } catch (err) {
          this.log(`overlay ${overlay.id}: asking view ${copy.view} to reload its copy failed: ${String(err)}`)
        }
        return false
      }
    }
    const payload: IpcEventMap['overlays.message'] = envelope
      ? { overlayId: overlay.id, message: text, copy: copy.id, envelope: true }
      : { overlayId: overlay.id, message: text, copy: copy.id }
    if (this.options.emitToView) {
      if (this.options.emitToView(copy.view, 'overlays.message', payload)) return true
      this.dropCopy(overlay, copy)
      return false
    }
    // No per-view addressing (no web access wiring): the window's one page routes it by `copy`.
    this.options.emit(overlay.windowId, 'overlays.message', payload)
    return true
  }

  /**
   * Count a connect of `viewId` against this overlay's cap (the panel ports' numbers and rule,
   * panel-ports.ts withinCap): false when over. Per view, so a phone's reload loop does not use up the
   * desktop's budget; keyed by main's view ids only, and the map goes with the overlay.
   */
  private withinCopyCap(overlay: Overlay, perView: PerViewState, viewId: ViewId): boolean {
    const now = Date.now()
    for (const [k, v] of perView.connects) if (v.times.every((t) => now - t >= CONNECT_WINDOW_MS)) perView.connects.delete(k)
    const entry = perView.connects.get(viewId) ?? { times: [], logged: false }
    entry.times = entry.times.filter((t) => now - t < CONNECT_WINDOW_MS)
    perView.connects.set(viewId, entry)
    if (entry.times.length >= MAX_CONNECTS_PER_PANEL) {
      // Once per burst: a reload loop must not turn into a log line per load.
      if (!entry.logged) {
        this.log(`overlay ${overlay.id}: more than ${MAX_CONNECTS_PER_PANEL} copy connects from view ${viewId} in ${CONNECT_WINDOW_MS / 1000} s, refusing`)
      }
      entry.logged = true
      return false
    }
    entry.times.push(now)
    entry.logged = false
    return true
  }

  /**
   * A toolbar click from the window's renderer (design-next §3.3, §3.6). Only a button main shows on
   * that overlay now, not busy (its own flag or a click still running) and not disabled: the
   * renderer drops those too, but it is not trusted, and a click can race the update that made the
   * button busy. An opener button goes to the opener's channel only, a type button to the window's
   * host, with the overlay's info; neither ever reaches the overlay's page. The button shows busy
   * until the click settles or OVERLAY_CLICK_TIMEOUT_MS passed; a type button's `{ close: true }`
   * dismisses the overlay. After it, the type buttons are asked again (labels follow state). True
   * when the click went out. `viewId`: the view that clicked (the router's caller); a remote one is
   * handed to the plugin so what its handler opens or focuses shows on that screen (origin-view.ts).
   */
  buttonClick(windowId: number, overlayId: string, click: OverlayButtonClick, viewId?: ViewId): boolean {
    const overlay = this.find(windowId, overlayId)
    if (!overlay) return false
    const view = viewId !== undefined && isRemoteViewId(viewId) ? viewId : undefined
    const key = clickKey(click)
    if (overlay.running.has(key)) return false
    let run: () => Promise<unknown>
    if (click.source === 'opener') {
      const button = overlay.openerButtons.find((b) => b.id === click.buttonId)
      const onButton = overlay.channel?.onButton
      if (!button || button.busy || button.disabled || !onButton) return false
      run = () => onButton.call(overlay.channel, click.buttonId, view)
    } else {
      const button = overlay.typeButtons.find((b) => b.pluginId === click.pluginId && b.id === click.buttonId)
      const source = this.options.typeButtons?.(windowId)
      const query = this.typeQuery(overlay)
      if (!button || button.busy || button.disabled || !source || !query || overlay.buttonsKey === undefined) return false
      const buttonsKey = overlay.buttonsKey
      run = () => source.click(buttonsKey, click.pluginId, click.buttonId, query, view)
    }
    overlay.running.add(key)
    this.publishButtons(overlay)
    const what = `overlay ${overlay.id}: button ${key}`
    // Sent now, in this call (a run that throws at once is a failed click like any other).
    let sent: Promise<unknown>
    try {
      sent = Promise.resolve(run())
    } catch (err) {
      sent = Promise.reject(toError(err))
    }
    void within(sent, OVERLAY_CLICK_TIMEOUT_MS, `${what} took longer than ${OVERLAY_CLICK_TIMEOUT_MS / 1000} s`)
      .then((answer) => {
        const close = click.source === 'type' && (answer as { close?: unknown } | null)?.close === true
        if (close) this.finish(overlay, { kind: 'dismissed' })
      })
      .catch((err: unknown) => this.log(`${what} failed: ${toError(err).message}`))
      .finally(() => {
        overlay.running.delete(key)
        if (this.byId.get(overlay.id) !== overlay) return
        this.publishButtons(overlay)
        this.askTypeButtons(overlay)
      })
    return true
  }

  /**
   * The opener replaces its buttons (handle.setButtons; HostApi found the overlay by plugin and
   * handle). Checked again here, as in a spec. False for an overlay that is gone or of another
   * window; throws for a bad list. The type buttons are asked again after it.
   */
  setButtons(windowId: number, overlayId: string, buttons: unknown): boolean {
    const overlay = this.find(windowId, overlayId)
    // A part draws no toolbar (design-parts.md §2): its buttons go nowhere.
    if (!overlay || overlay.parentId !== undefined) return false
    overlay.openerButtons = parseOverlayButtons(buttons)
    this.publishButtons(overlay)
    this.askTypeButtons(overlay)
    return true
  }

  /**
   * Ask the window's host again for the type buttons of every typed overlay of the window (a
   * plugin's ctx ended: its buttons leave the toolbars).
   */
  refreshTypeButtons(windowId: number): void {
    for (const overlay of this.stacks.get(windowId) ?? []) this.askTypeButtons(overlay)
  }

  /**
   * The opener registered its first `onDiscuss` handler (`on`), or disposed its last one (HostApi
   * found the overlay by plugin and handle). Discuss shows or goes with it, unless the overlay has a
   * type (shown anyway) or its spec said `discuss: false` (never). False for an overlay that is gone.
   */
  setDiscussHandler(windowId: number, overlayId: string, on: boolean): boolean {
    const overlay = this.find(windowId, overlayId)
    if (!overlay) return false
    if (overlay.discussHandler === (on === true)) return true
    overlay.discussHandler = on === true
    overlay.info = withDiscuss(overlay.info, overlay)
    this.changed(windowId)
    return true
  }

  /**
   * The opener draws Discuss as the primary button or plain (handle.setDiscussPrimary). Kept while
   * Discuss is hidden, so it applies when it shows. False for an overlay that is gone.
   */
  setDiscussPrimary(windowId: number, overlayId: string, on: boolean): boolean {
    const overlay = this.find(windowId, overlayId)
    if (!overlay) return false
    if ((overlay.discussPrimary === true) === (on === true)) return true
    overlay.discussPrimary = on === true
    overlay.info = withDiscuss(overlay.info, overlay)
    this.changed(windowId)
    return true
  }

  /**
   * Discuss with Claude's Send, from the window's renderer (design-next §3.5, §3.6). The renderer
   * is not trusted: the overlay must show Discuss, and a tab
   * target must be a Claude tab of this window, checked when the request arrives and again just
   * before the send (the context ask may take seconds, the tab may close meanwhile). The opener's
   * `onDiscuss` answers within DISCUSS_ASK_MS; a throw or a timeout is the answer's error and nothing
   * is sent. Then the text (discuss.ts) goes through the send gate, or opens a new session in the
   * project folder (DiscussSessionBudget: 5 a minute per window), the overlay closes as
   * `{ kind: 'discussed', tabId, queued }` and the tab is selected in the window (an overlay
   * dismissed while the new session opens has already answered `dismissed`). Never rejects.
   *
   * `viewId`: the view whose Send it was (the router's caller, never a payload's): the opener's
   * `onDiscuss` hears it, an owner's browser included (it used to act as the desktop). Absent: a
   * guest's own view, else the desktop's. Which view selects the tab afterwards stays `guest`'s rule.
   *
   * A guest's Discuss is re-checked after every await, right before the send (codex review, finding 3): still this
   * write guest and the overlay still visible to it (`guest.seesOverlay`, the one overlay rule over the access read
   * live). While the opener was asked, `via` may have grown with a plugin hidden from the guest (its copy released,
   * addSources), and the context that comes back is that plugin's: it must not reach a shared tab. A guest with no
   * `seesOverlay` is refused (fail closed), in the one text that names no plugin.
   */
  async discuss(windowId: number, overlayId: string, target: DiscussTarget, guest?: DiscussGuest, viewId?: ViewId): Promise<DiscussAnswer> {
    const overlay = this.find(windowId, overlayId)
    if (!overlay?.info.discuss) return { ok: false, error: 'Discuss is not available on this overlay' }
    const sessions = this.options.discuss
    if (!sessions) return { ok: false, error: 'Discuss is not available' }
    const guestSees = (): boolean => {
      if (guest === undefined) return true
      try {
        return guest.seesOverlay?.() === true
      } catch {
        return false
      }
    }
    if (!guestSees()) return { ok: false, error: GUEST_DISCUSS_REFUSED }
    // Checked again after the opener answered: the tab may have closed (or restarted) meanwhile.
    const early = discussTargetProblem(sessions, windowId, target)
    if (early) return { ok: false, error: early }
    if (overlay.discussing) return { ok: false, error: 'Already sending' }
    overlay.discussing = true
    try {
      const caller = viewId ?? guest?.viewId
      const view = caller !== undefined && isRemoteViewId(caller) ? caller : undefined
      // The view whose Send it is (the desktop's when the router named none): a part's text is asked only when this
      // view holds a live copy of the part (design-parts.md §5), so nothing reaches Claude that this view is not shown.
      const acting = caller ?? desktopViewId(windowId)
      // Started together with the opener's ask, awaited after it: the notes (task 03) and the parts' texts.
      // Only awaited when there is something to read, so an overlay with neither keeps the steps it always had.
      const notesRead = this.notesOf(windowId, overlay.id) && this.options.notes?.(windowId) ? this.readDiscussNotes(windowId, overlay) : undefined
      const partsRead = this.partsOf(windowId, overlay.id).length > 0 ? this.askParts(windowId, overlay, acting, view) : undefined
      let context: string | undefined
      if (overlay.discussHandler && overlay.channel?.onDiscuss) {
        const onDiscuss = overlay.channel.onDiscuss.bind(overlay.channel)
        const ask = (): Promise<unknown> => onDiscuss(view)
        let answer: unknown
        let failed: string | undefined
        try {
          answer = await within(Promise.resolve().then(ask), DISCUSS_ASK_MS, `onDiscuss took longer than ${DISCUSS_ASK_MS / 1000} s`)
        } catch (err) {
          failed = toError(err).message
        }
        // Before any reply content (second codex review, finding 3): the overlay may have closed, and a guest's
        // right to it is read again first, so a guest who lost it hears the access refusal and nothing else.
        if (this.byId.get(overlay.id) !== overlay) return { ok: false, error: 'The overlay closed' }
        if (!guestSees()) return { ok: false, error: GUEST_DISCUSS_REFUSED }
        if (failed !== undefined) {
          // The plugin's error is its own words (an ENOENT naming an absolute path): the owner reads it, a guest
          // gets a fixed text (D-33) and the log keeps the detail.
          if (guest === undefined) return { ok: false, error: `${this.openerName(overlay)} could not give its context: ${failed}` }
          this.log(`overlay ${overlay.id}: a guest's Discuss got no context: ${failed}`)
          return { ok: false, error: GUEST_DISCUSS_CONTEXT_FAILED }
        }
        const parsed = discussContextOf(answer)
        if (!parsed) {
          // Fixed for a guest too: an overlay it sees through a shared tab may have an opener hidden from it, never named.
          if (guest !== undefined) return { ok: false, error: GUEST_DISCUSS_CONTEXT_FAILED }
          return { ok: false, error: `${this.openerName(overlay)} answered Discuss with something other than { text } or null` }
        }
        context = parsed.context
      }
      const notesGot = notesRead === undefined ? undefined : await notesRead
      const parts = partsRead === undefined ? [] : await partsRead
      // The overlay may have closed while the opener was asked: nothing to discuss any more.
      if (this.byId.get(overlay.id) !== overlay) return { ok: false, error: 'The overlay closed' }
      // A guest's right to the overlay, again after the opener's await (its context may be a hidden plugin's now).
      if (!guestSees()) return { ok: false, error: GUEST_DISCUSS_REFUSED }
      // Notes that could not be read refuse the send: going without them would drop the person's notes silently.
      if (notesGot === 'failed') return { ok: false, error: 'Not sent: the notes could not be read' }
      // A part whose copy left this view while it was asked is left out (its text is no longer shown here).
      const shown = parts.filter((p) => this.copiesOf(windowId, p.overlayId).some((c) => c.view === acting))
      let text: string
      try {
        text = composeDiscuss({
          title: overlay.info.title,
          type: overlay.type,
          context,
          prompt: sessions.prompt?.(windowId),
          ...(notesGot ? { notes: notesGot.notes } : {}),
          ...(shown.length > 0 ? { parts: shown.map((p) => ({ name: p.name, text: p.text })) } : {})
        })
      } catch (err) {
        if (err instanceof DiscussTooLong) return { ok: false, error: err.message }
        throw err
      }
      // Removes the notes this text carries, once it is delivered (S3): only those still at their sent rev.
      const removeSent = (): void => {
        if (!notesGot || !notesGot.carries) return
        const { store, pluginId, key, sent } = notesGot
        void store.api.removeSent?.(store.projectId, pluginId, key, sent).catch((err: unknown) => {
          this.log(`overlay ${overlay.id}: removing the sent notes failed: ${String(err)}`)
        })
      }
      const late = discussTargetProblem(sessions, windowId, target)
      if (late) return { ok: false, error: late }
      // And in the same synchronous step as the send: deliverDiscuss asks `allowed` right before it sends or opens.
      const checked: DiscussGuest | undefined =
        guest === undefined
          ? undefined
          : {
              id: guest.id,
              viewId: guest.viewId,
              allowed: (to) => guestSees() && guest.allowed(to),
              // The new session's open awaits (seconds): the owner may hide the opener meanwhile, and the router's
              // own re-check after it reads only the project and the role (second codex review, finding 2). So the
              // overlay is read again as soon as the tab exists, before the router notes it as the guest's: a guest
              // who lost the overlay never gets the tab, which holds the overlay's text. It was made for this request
              // and nobody has typed in it: closed, and the Discuss refused (below).
              openTab: (liveTabs, create, idOf, close) =>
                guest.openTab(
                  liveTabs,
                  async () => {
                    const tab = await create()
                    if (tab !== null && !guestSees()) {
                      close(idOf(tab))
                      throw new GuestDiscussLost()
                    }
                    return tab
                  },
                  idOf,
                  close
                )
            }
      // A queued text: the notes go when the gate types it in, and stay when it is dropped (S3). No settle signal wired:
      // they stay (fail closed).
      const onQueued = (itemId: string): void => {
        if (notesGot && notesGot.carries) sessions.onSettled?.(itemId, (how) => (how === 'delivered' ? removeSent() : undefined))
      }
      const sent = await deliverDiscuss(sessions, this.discussSessions, windowId, target, text, checked, onQueued)
      if (!sent.ok) return sent
      const { tabId, queued } = sent
      // Again once a guest's new session is open, before the overlay closes as discussed and the tab is selected: one
      // whose overlay went in the last step is closed too (nothing awaits between here and the end). Not for a tab
      // target: its text went through the gate in deliverDiscuss's synchronous check-and-send, it cannot be taken back,
      // and "not sent" would be untrue.
      if (guest !== undefined && target.kind === 'new' && !guestSees()) {
        try {
          sessions.closeTab?.(windowId, tabId)
        } catch (err) {
          this.log(`overlay ${overlay.id}: closing the refused Discuss session ${tabId} failed: ${String(err)}`)
        }
        return { ok: false, error: GUEST_DISCUSS_REFUSED }
      }
      // Typed in now (a waiting tab) or the new session's first prompt (it opened with the text): the notes go now.
      if (target.kind === 'new' || !queued) removeSent()
      // The person may dismiss the overlay while a new session opens. The session already has the
      // text and cannot be taken back, so it is still selected and the answer is still ok, but the
      // opener has heard `dismissed` (finish below is a no-op): a reviewer-style opener keeps a draft
      // it would have cleared on `discussed`. Logged so the mismatch is traceable.
      if (target.kind === 'new' && this.byId.get(overlay.id) !== overlay) {
        this.log(`overlay ${overlay.id}: closed while its Discuss session ${tabId} opened; the opener heard dismissed`)
      }
      this.finish(overlay, { kind: 'discussed', tabId, queued })
      try {
        if (guest === undefined) sessions.selectTab(windowId, tabId)
        else sessions.selectTab(windowId, tabId, guest.viewId)
      } catch (err) {
        this.log(`overlay ${overlay.id}: selecting tab ${tabId} failed: ${String(err)}`)
      }
      return { ok: true, tabId, queued }
    } finally {
      overlay.discussing = false
    }
  }

  /**
   * Discuss's notes part (task 03): the overlay's notes as they are now, the ones that go into the text, and what to
   * remove once it is delivered. Undefined: the overlay has no notes key or there is no service (no part). 'failed':
   * the read threw, and the send is refused.
   */
  private async readDiscussNotes(
    windowId: number,
    overlay: Overlay
  ): Promise<
    | undefined
    | 'failed'
    | { store: { api: NotesApi; projectId: string }; pluginId: string; key: string; notes: DiscussNotes; sent: SentNotes; carries: boolean }
  > {
    const of = this.notesOf(windowId, overlay.id)
    if (!of) return undefined
    const store = this.options.notes?.(windowId)
    if (!store) return undefined
    let snapshot: NotesSnapshot
    try {
      snapshot = await store.api.list(store.projectId, of.pluginId, of.key)
    } catch (err) {
      this.log(`overlay ${overlay.id}: reading its notes for Discuss failed: ${String(err)}`)
      return 'failed'
    }
    // The notes the text prints (discuss.ts notesPart leaves out one with neither quote nor text), and only those are
    // removed after delivery.
    const notes = snapshot.notes.filter((note) => note.quote.trim() !== '' || note.text.trim() !== '')
    const global = snapshot.global.trim() !== '' ? snapshot.global : ''
    return {
      store,
      pluginId: of.pluginId,
      key: of.key,
      notes: { notes: notes.map((note) => ({ quote: note.quote, text: note.text, author: note.author })), global, pluginName: this.openerName(overlay) },
      sent: { global, notes: notes.map((note) => ({ id: note.id, rev: note.rev })) },
      carries: notes.length > 0 || global !== ''
    }
  }

  /**
   * The parts' Discuss texts (design-parts.md §5): each part of the overlay that has a live copy in `acting` and an
   * `onDiscuss`, asked with the same view and deadline as the opener. A null, a throw, a timeout or another shape
   * leaves that part out; it never fails the send.
   */
  private async askParts(
    windowId: number,
    overlay: Overlay,
    acting: ViewId,
    view: ViewId | undefined
  ): Promise<{ overlayId: string; name: string; text: string }[]> {
    const asks = this.partsOf(windowId, overlay.id).map(async (ref) => {
      const part = this.find(windowId, ref.overlayId)
      if (!part || !part.discussHandler || !part.channel?.onDiscuss) return undefined
      if (!this.copiesOf(windowId, ref.overlayId).some((c) => c.view === acting)) return undefined
      const onDiscuss = part.channel.onDiscuss.bind(part.channel)
      try {
        const answer = await within(
          Promise.resolve().then(() => onDiscuss(view)),
          DISCUSS_ASK_MS,
          `onDiscuss took longer than ${DISCUSS_ASK_MS / 1000} s`
        )
        const parsed = discussContextOf(answer)
        if (!parsed || parsed.context === undefined) return undefined
        return { overlayId: ref.overlayId, name: this.openerName(part), text: parsed.context }
      } catch (err) {
        this.log(`overlay ${overlay.id}: part ${ref.overlayId} gave no Discuss text: ${toError(err).message}`)
        return undefined
      }
    })
    return (await Promise.all(asks)).filter((p): p is { overlayId: string; name: string; text: string } => p !== undefined)
  }

  /** The window closed: every overlay it had is dismissed. */
  closeWindow(windowId: number): void {
    for (const overlay of [...(this.stacks.get(windowId) ?? [])].reverse()) {
      this.finish(overlay, { kind: 'dismissed' }, false)
    }
    this.stacks.delete(windowId)
    this.lastTop.delete(windowId)
    this.discussSessions.forget(windowId)
  }

  /** Who opened it, for an error the person reads: the plugin's title, else "The opener". */
  private openerName(overlay: Overlay): string {
    if (overlay.pluginId === undefined) return 'The opener'
    return this.options.pluginTitle?.(overlay.pluginId) ?? overlay.pluginId
  }

  /** App quit: dismiss everything and kill every program. */
  disposeAll(): void {
    for (const windowId of [...this.stacks.keys()]) this.closeWindow(windowId)
    this.pty.disposeAll()
  }

  /**
   * The overlay's body is ready: its loader goes. Once; a no-op for an overlay that already ended
   * (a url view's late load event, output of a program being ended).
   */
  private loaded(overlay: Overlay): void {
    if (this.byId.get(overlay.id) !== overlay || !overlay.info.loading) return
    const info = { ...overlay.info }
    delete info.loading
    overlay.info = info
    // A url view stays hidden while it loads (it would paint a blank page over the loader, a native
    // view is always above the renderer): show it now if it is on top, and give it the keyboard.
    const top = this.stacks.get(overlay.windowId)?.at(-1)
    this.changed(overlay.windowId)
    if (overlay.view && top === overlay) overlay.view.focus()
  }

  /** The overlay as a type-button provider sees it; undefined for an overlay without a type. */
  private typeQuery(overlay: Overlay): OverlayTypeQuery | undefined {
    if (!overlay.type) return undefined
    const opener = overlay.pluginId ?? (overlay.opener === 'cli' ? 'cli' : 'core')
    return { type: overlay.type, title: overlay.info.title, opener }
  }

  /**
   * Ask the window's host for a typed overlay's type buttons. Only the newest answer is applied,
   * and only while the overlay is open; a failed ask keeps what shows (logged).
   */
  private askTypeButtons(overlay: Overlay): void {
    const query = this.typeQuery(overlay)
    const source = this.options.typeButtons?.(overlay.windowId)
    if (!query || !source || overlay.buttonsKey === undefined) return
    const ask = ++overlay.typeAsk
    let pending: Promise<CleanTypeButton[]>
    try {
      pending = source.list(overlay.buttonsKey, query)
    } catch (err) {
      this.log(`overlay ${overlay.id}: asking for type buttons failed: ${String(err)}`)
      return
    }
    pending.then(
      (buttons) => {
        if (this.byId.get(overlay.id) !== overlay || overlay.typeAsk !== ask) return
        overlay.typeButtons = buttons
        this.publishButtons(overlay)
      },
      (err: unknown) => this.log(`overlay ${overlay.id}: asking for type buttons failed: ${toError(err).message}`)
    )
  }

  /** Rebuild the overlay's button infos (a running click shows busy) and tell the renderer. */
  private publishButtons(overlay: Overlay): void {
    const busy = (b: CleanOverlayButton, key: string): CleanOverlayButton => (overlay.running.has(key) ? { ...b, busy: true } : b)
    const info = { ...overlay.info }
    const opener = overlay.openerButtons.map((b) => busy(b, `opener/${b.id}`))
    if (opener.length > 0) info.buttons = buttonInfos(opener, overlay.pluginId)
    else delete info.buttons
    if (overlay.typeButtons.length > 0) {
      info.typeButtons = overlay.typeButtons.map((b) => {
        const { pluginId, ...button } = b
        const [shown] = buttonInfos([busy(button, `type/${pluginId}/${b.id}`)], pluginId)
        return { ...shown!, pluginId, pluginTitle: this.options.pluginTitle?.(pluginId) ?? pluginId }
      })
    } else delete info.typeButtons
    overlay.info = info
    this.changed(overlay.windowId)
  }

  private find(windowId: number, overlayId: unknown): Overlay | undefined {
    if (typeof overlayId !== 'string') return undefined
    const overlay = this.byId.get(overlayId)
    return overlay && overlay.windowId === windowId ? overlay : undefined
  }

  /**
   * Settle and remove. The only way out of the stack, so "exactly one result" holds: an overlay
   * is in `byId` until here, and everything that could settle it looks it up there first.
   */
  private finish(overlay: Overlay, result: OverlayResult, notify = true): void {
    if (this.byId.get(overlay.id) !== overlay) return
    // A parent's parts end first (their openers hear `dismissed` before the parent's does), with no list of their own.
    for (const id of [...(overlay.parts ?? [])]) {
      const part = this.byId.get(id)
      if (part) this.finish(part, { kind: 'dismissed' }, false)
    }
    overlay.parts = []
    if (overlay.parentId !== undefined) {
      const parent = this.byId.get(overlay.parentId)
      if (parent?.parts) parent.parts = parent.parts.filter((id) => id !== overlay.id)
    }
    this.byId.delete(overlay.id)
    overlay.unlinkPeer?.()
    overlay.unlinkPeer = undefined
    // Posts still waiting for a page that never loaded go nowhere; the opener hears the result.
    overlay.outbox.drain()
    // Its copies end with it, with no disconnects: the opener's handle ends here and hears the result.
    if (overlay.perView) {
      const ended = [...overlay.perView.copies.values()]
      for (const copy of ended) {
        copy.live = false
        copy.outbox.drain()
      }
      overlay.perView.copies.clear()
      overlay.perView.connects.clear()
      // No opener disconnects here, but main's own services (an Ask chat of the copy) must hear each copy end.
      for (const copy of ended) this.emitCopy(this.copyEndListeners, overlay, copy)
    }
    overlay.channel = undefined
    // The host forgets the type buttons' runs (a click still running there finds the overlay gone).
    if (overlay.buttonsKey !== undefined) {
      try {
        this.options.typeButtons?.(overlay.windowId)?.ended(overlay.buttonsKey)
      } catch (err) {
        this.log(`overlay ${overlay.id}: telling the host it ended failed: ${String(err)}`)
      }
    }
    const stack = this.stacks.get(overlay.windowId)
    if (stack) {
      const i = stack.indexOf(overlay)
      if (i >= 0) stack.splice(i, 1)
      if (stack.length === 0) this.stacks.delete(overlay.windowId)
    }
    // A program still running is asked to end; its exit then finds no overlay and is dropped.
    // One that is still there after the grace period is killed outright (PtyService.terminate).
    if (overlay.info.kind === 'terminal') {
      this.sizes.forget(overlay.id)
      this.pty.terminate(overlay.id)
    }
    if (overlay.view) {
      try {
        overlay.view.destroy()
      } catch (err) {
        this.log(`overlay ${overlay.id}: destroying its view failed: ${String(err)}`)
      }
    }
    this.log(`overlay ${overlay.id} (${overlay.info.kind}, opened by ${overlay.opener}): ${result.kind}`)
    overlay.settle(result)
    if (notify) this.changed(overlay.windowId)
  }

  /** After a push or a removal: native views, focus and the renderer follow the new stack. */
  private changed(windowId: number): void {
    const stack = this.stacks.get(windowId) ?? []
    const top = stack.at(-1)
    // A url view still loading stays hidden: its blank page would cover the renderer's loader.
    for (const o of stack) o.view?.setVisible(o === top && !o.info.loading)
    const before = this.lastTop.get(windowId)
    if (top) this.lastTop.set(windowId, top)
    else this.lastTop.delete(windowId)
    // Emitted before the focus moves: main's listener hides the window's webview panels while the
    // stack is not empty, and hiding one that had the keyboard hands it to the shell page
    // (webview-manager.ts apply). Focusing the url view first left a `ccc overlay --url` login
    // form opened over a visible browser panel with no keystrokes (review finding, ext round 8).
    this.options.emit(windowId, 'overlays.updated', this.infos(windowId))
    if (top !== before) {
      if (top?.view) top.view.focus()
      // A url view had the keyboard and is gone or covered: give it back to the window's page.
      else if (before?.view) this.options.views.focusWindow(windowId)
    }
  }
}

/**
 * `info` with `discuss` as the overlay's state says (design-next §3.5): shown for an overlay with a
 * type or an onDiscuss handler, unless its spec said `discuss: false`; a bare overlay has none.
 */
function withDiscuss(
  info: OverlayInfo,
  overlay: Pick<Overlay, 'type' | 'discussHandler' | 'discussSpec' | 'discussPrimary'>
): OverlayInfo {
  const next = { ...info }
  delete next.discuss
  if (overlay.discussSpec === false || (!overlay.type && !overlay.discussHandler)) return next
  const tabId = overlay.discussSpec?.tabId
  next.discuss = tabId === undefined ? {} : { tabId }
  if (overlay.discussPrimary) next.discuss.primary = true
  return next
}

/**
 * A page's result as the opener gets it: copied through JSON (plain data, at most MAX_RESULT_BYTES),
 * undefined when it has no JSON form or is too large. `undefined` (or a function) is "nothing": null.
 */
function resultValue(value: unknown): { value: unknown } | undefined {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    return undefined
  }
  json ??= 'null'
  if (json.length > MAX_RESULT_BYTES) return undefined
  return { value: JSON.parse(json) as unknown }
}

function stateOf(copy: OverlayCopy): CopyState {
  return { copy: copy.id, view: copy.view, joined: copy.joined, ready: copy.ready, loaded: copy.loaded }
}

/** The renderer's view of an overlay; an html page stays in main and is served at `src`. */
function infoOf(id: string, spec: OverlaySpec, pluginId: string | undefined): OverlayInfo {
  const size = spec.size ?? 'default'
  const info: OverlayInfo = { ...infoBody(id, spec), size, loading: true }
  if (spec.buttons && spec.buttons.length > 0) info.buttons = buttonInfos(spec.buttons, pluginId)
  return info
}

/**
 * Buttons as the renderer draws them: a core icon by name, a plugin `.svg` as that plugin's
 * `cc-plugin://` URL (the panel header's rule). An opener with no plugin (the CLI) has no folder,
 * so its `.svg` icon is dropped and the label shows alone.
 */
export function buttonInfos(buttons: readonly CleanOverlayButton[], pluginId: string | undefined): OverlayButtonInfo[] {
  return buttons.map((b) => {
    const { icon, ...rest } = b
    if (icon === undefined) return { ...rest }
    if (isPanelHeaderIcon(icon)) return { ...rest, icon }
    return pluginId === undefined ? { ...rest } : { ...rest, iconSrc: pluginFileUrl(pluginId, icon) }
  })
}

function infoBody(id: string, spec: OverlaySpec): OverlayInfoBody {
  switch (spec.kind) {
    case 'terminal':
      return { id, kind: 'terminal', title: spec.title ?? clip(spec.argv.join(' ')) }
    case 'url':
      return { id, kind: 'url', title: spec.title ?? clip(spec.url), url: spec.url }
    case 'html':
      return {
        id,
        kind: 'html',
        title: spec.title ?? 'Overlay',
        src: 'src' in spec ? spec.src : `${OVERLAY_SCHEME}://${id}/`
      }
  }
}

function clip(text: string): string {
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text
}

/**
 * Check a spec from an untrusted caller and return a clean copy (only the known fields). Throws
 * with the reason for anything else.
 */
export function parseOverlaySpec(spec: unknown, context: OverlayExtrasContext = {}): OverlaySpec {
  if (typeof spec !== 'object' || spec === null) throw new Error('overlay: spec must be an object')
  const s = spec as Record<string, unknown>
  const title = s.title
  if (title !== undefined && (typeof title !== 'string' || title.length > MAX_TITLE_LENGTH)) {
    throw new Error(`overlay: title must be a string of at most ${MAX_TITLE_LENGTH} characters`)
  }
  const size = s.size
  if (size !== undefined && !OVERLAY_SIZES.includes(size as OverlaySize)) {
    throw new Error(`overlay: size must be ${OVERLAY_SIZES.join(', ')}`)
  }
  // An unknown kind is refused by the switch below.
  const extras = s.kind === 'terminal' || s.kind === 'url' || s.kind === 'html' ? parseOverlayExtras(s, s.kind, context) : {}
  const withTitle = <T extends object>(o: T): T => {
    const withExtras = { ...o, ...extras }
    const withSize = size === undefined ? withExtras : { ...withExtras, size: size as OverlaySize }
    return title === undefined ? withSize : { ...withSize, title }
  }
  switch (s.kind) {
    case 'terminal':
      return withTitle({ kind: 'terminal', argv: argvOf(s.argv), cwd: cwdOf(s.cwd) })
    case 'url':
      return withTitle({ kind: 'url', url: overlayUrlOf(s.url) })
    case 'html': {
      // Either inline content (served from memory at cc-overlay://) or a plugin page's URL.
      if (s.src !== undefined) {
        if (s.html !== undefined) throw new Error('overlay: html and src exclude each other')
        return withTitle({ kind: 'html', src: pluginPageUrlOf(s.src) })
      }
      if (typeof s.html !== 'string') throw new Error('overlay: html must be a string')
      if (Buffer.byteLength(s.html) > MAX_HTML_BYTES) throw new Error('overlay: html is too large')
      return withTitle({ kind: 'html', html: s.html })
    }
    default:
      throw new Error('overlay: kind must be terminal, url or html')
  }
}

/**
 * A `cc-plugin://<id>/<path>` URL and nothing else: the renderer loads it in a sandboxed iframe,
 * and the protocol handler decides what (if anything) it serves. Anything else (http, file:,
 * javascript:) would load something other than a plugin's own page in the overlay frame.
 */
function pluginPageUrlOf(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) throw new Error('overlay: src must be a string')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('overlay: src is not a valid URL')
  }
  if (parsed.protocol !== `${PLUGIN_SCHEME}:` || parsed.hostname === '') throw new Error('overlay: src must be a plugin page')
  return parsed.href
}

/**
 * argv[0] is the program and the rest its arguments, never run through a shell (CLAUDE.md). NUL
 * cannot appear in an exec argument; it would be cut there silently, so it is refused.
 */
function argvOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('overlay: argv must be a non-empty array of strings')
  }
  if (value.length > MAX_ARGV_ENTRIES) throw new Error('overlay: argv has too many entries')
  let chars = 0
  for (const arg of value) {
    if (typeof arg !== 'string') throw new Error('overlay: argv must be a non-empty array of strings')
    if (arg.includes('\0')) throw new Error('overlay: argv entries must not contain NUL')
    chars += arg.length
  }
  if ((value[0] as string) === '') throw new Error('overlay: argv[0] must name a program')
  if (chars > MAX_ARGV_CHARS) throw new Error('overlay: argv is too long')
  return [...(value as string[])]
}

/**
 * An absolute path to an existing directory. Not confined to the project here: the caller already
 * picks the program to run (and could `cd` anywhere with it), and `ccc overlay` may be run from
 * any folder. The opener (Task 21 / Task 27) supplies the project folder as the default; a
 * plugin's cwd is confined to its project folder before it gets here (host-api.ts managerSpec).
 */
function cwdOf(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error('overlay: cwd must be an absolute path')
  }
  let isDir = false
  try {
    isDir = statSync(value).isDirectory()
  } catch {
    // Missing: reported below like a file.
  }
  if (!isDir) throw new Error('overlay: cwd is not a directory')
  return value
}

/**
 * Only http and https: `file:` would show local files in a page that has network access,
 * `javascript:` / `data:` would run caller-supplied script, and an app scheme would launch another
 * program. Checked here, before any view exists. The normalized `href` is returned, so what is
 * checked is exactly what is loaded.
 */
export function overlayUrlOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new Error('overlay: url must be a non-empty string')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('overlay: not a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('overlay: only http and https URLs are opened')
  }
  return parsed.href
}

/**
 * "Another site" for a url overlay: a different host name. Scheme and port are ignored so
 * http -> https upgrades and dev servers on another port stay in the overlay. A target that is
 * not http(s) is never the same site, whatever its host (`ftp://same.host`, `someapp://same.host`
 * must not load in the view), and anything that does not parse is another site too (so it goes
 * nowhere near the view).
 */
export function sameSite(current: string, target: string): boolean {
  try {
    const to = new URL(target)
    if (to.protocol !== 'http:' && to.protocol !== 'https:') return false
    return new URL(current).hostname === to.hostname
  } catch {
    return false
  }
}

/** The fields of an Electron `Input` (before-input-event) that decide a chord. */
export interface InputLike {
  type: string
  key: string
  code: string
  shift: boolean
  control: boolean
  alt: boolean
  meta: boolean
  isAutoRepeat: boolean
}

/**
 * The chord of a key typed into a page main watches, or null when it cannot be an overlay key:
 * not a key press, or an auto-repeat (holding Esc must not pop the whole stack).
 */
export function chordOfInput(input: InputLike): string | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return null
  return chordFromEvent({
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    altKey: input.alt,
    shiftKey: input.shift,
    metaKey: input.meta
  })
}
