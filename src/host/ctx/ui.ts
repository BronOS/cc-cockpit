// ctx.panels, ctx.badge and ctx.overlay (design §5 › UI).
//
//   badge(panelId, n | 'dot' | null)   one of the plugin's OWN declared panels; main checks again
//                                      (src/main/plugins/host-api.ts) against the host's scope
//   overlay.open(spec)                 terminal (argv only), url (http/https), html (a file of the
//                                      plugin's own folder, read by main); resolves when it closes
//   overlay.start(spec)                the same overlay as a handle: { result, post, onMessage,
//                                      onConnect, onDisconnect, hide, close, focus, onButton,
//                                      setButtons, onDiscuss, setDiscussPrimary, addSources };
//                                      open(spec) is start(spec).result
//   overlay.buttons(type, provider)    buttons on every overlay of that type (host/overlay-buttons.ts)
//   panels.post / panels.onMessage     over the panel's MessagePort
//   panels.slots                       slot placements in the panel's column (shared/slots.ts rules,
//                                      checked here for a fast error and again in main)
//   panels.header / panels.onAction    the panel's title bar: meta text and up to 3 icon buttons,
//                                      checked here and again in main (shared/panel-header.ts);
//                                      a click comes back as main's `panel.action` event
//
// Panel ports: main creates one channel per panel instance and hands the host its end, tagged with
// the plugin and panel id (src/main/plugins/panel-ports.ts). Here that end is the small PanelPort
// interface below (`fromMainPort` adapts Electron's MessagePortMain to it), so this file has no
// Electron import and unit tests use an in-memory port. A
// message on a panel port is ONE JSON string, like the host RPC (src/host/rpc.ts): the size cap is
// a length check and nothing but plain data crosses. A post while the panel has no port (it is
// not shown, or its iframe is reloading) is dropped: the panel asks for what it needs when it
// connects, the plugin does not have to track whether it is open.
//
// Overlay messages take another road than panels': main relays them (the page's port ends in the
// shell renderer, see src/renderer/overlays/HtmlOverlay.tsx), over the host RPC. Each start picks a
// random handle that main keys by plugin id (src/main/plugins/host-api.ts); main's
// `overlay.message` events come back with it and OverlayLinks hands them to that handle's
// listeners, in the view of the page that posted (`view`, origin-view.ts) as for panels, with
// `from` (who: view, access, a guest's person; main's word). Once the overlay ended, post/close do
// nothing and the listeners are dropped.
//
// Per-view copies (docs/design-overlay-views.md): an html overlay of a plugin whose manifest says
// `overlays.perView` has one copy of its page per view. Main announces each (`overlay.connect`, its
// `copy` id and `from`) and takes it back (`overlay.disconnect`); the copy's view is one line of
// ctx.views meanwhile, as a panel port is. The plugin answers a copy with `post(m, { copy })`, every
// copy with `post(m)`, and hides one view's copy with `hide({ copy })`. Any other overlay has one
// page: no copies, and `post { copy }` / `hide` throw at the call site.
//
// Provenance (docs/design-overlay-views.md §4, D-4): an overlay call made inside a service call (start,
// post, setButtons; a title is only set at start) carries `via`, the service caller chain
// (ctx.services.callers(), read at the plugin's call site), so main counts the overlay as shown for those
// plugins too and hides it from a guest who may not see one of them. `handle.addSources(ids)` is the same
// for content the plugin shows later, after the call settled (the chain is empty by then).
import { randomUUID } from 'node:crypto'
import type {
  BadgeValue,
  Disposer,
  JsonValue,
  OverlayButton,
  OverlayHandle,
  OverlayInfo,
  OverlayResult,
  OverlaySpec,
  OverlayTypeButton,
  PluginContext,
  ViewAccess,
  ViewFrom
} from '../../sdk/types'
import { MAX_DISCUSS_TEXT } from '../../shared/discuss'
import { MAX_OVERLAY_SOURCES, parseOverlayButtons, parseOverlayExtras } from '../../shared/overlay-buttons'
import { MAX_OVERLAY_MESSAGE_LENGTH } from '../../shared/overlay-message'
import { parsePanelHeader } from '../../shared/panel-header'
import { isAppSlotType, parseSlotPlacements } from '../../shared/slots'
import { errorText } from '../../shared/error-text'
import { PLUGIN_DESKTOP_VIEW, viewIdOf, type ViewId } from '../../shared/views'
import type { OverlayButtonRegistry } from '../overlay-buttons'
import { dispatchInView } from './origin-view'
import { HostViews, tagAccess, viewFromOf } from './views'

/** Longest panel message, as JSON text (the RPC cap). */
export const MAX_PANEL_MESSAGE_LENGTH = 1024 * 1024

/**
 * A plugin's message to one of its pages (panel, slot, settings page) as the port's JSON text, or a
 * throw: TypeError when it is not JSON, RangeError past MAX_PANEL_MESSAGE_LENGTH. `what` starts
 * each error ("panels.post", "slot post"). One rule for every page port, so the caps cannot drift.
 */
export function encodePortMessage(message: unknown, what: string): string {
  let text: string | undefined
  try {
    text = JSON.stringify(message)
  } catch (err) {
    throw new TypeError(`${what}: the message is not JSON: ${errorText(err)}`, { cause: err })
  }
  if (text === undefined) throw new TypeError(`${what}: the message is not JSON`)
  if (text.length > MAX_PANEL_MESSAGE_LENGTH) {
    throw new RangeError(`${what}: message of ${text.length} chars exceeds ${MAX_PANEL_MESSAGE_LENGTH}`)
  }
  return text
}

/**
 * A page's message as it came off the port: the parsed JSON, or why it is dropped (`size`: not a
 * string within the cap, `json`: not JSON). The page is the plugin's own code but may show
 * third-party content, so the caller logs a drop and gives each listener its own copy.
 */
export function decodePortMessage(raw: unknown): { ok: true; value: JsonValue } | { ok: false; reason: 'size' | 'json' } {
  if (typeof raw !== 'string' || raw.length > MAX_PANEL_MESSAGE_LENGTH) return { ok: false, reason: 'size' }
  try {
    return { ok: true, value: JSON.parse(raw) as JsonValue }
  } catch {
    return { ok: false, reason: 'json' }
  }
}

/** The host's end of one panel's MessagePort (`fromMainPort` adapts Electron's MessagePortMain). */
export interface PanelPort {
  postMessage(message: string): void
  /** Subscribe to what the panel posts; returns the unsubscribe. */
  onMessage(listener: (message: unknown) => void): () => void
  close(): void
}

/** The slice of Electron's MessagePortMain the host uses (typed here: the host imports no `electron`). */
export interface MainPortLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  off(event: 'message', listener: (e: { data: unknown }) => void): unknown
  start(): void
  close(): void
}

/**
 * A MessagePortMain as a PanelPort. A MessagePortMain queues what arrives until `start()`, so it
 * is started once a listener is on it (before that, the panel's early posts would wait forever).
 * `onClose` runs when the other end goes away (the iframe was removed or reloaded, the window
 * closed), so the host stops counting the panel as connected.
 */
export function fromMainPort(port: MainPortLike, onClose?: () => void): PanelPort {
  let started = false
  if (onClose) port.on('close', onClose)
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => {
      const l = (e: { data: unknown }): void => listener(e.data)
      port.on('message', l)
      if (!started) {
        started = true
        port.start()
      }
      return () => {
        port.off('message', l)
      }
    },
    close: () => port.close()
  }
}

/**
 * The plugin and panel id of main's port message `{ "panelPort": { pluginId, panelId, view? } }`
 * (sent with the port in its transfer list, host/index.ts), or undefined for anything else.
 * `view` names a remote view's page (shared/views.ts, design-web.md §5.3); absent is the desktop
 * window's own page, so a desktop port's message keeps its old shape.
 */
export function panelPortTag(data: unknown): { pluginId: string; panelId: string; view?: ViewId; access: ViewAccess } | undefined {
  if (typeof data !== 'string' || data.length > 1000) return undefined
  try {
    const tag = (JSON.parse(data) as { panelPort?: { pluginId?: unknown; panelId?: unknown; view?: unknown; access?: unknown } } | null)?.panelPort
    if (typeof tag?.pluginId === 'string' && typeof tag.panelId === 'string') {
      const view = viewIdOf(tag.view)
      // A view that is not one main mints is refused (the port is closed), never read as the
      // desktop's: a tag main did not write must not take over the desktop page's slot.
      if (tag.view !== undefined && view === undefined) return undefined
      // The view's access (views.ts tagAccess): a missing or malformed one refuses the port, never reads as the owner.
      const access = tagAccess(tag.access, view)
      if (access === null) return undefined
      return { pluginId: tag.pluginId, panelId: tag.panelId, ...(view !== undefined ? { view } : {}), access }
    }
  } catch {
    // Not one of main's port messages.
  }
  return undefined
}

type MessageListener = (message: JsonValue, from: PanelMessageSource) => void

/**
 * Which page a panel message came from, as a plugin sees it (the second argument of
 * `ctx.panels.onMessage` listeners; `post`'s `{ view }` target takes the same value): the
 * desktop window's own page is `DESKTOP_VIEW`, a remote browser page its view id (`web:<n>`).
 */
export interface PanelMessageSource {
  readonly view: string
  /** The view's access (guests, design-guests §6), from main's port tag only, never the page's word. */
  readonly access: ViewAccess
}

/** The `view` a plugin sees for the desktop window's own page (shared/views.ts PLUGIN_DESKTOP_VIEW). */
export const DESKTOP_VIEW = PLUGIN_DESKTOP_VIEW

interface Attached {
  port: PanelPort
  unsubscribe: () => void
  /** Ends this line's entry in ctx.views (views.ts). */
  release: () => void
}

/** The views map's key for the desktop window's own page (a port tag with no view). */
const DESKTOP_PAGE = ''

/**
 * The panel ports and message listeners of every plugin of one host, keyed `<pluginId>/<panelId>`.
 * A panel has one port PER VIEW (design-web.md §5.3): the desktop window's page and each remote
 * browser view's page of it. A post goes to every view's page and a listener hears every page, so
 * a plugin that pushes its state to "the panel" reaches every screen showing it; a reload in one
 * view replaces only that view's port, and the other views keep talking.
 */
export class PanelPorts {
  /** `<pluginId>/<panelId>` -> view (DESKTOP_PAGE for the desktop window's page) -> its port. */
  private readonly ports = new Map<string, Map<string, Attached>>()
  private readonly listeners = new Map<string, Set<MessageListener>>()

  constructor(
    private readonly log: (pluginId: string, message: string) => void,
    /** ctx.views: every port attached here is one line of its view (views.ts). */
    private readonly views: HostViews = new HostViews(log)
  ) {}

  /**
   * A panel's page in `view` (absent: the desktop window's) (re)connected: `port` replaces that
   * view's previous one, which is closed (a reloaded iframe gets a new port, and the old page must
   * not keep talking). Other views' ports stay. The caller checked that the plugin runs here and
   * declares the panel.
   */
  attach(pluginId: string, panelId: string, port: PanelPort, view: ViewId | undefined, access: ViewAccess): void {
    const key = `${pluginId}/${panelId}`
    const v = view ?? DESKTOP_PAGE
    this.detachView(key, v)
    const unsubscribe = port.onMessage((raw) => this.receive(pluginId, key, raw, view, access))
    const release = this.views.add(pluginId, view ?? DESKTOP_VIEW, access)
    const views = this.ports.get(key) ?? new Map<string, Attached>()
    views.set(v, { port, unsubscribe, release })
    this.ports.set(key, views)
  }

  /**
   * A page went away: close its port. Listeners stay for the next one. With `port`, only that port
   * (whichever view holds it), and only while it is still attached: the close of an old page's
   * port can arrive after its reload already attached the new one. Without, every view's port of
   * the panel (the plugin is going).
   */
  detach(pluginId: string, panelId: string, port?: PanelPort): void {
    const key = `${pluginId}/${panelId}`
    const views = this.ports.get(key)
    if (!views) return
    for (const [v, attached] of [...views]) {
      if (port === undefined || attached.port === port) this.detachView(key, v)
    }
  }

  private detachView(key: string, view: string): void {
    const views = this.ports.get(key)
    const old = views?.get(view)
    if (!views || !old) return
    views.delete(view)
    if (views.size === 0) this.ports.delete(key)
    old.unsubscribe()
    old.release()
    try {
      old.port.close()
    } catch {
      // Already closed on the other side.
    }
  }

  /** Whether the panel has a port in any view now (a post would be delivered). */
  connected(pluginId: string, panelId: string): boolean {
    return this.ports.has(`${pluginId}/${panelId}`)
  }

  /**
   * Send to the panel's page in every view; false when it has no port at all (the message is
   * dropped). One view's broken port is logged and does not keep the message from the others.
   * `only` (DESKTOP_VIEW or a remote view id) sends to that one view's page: false when it has
   * none (the view left or reloads), and nothing reaches another view.
   */
  post(pluginId: string, panelId: string, message: unknown, only?: string): boolean {
    const text = encodePortMessage(message, 'panels.post')
    const views = this.ports.get(`${pluginId}/${panelId}`)
    if (!views) return false
    let delivered = false
    for (const [view, attached] of [...views]) {
      if (only !== undefined && view !== (only === DESKTOP_VIEW ? DESKTOP_PAGE : only)) continue
      try {
        attached.port.postMessage(text)
        delivered = true
      } catch (err) {
        this.log(pluginId, `panels.post to ${panelId}${view !== DESKTOP_PAGE ? ` (${view})` : ''} failed: ${errorText(err)}`)
      }
    }
    return delivered
  }

  onMessage(pluginId: string, panelId: string, listener: MessageListener): Disposer {
    const key = `${pluginId}/${panelId}`
    const set = this.listeners.get(key) ?? new Set<MessageListener>()
    const entry: MessageListener = (m, from) => listener(m, from)
    set.add(entry)
    this.listeners.set(key, set)
    return () => {
      set.delete(entry)
      if (set.size === 0 && this.listeners.get(key) === set) this.listeners.delete(key)
    }
  }

  /** The plugin is gone: close its ports and drop its listeners. */
  removePlugin(pluginId: string): void {
    const prefix = `${pluginId}/`
    for (const key of [...this.ports.keys()]) {
      if (key.startsWith(prefix)) this.detach(pluginId, key.slice(prefix.length))
    }
    for (const key of [...this.listeners.keys()]) if (key.startsWith(prefix)) this.listeners.delete(key)
  }

  /**
   * A message from a panel page. The page is the plugin's own code, but it may show third-party
   * content: anything that is not a JSON string within the cap is dropped (logged), and each
   * listener gets its own parsed copy. Each listener runs in its page's view (origin-view.ts), so
   * the calls it makes act where the click came from.
   */
  private receive(pluginId: string, key: string, raw: unknown, view: ViewId | undefined, access: ViewAccess): void {
    const got = decodePortMessage(raw)
    if (!got.ok) {
      this.log(pluginId, `dropped a message from panel ${key}: ${got.reason === 'size' ? 'not a JSON string within the size cap' : 'not JSON'}`)
      return
    }
    for (const listener of [...(this.listeners.get(key) ?? [])]) {
      try {
        dispatchInView(
          view,
          () => listener(structuredClone(got.value), { view: view ?? DESKTOP_VIEW, access }),
          (err) => this.log(pluginId, `a panels.onMessage listener failed: ${errorText(err)}`)
        )
      } catch (err) {
        this.log(pluginId, `a panels.onMessage listener threw: ${errorText(err)}`)
      }
    }
  }
}

type ActionListener = (actionId: string, from: ViewFrom) => void

/**
 * The ctx.panels.onAction listeners of every plugin of one host, keyed `<pluginId>/<panelId>`,
 * and the routing of main's `panel.action { pluginId, panelId, actionId }` to them. Main only
 * sends a click on an action the plugin's current header has (not busy, not disabled), so nothing
 * is re-checked here beyond the shape; a click that arrives after the plugin cleared its header
 * (it raced the IPC) just reaches listeners that know what to ignore.
 */
export class PanelActions {
  private readonly listeners = new Map<string, Set<ActionListener>>()

  constructor(
    private readonly log: (pluginId: string, message: string) => void,
    /** Where a click's view gets its access: the plugin's own lines (views.ts). */
    private readonly views: HostViews = new HostViews(log)
  ) {}

  onAction(pluginId: string, panelId: string, listener: ActionListener): Disposer {
    const key = `${pluginId}/${panelId}`
    const set = this.listeners.get(key) ?? new Set<ActionListener>()
    // Wrapped: the same function registered twice is two registrations, each with its disposer.
    const entry: ActionListener = (id, from) => listener(id, from)
    set.add(entry)
    this.listeners.set(key, set)
    return () => {
      set.delete(entry)
      if (set.size === 0 && this.listeners.get(key) === set) this.listeners.delete(key)
    }
  }

  /** The plugin's ctx ended: its listeners go (a reloaded copy registers its own). */
  removePlugin(pluginId: string): void {
    const prefix = `${pluginId}/`
    for (const key of [...this.listeners.keys()]) if (key.startsWith(prefix)) this.listeners.delete(key)
  }

  /**
   * main's `panel.action`; anything malformed is dropped. Each listener runs in the clicking view
   * (`view`, a remote one; none for the desktop's), as a panel's message listeners do.
   */
  handleEvent(params: unknown): void {
    const { pluginId, panelId, actionId, view: rawView } = (params ?? {}) as Record<string, unknown>
    if (typeof pluginId !== 'string' || typeof panelId !== 'string' || typeof actionId !== 'string') return
    // A view main did not mint is refused, never read as the desktop's (as slots.ts does).
    const view = viewIdOf(rawView)
    if (rawView !== undefined && view === undefined) return
    // The click names its view, not its access: the access is the one main tagged that view's lines of this
    // plugin with. The desktop page is the owner's; a remote view with no open line of the plugin (it cannot
    // be showing the panel's page) reads as a read-only guest, never as the owner.
    const access: ViewAccess = view === undefined ? 'owner' : (this.views.access(pluginId, view) ?? 'read')
    for (const listener of [...(this.listeners.get(`${pluginId}/${panelId}`) ?? [])]) {
      try {
        dispatchInView(
          view,
          () => listener(actionId, { view: view ?? DESKTOP_VIEW, access }),
          (err) => this.log(pluginId, `a panels.onAction listener failed: ${errorText(err)}`)
        )
      } catch (err) {
        this.log(pluginId, `a panels.onAction listener threw: ${errorText(err)}`)
      }
    }
  }
}

/** Who a copy's or a holder's message came from, as the plugin's listeners get it. */
type OverlayFrom = ViewFrom & { copy?: string }
type OverlayMessageListener = (message: JsonValue, from: OverlayFrom) => void
type CopyListener = (from: ViewFrom & { copy: string }) => void
type FromHandler = (from: ViewFrom) => unknown

/** One live copy of a perView overlay, as main announced it (`overlay.connect`). */
interface LiveCopy {
  /** The connect's `from`: the disconnect gets the same one (the view may be gone from main's registry by then). */
  readonly from: ViewFrom
  /** Main's id of the copy's view (undefined: the desktop page): the listeners run in it. */
  readonly view: ViewId | undefined
  /** Ends the copy's line in ctx.views (views.ts). */
  readonly release: () => void
}

/** One ctx.overlay.start handle of this host, while its overlay is open. */
interface OverlayLink {
  readonly pluginId: string
  readonly handle: string
  /**
   * An html overlay of a plugin whose manifest says `overlays.perView` (main decides the same from the same
   * manifest): one copy per view, connect and disconnect, `post { copy }` and `hide`. Otherwise one page, held
   * by one view: its messages carry no copy and nothing connects.
   */
  readonly perView: boolean
  readonly listeners: Set<OverlayMessageListener>
  readonly connectListeners: Set<CopyListener>
  readonly disconnectListeners: Set<CopyListener>
  /** Button id -> click handlers (main's `overlay.buttonClick` for an opener button runs them, `click`). */
  readonly buttonHandlers: Map<string, Set<FromHandler>>
  /** The Discuss context answerers, in the order added; the first to return text wins (main asks over RPC). */
  readonly discussHandlers: Set<FromHandler>
  /** perView: the copies main announced and has not taken back, by copy id. */
  readonly copies: Map<string, LiveCopy>
  ended: boolean
}

/** Longest copy id taken from main (it mints 32 hex characters); anything else names no copy. */
const MAX_COPY_ID_LENGTH = 100

function copyIdOf(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw !== '' && raw.length <= MAX_COPY_ID_LENGTH ? raw : undefined
}

/**
 * The open overlay handles of every plugin of one host, keyed `<pluginId>/<handle>`, and the routing of main's
 * overlay events and requests to their listeners. Every one carries `from` (docs/design-overlay-views.md §3),
 * main's word for who acted, checked here (views.ts viewFromOf): a missing or malformed one drops a message or a
 * connect and refuses a request, never reads as the owner. A disconnect does not read its own `from`: it runs
 * with its connect's (dropping it would leave the copy's ctx.views line behind). Each listener runs in the acting view (origin-view.ts), so
 * what it opens or focuses without naming a view shows there; plugins should still answer by `from`.
 *
 * Listeners are called one at a time, in the order added, each with its own copy of `from` and of the
 * message; one that throws (or rejects) is logged in the plugin's log and the next still runs.
 */
export class OverlayLinks {
  private readonly links = new Map<string, OverlayLink>()

  constructor(
    private readonly log: (pluginId: string, message: string) => void,
    /** ctx.views: a perView copy is one line of its view while it is connected (views.ts). */
    private readonly views: HostViews = new HostViews(log)
  ) {}

  open(pluginId: string, perView = false): OverlayLink {
    const link: OverlayLink = {
      pluginId,
      handle: randomUUID(),
      perView,
      listeners: new Set(),
      connectListeners: new Set(),
      disconnectListeners: new Set(),
      buttonHandlers: new Map(),
      discussHandlers: new Set(),
      copies: new Map(),
      ended: false
    }
    this.links.set(`${pluginId}/${link.handle}`, link)
    return link
  }

  /**
   * The overlay ended: post/close become no-ops and its listeners are dropped. Its copies' lines in ctx.views
   * end too (no onDisconnect: the listeners are the overlay's, and it is gone), so a closed overlay never keeps
   * a guest's view known.
   */
  end(link: OverlayLink): void {
    link.ended = true
    link.listeners.clear()
    link.connectListeners.clear()
    link.disconnectListeners.clear()
    link.buttonHandlers.clear()
    link.discussHandlers.clear()
    for (const copy of [...link.copies.values()]) copy.release()
    link.copies.clear()
    const key = `${link.pluginId}/${link.handle}`
    if (this.links.get(key) === link) this.links.delete(key)
  }

  /**
   * The plugin has an overlay open or opening: its dispose must tell main (`plugin.disposed`),
   * which dismisses them. Checked before removePlugin.
   */
  has(pluginId: string): boolean {
    for (const link of this.links.values()) if (link.pluginId === pluginId) return true
    return false
  }

  /** The plugin's ctx ended: its handles end with it (main dismisses the overlays on `plugin.disposed`). */
  removePlugin(pluginId: string): void {
    for (const link of [...this.links.values()]) if (link.pluginId === pluginId) this.end(link)
  }

  /**
   * main's `overlay.buttonClick { pluginId, handle, buttonId, view?, from }` for one of the opener's own
   * buttons: every `onButton` handler of that id runs with `from` (who clicked), in the clicking view, and the
   * answer comes once all have settled (main shows the button busy until then, bounded to 30 s there). A
   * handler that throws is logged in the plugin's log; the click still answers. Main only sends a click on a
   * button it shows on that plugin's overlay; one for an ended handle runs nothing.
   */
  async click(params: unknown): Promise<null> {
    const { pluginId, handle, buttonId, view: rawView, from: rawFrom } = (params ?? {}) as Record<string, unknown>
    if (typeof pluginId !== 'string' || typeof handle !== 'string' || typeof buttonId !== 'string') {
      throw new Error('overlay.buttonClick: bad button')
    }
    // The remote view whose toolbar was clicked; one main did not mint is refused, never read as the desktop's.
    const view = viewIdOf(rawView)
    if (rawView !== undefined && view === undefined) throw new Error('overlay.buttonClick: bad view')
    const from = viewFromOf(rawFrom, view)
    if (!from) throw new Error('overlay.buttonClick: bad from')
    const link = this.links.get(`${pluginId}/${handle}`)
    if (!link || link.ended) return null
    const handlers = [...(link.buttonHandlers.get(buttonId) ?? [])]
    // Each in the clicking view (origin-view.ts); a rejection is logged below, from the outcomes.
    const outcomes = await Promise.allSettled(
      handlers.map((h) => Promise.resolve().then(() => dispatchInView(view, () => h({ ...from }), () => undefined)))
    )
    for (const o of outcomes) {
      if (o.status === 'rejected') this.log(pluginId, `an overlay onButton("${buttonId}") handler threw: ${errorText(o.reason)}`)
    }
    return null
  }

  /**
   * main's `overlay.discuss { pluginId, handle, view?, from }` (Discuss with Claude's Send): the handle's
   * `onDiscuss` handlers are asked with `from` (whose Send it was), in the sending view, in the order they were
   * added, and the first that answers `{ text }` wins; `null` (or nothing) passes to the next, and all null
   * means "no extra context". A handler that throws, or answers anything else, fails the ask: main shows the
   * error in the popover and sends nothing (it also bounds the ask to 5 s). The text is cut to the whole
   * message's cap here, so a huge answer never crosses the port; main cuts it to fit again.
   */
  async discuss(params: unknown): Promise<{ text: string } | null> {
    const { pluginId, handle, view: rawView, from: rawFrom } = (params ?? {}) as Record<string, unknown>
    if (typeof pluginId !== 'string' || typeof handle !== 'string') throw new Error('overlay.discuss: bad handle')
    const view = viewIdOf(rawView)
    if (rawView !== undefined && view === undefined) throw new Error('overlay.discuss: bad view')
    const from = viewFromOf(rawFrom, view)
    if (!from) throw new Error('overlay.discuss: bad from')
    const link = this.links.get(`${pluginId}/${handle}`)
    if (!link || link.ended) return null
    for (const handler of [...link.discussHandlers]) {
      let answer: unknown
      try {
        // The rejection is handled by this await; dispatchInView's own handler only keeps it from being unhandled.
        answer = await dispatchInView(view, () => handler({ ...from }), () => undefined)
      } catch (err) {
        this.log(pluginId, `an overlay onDiscuss handler threw: ${errorText(err)}`)
        throw err
      }
      if (answer === null || answer === undefined) continue
      const text = (answer as { text?: unknown }).text
      if (typeof answer !== 'object' || typeof text !== 'string') {
        this.log(pluginId, 'an overlay onDiscuss handler answered something other than { text } or null')
        throw new TypeError('onDiscuss must answer { text } or null')
      }
      return { text: text.slice(0, MAX_DISCUSS_TEXT) }
    }
    return null
  }

  /**
   * main's `overlay.message { pluginId, handle, message, view?, copy?, from }`; anything malformed or for an
   * ended handle is dropped. A perView overlay's message names a copy main announced, from that copy's view;
   * any other overlay's names none (its holder posted). Each listener runs in the posting page's view.
   */
  handleEvent(params: unknown): void {
    const { pluginId, handle, message, view: rawView, copy: rawCopy, from: rawFrom } = (params ?? {}) as Record<string, unknown>
    if (typeof pluginId !== 'string' || typeof handle !== 'string') return
    // A view main did not mint is refused, never read as the desktop's (as slots.ts does).
    const view = viewIdOf(rawView)
    if (rawView !== undefined && view === undefined) return
    const link = this.links.get(`${pluginId}/${handle}`)
    if (!link || link.ended) return
    const from = viewFromOf(rawFrom, view)
    if (!from) {
      this.log(pluginId, 'dropped an overlay message with no valid sender')
      return
    }
    let copy: string | undefined
    if (link.perView) {
      copy = copyIdOf(rawCopy)
      // Only a live copy of that view: a stale or unannounced one (main drops those too) is nobody. Looked up
      // first: from the desktop page `view` is undefined, and so is a missing copy's view (the Task 7 review).
      const live = copy === undefined ? undefined : link.copies.get(copy)
      if (!live || live.view !== view) return
    } else if (rawCopy !== undefined) {
      return
    }
    for (const listener of [...link.listeners]) {
      if (link.ended) return
      try {
        // Each listener its own copy, as for panels: one cannot change what the next one sees.
        dispatchInView(
          view,
          () => listener(structuredClone(message as JsonValue), { ...from, ...(copy !== undefined ? { copy } : {}) }),
          (err) => this.log(pluginId, `an overlay onMessage listener failed: ${errorText(err)}`)
        )
      } catch (err) {
        this.log(pluginId, `an overlay onMessage listener threw: ${errorText(err)}`)
      }
    }
  }

  /**
   * main's `overlay.connect` / `overlay.disconnect { pluginId, handle, copy, view?, from }` for a perView
   * overlay. A connect makes the copy's view one line of ctx.views (with `from.access`, as a panel port does)
   * BEFORE the onConnect listeners run, so a listener asking ctx.views already finds it; a disconnect runs the
   * onDisconnect listeners with the connect's `from` and ends that line after them. A repeated connect, a
   * disconnect of a copy never announced, and anything for a non-perView or ended handle are dropped. A reload
   * is a disconnect of the old copy and a connect of a new one (main sends them in that order).
   */
  handleCopyEvent(event: 'overlay.connect' | 'overlay.disconnect', params: unknown): void {
    const { pluginId, handle, copy: rawCopy, view: rawView, from: rawFrom } = (params ?? {}) as Record<string, unknown>
    if (typeof pluginId !== 'string' || typeof handle !== 'string') return
    const copy = copyIdOf(rawCopy)
    if (copy === undefined) return
    const view = viewIdOf(rawView)
    if (rawView !== undefined && view === undefined) return
    const link = this.links.get(`${pluginId}/${handle}`)
    if (!link || link.ended || !link.perView) return
    if (event === 'overlay.connect') {
      const from = viewFromOf(rawFrom, view)
      if (!from) {
        this.log(pluginId, 'dropped an overlay copy with no valid viewer')
        return
      }
      if (link.copies.has(copy)) return
      const release = this.views.add(pluginId, from.view, from.access)
      link.copies.set(copy, { from, view, release })
      this.runCopyListeners(link, link.connectListeners, from, view, copy, 'onConnect')
      return
    }
    const live = link.copies.get(copy)
    if (!live) return
    link.copies.delete(copy)
    try {
      this.runCopyListeners(link, link.disconnectListeners, live.from, live.view, copy, 'onDisconnect')
    } finally {
      live.release()
    }
  }

  /**
   * A new onConnect listener first hears every copy already live (as ctx.views.onChange replays its views), each
   * dispatched in that copy's view, before onConnect returns: a plugin that registers after an await still sends
   * every copy its starting state. Copies in the order main announced them.
   */
  replayConnects(link: OverlayLink, listener: CopyListener): void {
    const once = new Set([listener])
    for (const [copy, live] of [...link.copies]) {
      if (!link.copies.has(copy) || !link.connectListeners.has(listener)) break
      this.runCopyListeners(link, once, live.from, live.view, copy, 'onConnect')
    }
  }

  private runCopyListeners(
    link: OverlayLink,
    listeners: Set<CopyListener>,
    from: ViewFrom,
    view: ViewId | undefined,
    copy: string,
    what: string
  ): void {
    for (const listener of [...listeners]) {
      // A listener that closed the overlay (or disposed the next one) ends the round.
      if (link.ended || !listeners.has(listener)) continue
      try {
        dispatchInView(
          view,
          () => listener({ ...from, copy }),
          (err) => this.log(link.pluginId, `an overlay ${what} listener failed: ${errorText(err)}`)
        )
      } catch (err) {
        this.log(link.pluginId, `an overlay ${what} listener threw: ${errorText(err)}`)
      }
    }
  }
}

/** A message's JSON text, checked against the overlay limit (throws with the limit named). */
function overlayMessageText(message: unknown): string {
  let text: string | undefined
  try {
    text = JSON.stringify(message)
  } catch (err) {
    throw new TypeError(`overlay post: the message is not JSON: ${errorText(err)}`, { cause: err })
  }
  if (text === undefined) throw new TypeError('overlay post: the message is not JSON')
  if (text.length > MAX_OVERLAY_MESSAGE_LENGTH) {
    throw new RangeError(`overlay post: message of ${text.length} chars exceeds ${MAX_OVERLAY_MESSAGE_LENGTH}`)
  }
  return text
}

export interface UiApiDeps {
  pluginId: string
  /** Panel ids the manifest declares (main sent them in the spec). */
  panels: readonly string[]
  /** The ones of kind `webview`: no page of the plugin's to post to (ctx.webview drives them). Default none. */
  webviewPanels?: readonly string[]
  call(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown>
  alive(): void
  guardAsync<T>(body: () => Promise<T>): Promise<T>
  ports: PanelPorts
  /** The host's overlay handles (ctx.overlay.start). */
  overlays: OverlayLinks
  /**
   * The manifest says `overlays.perView` (main sent it in the spec): the plugin's html overlays have one copy
   * per view (connect, disconnect, `post { copy }`, `hide`). Absent: false.
   */
  overlaysPerView?: boolean
  /** The host's type-button providers (ctx.overlay.buttons). */
  typeButtons: OverlayButtonRegistry
  /** The plugin added type buttons: its dispose must tell main (`plugin.disposed`), which asks the toolbars again. */
  typeButtonsUsed?(): void
  /** The host's header action listeners (ctx.panels.onAction). */
  actions: PanelActions
  /**
   * The plugin set a header: its dispose must tell main (`plugin.disposed`), which clears it. A
   * header outliving its ctx would offer buttons whose listeners are gone.
   */
  headerUsed?(): void
  /** Panel id -> the slot types its manifest lists: the only ones `panels.slots` may place there. Default none. */
  panelSlots?: Readonly<Record<string, readonly string[]>>
  /** The plugin placed slots: its dispose must tell main (`plugin.disposed`), which clears the placements. */
  slotsUsed?(): void
  /** Where a failed fire-and-forget request (badge, panels.header) is reported. */
  logError(message: string): void
  /**
   * The service caller chain the plugin's code runs in now (ServiceRegistry.callers, outermost first),
   * sent as an overlay call's `via`. Absent, or one that throws: none.
   */
  callers?(): string[]
  /**
   * Whether an id is one of this host's plugins (ServiceRegistry.knows): sources are filtered to these before
   * anything else. Absent: every non-empty string is kept, and a list past MAX_OVERLAY_SOURCES throws instead.
   */
  isHostPlugin?(pluginId: string): boolean
}

/**
 * Sources as main takes them: this host's plugins only (`isHostPlugin`), each once. Never cut to a bound: `via`
 * only narrows who sees an overlay, so a dropped source would fail open (a guest kept seeing content shown for a
 * hidden plugin; Task 4 review). Filtered first, the list is bounded by the host's plugin count, which main
 * accepts; ids that name nothing are dropped before they could use up anything. With no filter wired, a list
 * past MAX_OVERLAY_SOURCES throws at the call site (fail closed) rather than lose an id.
 */
export function cleanSources(ids: readonly unknown[], isHostPlugin?: (id: string) => boolean): string[] {
  const out = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue
    if (isHostPlugin !== undefined && !isHostPlugin(id)) continue
    out.add(id)
  }
  if (isHostPlugin === undefined && out.size > MAX_OVERLAY_SOURCES) {
    throw new RangeError(`overlay sources: more than ${MAX_OVERLAY_SOURCES} plugin ids`)
  }
  return [...out]
}

/**
 * The service caller chain the plugin's code runs in now, as main takes it (cleanSources): an overlay call's `via`,
 * and the `via` of a main-routed file open (ctx.files.open, ctx.sessions.openFile), which main hands the taker as
 * `requestedBy`. Read at the plugin's call site, before any await. A `callers` that throws is none; a list that
 * cannot be sent whole throws at the call site (fail closed).
 */
export function callerChainNow(callers?: () => string[], isHostPlugin?: (id: string) => boolean): string[] {
  let raw: string[]
  try {
    raw = callers?.() ?? []
  } catch {
    raw = []
  }
  return cleanSources(raw, isHostPlugin)
}

/** A declared html panel: panels.post/onMessage on a webview panel would go nowhere (no port ever comes). */
function htmlPanel(deps: UiApiDeps, panelId: unknown, what: string): string {
  const id = declared(deps, panelId, what)
  if ((deps.webviewPanels ?? []).includes(id)) {
    throw new Error(`${what}: panel "${id}" is a "webview" panel: it has no page to message (use ctx.webview)`)
  }
  return id
}

function declared(deps: UiApiDeps, panelId: unknown, what: string): string {
  if (typeof panelId !== 'string' || !deps.panels.includes(panelId)) {
    // At the plugin's call site: main would refuse it too, but only asynchronously.
    throw new Error(`${what}: panel "${String(panelId)}" is not declared in plugin.json contributes.panels`)
  }
  return panelId
}

function checkBadge(value: unknown): BadgeValue {
  if (value === null || value === 'dot') return value
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  throw new TypeError('badge: value must be a non-negative number, "dot" or null')
}

export function createUiApi(
  deps: UiApiDeps
): Pick<PluginContext, 'panels' | 'badge' | 'overlay'> {
  const { pluginId, ports, overlays, actions } = deps

  /** `{ via }` for the call being made now (the service chain at this call site), nothing outside a service call. */
  const viaNow = (): { via?: string[] } => {
    const chain = callerChainNow(deps.callers, deps.isHostPlugin)
    return chain.length > 0 ? { via: chain } : {}
  }

  const start = (spec: OverlaySpec): OverlayHandle => {
    const html = typeof spec === 'object' && spec !== null && (spec as { kind?: unknown }).kind === 'html'
    // Main makes the same call from the same manifest (overlay-manager.ts: html and the opener's perView).
    const perView = html && deps.overlaysPerView === true
    // Read here, synchronously at the plugin's call site, while its service frame is the current one.
    const openVia = viaNow()
    /** Made when the request goes out (below); stays undefined when the call is refused first. */
    let link: OverlayLink | undefined
    const result = deps.guardAsync(async () => {
      if (typeof spec !== 'object' || spec === null) throw new TypeError('overlay.open needs a spec object')
      // type, buttons, ready, discuss: the plugin gets the TypeError here; main checks them again.
      parseOverlayExtras(spec as unknown as Record<string, unknown>, String((spec as { kind?: unknown }).kind))
      link = overlays.open(pluginId, perView)
      try {
        // No timeout: the overlay is open until the user (or its program) ends it. A host that
        // stops rejects it (the RPC closes) and main dismisses the overlay; a ctx disposed in a
        // running host (reload, unload) resolves it as dismissed (main closes it on `plugin.disposed`). The request goes out
        // synchronously, inside start(), so a post right after start() reaches main behind it.
        return (await deps.call(
          'overlay.open',
          { pluginId, spec, handle: link.handle, ...openVia },
          { timeoutMs: Infinity }
        )) as OverlayResult
      } finally {
        overlays.end(link)
      }
    })
    const htmlOnly = (what: string): void => {
      if (!html) throw new TypeError(`overlay ${what}: only an html overlay has a page to message`)
    }
    /** Fire and forget: a refusal (a full queue) is logged; false (it just ended) is ignored. */
    const send = (method: string, params: Record<string, unknown>): void => {
      void deps.call(method, params).catch((err: unknown) => deps.logError(`${method}: ${errorText(err)}`))
    }
    /** One copy's id from a plugin's options, checked at its call site (main checks it is this overlay's live copy). */
    const copyOption = (options: unknown, what: string, required: boolean): string | undefined => {
      if (options === undefined && !required) return undefined
      if (typeof options !== 'object' || options === null) throw new TypeError(`overlay ${what}: options must be an object`)
      const copy = (options as { copy?: unknown }).copy
      if (copy === undefined && !required) return undefined
      if (typeof copy !== 'string' || copy === '') throw new TypeError(`overlay ${what}: copy must be the \`copy\` of a from`)
      if (!perView) {
        throw new Error(
          `overlay ${what}: { copy } is for an overlay of a plugin that declares "overlays": { "perView": true }; this overlay has one page`
        )
      }
      return copy
    }
    /** A listener set of the current link, or a no-op disposer once it ended (or never opened). */
    const listen = <L>(pick: (l: OverlayLink) => Set<L>, entry: L): Disposer => {
      const current = link
      if (!current || current.ended) return () => {}
      deps.alive()
      const set = pick(current)
      set.add(entry)
      return () => {
        set.delete(entry)
      }
    }
    const handle: OverlayHandle = {
      result,
      post: (message: JsonValue, options?: { copy?: string }): void => {
        htmlOnly('post')
        // Checked even when the overlay ended: a bad call fails where it is made.
        const copy = copyOption(options, 'post', false)
        if (!link || link.ended) return
        deps.alive()
        overlayMessageText(message)
        send('overlay.post', { pluginId, handle: link.handle, message, ...(copy !== undefined ? { copy } : {}), ...viaNow() })
      },
      onMessage: (listener: (message: JsonValue, from: ViewFrom & { copy?: string }) => void): Disposer => {
        htmlOnly('onMessage')
        if (typeof listener !== 'function') throw new TypeError('overlay onMessage needs a function')
        // Wrapped: the same function registered twice is two registrations, each with its disposer.
        return listen((l) => l.listeners, (m: JsonValue, from: OverlayFrom) => listener(m, from))
      },
      onConnect: (listener: (from: ViewFrom & { copy: string }) => void): Disposer => {
        htmlOnly('onConnect')
        if (typeof listener !== 'function') throw new TypeError('overlay onConnect needs a function')
        // Accepted on any html overlay so one plugin's code runs on either kind; only a perView one connects.
        const entry = (from: ViewFrom & { copy: string }): void => listener(from)
        const dispose = listen((l) => l.connectListeners, entry)
        // The copies already up hear it now (replayConnects), so a late listener misses none.
        if (link && !link.ended && link.connectListeners.has(entry)) overlays.replayConnects(link, entry)
        return dispose
      },
      onDisconnect: (listener: (from: ViewFrom & { copy: string }) => void): Disposer => {
        htmlOnly('onDisconnect')
        if (typeof listener !== 'function') throw new TypeError('overlay onDisconnect needs a function')
        return listen((l) => l.disconnectListeners, (from: ViewFrom & { copy: string }) => listener(from))
      },
      hide: (options: { copy: string }): void => {
        htmlOnly('hide')
        if (!perView) {
          throw new Error('overlay hide: only an overlay of a plugin that declares "overlays": { "perView": true } has copies to hide; use close()')
        }
        const copy = copyOption(options, 'hide', true) as string
        if (!link || link.ended) return
        deps.alive()
        // Fire and forget like post: main releases that copy in its own view only (a guest's hide holds for
        // every view of that guest) and refuses a copy that is not this overlay's.
        send('overlay.hide', { pluginId, handle: link.handle, copy })
      },
      close: (): void => {
        if (!link || link.ended) return
        deps.alive()
        send('overlay.close', { pluginId, handle: link.handle })
      },
      focus: (): void => {
        if (!link || link.ended) return
        deps.alive()
        send('overlay.focus', { pluginId, handle: link.handle })
      },
      onButton: (id: string, handler: (from: ViewFrom) => unknown): Disposer => {
        if (typeof id !== 'string' || typeof handler !== 'function') throw new TypeError('overlay onButton needs an id and a function')
        const current = link
        if (!current || current.ended) return () => {}
        deps.alive()
        const entry: FromHandler = (from) => handler(from)
        const set = current.buttonHandlers.get(id) ?? new Set<FromHandler>()
        set.add(entry)
        current.buttonHandlers.set(id, set)
        return () => {
          set.delete(entry)
        }
      },
      setButtons: (buttons: OverlayButton[]): void => {
        // Checked even when the overlay ended or is not up yet: a bad call fails where it is made.
        const clean = parseOverlayButtons(buttons)
        if (!link || link.ended) return
        deps.alive()
        // Fire and forget like post; main checks the list again and applies it to this plugin's
        // overlay of this handle only (held until the overlay exists). The port keeps order.
        send('overlay.setButtons', { pluginId, handle: link.handle, buttons: clean, ...viaNow() })
      },
      // Any kind (a terminal overlay has a title too). Checked at the call site; main keeps only this host's plugins.
      addSources: (pluginIds: readonly string[]): void => {
        if (!Array.isArray(pluginIds)) throw new TypeError('overlay addSources needs an array of plugin ids')
        const ids = cleanSources(pluginIds, deps.isHostPlugin)
        if (!link || link.ended || ids.length === 0) return
        deps.alive()
        // Fire and forget like post, and on the same port before it: a post after this call reaches main
        // after the sources grew, so the content it carries never reaches a guest who may not see them.
        send('overlay.addSources', { pluginId, handle: link.handle, ids })
      },
      setDiscussPrimary: (on: boolean): void => {
        if (typeof on !== 'boolean') throw new TypeError('setDiscussPrimary needs a boolean')
        if (!link || link.ended) return
        deps.alive()
        // Fire and forget like setButtons; held in main until the overlay exists.
        send('overlay.discussPrimary', { pluginId, handle: link.handle, on })
      },
      onDiscuss: (handler: (from: ViewFrom) => Promise<{ text: string } | null> | { text: string } | null): Disposer => {
        if (typeof handler !== 'function') throw new TypeError('overlay onDiscuss needs a function')
        const current = link
        if (!current || current.ended) return () => {}
        deps.alive()
        const entry: FromHandler = (from) => handler(from)
        // Main shows Discuss on an untyped overlay only while it has a handler: told on the first
        // one and when the last goes (fire and forget, held in main until the overlay exists).
        const first = current.discussHandlers.size === 0
        current.discussHandlers.add(entry)
        if (first) send('overlay.discussable', { pluginId, handle: current.handle, on: true })
        return () => {
          if (!current.discussHandlers.delete(entry) || current.ended) return
          if (current.discussHandlers.size === 0) send('overlay.discussable', { pluginId, handle: current.handle, on: false })
        }
      }
    }
    return Object.freeze(handle)
  }

  return {
    panels: Object.freeze({
      post: (panelId: string, message: JsonValue, options?: { view?: string }): void => {
        deps.alive()
        const id = htmlPanel(deps, panelId, 'panels.post')
        const view = options?.view
        // Only a view a listener was told of (or 'desktop') names a page; anything else is a bug in
        // the plugin, not a message to drop quietly.
        if (view !== undefined && view !== DESKTOP_VIEW && viewIdOf(view) === undefined) {
          throw new TypeError(`panels.post: view must be the \`view\` a panels.onMessage listener got, not ${JSON.stringify(view)}`)
        }
        ports.post(pluginId, id, message, view)
      },
      onMessage: (panelId: string, listener: MessageListener): Disposer => {
        deps.alive()
        const id = htmlPanel(deps, panelId, 'panels.onMessage')
        if (typeof listener !== 'function') throw new TypeError('panels.onMessage needs a function')
        return ports.onMessage(pluginId, id, listener)
      },
      show: (panelId: string): void => {
        deps.alive()
        // Either kind: `ccc browser open` must bring its webview panel into sight.
        const id = declared(deps, panelId, 'panels.show')
        // Fire and forget like badge: a refusal from main is logged, not thrown.
        void deps.call('panels.show', { pluginId, panelId: id }).catch((err: unknown) => {
          deps.logError(`panels.show ${id}: ${errorText(err)}`)
        })
      },
      header: (panelId: string, header: unknown): void => {
        deps.alive()
        // Either kind: a webview panel's title bar is the same header (its toolbar sits below).
        const id = declared(deps, panelId, 'panels.header')
        // Throws here, at the plugin's call site, for anything main would refuse (main checks again).
        const clean = parsePanelHeader(header)
        deps.headerUsed?.()
        // Fire and forget like badge: a refusal from main is logged, not thrown. The port keeps
        // order, so the last call is the header that shows.
        void deps.call('panels.header', { pluginId, panelId: id, header: clean }).catch((err: unknown) => {
          deps.logError(`panels.header ${id}: ${errorText(err)}`)
        })
      },
      slots: (panelId: string, placements: unknown): void => {
        deps.alive()
        // Either kind, as main allows (its column is the shell's, not the page's).
        const id = declared(deps, panelId, 'panels.slots')
        // Throws here, at the plugin's call site, for anything main would refuse (main checks again).
        const clean = parseSlotPlacements(placements)
        const listed = deps.panelSlots?.[id] ?? []
        for (const p of clean ?? []) {
          if (isAppSlotType(p.type)) throw new Error(`panels.slots: "${p.type}" is placed by the app, not by a panel`)
          if (!listed.includes(p.type)) {
            throw new Error(`panels.slots: panel ${id} does not list slot "${p.type}" in plugin.json contributes.panels[].slots`)
          }
        }
        deps.slotsUsed?.()
        // Fire and forget like panels.header: a refusal from main is logged. The port keeps order,
        // so the last call is the layout that shows.
        void deps.call('panels.slots', { pluginId, panelId: id, placements: clean }).catch((err: unknown) => {
          deps.logError(`panels.slots ${id}: ${errorText(err)}`)
        })
      },
      onAction: (panelId: string, listener: ActionListener): Disposer => {
        deps.alive()
        const id = declared(deps, panelId, 'panels.onAction')
        if (typeof listener !== 'function') throw new TypeError('panels.onAction needs a function')
        return actions.onAction(pluginId, id, listener)
      }
    }),
    badge: (panelId: string, value: BadgeValue): void => {
      deps.alive()
      const id = declared(deps, panelId, 'badge')
      const clean = checkBadge(value)
      // Fire and forget (the API is synchronous): a refusal from main is logged, not thrown.
      void deps.call('badge', { pluginId, panelId: id, value: clean }).catch((err: unknown) => {
        deps.logError(`badge ${id}: ${errorText(err)}`)
      })
    },
    overlay: Object.freeze({
      open: (spec: OverlaySpec): Promise<OverlayResult> => start(spec).result,
      start,
      buttons: (type: string, provider: (o: OverlayInfo) => OverlayTypeButton[] | Promise<OverlayTypeButton[]>): Disposer => {
        deps.alive()
        const off = deps.typeButtons.register(pluginId, type, provider)
        deps.typeButtonsUsed?.()
        return off
      }
    })
  }
}
