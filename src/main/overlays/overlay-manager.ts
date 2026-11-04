// The overlay stack of every project window (design §4). main owns it: plugins (Task 27) and the
// CLI (Task 21) ask for an overlay, the renderer only draws what main tells it and reports the ✕
// button, keys and a page's value back. Each `open` hands its caller a promise that settles
// exactly once, with what the overlay ended in:
//   terminal  { kind: 'exit', code }    the program ended (the overlay closes with it)
//   html      { kind: 'value', value }  the page posted a result through its MessagePort (inline
//                                        pages; a plugin's page posts `{ result }` with panel.js)
//   any       { kind: 'dismissed' }     ✕, Esc, Cmd+Shift+W, the window closed, the app quit
//
// Messages (ctx.overlay.start, friction round 1 Task 13): an opener that passes an OverlayChannel
// talks to an html overlay's page while it is open. `post` goes to the page (queued here until the
// renderer says the page's port is up: `pageReady`), and what the page posts without a `result`
// key comes back through `pageMessage` to that channel only. The channel is the opener's own
// callback, kept on the overlay record: nothing a renderer sends can name another receiver, and a
// page can only reach the record through an id of its own window's stack.
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
import { toError } from '../../shared/error-text'
import {
  OVERLAY_SIZES,
  type EventChannel,
  type IpcEventMap,
  type OverlayButtonInfo,
  type OverlayInfo,
  type OverlayInfoBody,
  type OverlayKind,
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
  type CleanTypeButton
} from '../../shared/overlay-buttons'
import { MAX_OVERLAY_MESSAGE_LENGTH } from '../../shared/overlay-message'
import { isPanelHeaderIcon } from '../../shared/panel-header'
import { PLUGIN_SCHEME, pluginFileUrl } from '../plugins/plugin-protocol'
import { exitStatus, type PtyBackend } from '../pty/pty-backend'
import { PtyService } from '../pty/pty-service'

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
  log?: (message: string) => void
}

/** What a type-button provider is told about an overlay (the SDK's OverlayInfo). */
export interface OverlayTypeQuery {
  type: CleanOverlayType
  title: string
  /** The opening plugin's id, `cli` or `core`. */
  opener: string
}

/**
 * The window's host side of type buttons. `key` is the overlay's buttons key (minted here, not its
 * id, which never leaves main). Each answer was checked by HostApi: plugins of that host only.
 */
export interface OverlayTypeButtons {
  list(key: string, query: OverlayTypeQuery): Promise<CleanTypeButton[]>
  /** Run one; `close` when its run answered `{ close: true }`. */
  click(key: string, pluginId: string, buttonId: string, query: OverlayTypeQuery): Promise<{ close: boolean }>
  /** The overlay went: the host forgets its runs. */
  ended(key: string): void
}

/** A toolbar click as the renderer reports it: whose button, by id. */
export type OverlayButtonClick =
  | { source: 'opener'; buttonId: string }
  | { source: 'type'; pluginId: string; buttonId: string }

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
  /** The page posted a message without a `result` key: plain JSON data, parsed from its text. */
  onMessage(message: unknown): void
  /**
   * A click on one of the opener's own buttons (any kind of overlay): settles when its handlers
   * have. Absent: the opener cannot hear clicks, and they are refused.
   */
  onButton?(buttonId: string): Promise<unknown>
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

interface Overlay {
  id: string
  windowId: number
  info: OverlayInfo
  /** An html overlay's page, served at `info.src` while the overlay is open. */
  html?: string
  /** Who asked (a plugin id, `cli`, ...): only for the log, never an authority. */
  opener: string
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
}

/** A click's key in `running`. */
function clickKey(click: OverlayButtonClick): string {
  return click.source === 'opener' ? `opener/${click.buttonId}` : `type/${click.pluginId}/${click.buttonId}`
}

/** `promise`, or a rejection after `ms`; the timer never outlives the race. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class OverlayManager {
  /** windowId -> its overlays, bottom first. */
  private readonly stacks = new Map<number, Overlay[]>()
  private readonly byId = new Map<string, Overlay>()
  /** The top overlay each window had after its last change, to move focus only on a change. */
  private readonly lastTop = new Map<number, Overlay | undefined>()
  private readonly pty: PtyService
  private readonly options: OverlayManagerOptions
  private readonly log: (message: string) => void

  constructor(options: OverlayManagerOptions) {
    this.options = options
    this.log = options.log ?? ((m) => console.warn(m))
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
    pluginId?: string
  ): Promise<OverlayResult> {
    try {
      return this.start(windowId, spec, opener, peerGone, channel, pluginId)
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
   */
  start(
    windowId: number,
    spec: unknown,
    opener: string,
    peerGone?: AbortSignal,
    channel?: OverlayChannel,
    pluginId?: string
  ): Promise<OverlayResult> {
    const parsed = parseOverlaySpec(spec)
    // Before anything is created: no program, no view, no stack for a window that is gone.
    if (!this.options.isWindowOpen(windowId)) throw new Error('overlay: the window is gone')
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
      settle,
      pageReady: false,
      outbox: new OverlayOutbox(),
      ready: parsed.ready ?? 'load',
      openerButtons: parsed.buttons ?? [],
      typeButtons: [],
      running: new Set(),
      typeAsk: 0
    }
    if (pluginId !== undefined) overlay.pluginId = pluginId
    if (parsed.type) {
      overlay.type = parsed.type
      overlay.buttonsKey = randomUUID()
    }
    if (parsed.kind === 'html' && 'html' in parsed) overlay.html = parsed.html
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
    this.byId.set(id, overlay)
    const stack = this.stacks.get(windowId) ?? []
    stack.push(overlay)
    this.stacks.set(windowId, stack)
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

  /** The window's overlays, bottom first. Also the re-attach point after a renderer reload. */
  list(windowId: number): OverlayInfo[] {
    const stack = this.stacks.get(windowId) ?? []
    // The old page never acked what it was sent; a paused PTY would otherwise stay paused.
    for (const o of stack) if (o.info.kind === 'terminal') this.pty.resetFlow(o.id)
    // Its html pages reload with it: an opener's posts wait again until each one's port is up, and
    // the loader is back until the page is ready again (a `manual` page calls ready() once more).
    // A url view and a PTY live in main and do not reload with the renderer.
    for (const o of stack) {
      o.pageReady = false
      if (o.info.kind === 'html') o.info = { ...o.info, loading: true }
    }
    return this.infos(windowId)
  }

  /** The window's overlays, bottom first; a plain read (no flow-control reset). */
  infos(windowId: number): OverlayInfo[] {
    return (this.stacks.get(windowId) ?? []).map((o) => o.info)
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

  /** The user typing into a terminal overlay. */
  input(windowId: number, overlayId: string, data: string): void {
    const overlay = this.find(windowId, overlayId)
    if (overlay?.info.kind === 'terminal') this.pty.write(overlay.id, data)
  }

  resize(windowId: number, overlayId: string, cols: number, rows: number): void {
    const overlay = this.find(windowId, overlayId)
    if (overlay?.info.kind === 'terminal') this.pty.resize(overlay.id, cols, rows)
  }

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
   * for an unknown overlay, a non-html one, or a value that is not JSON or too large.
   */
  result(windowId: number, overlayId: string, value: unknown): boolean {
    const overlay = this.find(windowId, overlayId)
    if (overlay?.info.kind !== 'html') return false
    let json: string | undefined
    try {
      json = JSON.stringify(value)
    } catch {
      return false
    }
    // `undefined` (or a function) has no JSON form: the page posted "nothing", which is null.
    json ??= 'null'
    if (json.length > MAX_RESULT_BYTES) return false
    this.finish(overlay, { kind: 'value', value: JSON.parse(json) as unknown })
    return true
  }

  /**
   * The opener sends `text` (one JSON text, as the page's port carries it) to its html overlay's
   * page. True when it went out or was queued until the page has loaded; false for an overlay that
   * is gone, of another window, or opened without a channel (only the opener holds the id, and
   * HostApi looks it up by its own plugin and handle). Throws for a message over the limit or a
   * full queue.
   */
  post(windowId: number, overlayId: string, text: string): boolean {
    const overlay = this.find(windowId, overlayId)
    if (!overlay?.channel || overlay.info.kind !== 'html') return false
    if (typeof text !== 'string' || text.length > MAX_OVERLAY_MESSAGE_LENGTH) {
      throw new RangeError(`overlay post: message exceeds ${MAX_OVERLAY_MESSAGE_LENGTH} chars`)
    }
    if (overlay.pageReady) this.options.emit(windowId, 'overlays.message', { overlayId, message: text })
    else overlay.outbox.push(text)
    return true
  }

  /**
   * The renderer handed an html overlay's page its port (on every page load): what the opener
   * posted before goes out now, in order. A no-op for an overlay without a channel.
   */
  pageReady(windowId: number, overlayId: string): void {
    const overlay = this.find(windowId, overlayId)
    if (overlay?.info.kind !== 'html') return
    // The page loaded and has its port: a `ready: 'load'` overlay is ready (an inline page reports
    // its load here too, with no channel behind it).
    if (overlay.ready === 'load') this.loaded(overlay)
    if (!overlay.channel) return
    overlay.pageReady = true
    for (const message of overlay.outbox.drain()) this.options.emit(windowId, 'overlays.message', { overlayId, message })
  }

  /**
   * An html overlay's page says it has drawn (`ccPanel.ready()`): the loader goes, whatever its
   * `ready` mode (a `load` page calling it early changes nothing worse than an early port).
   */
  pageLoaded(windowId: number, overlayId: string): void {
    const overlay = this.find(windowId, overlayId)
    if (overlay?.info.kind === 'html') this.loaded(overlay)
  }

  /**
   * An html overlay's page posted a message that is not a result (relayed by the renderer of the
   * window it is in). Only to the channel of the overlay's own opener; false (dropped, logged) for
   * an overlay of another window, one without a channel, or text that is not JSON within the limit.
   */
  pageMessage(windowId: number, overlayId: string, text: unknown): boolean {
    const overlay = this.find(windowId, overlayId)
    if (!overlay?.channel || overlay.info.kind !== 'html') return false
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
      overlay.channel.onMessage(message)
    } catch (err) {
      this.log(`overlay ${overlay.id}: delivering a page message failed: ${String(err)}`)
    }
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
   * when the click went out.
   */
  buttonClick(windowId: number, overlayId: string, click: OverlayButtonClick): boolean {
    const overlay = this.find(windowId, overlayId)
    if (!overlay) return false
    const key = clickKey(click)
    if (overlay.running.has(key)) return false
    let run: () => Promise<unknown>
    if (click.source === 'opener') {
      const button = overlay.openerButtons.find((b) => b.id === click.buttonId)
      const onButton = overlay.channel?.onButton
      if (!button || button.busy || button.disabled || !onButton) return false
      run = () => onButton.call(overlay.channel, click.buttonId)
    } else {
      const button = overlay.typeButtons.find((b) => b.pluginId === click.pluginId && b.id === click.buttonId)
      const source = this.options.typeButtons?.(windowId)
      const query = this.typeQuery(overlay)
      if (!button || button.busy || button.disabled || !source || !query || overlay.buttonsKey === undefined) return false
      const buttonsKey = overlay.buttonsKey
      run = () => source.click(buttonsKey, click.pluginId, click.buttonId, query)
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
    void within(sent, OVERLAY_CLICK_TIMEOUT_MS, what)
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
    if (!overlay) return false
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

  /** The window closed: every overlay it had is dismissed. */
  closeWindow(windowId: number): void {
    for (const overlay of [...(this.stacks.get(windowId) ?? [])].reverse()) {
      this.finish(overlay, { kind: 'dismissed' }, false)
    }
    this.stacks.delete(windowId)
    this.lastTop.delete(windowId)
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
    this.byId.delete(overlay.id)
    overlay.unlinkPeer?.()
    overlay.unlinkPeer = undefined
    // Posts still waiting for a page that never loaded go nowhere; the opener hears the result.
    overlay.outbox.drain()
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
    if (overlay.info.kind === 'terminal') this.pty.terminate(overlay.id)
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
export function parseOverlaySpec(spec: unknown): OverlaySpec {
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
  const extras = s.kind === 'terminal' || s.kind === 'url' || s.kind === 'html' ? parseOverlayExtras(s, s.kind) : {}
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
