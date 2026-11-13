// Page tab frames (design-editor.md §1 "Frame lifetime"): the frames that show page tabs, and the
// one place their lifetime is decided. A page tab holds unsaved text (the editor's buffers), so its
// frame must outlive everything that reloads plugin pages today:
//
// - Mount on first select, never at restore: a window that comes back with thirty file tabs loads
//   the one it shows. A small LRU (MAX_LIVE_PAGE_FRAMES) keeps the recently used frames alive and
//   hidden; the least recent one past it is unmounted (its page loads afresh when selected again),
//   never the shown one and never one `keep` holds (a dirty page, Task 3).
// - Host restart (`panels.reload` for the tab's plugin): the frame stays and its page is handed a
//   NEW port with no load (FrameLoads.reconnect); the page re-sends what it holds (`ccPanel.onConnect`).
// - Web reconnect: the web shell remounts its whole React tree (`<App key>` in web/main.tsx), so the
//   frames are not in it. They sit in a layer of their own outside the tree (`attachLayer`, a fixed
//   box laid over the tab area's placeholder), owned by this module for the page's life; a remounted
//   tabs pane finds them here and each live one takes a new port the same way.
// - Relay backlog: main pauses a page tab's port at the byte limit and says `port.resync` once the
//   socket drained; FrameLoads reconnects on it (renderer/web/port-relay.ts).
// - Server mode's hidden page: main answers `pageTabs.src` with null there, so nothing mounts.
//
// Each frame is an iframe sandboxed with `allow-scripts` only, as PluginFrame's, loaded and served
// by FrameLoads (the web shell's navigation guard included): the theme on every served load, then
// the `cc-plugin.tab` intro and the port. Moving an iframe in the document reloads it, which is why
// the frames never move: the layer is placed over the placeholder instead.
//
// DOM-light: the frame elements, the layer and the IPC are passed in, so unit tests drive it with
// fakes in plain Node.

import { TAB_MESSAGE } from '../../sdk/panel-core'
import { FrameLoads, type FrameTarget } from '../web/port-relay'

/**
 * Frames kept alive at most (shown plus hidden). Each is a page with its own scripts (CodeMirror,
 * its buffers); a person switches among a handful of files, and one past this loads again when
 * selected, which costs a second, not text, once a page saves or keeps its own drafts.
 */
export const MAX_LIVE_PAGE_FRAMES = 6

/** One frame element as the pool drives it (an iframe in the app, a fake in tests). */
export interface PageFrameElement {
  /** Navigate it (set `src`). */
  load(url: string): void
  /** Show or hide it (`hidden`: display none keeps the page alive). */
  setHidden(hidden: boolean): void
  /** Post into its page; false when it has no window. */
  post(message: unknown, transfer?: MessagePort[]): boolean
  /** Its `load` events. */
  onLoad(listener: () => void): void
  /** Take it out of the document (its page dies with it). */
  remove(): void
  /** Give it the keyboard (the tab was selected, or a dialog over it went). */
  focus(): void
}

/** A page tab as the pool needs it: main's id, its plugin (for a host restart), its manifest type and title. */
export interface PageTabEntry {
  id: string
  plugin: string
  type: string
  title: string
}

export interface PageFramesOptions {
  /** A new frame element in the layer, hidden, loading nothing yet (`title`: its accessible name). */
  createFrame(title: string): PageFrameElement
  /** The page URL main names for the tab (`pageTabs.src`); null: none here (plugin off, hidden page). */
  src(tabId: string): Promise<string | null>
  /** The URL this shell loads for it (web: the HTTP path, page-paths.ts); undefined: none. */
  pageUrl(src: string): string | undefined
  /** Ask main for the tab's port (`pageTabs.connect`, panel-port-bus.ts); returns the cancel. */
  connect(tabId: string, deliver: (port: MessagePort) => void): () => void
  /** The frame went: main tells the plugin (`pageTabs.disconnect`). */
  disconnect(tabId: string): void
  /** Web shell: only loads the shell started are served (FrameLoads `guard`), ports asked early. */
  guard: boolean
  /** The port message (`cc-plugin.port` with `remote`). */
  portMessage: object
  /** The theme message for a page now; undefined: no theme yet. */
  theme(): object | undefined
  /** A frame the LRU must not unmount (a page with unsaved text, Task 3). */
  keep?(tabId: string): boolean
  maxLive?: number
  log?(message: string): void
}

/** A tab whose frame is live, or whose page is being looked up. */
interface Live {
  readonly tab: PageTabEntry
  /** Undefined while `src` is being looked up. */
  frame?: {
    element: PageFrameElement
    loads: FrameLoads
  }
  /** Set when it was unmounted: a late `src` answer finds it gone. */
  gone?: boolean
}

export class PageFrames {
  /** Live (or looking up) frames, most recently shown first. */
  private live: Live[] = []
  private readonly tabs = new Map<string, PageTabEntry>()
  /** Tabs whose page main named none for: not asked again until reselected or their host restarts. */
  private readonly none = new Set<string>()
  private shown: string | null = null
  private readonly max: number

  constructor(private readonly o: PageFramesOptions) {
    this.max = Math.max(1, o.maxLive ?? MAX_LIVE_PAGE_FRAMES)
  }

  /**
   * The page tabs in the window's list now. A frame of a tab no longer in it is unmounted (the tab
   * closed here or in another view); a changed title is kept for the next frame element.
   */
  sync(tabs: readonly PageTabEntry[]): void {
    const ids = new Set(tabs.map((t) => t.id))
    this.tabs.clear()
    for (const t of tabs) this.tabs.set(t.id, t)
    for (const l of [...this.live]) if (!ids.has(l.tab.id)) this.unmount(l)
    for (const id of [...this.none]) if (!ids.has(id)) this.none.delete(id)
    if (this.shown !== null && !ids.has(this.shown)) this.shown = null
  }

  /**
   * The tab shown now (null: a terminal tab, or none). A page tab's frame mounts on its first show
   * and moves to the front of the LRU; every other live frame is hidden, and the least recent ones
   * past the cap unmount.
   */
  show(tabId: string | null): void {
    const changed = tabId !== this.shown
    this.shown = tabId
    const tab = tabId === null ? undefined : this.tabs.get(tabId)
    if (tab) {
      // Selected again after main had no page for it: worth one more look (the plugin may be on now).
      if (changed) this.none.delete(tab.id)
      let entry = this.live.find((l) => l.tab.id === tab.id)
      if (!entry && !this.none.has(tab.id)) entry = this.mount(tab)
      if (entry) this.live = [entry, ...this.live.filter((l) => l !== entry)]
    }
    for (const l of this.live) l.frame?.element.setHidden(l.tab.id !== this.shown)
    this.trim()
  }

  /**
   * A new port, no reload, for every live frame of these plugins (`panels.reload`: their host
   * restarted or the plugin reloaded), or of all (undefined: a web reconnect). A tab main had no page
   * for is asked again, and mounted now when it is the one shown.
   */
  reconnect(pluginIds?: readonly string[]): void {
    const of = (plugin: string): boolean => pluginIds === undefined || pluginIds.includes(plugin)
    for (const l of this.live) if (of(l.tab.plugin)) l.frame?.loads.reconnect()
    let retry = false
    for (const id of [...this.none]) {
      const tab = this.tabs.get(id)
      if (!tab || !of(tab.plugin)) continue
      this.none.delete(id)
      if (id === this.shown) retry = true
    }
    if (retry) this.show(this.shown)
  }

  /** The tab's frame takes the keyboard, when it is mounted (TabsPane's focusActive). */
  focus(tabId: string): void {
    this.live.find((l) => l.tab.id === tabId)?.frame?.element.focus()
  }

  /** The theme changed: every served page gets it. */
  themeChanged(message: object): void {
    for (const l of this.live) l.frame?.loads.themeChanged(message)
  }

  /** Whether the tab's frame is mounted (or being looked up) now (tests, the tab area). */
  isLive(tabId: string): boolean {
    return this.live.some((l) => l.tab.id === tabId)
  }

  /** The live tab ids, most recently shown first (tests). */
  liveIds(): string[] {
    return this.live.map((l) => l.tab.id)
  }

  /** Every frame unmounts (the window's page goes). */
  disposeAll(): void {
    for (const l of [...this.live]) this.unmount(l)
    this.shown = null
  }

  private mount(tab: PageTabEntry): Live {
    const entry: Live = { tab }
    this.o
      .src(tab.id)
      .catch((err: unknown) => {
        this.o.log?.(`page tab ${tab.id}: asking for its page failed: ${String(err)}`)
        return null
      })
      .then((src) => {
        if (entry.gone) return
        const url = src === null ? undefined : this.o.pageUrl(src)
        if (url === undefined) {
          // No page here: drop it from the live set until it is selected again or its host restarts.
          this.none.add(tab.id)
          this.live = this.live.filter((l) => l !== entry)
          return
        }
        this.start(entry, url)
      })
    return entry
  }

  /** Make the frame element and its loads, and start the load (as PluginFrame's commit does). */
  private start(entry: Live, url: string): void {
    const tabId = entry.tab.id
    // Posted before every port: the page is a page tab of that type (`ccPanel.tab`).
    const intro = Object.freeze({ type: TAB_MESSAGE, tab: Object.freeze({ type: entry.tab.type }) })
    let element = this.element(entry, 0)
    const target: FrameTarget = {
      load: (to) => element.load(to),
      // A new element (a new browsing context) at the shell's own src; the old one goes with its page.
      remount: (gen) => {
        element.remove()
        element = this.element(entry, gen)
        if (entry.frame) entry.frame.element = element
        element.load(url)
      },
      post: (message, transfer) => element.post(message, transfer)
    }
    const loads = new FrameLoads({
      guard: this.o.guard,
      early: true,
      portMessage: this.o.portMessage,
      target,
      theme: () => this.o.theme(),
      intro: () => intro,
      connect: (deliver) => this.o.connect(tabId, deliver),
      log: (m) => this.o.log?.(m)
    })
    entry.frame = { element, loads }
    element.load(url)
    loads.started(url)
  }

  /** A frame element for `entry` whose loads report generation `gen`, shown when its tab is. */
  private element(entry: Live, gen: number): PageFrameElement {
    const el = this.o.createFrame(entry.tab.title)
    el.setHidden(entry.tab.id !== this.shown)
    el.onLoad(() => entry.frame?.loads.loaded(gen))
    return el
  }

  /** Unmount the least recent frames past the cap, never the shown one nor one `keep` holds. */
  private trim(): void {
    let count = this.live.length
    for (let i = this.live.length - 1; i >= 0 && count > this.max; i--) {
      const l = this.live[i]!
      if (l.tab.id === this.shown || this.o.keep?.(l.tab.id) === true) continue
      this.unmount(l)
      count--
    }
  }

  private unmount(entry: Live): void {
    entry.gone = true
    this.live = this.live.filter((l) => l !== entry)
    if (!entry.frame) return
    entry.frame.loads.dispose()
    entry.frame.element.remove()
    entry.frame = undefined
    try {
      this.o.disconnect(entry.tab.id)
    } catch (err) {
      this.o.log?.(`page tab ${entry.tab.id}: telling main it went failed: ${String(err)}`)
    }
  }
}
