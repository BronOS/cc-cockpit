// ctx.tabs (design-editor.md §1 "Core: page tabs"): tabs in the main tab bar whose content is this
// plugin's page (the editor's file tabs). The types are the manifest's (`contributes.tabs`); main
// keeps the tab (title, params, unseen dot, dirty per view) and decides everything about it.
//
//   ctx.tabs.openPage(type, params, { title, icon?, focus? })  a new page tab in this project's
//                                      window -> its id (main's); budgeted per plugin in main
//   ctx.tabs.onOpen(type, listener)    a frame of a tab of `type` connected in a view: the listener
//                                      gets a PageTabInstance (its port, params, view, setTitle,
//                                      onDiscuss); again after a host restart, a web reconnect or a
//                                      relay resync (a new line to the same page, never a reload)
//   ctx.tabs.list(type)                this plugin's open page tabs of `type` in the project
//   ctx.tabs.focus(id)                 select one of them (a file that already has a tab); main
//                                      checks the tab is the plugin's own, openPage's budget
//   ctx.tabs.close(id)                 close one the person's way (core's ask for unsaved text);
//                                      ctx.sessions.close's budget
//
// Frames are the shell's, as for slots: main hands this host one end of the frame's channel,
// tagged `{ "pageTabOpen": { pluginId, id, type, params?, view? } }` with the port in its transfer
// list (HostManager.sendPageTabPort, host/index.ts receivePort). The line ends with main's
// `pageTab.close { pluginId, id, view? }` event or the page's end of the port closing. Main never
// closes the host's end itself (panel-ports.ts tellPageTabClosed): the close here is the one that
// ends it, and a close for an id this host never opened (the first reconnect after a host restart)
// is ignored. Messages on the port follow the panel rules (host/ctx/ui.ts): ONE JSON string each,
// the same 1 MiB cap.
//
// Discuss (design-editor.md §4 "Ask Claude"): core draws the question box over the tab; main asks
// `pageTab.discuss { pluginId, id, view? }` for the context, and the instance of THAT view (its
// selection is the one the person sees) answers through its `onDiscuss` handlers.
import type { Disposer, JsonValue, PageTabInfo, PageTabInstance, PluginContext } from '../../sdk/types'
import { MAX_DISCUSS_TEXT } from '../../shared/discuss'
import { errorText } from '../../shared/error-text'
import {
  MAX_PAGE_TAB_PARAMS_BYTES,
  PAGE_TAB_ICON_PATTERN,
  PAGE_TAB_ID_PATTERN,
  PAGE_TAB_TITLE_MAX,
  PAGE_TAB_TYPE_PATTERN
} from '../../shared/page-tabs'
import { viewIdOf, type ViewId } from '../../shared/views'
import { dispatchInView } from './origin-view'
import { decodePortMessage, encodePortMessage, type PanelPort } from './ui'

type MessageListener = (message: JsonValue) => void
type DiscussHandler = () => unknown

/** main's tag: the params are at most 4 KiB as JSON, so the tag may be longer than a panel's. */
const MAX_PAGE_TAB_TAG_LENGTH = MAX_PAGE_TAB_PARAMS_BYTES * 4 + 1024

export interface PageTabOpenTag {
  pluginId: string
  /** main's tab id (a UUID): the same in every view, stable for the tab's life. */
  id: string
  type: string
  params?: JsonValue
  /** The remote view whose frame this is; absent: the desktop window's. */
  view?: ViewId
}

/** The frames map's key: one tab id per view (absent view: the desktop window's). */
function frameKey(pluginId: string, id: string, view: ViewId | undefined): string {
  return view === undefined ? `${pluginId}/${id}` : `${pluginId}/${id}\n${view}`
}

/** main's port message `{ "pageTabOpen": {...} }` (sent with the port), or undefined for anything else. */
export function pageTabOpenTag(data: unknown): PageTabOpenTag | undefined {
  if (typeof data !== 'string' || data.length > MAX_PAGE_TAB_TAG_LENGTH) return undefined
  try {
    const tag = (JSON.parse(data) as { pageTabOpen?: Record<string, unknown> } | null)?.pageTabOpen
    if (typeof tag !== 'object' || tag === null) return undefined
    const { pluginId, id, type, params } = tag
    if (typeof pluginId !== 'string' || typeof id !== 'string' || !PAGE_TAB_ID_PATTERN.test(id)) return undefined
    if (typeof type !== 'string' || !PAGE_TAB_TYPE_PATTERN.test(type)) return undefined
    // A view main did not mint is refused, never read as the desktop's frame (it would close it).
    const view = viewIdOf(tag.view)
    if (tag.view !== undefined && view === undefined) return undefined
    return {
      pluginId,
      id,
      type,
      ...(params !== undefined ? { params: params as JsonValue } : {}),
      ...(view !== undefined ? { view } : {})
    }
  } catch {
    // Not one of main's port messages.
  }
  return undefined
}

/** One connected frame of a page tab in one view: the plugin's side. */
interface Frame {
  readonly pluginId: string
  readonly id: string
  readonly view: ViewId | undefined
  readonly port: PanelPort
  readonly unsubscribe: () => void
  readonly messageListeners: Set<MessageListener>
  readonly closeListeners: Set<() => void>
  readonly discussHandlers: Set<DiscussHandler>
  ended: boolean
}

/** The connected page tab frames and `onOpen` listeners of every plugin of one host. */
export class PageTabHub {
  /** `<pluginId>/<type>` -> listeners. */
  private readonly openers = new Map<string, Set<(tab: PageTabInstance) => void>>()
  /** frameKey(pluginId, tabId, view) -> frame. */
  private readonly frames = new Map<string, Frame>()

  constructor(
    private readonly log: (pluginId: string, message: string) => void,
    /** A request to main (`tabs.setTitle` from an instance). */
    private readonly call: (method: string, params: unknown) => Promise<unknown>
  ) {}

  onOpen(pluginId: string, type: string, listener: (tab: PageTabInstance) => void): Disposer {
    const key = `${pluginId}/${type}`
    const set = this.openers.get(key) ?? new Set<(tab: PageTabInstance) => void>()
    // Wrapped: the same function registered twice is two registrations, each with its disposer.
    const entry = (tab: PageTabInstance): void => listener(tab)
    set.add(entry)
    this.openers.set(key, set)
    return () => {
      set.delete(entry)
      if (set.size === 0 && this.openers.get(key) === set) this.openers.delete(key)
    }
  }

  /**
   * A frame connected (host/index.ts calls this for main's `pageTabOpen` port; the caller checked
   * the plugin runs here and declares the type). The same tab's line IN THE SAME VIEW is ended
   * first (a reconnect: main says close too, but the order of the two is not guaranteed); the same
   * tab in another view is another instance and stays.
   */
  open(tag: PageTabOpenTag, port: PanelPort): void {
    const key = frameKey(tag.pluginId, tag.id, tag.view)
    const old = this.frames.get(key)
    if (old) this.end(old)
    const frame: Frame = {
      pluginId: tag.pluginId,
      id: tag.id,
      view: tag.view,
      port,
      unsubscribe: port.onMessage((raw) => this.receive(frame, raw)),
      messageListeners: new Set(),
      closeListeners: new Set(),
      discussHandlers: new Set(),
      ended: false
    }
    this.frames.set(key, frame)
    const tab = this.instanceOf(frame, tag)
    const listeners = [...(this.openers.get(`${tag.pluginId}/${tag.type}`) ?? [])]
    // A connect that lands before activate() registered tabs.onOpen would leave the page with
    // nobody serving it, silently: say so.
    if (listeners.length === 0) this.log(tag.pluginId, `a "${tag.type}" page tab connected but no tabs.onOpen listener is registered for it (yet)`)
    for (const listener of listeners) {
      try {
        dispatchInView(
          tag.view,
          () => listener(tab),
          (err) => this.log(tag.pluginId, `a tabs.onOpen listener failed: ${errorText(err)}`)
        )
      } catch (err) {
        this.log(tag.pluginId, `a tabs.onOpen listener threw: ${errorText(err)}`)
      }
    }
  }

  /**
   * main's `pageTab.close { pluginId, id, view? }`, or the page's port closing (`port`: only that
   * frame's own). Only the frame of that id in `view`; an id never opened here is ignored.
   */
  close(pluginId: string, id: string, view?: ViewId, port?: PanelPort): void {
    const frame = this.frames.get(frameKey(pluginId, id, view))
    if (frame && (port === undefined || frame.port === port)) this.end(frame)
  }

  /**
   * main's `pageTab.discuss { pluginId, id, view? }`: the onDiscuss handlers of that view's instance,
   * in the order added; the first `{ text }` wins, null passes on, all null (or no instance) is no
   * extra context. A throw or another shape fails the ask (main shows it and sends nothing). The text
   * is cut to the whole message's cap here so a huge answer never crosses the port.
   */
  async discuss(params: unknown): Promise<{ text: string } | null> {
    const { pluginId, id, view: rawView } = (params ?? {}) as Record<string, unknown>
    if (typeof pluginId !== 'string' || typeof id !== 'string') throw new Error('pageTab.discuss: bad tab')
    const view = viewIdOf(rawView)
    if (rawView !== undefined && view === undefined) return null
    const frame = this.frames.get(frameKey(pluginId, id, view))
    if (!frame || frame.ended) return null
    for (const handler of [...frame.discussHandlers]) {
      let answer: unknown
      try {
        // The rejection is handled by this await; without an onReject origin-view rethrows it in its
        // own `.then` too, which logs a second, unhandled one beside the real error.
        answer = await dispatchInView(frame.view, handler, () => undefined)
      } catch (err) {
        this.log(pluginId, `a page tab onDiscuss handler threw: ${errorText(err)}`)
        throw err
      }
      if (answer === null || answer === undefined) continue
      const text = (answer as { text?: unknown }).text
      if (typeof answer !== 'object' || typeof text !== 'string') {
        this.log(pluginId, 'a page tab onDiscuss handler answered something other than { text } or null')
        throw new TypeError('onDiscuss must answer { text } or null')
      }
      return { text: text.slice(0, MAX_DISCUSS_TEXT) }
    }
    return null
  }

  /** The plugin is gone: its frames end (onClose runs) and its listeners drop. */
  removePlugin(pluginId: string): void {
    for (const frame of [...this.frames.values()]) if (frame.pluginId === pluginId) this.end(frame)
    const prefix = `${pluginId}/`
    for (const key of [...this.openers.keys()]) if (key.startsWith(prefix)) this.openers.delete(key)
  }

  /** How many frames of the plugin are connected (tests). */
  openCount(pluginId: string): number {
    let n = 0
    for (const f of this.frames.values()) if (f.pluginId === pluginId) n++
    return n
  }

  private end(frame: Frame): void {
    if (frame.ended) return
    frame.ended = true
    const key = frameKey(frame.pluginId, frame.id, frame.view)
    if (this.frames.get(key) === frame) this.frames.delete(key)
    frame.unsubscribe()
    try {
      frame.port.close()
    } catch {
      // Already closed on the other side.
    }
    const closers = [...frame.closeListeners]
    frame.messageListeners.clear()
    frame.closeListeners.clear()
    frame.discussHandlers.clear()
    for (const listener of closers) {
      try {
        listener()
      } catch (err) {
        this.log(frame.pluginId, `a page tab onClose listener threw: ${errorText(err)}`)
      }
    }
  }

  private instanceOf(frame: Frame, tag: PageTabOpenTag): PageTabInstance {
    const post = (message: JsonValue): void => {
      const text = encodePortMessage(message, 'page tab post')
      if (frame.ended) return
      try {
        frame.port.postMessage(text)
      } catch (err) {
        this.log(frame.pluginId, `page tab post to ${frame.id} failed: ${errorText(err)}`)
      }
    }
    const onMessage = (listener: MessageListener): Disposer => {
      if (typeof listener !== 'function') throw new TypeError('page tab onMessage needs a function')
      if (frame.ended) return () => {}
      const entry: MessageListener = (m) => listener(m)
      frame.messageListeners.add(entry)
      return () => {
        frame.messageListeners.delete(entry)
      }
    }
    const onClose = (listener: () => void): Disposer => {
      if (typeof listener !== 'function') throw new TypeError('page tab onClose needs a function')
      if (frame.ended) {
        // Registered after the end: told at once, so a late listener still cleans up.
        queueMicrotask(() => {
          try {
            listener()
          } catch (err) {
            this.log(frame.pluginId, `a page tab onClose listener threw: ${errorText(err)}`)
          }
        })
        return () => {}
      }
      const entry = (): void => listener()
      frame.closeListeners.add(entry)
      return () => {
        frame.closeListeners.delete(entry)
      }
    }
    const onDiscuss = (handler: DiscussHandler): Disposer => {
      if (typeof handler !== 'function') throw new TypeError('page tab onDiscuss needs a function')
      if (frame.ended) return () => {}
      const entry: DiscussHandler = () => handler()
      frame.discussHandlers.add(entry)
      return () => {
        frame.discussHandlers.delete(entry)
      }
    }
    const setTitle = async (title: string, icon?: string): Promise<void> => {
      checkTitle(title, 'setTitle')
      if (icon !== undefined && (typeof icon !== 'string' || !PAGE_TAB_ICON_PATTERN.test(icon))) {
        throw new TypeError(`page tab setTitle: icon must match ${PAGE_TAB_ICON_PATTERN.source}`)
      }
      // The tab outlives this line (a reconnect makes a new instance): main checks the tab is still
      // this plugin's and open, not whether this instance is current.
      await this.call('tabs.setTitle', { pluginId: frame.pluginId, tabId: frame.id, title, ...(icon !== undefined ? { icon } : {}) })
    }
    return Object.freeze({
      id: tag.id,
      type: tag.type,
      params: tag.params === undefined ? undefined : structuredClone(tag.params),
      view: tag.view,
      post,
      onMessage,
      onClose,
      onDiscuss,
      setTitle
    }) as PageTabInstance
  }

  /** A message from the tab's page: a JSON string within the cap, else dropped (logged). */
  private receive(frame: Frame, raw: unknown): void {
    const got = decodePortMessage(raw)
    if (!got.ok) {
      this.log(frame.pluginId, `dropped a message from page tab ${frame.id}: ${got.reason === 'size' ? 'not a JSON string within the size cap' : 'not JSON'}`)
      return
    }
    for (const listener of [...frame.messageListeners]) {
      try {
        dispatchInView(
          frame.view,
          () => listener(structuredClone(got.value)),
          (err) => this.log(frame.pluginId, `a page tab onMessage listener failed: ${errorText(err)}`)
        )
      } catch (err) {
        this.log(frame.pluginId, `a page tab onMessage listener threw: ${errorText(err)}`)
      }
    }
  }
}

/** A fast check of a title (main clamps and checks it again): text with something to show. */
function checkTitle(title: unknown, what: string): void {
  if (typeof title !== 'string' || title.trim() === '') throw new TypeError(`tabs.${what}: title must be non-empty text`)
  // Main cuts at PAGE_TAB_TITLE_MAX; a title far past that is a mistake, not a long name.
  if (title.length > PAGE_TAB_TITLE_MAX * 16) throw new TypeError(`tabs.${what}: title is far longer than ${PAGE_TAB_TITLE_MAX} characters`)
}

export interface TabsApiDeps {
  pluginId: string
  /** The types the manifest's `contributes.tabs` declares; every call accepts only these. */
  types: readonly string[]
  call(method: string, params: unknown): Promise<unknown>
  /** Throws when the plugin is deactivated. */
  alive(): void
  guardAsync<T>(body: () => Promise<T>): Promise<T>
  hub: PageTabHub
}

export function createTabsApi(deps: TabsApiDeps): PluginContext['tabs'] {
  const { pluginId, types, call, guardAsync } = deps
  const declared = (type: unknown, what: string): string => {
    if (typeof type !== 'string' || !types.includes(type)) {
      throw new Error(`tabs.${what}: "${String(type)}" is not declared in plugin.json contributes.tabs`)
    }
    return type
  }
  return Object.freeze({
    openPage: (type: string, params: JsonValue | undefined, options: { title: string; icon?: string; focus?: boolean }): Promise<string> =>
      guardAsync(async () => {
        declared(type, 'openPage')
        const { title, icon, focus } = (options ?? {}) as Record<string, unknown>
        checkTitle(title, 'openPage')
        if (icon !== undefined && (typeof icon !== 'string' || !PAGE_TAB_ICON_PATTERN.test(icon))) {
          throw new TypeError(`tabs.openPage: icon must match ${PAGE_TAB_ICON_PATTERN.source}`)
        }
        if (focus !== undefined && typeof focus !== 'boolean') throw new TypeError('tabs.openPage: focus must be a boolean')
        const res = (await call('tabs.openPage', {
          pluginId,
          type,
          ...(params !== undefined ? { params } : {}),
          title,
          ...(icon !== undefined ? { icon } : {}),
          ...(focus !== undefined ? { focus } : {})
        })) as { tabId?: unknown } | null
        if (typeof res?.tabId !== 'string') throw new Error('tabs.openPage: the app answered no tab id')
        return res.tabId
      }),
    onOpen: (type: string, listener: (tab: PageTabInstance) => void): Disposer => {
      deps.alive()
      declared(type, 'onOpen')
      if (typeof listener !== 'function') throw new TypeError('tabs.onOpen needs a function')
      return deps.hub.onOpen(pluginId, type, listener)
    },
    list: (type: string): Promise<PageTabInfo[]> =>
      guardAsync(async () => {
        declared(type, 'list')
        const res = await call('tabs.list', { pluginId, type })
        return Array.isArray(res) ? (res as PageTabInfo[]) : []
      }),
    focus: (tabId: string): Promise<void> =>
      guardAsync(async () => {
        if (typeof tabId !== 'string' || !PAGE_TAB_ID_PATTERN.test(tabId)) throw new TypeError('tabs.focus: tabId must be a page tab id')
        await call('tabs.focus', { pluginId, tabId })
      }),
    close: (tabId: string): Promise<{ closed: boolean }> =>
      guardAsync(async () => {
        if (typeof tabId !== 'string' || !PAGE_TAB_ID_PATTERN.test(tabId)) throw new TypeError('tabs.close: tabId must be a page tab id')
        const res = (await call('tabs.close', { pluginId, tabId })) as { closed?: unknown } | null
        return { closed: res?.closed === true }
      })
  })
}
