// Page tab frames (design-editor.md §1 "Frame lifetime"): the frames that show page tabs, and the
// one place their lifetime is decided. A page tab holds unsaved text (the editor's buffers), so its
// frame must outlive everything that reloads plugin pages today:
//
// - Mount on first show, never at restore: a window that comes back with thirty file tabs loads
//   the ones it shows (every visible page pane of a split group, design-split-pages.md §3). A small
//   LRU (MAX_LIVE_PAGE_FRAMES, or the visible count when larger) keeps the recently used frames
//   alive and hidden; the least recent one past it is unmounted (its page loads afresh when shown
//   again), never a visible one and never one `keep` holds or that is dirty.
// - Placement: each visible frame is placed at its pane's body box (`place`, from pane-layout.ts
//   frameBoxes); placing, moving a pane out, between groups or ungrouping only changes a box, so no
//   page reloads for a group change.
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
// Focus (design-split-pages.md §4, frame-focus.ts): the pool records its own focus calls (`ownFocus`,
// the shell's half of the evidence that a frame holding the keyboard was put there by the person),
// says which frame holds the keyboard (`keyboardTab`), blurs one (`blurFrame`, `blurKeyboard`), lets a
// blurred one pass the pointer to its pane until the pointer moves (`passThrough`) and hands on a page's `cc-plugin.tab-focus` hint (`focusHint`: a reason for the shell to look, and
// with another frame on record a move of the keyboard into the hinting frame, `resync`; never into a terminal).
// `wantFocus` takes the keyboard at the load only for the focused pane with the keys on (`show`'s
// `focused` is null while they are off), so a pane shown by a group change elsewhere never takes it.
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
import { TAB_DIRTY_MESSAGE, TAB_DISCUSS_MESSAGE, TAB_FOCUS_MESSAGE, TAB_KEY_MESSAGE, TAB_MESSAGE } from '../../sdk/panel-core'
import { FrameLoads, type FrameTarget } from '../web/port-relay'

/**
 * Frames kept alive at most (shown plus hidden). Each is a page with its own scripts (CodeMirror,
 * its buffers); a person switches among a handful of files, and one past this loads again when
 * selected, which costs a second, not text, once a page saves or keeps its own drafts.
 */
export const MAX_LIVE_PAGE_FRAMES = 6

/** A frame's box in pixels relative to the layer. */
export interface FrameRect {
  left: number
  top: number
  width: number
  height: number
}

/** One frame element as the pool drives it (an iframe in the app, a fake in tests). */
export interface PageFrameElement {
  /** Navigate it (set `src`). */
  load(url: string): void
  /**
   * Place it at `box` (pixels in the layer) and show it, or hide it (null: `hidden`, display none,
   * which keeps the page alive). Never moved in the document: an iframe moved there reloads.
   */
  place(box: FrameRect | null): void
  /** Post into its page; false when it has no window. */
  post(message: unknown, transfer?: MessagePort[]): boolean
  /** Its `load` events. */
  onLoad(listener: () => void): void
  /** Take it out of the document (its page dies with it). */
  remove(): void
  /** Give it the keyboard (the tab was selected, or a dialog over it went). */
  focus(): void
  /** Take the keyboard from it (it took it with no evidence of the person, or the keys went off). */
  blur(): void
  /**
   * Let the pointer through to the pane under it (on) or take it again (off): a frame blurred for
   * want of evidence, so the person's next press on it reaches the shell (frame-focus.ts).
   */
  passThrough(on: boolean): void
  /** Its box in viewport pixels while placed, else null (the pointer evidence, frame-focus.ts). */
  rect(): FrameRect | null
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
  /**
   * A forwarded chord typed in page tab `tabId`, whose visible frame has the keyboard: the shell runs
   * its command for that tab (through its gate), never for "the active tab", which may be the pane
   * beside it (design-split-pages.md §4 "Chords from a frame name their tab").
   */
  chord?(chord: string, tabId: string): void
  /**
   * Whether the person gave real input a moment ago (web shell: `navigator.userActivation.isActive`,
   * transient activation: set by a trusted key press or click in the frame or the shell, which a
   * page's script cannot set, and kept for a few seconds after it). A forwarded chord is taken only
   * then. This narrows, it does not prove: the SDK's forwarding runs in the page, so while the person
   * types in it the page could post any listed chord from its script with no matching key; what it
   * stops is a page running the app's commands while nobody uses it. Absent or false: no chord is
   * taken (the desktop needs none: main reads the real input in before-input-event).
   */
  userActive?(): boolean
  /** A visible page tab whose frame has the keyboard asked for Ask Claude (`ccPanel.tab.discuss()`): the shell opens its box. */
  discuss?(tabId: string): void
  /**
   * A live frame's page says its window got the focus (`cc-plugin.tab-focus`): the shell reads
   * `document.activeElement` now (frame to frame, it sees no event of its own), after `resync` when
   * that still names another frame. Never trusted for what it says: any page may post it any time,
   * and the check decides by the shell's evidence only. So a hint can move the keyboard between
   * frames (to the hinting one with evidence, else to nothing), never into a terminal.
   */
  focusHint?(tabId: string): void
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
  /** Asked to take the keyboard before its frame existed (its first select): it does once loaded. */
  wantFocus?: boolean
}

export class PageFrames {
  /** Live (or looking up) frames, most recently shown first. */
  private live: Live[] = []
  private readonly tabs = new Map<string, PageTabEntry>()
  /**
   * Tabs whose page main named none for: not asked again until shown again or their host restarts.
   * Replaced (never mutated) on each change, so a React view can hold it as a snapshot (`unavailable`).
   */
  private none: ReadonlySet<string> = new Set<string>()
  private readonly noneListeners = new Set<() => void>()
  /** The page tabs this view shows now (every visible page pane), and the focused one among them. */
  private visible: ReadonlySet<string> = new Set<string>()
  private focused: string | null = null
  /** Each visible frame's box in the layer, as last placed. */
  private boxes = new Map<string, FrameRect>()
  private readonly max: number
  /** Tabs whose page here said it holds unsaved changes (and has not said otherwise since). */
  private readonly dirty = new Set<string>()
  /**
   * The tab whose frame the shell itself last gave the keyboard (`focus`, `wantFocus` at the load) or
   * a check accepted on the person's evidence (`proven`); null once the focus moved within the shell
   * (`shellFocused`), a frame was blurred or the selection moved on (`show`).
   */
  private own: string | null = null
  /** Tabs whose frame lets the pointer through to its pane now (`passThrough`), until it moves. */
  private readonly through = new Set<string>()

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
    this.setNone([...this.none].filter((id) => ids.has(id)))
    if ([...this.visible].some((id) => !ids.has(id))) this.visible = new Set([...this.visible].filter((id) => ids.has(id)))
    if (this.focused !== null && !ids.has(this.focused)) this.focused = null
  }

  /**
   * The panes this view shows now (`visible`: PaneView.visible, terminal tabs among them are
   * skipped) and the focused one (`focused`: the view's selected tab, null for none and while the
   * keys are off, D3: then no frame takes the keyboard at its load). Each visible
   * page tab's frame mounts on its first show and moves to the front of the LRU, the focused one
   * first; every other live frame is hidden (alive), and the least recent ones past the cap
   * unmount. A visible frame keeps its last box until `place` gives a new one.
   */
  show(visible: readonly string[], focused: string | null): void {
    const before = this.visible
    const pages = visible.filter((id) => this.tabs.has(id))
    this.visible = new Set(pages)
    this.focused = focused !== null && this.visible.has(focused) ? focused : null
    // The shell's own focus call counts for the pane it was made for while that pane stays the
    // focused one: once the selection moved on (to a page still loading, a terminal, keys off), a
    // frame the shell focused before and that takes the keyboard again is not picked back by it.
    if (this.own !== null && this.own !== this.focused) this.own = null
    // Shown again after main had no page for it: worth one more look (the plugin may be on now).
    const again = pages.filter((id) => !before.has(id) && this.none.has(id))
    if (again.length > 0) this.setNone([...this.none].filter((id) => !again.includes(id)))
    // The focused one is looked up first and ends at the front, the other visible ones right behind it.
    const order = this.focused === null ? pages : [this.focused, ...pages.filter((id) => id !== this.focused)]
    const front: Live[] = []
    for (const id of order) {
      let entry = this.live.find((l) => l.tab.id === id)
      if (!entry && !this.none.has(id)) {
        entry = this.mount(this.tabs.get(id)!)
        this.live.push(entry)
      }
      if (entry) front.push(entry)
    }
    this.live = [...front, ...this.live.filter((l) => !front.includes(l))]
    for (const l of this.live) {
      this.placeOne(l)
      if (l.tab.id !== this.focused) l.wantFocus = false
    }
    this.trim()
  }

  /**
   * Each visible frame's box in the layer (pane-layout.ts frameBoxes, in pixels of the layer's
   * measured box). A visible frame with no box here is hidden (alive); a box for a tab not visible
   * is ignored. Only boxes change: no frame is mounted, unmounted or reloaded by a placement.
   */
  place(boxes: ReadonlyArray<FrameRect & { tab: string }>): void {
    this.boxes = new Map(boxes.map((b) => [b.tab, { left: b.left, top: b.top, width: b.width, height: b.height }]))
    for (const l of this.live) this.placeOne(l)
  }

  /** Whether main named no page for the tab here (its plugin is off or did not load): the pane says so. */
  unavailable(): ReadonlySet<string> {
    return this.none
  }

  /** Called when `unavailable()` changes; returns the unsubscribe. */
  onUnavailable(listener: () => void): () => void {
    this.noneListeners.add(listener)
    return () => this.noneListeners.delete(listener)
  }

  private setNone(ids: readonly string[]): void {
    const next = new Set(ids)
    if (next.size === this.none.size && [...next].every((id) => this.none.has(id))) return
    this.none = next
    for (const l of [...this.noneListeners]) l()
  }

  /** The box a live frame gets now: its pane's while visible, else none (hidden). */
  private boxFor(tabId: string): FrameRect | null {
    return this.visible.has(tabId) ? (this.boxes.get(tabId) ?? null) : null
  }

  private placeOne(l: Live): void {
    l.frame?.element.place(this.boxFor(l.tab.id))
  }

  /**
   * A new port, no reload, for every live frame of these plugins (`panels.reload`: their host
   * restarted or the plugin reloaded), or of all (undefined: a web reconnect). A tab main had no page
   * for is asked again, and mounted now when it is visible.
   */
  reconnect(pluginIds?: readonly string[]): void {
    const of = (plugin: string): boolean => pluginIds === undefined || pluginIds.includes(plugin)
    for (const l of this.live) if (of(l.tab.plugin)) l.frame?.loads.reconnect()
    // A web reconnect is a new view to main, which dropped what the old one said: say it again.
    if (pluginIds === undefined) for (const id of this.dirty) this.report(id, true)
    const again = [...this.none].filter((id) => {
      const tab = this.tabs.get(id)
      return tab !== undefined && of(tab.plugin)
    })
    if (again.length === 0) return
    this.setNone([...this.none].filter((id) => !again.includes(id)))
    if (again.some((id) => this.visible.has(id))) this.show([...this.visible], this.focused)
  }

  /**
   * The tab's frame takes the keyboard (TabsPane's focusActive, a select). On a first show its page
   * is still being looked up (`src`), so there is no frame yet: it takes the keyboard once its page
   * loaded, if its tab is still the focused one, or the keyboard stayed wherever it was until the
   * person clicked.
   */
  focus(tabId: string): void {
    const l = this.live.find((x) => x.tab.id === tabId)
    if (!l) return
    if (l.frame) {
      this.own = tabId
      this.takePointer(tabId)
      // Already holding it (the person clicked into it and the shell picked the pane): focusing the
      // frame again could only move the page's own focus.
      if (!l.frame.element.hasFocus()) l.frame.element.focus()
    } else l.wantFocus = true
  }

  /** The live tab whose frame holds the keyboard now (the document's active element), or null. */
  keyboardTab(): string | null {
    return this.live.find((l) => l.frame?.element.hasFocus() === true)?.tab.id ?? null
  }

  /** Whether the tab is one of the panes this view shows now (`show`'s visible set). */
  isVisible(tabId: string): boolean {
    return this.visible.has(tabId)
  }

  /** Whether the shell's own focus call put the keyboard in this visible tab's frame (frame-focus.ts). */
  ownFocus(tabId: string): boolean {
    return this.own === tabId && this.visible.has(tabId)
  }

  /**
   * A focus check kept or picked this visible tab's frame on the person's evidence (frame-focus.ts
   * checkFrames): from now on it holds the keyboard as if the shell had put it there (`ownFocus`), so
   * a later check (a chord typed in it once the pointer evidence is stale) still names it.
   */
  proven(tabId: string): void {
    if (this.visible.has(tabId)) this.own = tabId
  }

  /** The tab's frame box in viewport pixels while it is placed, else null. */
  frameRect(tabId: string): FrameRect | null {
    if (!this.visible.has(tabId)) return null
    return this.live.find((l) => l.tab.id === tabId)?.frame?.element.rect() ?? null
  }

  /** Every visible frame's box in viewport pixels, by tab (the pointer evidence's neighbours). */
  frameRects(): Map<string, FrameRect> {
    const rects = new Map<string, FrameRect>()
    for (const id of this.visible) {
      const rect = this.frameRect(id)
      if (rect) rects.set(id, rect)
    }
    return rects
  }

  /** The focus moved to an element of the shell: what the shell focused before is no evidence any more. */
  shellFocused(): void {
    this.own = null
  }

  /**
   * The shell's record says frame `other` holds the keyboard but `tabId`'s page says its window just
   * got the focus (its `cc-plugin.tab-focus`): focus `tabId`'s frame element so the record matches
   * again, recording no focus of the shell's own (it is no evidence: the page asked). Measured
   * (Electron 45, the plan's Task 4 e2e): a click from one page tab frame into another of the same
   * plugin moves the keyboard but leaves the shell's `document.activeElement` on the first frame, for
   * good, so without this every chord, Ask Claude and blur would act on the frame the person left. A
   * page that lies gains nothing it could not take itself: the keyboard was already in a frame (never
   * in a terminal: only called while one holds it, `keyboardTab`), and any page may call `focus()`.
   * The check that follows decides whether it keeps it; without evidence the keyboard goes to nothing,
   * never back to an element of the shell (frame-focus.ts: a page looping the hint can only empty
   * the keyboard of the frame the person types in, never fill a terminal).
   */
  resync(tabId: string): void {
    if (!this.visible.has(tabId) || this.keyboardTab() === null) return
    const el = this.live.find((l) => l.tab.id === tabId)?.frame?.element
    if (el && !el.hasFocus()) el.focus()
  }

  /** Take the keyboard from the tab's frame (it took it with no evidence of the person). */
  blurFrame(tabId: string): void {
    if (this.own === tabId) this.own = null
    this.live.find((l) => l.tab.id === tabId)?.frame?.element.blur()
  }

  /**
   * The tab's frame lets the pointer through to its pane (it was blurred for want of evidence): the
   * person's next press there lands on the shell's pane and picks it, a press the shell sees. Ends at
   * the shell's next sight of the pointer (`endPassThrough`) or its own focus call for the tab.
   */
  passThrough(tabId: string): void {
    const el = this.live.find((l) => l.tab.id === tabId)?.frame?.element
    if (!el) return
    this.through.add(tabId)
    el.passThrough(true)
  }

  /** The shell saw the pointer move (or press, or wheel): every frame takes the pointer again. */
  endPassThrough(): void {
    if (this.through.size === 0) return
    for (const id of [...this.through]) this.takePointer(id)
  }

  /** Whether the tab's frame lets the pointer through now (tests). */
  passesThrough(tabId: string): boolean {
    return this.through.has(tabId)
  }

  private takePointer(tabId: string): void {
    if (!this.through.delete(tabId)) return
    this.live.find((l) => l.tab.id === tabId)?.frame?.element.passThrough(false)
  }

  /** Take the keyboard from whichever frame holds it (D3: the keys went off); returns that tab, or null. */
  blurKeyboard(): string | null {
    const tab = this.keyboardTab()
    if (tab !== null) this.blurFrame(tab)
    return tab
  }

  /** The app's key table changed: every served page gets the new list with its intro. */
  keysChanged(): void {
    for (const l of this.live) l.frame?.loads.postServed(this.intro(l.tab))
  }

  /** Whether this view's page of the tab said it holds unsaved changes. */
  isDirty(tabId: string): boolean {
    return this.dirty.has(tabId)
  }

  /** Whether any page of this view holds unsaved changes (the web shell's unload guard). */
  hasDirty(): boolean {
    return this.dirty.size > 0
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
    this.visible = new Set()
    this.focused = null
  }

  private mount(tab: PageTabEntry): Live {
    const entry: Live = { tab }
    // No page here, or none could be made: out of the live set (its frame, if one was made, goes)
    // until it is shown again or its host restarts, so a later show tries again rather than
    // leaving a blank placeholder for good (its pane says the page is not available meanwhile).
    const none = (): void => {
      this.unmount(entry)
      this.setNone([...this.none, tab.id])
    }
    let asked: Promise<string | null>
    try {
      asked = this.o.src(tab.id)
    } catch (err) {
      asked = Promise.reject(err)
    }
    asked
      .then(
        (src) => {
          if (entry.gone) return
          const url = src === null ? undefined : this.o.pageUrl(src)
          if (url === undefined) return none()
          this.start(entry, url)
        },
        (err: unknown) => {
          this.o.log?.(`page tab ${tab.id}: asking for its page failed: ${String(err)}`)
          if (!entry.gone) none()
        }
      )
      // A throw from pageUrl or start (createFrame): logged, never an unhandled rejection.
      .catch((err: unknown) => {
        this.o.log?.(`page tab ${tab.id}: its frame could not be made: ${String(err)}`)
        if (!entry.gone) none()
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
    let loads: FrameLoads
    try {
      loads = new FrameLoads({
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
    } catch (err) {
      // Made but never handed to the entry (unmount would not find it): out of the layer here.
      element.remove()
      throw err
    }
    entry.frame = { element, loads }
    element.load(url)
    loads.started(url)
  }

  /** A frame element for `entry` whose loads report generation `gen`, placed at its pane's box while visible. */
  private element(entry: Live, gen: number): PageFrameElement {
    const el = this.o.createFrame(entry.tab.title)
    el.place(this.boxFor(entry.tab.id))
    el.onLoad(() => {
      entry.frame?.loads.loaded(gen)
      // Asked for the keyboard before it existed (a first select): taken once its page is there, if
      // its tab is still the focused pane (a frame focused before its document loads leaves the
      // loaded page without the keyboard).
      if (entry.wantFocus === true && entry.frame?.element === el && entry.tab.id === this.focused) {
        entry.wantFocus = false
        this.own = entry.tab.id
        el.focus()
      }
    })
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
    // A chord only from a visible page whose frame has the keyboard, only one the shell listed, and only while the
    // browser says the person gave real input a moment ago (`userActive`): a page cannot run the
    // app's commands from the background, nor any the person could not have typed here, nor any
    // while nobody uses it. Transient activation lasts seconds and is not tied to one key, so a page
    // the person is typing in can still post a listed chord they did not press (a known limit).
    if (type === TAB_KEY_MESSAGE && typeof chord === 'string' && this.visible.has(tabId) && el.hasFocus()) {
      if (this.o.keys?.()?.includes(chord) === true && this.o.userActive?.() === true) this.o.chord?.(chord, tabId)
      return
    }
    if (type === TAB_DISCUSS_MESSAGE && this.visible.has(tabId) && el.hasFocus()) {
      this.o.discuss?.(tabId)
      return
    }
    if (type === TAB_FOCUS_MESSAGE) this.o.focusHint?.(tabId)
  }

  private report(tabId: string, dirty: boolean): void {
    try {
      this.o.reportDirty?.(tabId, dirty)
    } catch (err) {
      this.o.log?.(`page tab ${tabId}: reporting unsaved changes failed: ${String(err)}`)
    }
  }

  /**
   * Unmount the least recent frames past the cap, never a visible one, a dirty one nor one `keep`
   * holds. The cap is the visible count when that is larger (a group of 8 page panes keeps all 8
   * while shown; hidden again, the least recent go down to the cap).
   */
  private trim(): void {
    const cap = Math.max(this.max, this.visible.size)
    let count = this.live.length
    for (let i = this.live.length - 1; i >= 0 && count > cap; i--) {
      const l = this.live[i]!
      if (this.visible.has(l.tab.id) || this.dirty.has(l.tab.id) || this.o.keep?.(l.tab.id) === true) continue
      this.unmount(l)
      count--
    }
  }

  private unmount(entry: Live): void {
    entry.gone = true
    if (this.own === entry.tab.id) this.own = null
    this.through.delete(entry.tab.id)
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
