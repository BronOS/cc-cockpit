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
  PANE_MIN_CELLS,
  contiguousOrder,
  dissolve,
  groupOf,
  leavesOf,
  normalizeGroups,
  place,
  removeLeaf,
  rename,
  restoreGroups,
  setSizes,
  isPaneKind,
  type GroupRefusalReason,
  type GroupsSnapshot,
  type PaneEdge,
  type PlaceIntent,
  type TabGroup
} from '../../shared/tab-groups'
import type { TabKind } from '../../shared/types'
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
   * The anchor's terminal size in cells now (TabManager.sizeOf): a plugin's `beside` is placed only
   * when both halves of the anchor's pane would keep PANE_MIN_CELLS (D5). Absent or unknown: no check.
   */
  sizeOf?(projectId: string, tabId: string): { cols: number; rows: number } | undefined
  log?: (message: string) => void
}

interface ProjectGroups {
  groups: TabGroup[]
  /** What the last snapshot said, to publish only a real change (`sync`). */
  published: { seq: number; order: string[]; groups: string } | undefined
}

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
  place(projectId: string, intent: PlaceIntent, opts: { plugin?: boolean } = {}): GroupsReply {
    // A kind outside isPaneKind is refused, as the tab placed or as the anchor. An unknown id goes
    // on to `unknown-tab`.
    if (!this.mayBePane(projectId, intent.tabId) || !this.mayBePane(projectId, intent.at)) {
      return { ok: false, reason: 'not-a-pane' }
    }
    const order = this.deps.order(projectId)
    const result = place(this.groupsOf(projectId), order, intent, {
      mint: this.mint,
      ...(opts.plugin === true ? { plugin: true } : {})
    })
    if (!result.ok) return result
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
    opts: { plugin?: boolean } = {}
  ): { tab: T; placed: boolean } {
    return this.atomic(projectId, () => {
      const tab = create()
      if (!tab || !beside) return { tab, placed: false }
      // A plugin never squeezes a pane below the minimum (D5, D7): its tab opens plain instead. Asked
      // after the create (the anchor may have closed or been resized while the login env was awaited).
      if (opts.plugin === true && !this.halvesFit(projectId, beside)) return { tab, placed: false }
      const reply = this.place(projectId, { tabId: tab.id, at: beside.tabId, edge: beside.edge }, opts)
      return { tab, placed: reply.ok }
    })
  }

  /** Whether both halves of the anchor's pane split on `edge` keep PANE_MIN_CELLS (a 1-cell divider between). */
  private halvesFit(projectId: string, beside: BesideRequest): boolean {
    let size: { cols: number; rows: number } | undefined
    try {
      size = this.deps.sizeOf?.(projectId, beside.tabId)
    } catch (err) {
      this.log(`tab groups size failed: ${errorText(err)}`)
    }
    if (!size) return true
    const across = beside.edge === 'left' || beside.edge === 'right'
    return across
      ? Math.floor((size.cols - 1) / 2) >= PANE_MIN_CELLS.cols && size.rows >= PANE_MIN_CELLS.rows
      : Math.floor((size.rows - 1) / 2) >= PANE_MIN_CELLS.rows && size.cols >= PANE_MIN_CELLS.cols
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
    for (const [projectId, state] of this.projects) {
      if (!groupOf(state.groups, tabId)) continue
      const order = this.deps.order(projectId).filter((t) => t !== tabId)
      const result = removeLeaf(state.groups, order, tabId)
      if (!result.ok) return
      state.groups = result.groups
      this.publish(projectId, order)
      this.told(projectId)
      return
    }
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

  /** The project's window closed (or is being reopened): its tabs die with it, so do its groups. */
  closeProject(projectId: string): void {
    this.projects.delete(projectId)
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
      state = { groups: [], published: undefined }
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

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}
