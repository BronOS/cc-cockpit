// ctx.panels, ctx.badge and ctx.overlay (design §5 › UI).
//
//   badge(panelId, n | 'dot' | null)   one of the plugin's OWN declared panels; main checks again
//                                      (src/main/plugins/host-api.ts) against the host's scope
//   overlay.open(spec)                 terminal (argv only), url (http/https), html (a file of the
//                                      plugin's own folder, read by main); resolves when it closes
//   overlay.start(spec)                the same overlay as a handle: { result, post, onMessage, close,
//                                      focus }; open(spec) is start(spec).result
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
// listeners. Once the overlay ended, post/close do nothing and the listeners are dropped.
import { randomUUID } from 'node:crypto'
import type {
  BadgeValue,
  Disposer,
  JsonValue,
  OverlayHandle,
  OverlayResult,
  OverlaySpec,
  PluginContext
} from '../../sdk/types'
import { MAX_OVERLAY_MESSAGE_LENGTH } from '../../shared/overlay-message'
import { parsePanelHeader } from '../../shared/panel-header'
import { isAppSlotType, parseSlotPlacements } from '../../shared/slots'
import { errorText } from '../../shared/error-text'

/** Longest panel message, as JSON text (the RPC cap). */
export const MAX_PANEL_MESSAGE_LENGTH = 1024 * 1024

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
 * The plugin and panel id of main's port message `{ "panelPort": { pluginId, panelId } }` (sent
 * with the port in its transfer list, host/index.ts), or undefined for anything else.
 */
export function panelPortTag(data: unknown): { pluginId: string; panelId: string } | undefined {
  if (typeof data !== 'string' || data.length > 1000) return undefined
  try {
    const tag = (JSON.parse(data) as { panelPort?: { pluginId?: unknown; panelId?: unknown } } | null)?.panelPort
    if (typeof tag?.pluginId === 'string' && typeof tag.panelId === 'string') return { pluginId: tag.pluginId, panelId: tag.panelId }
  } catch {
    // Not one of main's port messages.
  }
  return undefined
}

type MessageListener = (message: JsonValue) => void

interface Attached {
  port: PanelPort
  unsubscribe: () => void
}

/** The panel ports and message listeners of every plugin of one host, keyed `<pluginId>/<panelId>`. */
export class PanelPorts {
  private readonly ports = new Map<string, Attached>()
  private readonly listeners = new Map<string, Set<MessageListener>>()

  constructor(private readonly log: (pluginId: string, message: string) => void) {}

  /**
   * A panel (re)connected: `port` replaces the previous one, which is closed (a reloaded iframe
   * gets a new port, and the old page must not keep talking). The caller checked that the plugin
   * runs here and declares the panel.
   */
  attach(pluginId: string, panelId: string, port: PanelPort): void {
    const key = `${pluginId}/${panelId}`
    this.detach(pluginId, panelId)
    const unsubscribe = port.onMessage((raw) => this.receive(pluginId, key, raw))
    this.ports.set(key, { port, unsubscribe })
  }

  /**
   * The panel went away: close its port. Listeners stay for the next one. With `port`, only when
   * that is still the panel's port: the close of an old page's port can arrive after its reload
   * already attached the new one.
   */
  detach(pluginId: string, panelId: string, port?: PanelPort): void {
    const key = `${pluginId}/${panelId}`
    const old = this.ports.get(key)
    if (!old || (port !== undefined && old.port !== port)) return
    this.ports.delete(key)
    old.unsubscribe()
    try {
      old.port.close()
    } catch {
      // Already closed on the other side.
    }
  }

  /** Whether the panel has a port now (a post would be delivered). */
  connected(pluginId: string, panelId: string): boolean {
    return this.ports.has(`${pluginId}/${panelId}`)
  }

  /** Send to the panel; false when it has no port (the message is dropped). */
  post(pluginId: string, panelId: string, message: unknown): boolean {
    let text: string | undefined
    try {
      text = JSON.stringify(message)
    } catch (err) {
      throw new TypeError(`panels.post: the message is not JSON: ${errorText(err)}`, { cause: err })
    }
    if (text === undefined) throw new TypeError('panels.post: the message is not JSON')
    if (text.length > MAX_PANEL_MESSAGE_LENGTH) {
      throw new RangeError(`panels.post: message of ${text.length} chars exceeds ${MAX_PANEL_MESSAGE_LENGTH}`)
    }
    const attached = this.ports.get(`${pluginId}/${panelId}`)
    if (!attached) return false
    try {
      attached.port.postMessage(text)
      return true
    } catch (err) {
      this.log(pluginId, `panels.post to ${panelId} failed: ${errorText(err)}`)
      return false
    }
  }

  onMessage(pluginId: string, panelId: string, listener: MessageListener): Disposer {
    const key = `${pluginId}/${panelId}`
    const set = this.listeners.get(key) ?? new Set<MessageListener>()
    const entry: MessageListener = (m) => listener(m)
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
   * listener gets its own parsed copy.
   */
  private receive(pluginId: string, key: string, raw: unknown): void {
    if (typeof raw !== 'string' || raw.length > MAX_PANEL_MESSAGE_LENGTH) {
      this.log(pluginId, `dropped a message from panel ${key}: not a JSON string within the size cap`)
      return
    }
    let parsed: JsonValue
    try {
      parsed = JSON.parse(raw) as JsonValue
    } catch {
      this.log(pluginId, `dropped a message from panel ${key}: not JSON`)
      return
    }
    for (const listener of [...(this.listeners.get(key) ?? [])]) {
      try {
        listener(structuredClone(parsed))
      } catch (err) {
        this.log(pluginId, `a panels.onMessage listener threw: ${errorText(err)}`)
      }
    }
  }
}

type ActionListener = (actionId: string) => void

/**
 * The ctx.panels.onAction listeners of every plugin of one host, keyed `<pluginId>/<panelId>`,
 * and the routing of main's `panel.action { pluginId, panelId, actionId }` to them. Main only
 * sends a click on an action the plugin's current header has (not busy, not disabled), so nothing
 * is re-checked here beyond the shape; a click that arrives after the plugin cleared its header
 * (it raced the IPC) just reaches listeners that know what to ignore.
 */
export class PanelActions {
  private readonly listeners = new Map<string, Set<ActionListener>>()

  constructor(private readonly log: (pluginId: string, message: string) => void) {}

  onAction(pluginId: string, panelId: string, listener: ActionListener): Disposer {
    const key = `${pluginId}/${panelId}`
    const set = this.listeners.get(key) ?? new Set<ActionListener>()
    // Wrapped: the same function registered twice is two registrations, each with its disposer.
    const entry: ActionListener = (id) => listener(id)
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

  /** main's `panel.action`; anything malformed is dropped. */
  handleEvent(params: unknown): void {
    const { pluginId, panelId, actionId } = (params ?? {}) as Record<string, unknown>
    if (typeof pluginId !== 'string' || typeof panelId !== 'string' || typeof actionId !== 'string') return
    for (const listener of [...(this.listeners.get(`${pluginId}/${panelId}`) ?? [])]) {
      try {
        listener(actionId)
      } catch (err) {
        this.log(pluginId, `a panels.onAction listener threw: ${errorText(err)}`)
      }
    }
  }
}

/** One ctx.overlay.start handle of this host, while its overlay is open. */
interface OverlayLink {
  readonly pluginId: string
  readonly handle: string
  readonly listeners: Set<MessageListener>
  ended: boolean
}

/**
 * The open overlay handles of every plugin of one host, keyed `<pluginId>/<handle>`, and the
 * routing of main's `overlay.message { pluginId, handle, message }` to their listeners.
 */
export class OverlayLinks {
  private readonly links = new Map<string, OverlayLink>()

  constructor(private readonly log: (pluginId: string, message: string) => void) {}

  open(pluginId: string): OverlayLink {
    const link: OverlayLink = { pluginId, handle: randomUUID(), listeners: new Set(), ended: false }
    this.links.set(`${pluginId}/${link.handle}`, link)
    return link
  }

  /** The overlay ended: post/close become no-ops and its listeners are dropped. */
  end(link: OverlayLink): void {
    link.ended = true
    link.listeners.clear()
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

  /** main's `overlay.message`; anything malformed or for an ended handle is dropped. */
  handleEvent(params: unknown): void {
    const { pluginId, handle, message } = (params ?? {}) as Record<string, unknown>
    if (typeof pluginId !== 'string' || typeof handle !== 'string') return
    const link = this.links.get(`${pluginId}/${handle}`)
    if (!link || link.ended) return
    for (const listener of [...link.listeners]) {
      try {
        // Each listener its own copy, as for panels: one cannot change what the next one sees.
        listener(structuredClone(message as JsonValue))
      } catch (err) {
        this.log(pluginId, `an overlay onMessage listener threw: ${errorText(err)}`)
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

  const start = (spec: OverlaySpec): OverlayHandle => {
    const html = typeof spec === 'object' && spec !== null && (spec as { kind?: unknown }).kind === 'html'
    /** Made when the request goes out (below); stays undefined when the call is refused first. */
    let link: OverlayLink | undefined
    const result = deps.guardAsync(async () => {
      if (typeof spec !== 'object' || spec === null) throw new TypeError('overlay.open needs a spec object')
      link = overlays.open(pluginId)
      try {
        // No timeout: the overlay is open until the user (or its program) ends it. A host that
        // stops rejects it (the RPC closes) and main dismisses the overlay; a ctx disposed in a
        // running host (reload, unload) resolves it as dismissed (main closes it on `plugin.disposed`). The request goes out
        // synchronously, inside start(), so a post right after start() reaches main behind it.
        return (await deps.call(
          'overlay.open',
          { pluginId, spec, handle: link.handle },
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
    return Object.freeze({
      result,
      post: (message: JsonValue): void => {
        htmlOnly('post')
        if (!link || link.ended) return
        deps.alive()
        overlayMessageText(message)
        send('overlay.post', { pluginId, handle: link.handle, message })
      },
      onMessage: (listener: MessageListener): Disposer => {
        htmlOnly('onMessage')
        if (typeof listener !== 'function') throw new TypeError('overlay onMessage needs a function')
        const current = link
        if (!current || current.ended) return () => {}
        deps.alive()
        const entry: MessageListener = (m) => listener(m)
        current.listeners.add(entry)
        return () => {
          current.listeners.delete(entry)
        }
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
      }
    })
  }

  return {
    panels: Object.freeze({
      post: (panelId: string, message: JsonValue): void => {
        deps.alive()
        ports.post(pluginId, htmlPanel(deps, panelId, 'panels.post'), message)
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
      start
    })
  }
}
