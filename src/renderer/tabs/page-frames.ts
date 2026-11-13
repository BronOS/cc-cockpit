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
//   frames are not in it. They sit in a layer of their own outside the tree (a fixed box laid over
//   the tab area's placeholder, PageTabArea.tsx), owned for the page's life; each live one takes a
//   new port the same way at the bridge's new `ready` (ReadyReconnects), not when the tab area
//   mounts again (a layout change or StrictMode remounts it too). The remounted tabs pane starts
//   with an empty list until `tabs.list` answers: `sync(undefined)` until then, so no frame of a
//   tab that is still open is unmounted for not being listed yet.
// - Relay backlog: main pauses a page tab's port at the byte limit and says `port.resync` once the
//   socket drained; FrameLoads reconnects on it (renderer/web/port-relay.ts).
// - Server mode's hidden page: main answers `pageTabs.src` with null there, so nothing mounts.
//
// Dirty (design-editor.md §1 "Dirty and close", Task 3): a page says it holds unsaved changes with
// `ccPanel.tab.setDirty` (`cc-plugin.tab-dirty` to its parent, read only from that frame's window);
// the pool keeps it for this view, tells main (`pageTabs.dirty`, kept per view there), never lets the
// LRU unmount such a frame, and says it again after a web reconnect (main dropped the old view's).
//
// Keys (§1 "Keyboard"): in the web shell the intro lists the app's chords (`keys`), the page's SDK
// forwards them (`cc-plugin.tab-key`), and the pool hands a chord on only from the frame that has
// the keyboard. On the desktop no list is sent: main takes the chords before the frame gets them.
//
// Ask Claude (design-editor.md §4): `ccPanel.tab.discuss()` (`cc-plugin.tab-discuss`) opens the
// shell's question box, taken like a chord only from the frame on screen that has the keyboard, so a
// page in the background cannot put a box in front of the person.
//
// Each frame is an iframe sandboxed with `allow-scripts` only, as PluginFrame's, loaded and served
// by FrameLoads (the web shell's navigation guard included): the theme on every served load, then
// the `cc-plugin.tab` intro and the port. Moving an iframe in the document reloads it, which is why
// the frames never move: the layer is placed over the placeholder instead.
//
// DOM-light: the frame elements, the layer and the IPC are passed in, so unit tests drive it with
// fakes in plain Node.

import type { TabInfo } from '../../shared/ipc'
import { TAB_DIRTY_MESSAGE, TAB_DISCUSS_MESSAGE, TAB_KEY_MESSAGE, TAB_MESSAGE } from '../../sdk/panel-core'
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
  /** What its page posts to the shell (`event.source` is this frame's window; nothing else). */
  onMessage(listener: (data: unknown) => void): void
  /** It has the keyboard now (the document's active element). */
  hasFocus(): boolean
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
  /** A frame the LRU must not unmount, besides the dirty ones (which it never unmounts). */
  keep?(tabId: string): boolean
  /** The tab's page in this view holds unsaved changes or not (`pageTabs.dirty`). */
  reportDirty?(tabId: string, dirty: boolean): void
  /**
   * The app's chords a page forwards (web shell: the key table's), sent with each intro; undefined:
   * none (the desktop, where main takes them in `before-input-event`).
   */
  keys?(): readonly string[] | undefined
  /** A forwarded chord typed in the focused page tab: the shell runs its command (through its gate). */
  chord?(chord: string): void
  /** The shown, focused page tab asked for Ask Claude (`ccPanel.tab.discuss()`): the shell opens its box. */
  discuss?(tabId: string): void
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
  /** Tabs whose page here said it holds unsaved changes (and has not said otherwise since). */
  private readonly dirty = new Set<string>()

  constructor(private readonly o: PageFramesOptions) {
    this.max = Math.max(1, o.maxLive ?? MAX_LIVE_PAGE_FRAMES)
  }

  /**
   * The page tabs in the window's list now. A frame of a tab no longer in it is unmounted (the tab
   * closed here or in another view); a changed title is kept for the next frame element.
   * Undefined: the pane has no list yet (a web reconnect's fresh pane, before `tabs.list`
   * answers); nothing changes, since an empty list would unmount every frame and lose its text.
   */
  sync(tabs: readonly PageTabEntry[] | undefined): void {
    if (tabs === undefined) return
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
    // A web reconnect is a new view to main, which dropped what the old one said: say it again.
    if (pluginIds === undefined) for (const id of this.dirty) this.report(id, true)
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

  /** The app's key table changed: every served page gets the new list with its intro. */
  keysChanged(): void {
    for (const l of this.live) l.frame?.loads.postServed(this.intro(l.tab))
  }

  /** Whether this view's page of the tab said it holds unsaved changes. */
  isDirty(tabId: string): boolean {
    return this.dirty.has(tabId)
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
    let element = this.element(entry, 0)
    const target: FrameTarget = {
      load: (to) => element.load(to),
      // A new element (a new browsing context) at the shell's own src; the old one goes with its page.
      remount: (gen) => {
        element.remove()
        // The fresh page starts clean and never says so: clear the old page's dirty here (it reports
        // again when it is dirty), or the tab stays dirty until it closes.
        if (this.dirty.delete(tabId)) {
          this.report(tabId, false)
          this.trim()
        }
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
      // Posted before every port: the page is a page tab of that type (`ccPanel.tab`), with the keys now.
      intro: () => this.intro(entry.tab),
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
    el.onMessage((data) => {
      // Only from the element in the document now (a replaced one is leaving with its page).
      if (entry.gone || entry.frame?.element !== el) return
      this.fromPage(entry.tab.id, el, data)
    })
    return el
  }

  /** The intro posted before every port and again when the key table changes. */
  private intro(tab: PageTabEntry): object {
    const keys = this.o.keys?.()
    return { type: TAB_MESSAGE, tab: { type: tab.type }, ...(keys ? { keys: [...keys] } : {}) }
  }

  /** A message the tab's page posted to the shell. Anything not understood is ignored. */
  private fromPage(tabId: string, el: PageFrameElement, data: unknown): void {
    if (typeof data !== 'object' || data === null) return
    const { type, dirty, chord } = data as { type?: unknown; dirty?: unknown; chord?: unknown }
    if (type === TAB_DIRTY_MESSAGE && typeof dirty === 'boolean') {
      if (dirty === this.dirty.has(tabId)) return
      if (dirty) this.dirty.add(tabId)
      else this.dirty.delete(tabId)
      this.report(tabId, dirty)
      // A clean page may be past the cap now.
      if (!dirty) this.trim()
      return
    }
    // A chord only from the page that has the keyboard, and only one the shell listed: a page cannot
    // run the app's commands from the background, nor any the person could not have typed here.
    if (type === TAB_KEY_MESSAGE && typeof chord === 'string' && tabId === this.shown && el.hasFocus()) {
      if (this.o.keys?.()?.includes(chord) === true) this.o.chord?.(chord)
      return
    }
    if (type === TAB_DISCUSS_MESSAGE && tabId === this.shown && el.hasFocus()) this.o.discuss?.(tabId)
  }

  private report(tabId: string, dirty: boolean): void {
    try {
      this.o.reportDirty?.(tabId, dirty)
    } catch (err) {
      this.o.log?.(`page tab ${tabId}: reporting unsaved changes failed: ${String(err)}`)
    }
  }

  /** Unmount the least recent frames past the cap, never the shown one nor one `keep` holds. */
  private trim(): void {
    let count = this.live.length
    for (let i = this.live.length - 1; i >= 0 && count > this.max; i--) {
      const l = this.live[i]!
      if (l.tab.id === this.shown || this.dirty.has(l.tab.id) || this.o.keep?.(l.tab.id) === true) continue
      this.unmount(l)
      count--
    }
  }

  private unmount(entry: Live): void {
    entry.gone = true
    // Its page goes with whatever it had not saved; main clears this view's dirty at the disconnect.
    this.dirty.delete(entry.tab.id)
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

/** The page tabs of a tab list, as the pool takes them. */
export function pageTabEntries(tabs: readonly TabInfo[]): PageTabEntry[] {
  return tabs.flatMap((t) => (t.kind === 'page' && t.page ? [{ id: t.id, plugin: t.page.plugin, type: t.page.type, title: t.page.title }] : []))
}

/**
 * The web reconnect signal: the bridge's `ready` generations (web/main.tsx). The first is the page
 * load (nothing to reconnect); every later, newer one is a new socket and a new view, so the old
 * one's ports are gone and every live frame takes a new one. Explicit rather than "the tab area
 * mounted again": a layout change or StrictMode's double mount remount it too, and each extra
 * reconnect is a close and an open for the plugin and counts toward the hub's connect cap.
 */
export class ReadyReconnects {
  private seen = 0
  constructor(private readonly reconnect: () => void) {}

  ready(generation: number): void {
    if (generation <= this.seen) return
    const first = this.seen === 0
    this.seen = generation
    if (!first) this.reconnect()
  }
}

/** Where the layer goes: over the placeholder's box, or hidden (a terminal tab shown, or no box yet). */
export function layerBox(
  showsPage: boolean,
  rect: { left: number; top: number; width: number; height: number } | undefined
): { left: number; top: number; width: number; height: number } | null {
  if (!showsPage || !rect || rect.width === 0 || rect.height === 0) return null
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}
