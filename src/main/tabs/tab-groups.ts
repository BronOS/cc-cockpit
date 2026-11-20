// Split groups of every project window (design.md §3 "Split groups"; team run 001 design §1): which
// terminal tabs are drawn side by side, in which tree, and the project's tab order with every group
// contiguous. Main is the one writer. Pages (the desktop and every browser view, D12) and, later,
// plugins send small intents naming tab ids (`groups.place`, `groups.remove`, ...), never a whole
// tree: two views editing at once must not overwrite each other the way a whole-state `layout.set`
// did. Every edit goes through the pure ops of shared/tab-groups.ts and produces one whole snapshot
// with a new `seq`, published to every view of the project through ViewRegistry (pages drop an
// older `seq`).
//
// Kept beside TabManager, not in it (1,300 lines of ptys) and not in LayoutState (panel keys,
// whole-state edits). TabManager keeps the one tab order; this service rewrites it after a group op
// (`setOrder`) so the strip, tab shortcuts, the switcher and restore all see the groups contiguous.
//
// No Electron import: everything outside comes in through `TabGroupsDeps`, so vitest drives it with
// plain functions.

import { errorText } from '../../shared/error-text'
import type { GroupsReply } from '../../shared/ipc'
import {
  AUTO_ZOOM_CELLS,
  GROUP_CAPS,
  PANE_CHROME_CELLS,
  PANE_MIN_CELLS,
  cellsOf,
  contiguousOrder,
  dissolve,
  evenRoot,
  extentFrom,
  groupOf,
  leavesOf,
  normalizeGroups,
  pathTo,
  place,
  removeLeaf,
  rename,
  restoreGroups,
  setSizes,
  isPaneKind,
  type CellSize,
  type GroupRefusalReason,
  type GroupsSnapshot,
  type PaneEdge,
  type PaneStep,
  type PlaceIntent,
  type TabGroup
} from '../../shared/tab-groups'
import type { TabKind } from '../../shared/types'
import { autoZoomed, type SplitGeometry } from '../../shared/pane-zoom'
import { isRemoteViewId, type ViewId } from '../../shared/views'
import { warnLog } from '../warn-log'

export interface TabGroupsDeps {
  /**
   * The project's live tab ids in TabManager's order (overlay entries are never in it; page tabs
   * are, as they are in the strip; `kindOf` decides which kinds may be panes and which join a terminal mirror).
   */
  order(projectId: string): string[]
  /**
   * A live tab's kind (TabManager's table), undefined for an unknown or another project's id. Only
   * kinds in isPaneKind may be panes (every kind today): a placement naming another is refused
   * (`not-a-pane`) and a group loaded or synced with one prunes it. Absent: every tab may (tests that
   * do not care).
   */
  kindOf?(projectId: string, tabId: string): TabKind | undefined
  /**
   * Put the project's tabs in this order (TabManager.setOrder): a permutation of `order()`. Not a
   * save by itself: the service calls `changed` once the whole edit is applied.
   */
  setOrder(projectId: string, ids: readonly string[]): void
  /** `groups.changed` to every view of the project (ViewRegistry.toProject). */
  publish(projectId: string, snapshot: GroupsSnapshot): void
  /**
   * The saved shape changed: save the tabs and the groups together (TabRestorer.tabsChanged, which
   * a quit's `freeze` turns into a no-op). Never called for a tab closing: TabManager's own change
   * after the close saves, and a window closing must not rewrite the record at all (restore.ts).
   */
  changed(projectId: string): void
  /**
   * The groups of the project changed (membership or tree): browser views whose selected tab is in a
   * group join its new members (web/connection.ts). Absent: nobody is told.
   */
  groupsChanged?(projectId: string): void
  /**
   * A tab's terminal size in cells now (TabManager.sizeOf): a plugin's `beside` is placed only when every pane it
   * shrinks keeps PANE_MIN_CELLS (D5). Read at each placement and at each layout change (`moved`), so a size is known
   * with the layout it was measured under. Undefined for a tab no view has sized yet (its spawn size is no pane's).
   * Absent, or unknown for every tab of the project: no check.
   */
  sizeOf?(projectId: string, tabId: string): { cols: number; rows: number } | undefined
  /**
   * The person's `panesPerGroup` limit for a plugin (PluginLimitsStore.limits): its `beside` places only while the
   * target group has fewer panes. Read at each placement, so a change applies to the next open; clamped again here
   * (2..GROUP_CAPS.maxPanes). Absent, throwing or not a number: GROUP_CAPS.pluginBelow.
   */
  pluginPanes?(pluginId: string): number
  /**
   * Whether a view's split geometry (`viewArea`) counts. Absent: every view's. Server mode answers no for the hidden
   * page (design-web.md §9.8, as ViewSizes' `measured`): nobody looks at it, and its 480x320 window would refuse plugin
   * panes no browser would zoom for.
   */
  measured?(viewId: ViewId): boolean
  log?: (message: string) => void
}

/** A placement's options: the person's own (none), or a plugin's `beside` with the plugin main opened the tab for. */
export interface PlaceOpts {
  plugin?: boolean
  /** The plugin the open is for (HostApi's checked host plugin, never a payload's), whose `panesPerGroup` applies. */
  pluginId?: string
}

interface ProjectGroups {
  groups: TabGroup[]
  /** What the last snapshot said, to publish only a real change (`sync`). */
  published: { seq: number; order: string[]; groups: string } | undefined
  /** Each tab's size as of its last move in the layout, for a plugin's size check (`moved`, `extentAt`). */
  seen: Map<string, Seen>
}

/**
 * A tab's size against the layouts it can have been measured under. A view measures a pane after it drew the layout
 * main published, so its report lands a round trip after the layout changed: a size main reads right after a move is
 * still the old place's, and only a size that changed since was measured in a place the tab has had since.
 */
interface Seen {
  /** The tab's size when its place last changed (undefined: none known then). */
  size: CellSize | undefined
  /** The group extent that size gives under the place(s) it was measured in; undefined: unknown. */
  extent: CellSize | undefined
  /**
   * The tab's places since then, the current one among them: a size other than `size` was measured in one of them. Undefined
   * once more than SEEN_PLACES different ones piled up with no new size: unknown, and a plugin's check then refuses.
   */
  since: PaneStep[][] | undefined
}

/** The most places `Seen.since` keeps (a tab's place changes; its size follows within a round trip). */
const SEEN_PLACES = 8

/** Float noise in cellsOf's arithmetic, below which a pane's cells did not change (a placement moves whole fractions). */
const SHRINK_EPS = 1e-9

/** A `tabs.create` `beside`, already shape-checked by the router. */
export interface BesideRequest {
  tabId: string
  edge: PaneEdge
}

export class TabGroups {
  private readonly projects = new Map<string, ProjectGroups>()
  /**
   * One counter for the whole run, never per project: a window closed and opened again starts a new
   * page anyway, but a page must never see a `seq` go back and drop a real snapshot as old.
   */
  private seq = 0
  /** Group and split ids, unique for the run (shared/tab-groups.ts `MintId`); a restore re-mints. */
  private minted = 0
  private readonly mint = (): string => `g${++this.minted}`
  /**
   * Projects inside `atomic`: their snapshot waits for the end of the whole step, so no view sees
   * the halfway state (a tab created by `tabs.create` with `beside`, before it is placed).
   */
  private readonly held = new Map<string, number>()
  /** Held projects whose save waits for the end of the step (`atomic`). */
  private readonly saveOwed = new Set<string>()
  private readonly log: (message: string) => void
  /** The last pane `tabClosed` removed and what was left of its group (`departedPanes`). */
  private departed: { tabId: string; panes: string[] } | undefined
  /**
   * Each view's split geometry by project (`groups.area`): the area and cell its autoZoomed runs with, so a plugin's
   * placement is judged by the view's own rule (`panesFit`). A view's entry goes with the view (`viewGone`).
   */
  private readonly areas = new Map<string, Map<ViewId, SplitGeometry & { remote: boolean }>>()

  constructor(private readonly deps: TabGroupsDeps) {
    this.log = deps.log ?? warnLog
  }

  /** The project's groups and tab order now (`groups.get`; the web `ready` snapshot). */
  get(projectId: string): GroupsSnapshot {
    const state = this.projects.get(projectId)
    const order = this.deps.order(projectId)
    return { seq: state?.published?.seq ?? this.seq, order, groups: state?.groups ?? [] }
  }

  /** The project's groups as they are saved (TabRestorer, with the tabs, in one write). */
  groupsOf(projectId: string): TabGroup[] {
    return this.projects.get(projectId)?.groups ?? []
  }

  /**
   * A browser view's terminals (design §1 "Web and cost"): the tabs to join for a view that selected
   * `tabId`, the selected one first, then the rest of its group in reading order. Just `[tabId]` for
   * a plain tab or one not of this project (the caller checks the tab against the view's window).
   * Terminal members only: a page member has no mirror to join, so it never waits in the view's set.
   */
  joinOrder(projectId: string, tabId: string): string[] {
    const group = groupOf(this.groupsOf(projectId), tabId)
    if (!group) return [tabId]
    const k = this.deps.kindOf
    return [tabId, ...leavesOf(group.root).filter((t) => t !== tabId && (!k || k(projectId, t) !== 'page'))]
  }

  /**
   * Put `tabId` beside the pane of `at` (`groups.place`; a plugin's `beside` with `plugin`, task 04).
   * Both ids are looked up in the project's own live tabs: an unknown and another project's id are
   * the same `unknown-tab` refusal, and a refusal changes nothing and publishes nothing.
   */
  place(projectId: string, intent: PlaceIntent, opts: PlaceOpts = {}): GroupsReply {
    return this.placeIf(projectId, intent, opts) ?? { ok: false, reason: 'full' }
  }

  /** `place`, applied only when `fits` (if given) accepts the groups before and after; undefined when it did not. */
  private placeIf(
    projectId: string,
    intent: PlaceIntent,
    opts: PlaceOpts,
    fits?: (before: readonly TabGroup[], after: readonly TabGroup[]) => boolean
  ): GroupsReply | undefined {
    // A kind outside isPaneKind is refused, as the tab placed or as the anchor. An unknown id goes
    // on to `unknown-tab`.
    if (!this.mayBePane(projectId, intent.tabId) || !this.mayBePane(projectId, intent.at)) {
      return { ok: false, reason: 'not-a-pane' }
    }
    const order = this.deps.order(projectId)
    const result = place(this.groupsOf(projectId), order, intent, {
      mint: this.mint,
      ...(opts.plugin === true ? { plugin: true, caps: { ...GROUP_CAPS, pluginBelow: this.pluginPanes(opts.pluginId) } } : {})
    })
    if (!result.ok) return result
    if (fits && !fits(this.groupsOf(projectId), result.groups)) return undefined
    return this.apply(projectId, result.groups, order, result.order)
  }

  /** Move a tab out of its group (`groups.remove`): a plain tab right after what is left of the block. */
  remove(projectId: string, tabId: string): GroupsReply {
    const order = this.deps.order(projectId)
    // A tab of another project is not in this project's groups: `not-grouped`, like a plain tab.
    const result = removeLeaf(this.groupsOf(projectId), order, tabId)
    if (!result.ok) return result
    return this.apply(projectId, result.groups, order, result.order)
  }

  /** Ungroup (`groups.dissolve`): the members stay where they are, nothing closes. */
  dissolve(projectId: string, groupId: string): GroupsReply {
    const order = this.deps.order(projectId)
    const result = dissolve(this.groupsOf(projectId), order, groupId)
    if (!result.ok) return result
    return this.apply(projectId, result.groups, order, result.order)
  }

  /** A divider drag's result (`groups.resize`, sent once on release; shared by every view, D1). */
  resize(projectId: string, groupId: string, splitId: string, sizes: readonly number[]): GroupsReply {
    const result = setSizes(this.groupsOf(projectId), groupId, splitId, sizes)
    if (!result.ok) return result
    const order = this.deps.order(projectId)
    return this.apply(projectId, result.groups, order, order)
  }

  /** Name a group or clear its name (`groups.rename`). */
  rename(projectId: string, groupId: string, name: string | null): GroupsReply {
    const result = rename(this.groupsOf(projectId), groupId, name)
    if (!result.ok) return result
    const order = this.deps.order(projectId)
    return this.apply(projectId, result.groups, order, order)
  }

  /**
   * `tabs.reorder` in a project that may have groups (decisions D9). Throws for a tab that is not
   * the project's (TabManager.reorder's rule; the router turns it into a rejected invoke).
   *  - `block` (the group handle's drag): the whole group of `tabId` moves to `toIndex`, an index
   *    in the order without the block. For a plain tab it is a plain move.
   *  - a member without `block`: dropped strictly inside its own segment, nothing happens (no
   *    reordering inside a segment: panes move by drag-to-edge or the palette); anywhere else it
   *    leaves the group and becomes a plain tab there (the group may dissolve).
   *  - a plain tab: moved; dropped inside a group's segment it lands after the group (contiguity).
   * Every resulting order keeps the groups contiguous.
   */
  reorder(projectId: string, tabId: string, toIndex: number, block = false): void {
    if (!Number.isInteger(toIndex)) throw new Error('toIndex must be an integer')
    const order = this.deps.order(projectId)
    const from = order.indexOf(tabId)
    if (from < 0) throw new Error('unknown tab')
    let groups = this.groupsOf(projectId)
    const group = groupOf(groups, tabId)
    let next: string[]
    if (group && block) {
      const members = new Set(leavesOf(group.root))
      const moving = order.filter((t) => members.has(t))
      const rest = order.filter((t) => !members.has(t))
      rest.splice(clamp(toIndex, rest.length), 0, ...moving)
      next = rest
    } else {
      const without = order.filter((t) => t !== tabId)
      const at = clamp(toIndex, without.length)
      if (group) {
        // D17, D26 N2: the same position, or one strictly between two group mates (in the order
        // without the tab), is a no-op; before its first mate or after its last it detaches there,
        // so a member dropped just past its bracket leaves, and a group at either end of the strip
        // can be dragged out on that side. The page decides a drop inside the segment by hit-testing
        // and sends nothing; this is main's rule for what it does get.
        if (at === from) return
        const mates = new Set(leavesOf(group.root).filter((t) => t !== tabId))
        const first = without.findIndex((t) => mates.has(t))
        const last = without.length - 1 - [...without].reverse().findIndex((t) => mates.has(t))
        // Inserting at `at` puts the tab before without[at]: between two mates when first < at <= last.
        if (first >= 0 && at > first && at <= last) return
        const removed = removeLeaf(groups, order, tabId)
        if (removed.ok) groups = removed.groups
      }
      without.splice(at, 0, tabId)
      next = without
    }
    this.apply(projectId, groups, order, contiguousOrder(next, groups), true)
  }

  /**
   * `tabs.create` with `beside` (split right / down, D15): run `create`, then place the new tab
   * beside `beside.tabId`, publishing one snapshot at the end, so no view ever sees the new tab plain
   * first. A refused placement (anchor gone or foreign, the group full, too deep) leaves the tab
   * plain, as a plugin's `beside` does; the page sees the result in `groups.changed`. `create`
   * returning null (a command entry that opened as an overlay) places nothing: an overlay entry is
   * never a pane.
   */
  createBeside<T extends { id: string } | null>(
    projectId: string,
    beside: BesideRequest | undefined,
    create: () => T,
    opts: PlaceOpts = {}
  ): { tab: T; placed: boolean } {
    return this.atomic(projectId, () => {
      const tab = create()
      if (!tab || !beside) return { tab, placed: false }
      // A plugin never squeezes a pane below the minimum (D5, D7): its tab opens plain instead. Checked
      // after the create (the anchor may have closed or been resized while the login env was awaited), on
      // the very groups the placement makes.
      const fits =
        opts.plugin === true
          ? (before: readonly TabGroup[], after: readonly TabGroup[]) => this.panesFit(projectId, beside.tabId, tab.id, before, after)
          : undefined
      const reply = this.placeIf(projectId, { tabId: tab.id, at: beside.tabId, edge: beside.edge }, opts, fits)
      return { tab, placed: reply?.ok === true }
    })
  }

  /**
   * Whether a plugin's placement of `tabId` beside `anchor` (`before` to `after`) leaves PANE_MIN_CELLS to the new pane
   * and to every pane it shrinks: an even join of a split shrinks all its children, nested splits included (a pane at
   * 20% of a row inside a sibling can fall from 31 columns to 13). Both layouts are drawn in cells (cellsOf) in the
   * group's extent, which a size gives under the layout it was measured in (`extentFor`, never the share main has now).
   * A pane already under the minimum that the placement does not shrink is no reason to refuse.
   */
  private panesFit(projectId: string, anchor: string, tabId: string, before: readonly TabGroup[], after: readonly TabGroup[]): boolean {
    const was = groupOf(before, anchor)?.root
    const now = groupOf(after, tabId)?.root
    if (!now) return true // cannot happen: the placement put the tab in the anchor's group
    // The view's automatic zoom (D5): a group some view would show as its focused pane only. A plugin's pane that tips
    // a view over it would hide every pane but one there (a Team column of five on a 1080p screen collapsed to the
    // lead's pane), so it opens as a plain tab instead. Judged per view with the view's own rule (shared/pane-zoom.ts
    // autoZoomed) on the geometry it reported; a view zoomed before the placement is zoomed either way and no reason.
    const views = this.areas.get(projectId)
    const geometry = views && views.size > 0 ? [...views.values()] : []
    // Views whose own rule judged this placement: a remote view skipped below did not, so with only such views (a phone
    // reported, the desktop not yet) the cell-model fallback still runs rather than nothing checking the desktop.
    let judged = 0
    for (const g of geometry) {
      const zoomsAfter = autoZoomed(now, g.area, g.cell)
      // A plain anchor: the page never zooms a plain tab, so every view "shows" it. A local (desktop) view is strict: a
      // placement it would zoom is refused. A remote view that zooms even this two-pane split is too small for any split
      // (a phone): counting it would block every plugin split while it is open, so it is ignored (and judges nothing).
      if (!was && zoomsAfter && g.remote) continue
      judged++
      if (!zoomsAfter) continue
      if (!was) return false
      // In a group: a view zoomed before is zoomed either way and no reason; one that starts zooming is.
      if (!autoZoomed(was, g.area, g.cell)) return false
    }
    const extent = this.extentFor(projectId, anchor, before)
    // No tab of the project has a size a view gave it (a page anchor, a window no view has measured yet): no check.
    if (extent === 'unknown') return true
    // Sizes whose layout cannot be told apart any more (see Seen.since): a pane that may not fit is not placed.
    if (!extent) return false
    const old = was ? cellsOf(was, extent) : new Map([[anchor, extent]])
    // Shrinking is decided on the unrounded cells: floored, 19.43 to 19.23 columns are both 19 and would hide a pane
    // that (the extent being a low estimate) really goes from 20.08 to 19.88. A shrunk or new pane then needs the
    // minimum in whole cells.
    const tooSmall = (now: number, was: number | undefined, min: number): boolean =>
      (was === undefined || now < was - SHRINK_EPS) && Math.floor(now) < min
    for (const [t, c] of cellsOf(now, extent)) {
      const o = old.get(t)
      if (tooSmall(c.cols, o?.cols, PANE_MIN_CELLS.cols) || tooSmall(c.rows, o?.rows, PANE_MIN_CELLS.rows)) return false
    }
    // The fallback while no view has judged the placement by its geometry (a page not loaded yet, an older client, or
    // only a phone that is too small for any split): the same zoom
    // approximated in main's cell model, with a fixed chrome allowance. It can disagree with the view (tiny fonts, near
    // the 40-column boundary, dragged shares), which is why the geometry above wins whenever there is any.
    if (judged === 0 && showsSideBySide(was ? cellsOf(evenRoot(was), extent) : new Map([[anchor, extent]]))) {
      if (!showsSideBySide(cellsOf(evenRoot(now), extent))) return false
    }
    return true
  }

  /**
   * The group extent a plugin's placement beside `anchor` is checked in (`groups`: the layout before it). First the
   * anchor's own size when it was measured in the place the anchor has now (`exactExtent`). Else a group mate's size
   * measured where it is now, the smallest of them (two views can size different panes). Else the sizes of the anchor
   * and its mates read against the places they may have been measured in (`extentAt`), the smallest; undefined when
   * some of them have a size but none can be told any more (refused). 'unknown' only when none of them has a size.
   *
   * Why a mate's current size beats the anchor's own: a pane is placed and the next one asked beside it before any
   * view reported the first one's size (a plugin opening a column of panes back to back). The anchor then has no size,
   * or a size from before its last move, read against the smallest of the places it may have come from: a pane at a
   * third of a row read as if it were at a half gives half the real width, and a fourth pane that fits in a wide window
   * was refused. The lead beside it, measured since, knows the area. An anchor with no size is still checked against a
   * mate's older size: 'unknown' there let three 4-row panes into a 14-row window.
   *
   * Only the group: its panes are shown together, so their sizes are as fresh as the anchor's. A tab outside it (a
   * plain tab, another group) may be hidden, and a hidden tab keeps its size after the window was resized while its
   * place never changed, so nothing would mark that size old: it would refuse a pane that fits, or pass one that does not.
   */
  private extentFor(projectId: string, anchor: string, groups: readonly TabGroup[]): CellSize | undefined | 'unknown' {
    const own = this.exactExtent(projectId, anchor, groups)
    if (own) return own
    const group = groupOf(groups, anchor)
    const mates = group ? leavesOf(group.root).filter((t) => t !== anchor) : []
    const exact = mates.flatMap((t) => this.exactExtent(projectId, t, groups) ?? [])
    if (exact.length > 0) return smallestOf(exact)
    let sized = false
    const estimates: CellSize[] = []
    for (const t of [anchor, ...mates]) {
      const size = this.sizeOf(projectId, t)
      if (!size) continue
      sized = true
      const e = this.extentAt(projectId, t, size, placeIn(groups, t))
      if (e) estimates.push(e)
    }
    if (!sized) return 'unknown'
    return estimates.length > 0 ? smallestOf(estimates) : undefined
  }

  /**
   * The group extent `tabId`'s size gives when that size was measured in the place the tab has in `groups`: it has not
   * moved since the tracking began (no Seen), or its size changed after its last move and it has had only that place
   * since. Undefined otherwise (no size, a size from before the last move, or several places it may come from).
   */
  private exactExtent(projectId: string, tabId: string, groups: readonly TabGroup[]): CellSize | undefined {
    const size = this.sizeOf(projectId, tabId)
    if (!size) return undefined
    const rec = this.stateOf(projectId).seen.get(tabId)
    if (!rec) return extentFrom(placeIn(groups, tabId), size)
    if (sameSize(rec.size, size) || rec.since?.length !== 1) return undefined
    return extentFrom(rec.since[0]!, size)
  }

  /**
   * The group extent the tab's `size` gives, read against the place it was measured in (Seen): its size unchanged
   * since its last move, the place it had before that move; a size reported since, the places it has had since (the
   * smallest extent of them, as a view can still be one move behind). A tab never moved has always had `path`.
   */
  private extentAt(projectId: string, tabId: string, size: CellSize, path: PaneStep[] | undefined): CellSize | undefined {
    const rec = this.stateOf(projectId).seen.get(tabId)
    if (!rec) return path ? extentFrom(path, size) : undefined
    if (sameSize(rec.size, size)) return rec.extent
    return rec.since ? smallestExtent(rec.since, size) : undefined
  }

  /**
   * The layout changes from `before` to `after`: note, for every tab whose place in it changes, its size now and what it
   * was measured under (Seen). Run before each change is stored, so a size read here is never the new layout's.
   */
  private moved(projectId: string, before: readonly TabGroup[], after: readonly TabGroup[]): void {
    if (!this.deps.sizeOf) return
    const seen = this.stateOf(projectId).seen
    const tabs = new Set([...before, ...after].flatMap((g) => leavesOf(g.root)))
    for (const t of tabs) {
      const was = placeIn(before, t)
      const now = placeIn(after, t)
      if (samePlace(was, now)) continue
      const size = this.sizeOf(projectId, t)
      const rec = seen.get(t)
      if (rec && sameSize(rec.size, size)) {
        // Still the size of the place before the last move: one more place a new size may come from.
        if (rec.since && !rec.since.some((p) => samePlace(p, now))) {
          rec.since = rec.since.length < SEEN_PLACES ? [...rec.since, now] : undefined
        }
        continue
      }
      // A new size (or the first move): measured in a place the tab had since its last move, or `was` for a first one.
      const extent = !size ? undefined : !rec ? extentFrom(was, size) : rec.since ? smallestExtent(rec.since, size) : undefined
      seen.set(t, { size, extent, since: [now] })
    }
  }

  /** TabGroupsDeps.sizeOf, undefined when absent, unknown or throwing. */
  private sizeOf(projectId: string, tabId: string): CellSize | undefined {
    try {
      return this.deps.sizeOf?.(projectId, tabId)
    } catch (err) {
      this.log(`tab groups size failed: ${errorText(err)}`)
      return undefined
    }
  }

  /** A plugin's `panesPerGroup` now (TabGroupsDeps.pluginPanes), clamped to 2..GROUP_CAPS.maxPanes; the default when unknown. */
  private pluginPanes(pluginId: string | undefined): number {
    let n: unknown
    try {
      n = pluginId === undefined ? undefined : this.deps.pluginPanes?.(pluginId)
    } catch (err) {
      this.log(`tab groups plugin limit failed: ${errorText(err)}`)
    }
    if (typeof n !== 'number' || !Number.isInteger(n)) return GROUP_CAPS.pluginBelow
    return Math.min(Math.max(n, 2), GROUP_CAPS.maxPanes)
  }

  /**
   * Where a plugin's `focus: true` goes after an open (D4, D7). Placed beside an anchor: the group is
   * shown in the origin view only, by selecting the anchor there, so the anchor keeps focus and the new
   * pane never takes it; nothing at all when that view already shows the group (its focused pane stays
   * where the person left it: D3, nothing done elsewhere moves a view's keys). Not placed: the new
   * plain tab is selected in the window, as an open did before groups existed.
   */
  pluginFocus(
    projectId: string,
    opened: { tabId: string; placed: boolean; anchor?: string },
    view: string,
    selectionOf: (view: string) => string | undefined
  ): { to: 'window'; tabId: string } | { to: 'view'; view: string; tabId: string } | undefined {
    if (!opened.placed || opened.anchor === undefined) return { to: 'window', tabId: opened.tabId }
    const group = groupOf(this.groupsOf(projectId), opened.anchor)
    const shown = selectionOf(view)
    if (group && shown !== undefined && leavesOf(group.root).includes(shown)) return undefined
    return { to: 'view', view, tabId: opened.anchor }
  }

  /**
   * TabManager's lifecycle `closed` (a person's close, a plugin's, a clean exit under `tabExit`):
   * the leaf goes, its siblings take its space, a group left with one pane dissolves. Published at
   * once; not saved here (TabManager's change right after the close saves tabs and groups together).
   * The tab is still in TabManager's order while this runs. Removing a member keeps the others
   * contiguous, so the order is not rewritten.
   */
  tabClosed(tabId: string): void {
    this.departed = undefined
    for (const state of this.projects.values()) state.seen.delete(tabId)
    for (const [projectId, state] of this.projects) {
      const group = groupOf(state.groups, tabId)
      if (!group) continue
      const order = this.deps.order(projectId).filter((t) => t !== tabId)
      const result = removeLeaf(state.groups, order, tabId)
      if (!result.ok) return
      // What took the closed pane's place, for an exit's focus (`departedPanes`): what is left of the
      // group in reading order, or the one tab a dissolve left plain.
      const now = result.groups.find((g) => g.id === group.id)
      const panes = now ? leavesOf(now.root) : leavesOf(group.root).filter((t) => t !== tabId && order.includes(t))
      this.departed = { tabId, panes }
      this.moved(projectId, state.groups, result.groups)
      state.seen.delete(tabId)
      state.groups = result.groups
      this.publish(projectId, order)
      this.told(projectId)
      return
    }
  }

  /**
   * The panes the closed `tabId` left behind (reading order; one tab when its group dissolved), when
   * it was the last tab `tabClosed` removed from a group; undefined otherwise (a plain tab, or another
   * close since). Read right after the close by main's exit focus (TabManagerOptions.exitClosed,
   * which runs synchronously after the lifecycle's `closed`), so one slot is enough. Cleared on read.
   */
  departedPanes(tabId: string): string[] | undefined {
    const d = this.departed
    if (d?.tabId !== tabId) return undefined
    this.departed = undefined
    return d.panes
  }

  /**
   * TabManager's saved shape changed (a tab created, closed, moved, restarted, ...): publish when the
   * order differs from the last snapshot. A leaf that is not a live tab any more (it cannot happen
   * through `tabClosed`, but this is the one place that would notice) is pruned.
   */
  sync(projectId: string): void {
    if (this.held.has(projectId)) return
    const order = this.deps.order(projectId)
    const state = this.projects.get(projectId)
    if (state && state.groups.length > 0) {
      const live = normalizeGroups(state.groups, this.panesOf(projectId, order), undefined, this.mint)
      if (JSON.stringify(live) !== JSON.stringify(state.groups)) {
        this.moved(projectId, state.groups, live)
        state.groups = live
        this.told(projectId)
      }
    }
    this.publish(projectId, order)
  }

  /**
   * A restore (launch, or `TabRestorer.requeue` on a window reopen) brought tabs back with new ids:
   * the saved groups name the saved `TabRecord.id`s, `idMap` maps each to its restored tab, and a
   * leaf whose tab did not come back is pruned (shared/tab-groups.ts restoreGroups, with the load
   * caps of D6). Groups made meanwhile (a browser split tabs before the desktop attached) come first.
   * Publishes and saves, before the desktop's `tabs.list` reply (restore.ts runs it inside the attach).
   */
  restore(projectId: string, saved: unknown, idMap: ReadonlyMap<string, string>): void {
    const order = this.deps.order(projectId)
    const restored = restoreGroups(saved, idMap, this.mint)
    // Against the panes: a saved leaf whose tab did not come back (or is not a pane kind) is pruned.
    const groups = normalizeGroups([...this.groupsOf(projectId), ...restored], this.panesOf(projectId, order), undefined, this.mint)
    this.apply(projectId, groups, order, contiguousOrder(order, groups), true)
  }

  /**
   * A view of the project reported its split geometry (router `groups.area`, checked by splitGeometryOf; undefined: a
   * malformed report, which drops what the view said before rather than keep a stale one).
   */
  viewArea(projectId: string, viewId: ViewId, geometry: SplitGeometry | undefined): void {
    if (this.deps.measured && !this.deps.measured(viewId)) return
    let views = this.areas.get(projectId)
    if (!geometry) {
      views?.delete(viewId)
      return
    }
    if (!views) this.areas.set(projectId, (views = new Map()))
    // `remote` from the id main bound to the view (router CallView), never from the payload.
    views.set(viewId, { area: { ...geometry.area }, cell: { ...geometry.cell }, remote: isRemoteViewId(viewId) })
  }

  /** The split geometry each view of the project reported, as panesFit judges by it (a test hook's read). */
  viewAreas(projectId: string): Array<SplitGeometry & { remote: boolean }> {
    return [...(this.areas.get(projectId)?.values() ?? [])].map((g) => ({ area: { ...g.area }, cell: { ...g.cell }, remote: g.remote }))
  }

  /** The view is gone (its socket or window closed): its geometry no longer stands for a screen anyone looks at. */
  viewGone(viewId: ViewId): void {
    for (const [projectId, views] of this.areas) {
      views.delete(viewId)
      if (views.size === 0) this.areas.delete(projectId)
    }
  }

  /** The project's window closed (or is being reopened): its tabs die with it, so do its groups. */
  closeProject(projectId: string): void {
    this.projects.delete(projectId)
    this.areas.delete(projectId)
    this.held.delete(projectId)
    this.saveOwed.delete(projectId)
  }

  /** False only for a live tab of the project whose kind may not be a pane. */
  private mayBePane(projectId: string, tabId: string): boolean {
    if (!this.deps.kindOf) return true
    const kind = this.deps.kindOf(projectId, tabId)
    return kind === undefined || isPaneKind(kind)
  }

  /** The ids of `order` that may be panes: the liveness a load or a sync checks leaves against. */
  private panesOf(projectId: string, order: readonly string[]): string[] {
    return this.deps.kindOf ? order.filter((t) => isPaneKind(this.deps.kindOf!(projectId, t))) : [...order]
  }

  /** Run `fn` with this project's snapshot held until it returns, then publish once. */
  private atomic<R>(projectId: string, fn: () => R): R {
    this.held.set(projectId, (this.held.get(projectId) ?? 0) + 1)
    try {
      return fn()
    } finally {
      const n = (this.held.get(projectId) ?? 1) - 1
      if (n > 0) this.held.set(projectId, n)
      else {
        this.held.delete(projectId)
        this.sync(projectId)
        if (this.saveOwed.delete(projectId)) this.save(projectId)
      }
    }
  }

  /**
   * Store an op's result: the new order into TabManager when it differs, then one snapshot, one
   * save. `always`: publish and save even when nothing differs (a reorder that changed only the
   * order, a restore that brought nothing, which still owes the views the order).
   */
  private apply(projectId: string, groups: TabGroup[], before: readonly string[], order: string[], always = false): GroupsReply {
    const state = this.stateOf(projectId)
    const groupsMoved = JSON.stringify(groups) !== JSON.stringify(state.groups)
    const orderMoved = !sameList(before, order)
    if (groupsMoved) this.moved(projectId, state.groups, groups)
    state.groups = groups
    if (orderMoved) this.deps.setOrder(projectId, order)
    if (groupsMoved || orderMoved || always) {
      this.publish(projectId, this.deps.order(projectId))
      this.save(projectId)
    }
    if (groupsMoved) this.told(projectId)
    return { ok: true, seq: state.published?.seq ?? this.seq }
  }

  /** Publish a snapshot unless it says what the last one said (or the project is held). */
  private publish(projectId: string, order: string[]): void {
    if (this.held.has(projectId)) return
    const state = this.stateOf(projectId)
    const groups = JSON.stringify(state.groups)
    const last = state.published
    if (last && last.groups === groups && sameList(last.order, order)) return
    const seq = ++this.seq
    state.published = { seq, order: [...order], groups }
    // Pages draw from this; a project with no groups gets `groups: []` and the order, which is
    // exactly its strip as today.
    this.call('publish', () => this.deps.publish(projectId, { seq, order: [...order], groups: state.groups }))
  }

  private save(projectId: string): void {
    if (this.held.has(projectId)) {
      this.saveOwed.add(projectId)
      return
    }
    this.call('save', () => this.deps.changed(projectId))
  }

  private told(projectId: string): void {
    this.call('groupsChanged', () => this.deps.groupsChanged?.(projectId))
  }

  /** A throwing listener is logged and never undoes the edit (TabManager's rule for its listeners). */
  private call(what: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.log(`tab groups ${what} failed: ${errorText(err)}`)
    }
  }

  private stateOf(projectId: string): ProjectGroups {
    let state = this.projects.get(projectId)
    if (!state) {
      state = { groups: [], published: undefined, seen: new Map() }
      this.projects.set(projectId, state)
    }
    return state
  }
}

/** A refusal's reason, for logs and tests. */
export function refusalOf(reply: GroupsReply): GroupRefusalReason | undefined {
  return reply.ok ? undefined : reply.reason
}

const clamp = (i: number, length: number): number => Math.min(Math.max(i, 0), length)

/**
 * Whether every pane of an evened group (cellsOf over evenRoot) holds AUTO_ZOOM_CELLS plus its chrome (PANE_CHROME_CELLS:
 * main's cells count no frame or header, the view's pixels do), so a view of this size shows the panes side by side.
 * Only panesFit's fallback while no view has reported its geometry: the view's own rule (pane-zoom.ts) wins otherwise.
 */
function showsSideBySide(cells: ReadonlyMap<string, CellSize>): boolean {
  for (const c of cells.values()) {
    if (Math.floor(c.cols) < AUTO_ZOOM_CELLS.cols + PANE_CHROME_CELLS.cols) return false
    if (Math.floor(c.rows) < AUTO_ZOOM_CELLS.rows + PANE_CHROME_CELLS.rows) return false
  }
  return true
}

function sameSize(a: CellSize | undefined, b: CellSize | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.cols === b.cols && a.rows === b.rows
}

/** The smallest of `extents` per axis: the one that cannot overstate the room. */
function smallestOf(extents: readonly CellSize[]): CellSize {
  return { cols: Math.min(...extents.map((e) => e.cols)), rows: Math.min(...extents.map((e) => e.rows)) }
}

/** The tab's place in `groups`: its path in its group, `[]` for a plain tab (its pane is the whole area). */
function placeIn(groups: readonly TabGroup[], tabId: string): PaneStep[] {
  const g = groupOf(groups, tabId)
  return (g && pathTo(g.root, tabId)) ?? []
}

function samePlace(a: readonly PaneStep[], b: readonly PaneStep[]): boolean {
  return a.length === b.length && a.every((s, i) => s.dir === b[i]!.dir && s.n === b[i]!.n && s.share === b[i]!.share)
}

/** The smallest group extent `size` gives in any of `places`, per axis: the one that cannot overstate the room. */
function smallestExtent(places: readonly PaneStep[][], size: CellSize): CellSize {
  return smallestOf(places.map((p) => extentFrom(p, size)))
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}
