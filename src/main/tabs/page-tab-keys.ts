// Keys typed into a page tab's frame on the desktop (design-editor.md §1 "Keyboard"). A sandboxed
// frame's key events stay in the frame: the shell page's window listener never sees them, so Cmd+W,
// Ctrl+Tab or Cmd+T typed in an editor tab would do nothing. Main sees every key of the window's
// webContents first (`before-input-event`, frames included), so when the focused frame is a page
// tab's (PageTabFrameTabs: main's own record of which tab a frame shows), the app's chords go to the
// shell as `commands.trigger` naming that tab, as for a webview panel's page (webview-manager.ts
// webviewChord), and the page never gets them.
//
// Precedence: the app table (defaults plus the person's keyOverrides, CommandRegistry.view) wins for
// every chord it holds, whatever the page declared; the page's declared `keys` and everything else
// reach the page. The clash of a declared key with the table is shown in Settings › Keybindings
// (KeyBindingRow.pageKeys). Only chords with Cmd, Ctrl or Alt (forwardedCommand): Escape (overlay.pop)
// and bare keys are the page's typing. The web shell has no `before-input-event`: there the panel
// SDK forwards the same chords (panel-core.ts, the shell's `cc-plugin.tab` `keys`).
//
// No Electron import: index.ts hands the frames in, so vitest drives it.
import { pageTabOfFrameName } from '../../shared/page-tabs'
import { forwardedCommand } from '../webview/webview-manager'

/** The fields of an Electron WebFrameMain PageTabFrameTabs decides on. */
export interface TrackedFrameLike {
  readonly name: string
  readonly url: string
  /** Null for the page's main frame (the shell itself). */
  readonly parent: unknown
  /** Stable for the iframe element's life, across its navigations and process swaps. */
  readonly frameTreeNodeId: number
}

/**
 * At most this many frames remembered per window, a backstop only: a record goes when its frame is no
 * longer in the window's frame tree (`liveFrames`), so the map holds the live page tab frames (the
 * mounted LRU of 6 plus the visible panes). Past it, the record least recently used for a key goes.
 */
export const MAX_TRACKED_PAGE_TAB_FRAMES = 256

/**
 * Which page tab each of a window's page tab frames shows, as main saw it (the external review's
 * CRITICAL: a chord typed in page A must not run for page B because B took the keyboard before the
 * chord reached the shell). Recorded once per frame, at `will-frame-navigate` when the navigation is
 * the shell page's own (initiator: the top frame) of one of its own child frames: the shell sets the
 * frame's src, and the name it gave the element (`cc-page-tab:<tab id>`, pageTabFrameName) is read
 * before any page ran in it. Never read again and never overwritten: a page renaming its window or
 * navigating itself, or a frame it nests, changes nothing (derived from the sender, never from what the
 * page says). Keyed by frameTreeNodeId, which a WebFrameMain swapped by the cross-process navigation
 * keeps.
 *
 * A frame's end is read from the frame tree, not from its WebFrameMain (that object is replaced at the
 * swap, so its destroyed state says nothing about the element): at each new record, every record
 * whose frameTreeNodeId is no longer in the window's tree (`liveFrames`: the iframe element removed, a
 * page tab closed, trimmed from the LRU or remounted) goes first. The final review's MAJOR: with the
 * cap alone and the oldest record evicted first, a window open all day made the longest-lived frame
 * still in use (the file kept beside Claude since the morning) the one forgotten, and its app chords
 * stopped reaching the shell until a reload. The cap stays as a backstop for a tree main could not
 * read, and then evicts the record least recently used for a key (`tabOf` refreshes a hit), never the
 * frame being typed in. A frame forgotten anyway is simply no page tab's: its chords go to the page,
 * the safe side. The shell page reloading clears them all (`clear`).
 */
export class PageTabFrameTabs {
  private readonly tabs = new Map<number, string>()

  /**
   * `liveFrames`: the frameTreeNodeIds of the window's frame tree now (index.ts: the main frame's
   * `framesInSubtree`), or undefined when it cannot be read; then only the cap prunes.
   */
  constructor(private readonly liveFrames: () => Iterable<number> | undefined = () => undefined) {}

  /** A `will-frame-navigate` of the window's webContents: `frame` is navigated to `url` by `initiator`. */
  navigating(frame: TrackedFrameLike | null | undefined, url: string, initiator: { readonly parent: unknown } | null | undefined): void {
    if (!frame || !initiator || initiator.parent !== null) return
    const parent = frame.parent as { readonly parent?: unknown } | null | undefined
    if (!parent || parent.parent !== null) return
    if (this.tabs.has(frame.frameTreeNodeId) || !url.startsWith('cc-plugin:')) return
    const tabId = pageTabOfFrameName(frame.name)
    if (tabId === undefined) return
    this.prune()
    if (this.tabs.size >= MAX_TRACKED_PAGE_TAB_FRAMES) {
      // Insertion order is use order (`tabOf` re-inserts a hit): the first is the least recently used.
      const stalest = this.tabs.keys().next()
      if (!stalest.done) this.tabs.delete(stalest.value)
    }
    this.tabs.set(frame.frameTreeNodeId, tabId)
  }

  /** Drop the records of frames no longer in the window's frame tree; nothing when it cannot be read. */
  private prune(): void {
    if (this.tabs.size === 0) return
    let live: Set<number>
    try {
      const ids = this.liveFrames()
      if (ids === undefined) return
      live = new Set(ids)
    } catch {
      // The window's contents going away mid-call: keep every record (the cap still bounds them).
      return
    }
    for (const id of [...this.tabs.keys()]) if (!live.has(id)) this.tabs.delete(id)
  }

  /**
   * The page tab whose frame `frame` is (the window's focused frame at a key), or undefined when it
   * is none: the shell page, another plugin frame, a frame a page nests, a frame no longer showing a
   * plugin page.
   */
  tabOf(frame: TrackedFrameLike | null | undefined): string | undefined {
    if (!frame || frame.parent === null || frame.parent === undefined || !frame.url.startsWith('cc-plugin:')) return undefined
    const tab = this.tabs.get(frame.frameTreeNodeId)
    if (tab === undefined) return undefined
    // Used now: to the back of the eviction order (the cap's backstop evicts the least recently used).
    this.tabs.delete(frame.frameTreeNodeId)
    this.tabs.set(frame.frameTreeNodeId, tab)
    return tab
  }

  /** How many frames are on record (tests). */
  get size(): number {
    return this.tabs.size
  }

  /** The shell page (re)loaded: its frames went with it. */
  clear(): void {
    this.tabs.clear()
  }
}

/** What `pageTabChord` needs from main (index.ts: the key table and the window's shell page). */
export interface PageTabChordDeps {
  /** The window's key table: the command bound to `chord`, if any. */
  commandFor(windowId: number, chord: string): string | undefined
  /**
   * Send `commands.trigger` to the window's own shell page, with the chord and its key's code (the
   * shell holds that key after a pane chord, so an auto-repeat does not reach the terminal it moved
   * to) and `from: 'page-tab'` with the tab (the shell runs it only while that tab's frame still holds
   * the keyboard, never for another tab or the active one: frame-focus.ts chordTarget); false when
   * the window is gone.
   */
  trigger(windowId: number, id: string, chord: string, origin: PageTabChordOrigin): boolean
}

/**
 * Where main saw a chord: the page tab whose frame had the keyboard (PageTabFrameTabs, main's own
 * record, never the page's word) and the key's physical `code` (Electron's input), so the shell holds
 * the key that is down whatever it types once the modifiers are up (HeldChordKeys, pane-commands.ts).
 */
export interface PageTabChordOrigin {
  tab: string
  code: string
}

/**
 * A chord typed into a page tab's frame of `windowId`: true when it is an app chord, sent to the shell
 * (which runs it through its modal gate, command-gate.ts), so the caller swallows the key. The
 * keyboard stays in the frame: a command that moves it (a new tab) moves it itself.
 */
export function pageTabChord(deps: PageTabChordDeps, windowId: number, chord: string | null, origin: PageTabChordOrigin, repeat = false): boolean {
  if (chord === null) return false
  const id = forwardedCommand(chord, (c) => deps.commandFor(windowId, c))
  if (id === undefined) return false
  // An auto-repeat of an app chord is swallowed without running it again (the web SDK does the same):
  // holding Ctrl+W must not type or act in the page after the first press went to the shell.
  if (repeat) return true
  return deps.trigger(windowId, id, chord, origin)
}

/**
 * Whether `frame` is a plugin page the shell embeds directly (a panel or a slot: `cc-plugin:` page,
 * parent the shell page itself). The caller has already ruled out a page tab frame (`tabOf`). A frame
 * a plugin page nests is not one: its chords stay with it, as a nested page tab's do.
 */
export function isShellPluginFrame(frame: TrackedFrameLike | null | undefined): boolean {
  if (!frame || !frame.url.startsWith('cc-plugin:')) return false
  const parent = frame.parent as { readonly parent?: unknown } | null | undefined
  return !!parent && parent.parent === null
}

/** What `panelChord` needs from main (index.ts: the key table and the window's shell page). */
export interface PanelChordDeps {
  /** The window's key table: the command bound to `chord`, if any. */
  commandFor(windowId: number, chord: string): string | undefined
  /** Hand the keyboard to the window's shell page, then run the command there; false when it is gone. */
  triggerInShell(windowId: number, id: string, chord: string, code: string): boolean
}

/**
 * A chord typed into a plugin panel's frame (Sessions, Usage, Files...): a sandboxed frame keeps its
 * keys, so without this Cmd+T worked in a Claude tab and did nothing once a panel had the focus. Same
 * rules as a webview panel's page (`webviewChord`): `forwardedCommand` decides which chords (the app
 * table, Cmd/Ctrl/Alt only, never the overlay keys), the shell takes the keyboard first (a new tab's
 * terminal must get the keys that follow) and runs the command through its modal gate for the view's
 * active tab: a panel names no tab. True when the chord was taken; an auto-repeat is swallowed.
 */
export function panelChord(deps: PanelChordDeps, windowId: number, chord: string | null, code: string, repeat = false): boolean {
  if (chord === null) return false
  const id = forwardedCommand(chord, (c) => deps.commandFor(windowId, c))
  if (id === undefined) return false
  if (repeat) return true
  return deps.triggerInShell(windowId, id, chord, code)
}
