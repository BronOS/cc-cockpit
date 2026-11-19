// Split terminal view (design.md §1 of team run 001): a tab group is a tree of panes, each pane one
// live terminal tab of the project, drawn side by side. Groups are a layer over the flat tab list:
// a plain tab has no group, and a project with no groups runs exactly today's code.
//
// Pure and immutable, like shared/layout.ts: no DOM, Electron or Node imports, so main (the one
// writer, main/tabs/tab-groups.ts), the page and restore all go through this one module. Every
// operation takes the current groups and returns a new state or a typed refusal; none throws on bad
// input, since every payload here comes from a page (any view, a browser included: D12) or from the
// user-writable project record.
//
// Invariants (enforced by `canonGroup` after every op and by `normalizeGroups` on every load):
//  - a leaf is a live terminal tab of the project (the caller's `order` / `liveTabIds`), never an
//    overlay entry; a tab sits in at most one group (first wins);
//  - a split has >= 2 children, none a split of its own direction (flattened: N-ary tree), and
//    `sizes` are finite fractions, one per child, each >= the minimum share, summing to 1;
//  - a group has >= 2 leaves (down to one it dissolves: the tab stays a plain tab in its place),
//    and its root is always a split;
//  - caps (GROUP_CAPS, decisions D6): an op that would break one is refused; a load clamps to them.
//
// Group and split ids are minted by main per run (the `mint` the caller passes); a restore mints
// fresh ones (restoreGroups), so a saved id never collides with main's counter.

import { isPlainObject } from './guards'
import { checkSessionName } from './session-name'

export type SplitDir = 'row' | 'column'
/** Where a placed tab goes relative to its anchor pane. */
export type PaneEdge = 'left' | 'right' | 'up' | 'down'
export const PANE_EDGES: readonly PaneEdge[] = ['left', 'right', 'up', 'down']

/**
 * The tab kinds a pane may hold: every kind (Claude, Shell, command, and a plugin's page tab,
 * design-split-pages.md). An explicit list, not `true`: a new `TabKind` becomes a pane only by a
 * decision here. `undefined` (an unknown tab) is no pane; `not-a-pane` stays as the refusal for the
 * next kind that is not one.
 */
export const isPaneKind = (kind: string | undefined): boolean =>
  kind === 'claude' || kind === 'shell' || kind === 'command' || kind === 'page'

export interface PaneLeaf {
  tab: string
}
/** `row`: children left to right; `column`: top to bottom. `sizes[i]` is child i's share. */
export interface PaneSplit {
  id: string
  dir: SplitDir
  children: PaneNode[]
  sizes: number[]
}
export type PaneNode = PaneLeaf | PaneSplit

export interface TabGroup {
  id: string
  /** The person's name for the group (Rename in the handle menu); absent when unnamed. */
  name?: string
  /** Always a split: a group has at least two panes. */
  root: PaneSplit
}

/**
 * The whole arrangement of a project, as the `groups.changed` event and the `groups.get` reply
 * carry it. `order` is the project's tab order with every group contiguous (contiguousOrder);
 * `seq` grows with each change, and a page drops a snapshot older than the one it has.
 */
export interface GroupsSnapshot {
  seq: number
  order: string[]
  groups: TabGroup[]
}

export interface GroupCaps {
  /** Panes (leaves) per group. */
  maxPanes: number
  /** Nested split levels; the root split is level 1. */
  maxDepth: number
  /** Groups per project. */
  maxGroups: number
  /** The smallest share a child may have in its split (main's clamp; D5). */
  minShare: number
  /**
   * A plugin's `beside` places only while the target group has fewer panes than this (D6). The default; main passes
   * the person's `panesPerGroup` plugin limit (shared/plugin-limits.ts) in its place, read at each placement.
   */
  pluginBelow: number
}

/** Decisions D6 and D5. Ops refuse past them; a load clamps to them. */
export const GROUP_CAPS: Readonly<GroupCaps> = Object.freeze({
  maxPanes: 8,
  maxDepth: 4,
  maxGroups: 32,
  minShare: 0.1,
  pluginBelow: 4
})

/** The smallest pane in terminal cells: a split or a divider drag below it is refused (D5). */
export const PANE_MIN_CELLS = Object.freeze({ cols: 20, rows: 5 })
/**
 * A view whose panes would fall below this shows the group zoomed to the focused pane (D5, tunable). 6 rows, not 10:
 * a Team column of five members on a 1080p screen gets about 8 rows a pane, easy to follow, and at 10 the whole group
 * collapsed to one pane on a screen with room for all of it. The width stays 40 for phones and narrow windows.
 */
export const AUTO_ZOOM_CELLS = Object.freeze({ cols: 40, rows: 6 })
/**
 * A pane's chrome (its frame and header, PANE_CHROME in the renderer: 32 px wide, 38 px tall) in cells of a 13-14 px
 * terminal font, rounded up. Main's cell model (cellsOf) counts one cell per divider and nothing else, so a plugin's
 * placement checked against AUTO_ZOOM_CELLS adds this to stay at or above what the view's check (in pixels, chrome
 * taken off) will find.
 */
export const PANE_CHROME_CELLS = Object.freeze({ cols: 4, rows: 2 })

/** `root` with every split's children equal: what the view's automatic zoom (D5) judges a group's arrangement by. */
export function evenRoot(root: PaneNode): PaneNode {
  if (isLeaf(root)) return root
  return { ...root, children: root.children.map(evenRoot), sizes: root.children.map(() => 1 / root.children.length) }
}

/** A group name follows the tab name rule (1-60 characters, no control, bidi or invisible characters). */
export const checkGroupName = checkSessionName

export type GroupRefusalReason =
  | 'unknown-tab' // a tab id that is not a live tab of the project
  | 'not-a-pane' // a live tab of the project whose kind is not in isPaneKind (none today: every kind is a pane)
  | 'same-tab' // a tab placed beside itself
  | 'bad-edge'
  | 'not-grouped' // removeLeaf of a plain tab
  | 'unknown-group'
  | 'unknown-split'
  | 'bad-sizes' // not one finite positive number per child
  | 'bad-name'
  | 'full' // the group already has GROUP_CAPS.maxPanes panes (or pluginBelow, the person's panesPerGroup, for a plugin)
  | 'too-deep' // the placement would nest splits deeper than maxDepth
  | 'too-many-groups'

export interface GroupRefusal {
  ok: false
  reason: GroupRefusalReason
}
export interface GroupsChange {
  ok: true
  groups: TabGroup[]
  /** The new tab order: every group contiguous, in leaf reading order. */
  order: string[]
}
export type GroupsResult = GroupsChange | GroupRefusal
export type GroupsOnlyResult = { ok: true; groups: TabGroup[] } | GroupRefusal

/** Makes a fresh group or split id, unique for the run (main keeps a counter). */
export type MintId = () => string

export interface PlaceIntent {
  /** The tab to place: plain, or a member of any group (it moves out of that group). */
  tabId: string
  /** The anchor pane's tab: a member of a group, or a plain tab (then a new group is made). */
  at: string
  edge: PaneEdge
}

export interface PlaceOptions {
  mint: MintId
  caps?: GroupCaps
  /**
   * A plugin's `beside`: placed only while the target group has fewer than `caps.pluginBelow` panes (main passes the
   * person's `panesPerGroup` limit there), and placed evenly: beside an anchor whose parent split already runs the
   * edge's way the new pane joins that split and every child gets an equal share (withLeafBeside), so a stack of
   * room members stays 1/n each instead of 1/2, 1/4, 1/8.
   */
  plugin?: boolean
}

export const isPaneEdge = (v: unknown): v is PaneEdge =>
  typeof v === 'string' && (PANE_EDGES as readonly string[]).includes(v)

export const isLeaf = (node: PaneNode): node is PaneLeaf => 'tab' in node

const refuse = (reason: GroupRefusalReason): GroupRefusal => ({ ok: false, reason })

// ---------------------------------------------------------------------------------------------
// Queries

/** The tab ids of a tree in reading order: depth first, so left to right and top to bottom per split. */
export function leavesOf(root: PaneNode): string[] {
  const out: string[] = []
  const walk = (n: PaneNode): void => {
    if (isLeaf(n)) out.push(n.tab)
    else for (const c of n.children) walk(c)
  }
  walk(root)
  return out
}

/** The group a tab is a pane of, or undefined for a plain tab. */
export function groupOf(groups: readonly TabGroup[], tabId: string): TabGroup | undefined {
  return groups.find((g) => leavesOf(g.root).includes(tabId))
}

/** Nested split levels of a tree: a leaf is 0, a split of leaves 1. */
export function depthOf(node: PaneNode): number {
  return isLeaf(node) ? 0 : 1 + Math.max(...node.children.map(depthOf))
}

/**
 * The tab order with each group's members as one block in leaf reading order, at the place of the
 * group's first member in `order` (design §1, D9): the strip, tab shortcuts, the switcher and
 * restore keep one order. Plain tabs keep their place; a leaf not in `order` is left out.
 */
export function contiguousOrder(order: readonly string[], groups: readonly TabGroup[]): string[] {
  const inOrder = new Set(order)
  const groupByTab = new Map<string, TabGroup>()
  for (const g of groups) for (const t of leavesOf(g.root)) if (!groupByTab.has(t)) groupByTab.set(t, g)
  const emitted = new Set<TabGroup>()
  const seen = new Set<string>()
  const out: string[] = []
  for (const tab of order) {
    if (seen.has(tab)) continue
    const g = groupByTab.get(tab)
    if (!g) {
      seen.add(tab)
      out.push(tab)
      continue
    }
    if (emitted.has(g)) continue
    emitted.add(g)
    for (const t of leavesOf(g.root)) {
      if (!inOrder.has(t) || seen.has(t)) continue
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Geometry

export interface PaneRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The line between child `index` and `index + 1` of split `splitId`, as fractions of the group's
 * area. For a `row` split it is vertical: at `x`, from `y` down `length`; for a `column` split it is
 * horizontal: at `y`, from `x` across `length`. `area` is the split's own rect, which a drag needs
 * to turn a pointer position into sizes.
 */
export interface PaneDivider {
  splitId: string
  index: number
  dir: SplitDir
  x: number
  y: number
  length: number
  area: PaneRect
}

export interface PaneLayout {
  panes: Array<{ tab: string } & PaneRect>
  dividers: PaneDivider[]
}

/** Fractional rects (0..1 of the group's area) of every pane, in reading order, and every divider. */
export function rectsOf(root: PaneNode): PaneLayout {
  const out: PaneLayout = { panes: [], dividers: [] }
  const walk = (n: PaneNode, r: PaneRect): void => {
    if (isLeaf(n)) {
      out.panes.push({ tab: n.tab, ...r })
      return
    }
    let at = 0
    n.children.forEach((child, i) => {
      const share = n.sizes[i] ?? 0
      const cr: PaneRect =
        n.dir === 'row'
          ? { x: r.x + at * r.w, y: r.y, w: share * r.w, h: r.h }
          : { x: r.x, y: r.y + at * r.h, w: r.w, h: share * r.h }
      walk(child, cr)
      at += share
      if (i < n.children.length - 1) {
        out.dividers.push(
          n.dir === 'row'
            ? { splitId: n.id, index: i, dir: 'row', x: r.x + at * r.w, y: r.y, length: r.h, area: r }
            : { splitId: n.id, index: i, dir: 'column', x: r.x, y: r.y + at * r.h, length: r.w, area: r }
        )
      }
    })
  }
  walk(root, { x: 0, y: 0, w: 1, h: 1 })
  return out
}

const EPS = 1e-6

/**
 * The pane a focus chord moves to from `tabId`: among the panes across that edge (touching it), the
 * one with the most overlap along it; a tie goes to the top (left/right moves) or the left (up/down
 * moves). No wrap: undefined at the group's border, for a tab not in the tree, or a bad direction.
 */
export function neighbour(root: PaneNode, tabId: string, dir: PaneEdge): string | undefined {
  if (!isPaneEdge(dir)) return undefined
  const { panes } = rectsOf(root)
  const me = panes.find((p) => p.tab === tabId)
  if (!me) return undefined
  const horizontal = dir === 'left' || dir === 'right'
  let best: { tab: string; overlap: number; pos: number } | undefined
  for (const p of panes) {
    if (p.tab === tabId) continue
    const touches =
      dir === 'right'
        ? Math.abs(p.x - (me.x + me.w)) < EPS
        : dir === 'left'
          ? Math.abs(p.x + p.w - me.x) < EPS
          : dir === 'down'
            ? Math.abs(p.y - (me.y + me.h)) < EPS
            : Math.abs(p.y + p.h - me.y) < EPS
    if (!touches) continue
    const overlap = horizontal
      ? Math.min(me.y + me.h, p.y + p.h) - Math.max(me.y, p.y)
      : Math.min(me.x + me.w, p.x + p.w) - Math.max(me.x, p.x)
    if (overlap <= EPS) continue
    const pos = horizontal ? p.y : p.x
    if (!best || overlap > best.overlap + EPS || (Math.abs(overlap - best.overlap) <= EPS && pos < best.pos)) {
      best = { tab: p.tab, overlap, pos }
    }
  }
  return best?.tab
}

/**
 * Whether a pane of `rect` pixels holds at least `min` cells of `cell` pixels: PANE_MIN_CELLS for a
 * split or divider drag (D5), AUTO_ZOOM_CELLS for a narrow view's automatic zoom. Non-finite or
 * non-positive input never fits.
 */
export function fitsMinimum(
  rect: { width: number; height: number },
  cell: { width: number; height: number },
  min: { cols: number; rows: number } = PANE_MIN_CELLS
): boolean {
  const ok = (v: number): boolean => Number.isFinite(v) && v > 0
  if (!ok(rect.width) || !ok(rect.height) || !ok(cell.width) || !ok(cell.height)) return false
  return Math.floor(rect.width / cell.width) >= min.cols && Math.floor(rect.height / cell.height) >= min.rows
}

// ---------------------------------------------------------------------------------------------
// Sizes

/**
 * `sizes` as shares for `n` children: a non-finite or non-positive entry (or a missing one) takes
 * the mean of the good ones, the whole is scaled to sum 1, then every share below `min` is raised
 * to it and the rest scaled down to make room (repeated until none is below). When `n * min` does
 * not fit in 1 the shares are equal. Always n finite positive numbers summing to 1 (within float).
 */
export function fitShares(sizes: readonly unknown[], n: number, min: number): number[] {
  return snap(fitRaw(sizes, n, min))
}

/** fitShares without the grid: the raw shares a load scales pruned and flattened children by. */
function fitRaw(sizes: readonly unknown[], n: number, min: number): number[] {
  if (n <= 0) return []
  const good: number[] = []
  for (let i = 0; i < n; i++) {
    const v = sizes[i]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) good.push(v)
  }
  const mean = good.length > 0 ? good.reduce((a, b) => a + b, 0) / good.length : 1
  let s: number[] = []
  for (let i = 0; i < n; i++) {
    const v = sizes[i]
    s.push(typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : mean)
  }
  let total = s.reduce((a, b) => a + b, 0)
  // Huge finite entries can sum to Infinity.
  if (!Number.isFinite(total) || total <= 0) s = s.map(() => 1)
  total = s.reduce((a, b) => a + b, 0)
  s = s.map((v) => v / total)
  if (!(min > 0)) return s
  if (n * min >= 1 - EPS) return s.map(() => 1 / n)
  const fixed = new Set<number>()
  for (let round = 0; round < n; round++) {
    let changed = false
    for (let i = 0; i < n; i++) {
      if (!fixed.has(i) && s[i]! < min) {
        fixed.add(i)
        changed = true
      }
    }
    if (!changed) break
    const room = 1 - fixed.size * min
    const restSum = s.reduce((a, v, i) => (fixed.has(i) ? a : a + v), 0)
    s = s.map((v, i) => (fixed.has(i) ? min : (v / restSum) * room))
  }
  return s
}

/**
 * Shares on a 1e-6 grid, the rounding left on the largest one (far above any minimum), so fitting
 * fitted shares again gives the same numbers: a normalize after every op must not drift by a float
 * ulp and look like a change.
 */
function snap(s: number[]): number[] {
  if (s.length === 0) return s
  const out = s.map((v) => Math.round(v * 1e6) / 1e6)
  let big = 0
  for (let i = 1; i < out.length; i++) if (out[i]! > out[big]!) big = i
  out[big] = Math.round(out.reduce((a, v, i) => (i === big ? a : a - v), 1) * 1e6) / 1e6
  return out
}

// ---------------------------------------------------------------------------------------------
// Canonical form

/** How one tree is checked: which tabs are live, which are taken, how ids are minted. */
interface CanonCtx {
  /** The tab id a raw leaf is read as, or undefined to prune it (dead, mapped away). */
  tabOf: (raw: string) => string | undefined
  /** Tabs already in another group (first wins). */
  taken: Set<string>
  /** Ids already used by a group or split; a duplicate or bad id gets a minted one. */
  ids: Set<string>
  mint: MintId
  /** Re-mint every id (restore: the saved ids are another run's). */
  remint: boolean
  minShare: number
  /** Stop visiting nodes once this runs out (a 10,000-leaf record costs a bounded walk). */
  budget: { left: number }
  /** Leaves accepted so far in this group, and the most it may keep (Infinity in ops). */
  leaves: number
  maxLeaves: number
}

/** Raw nesting a load descends at most; deeper subtrees are pruned before they are visited. */
const RAW_DEPTH_LIMIT = 16
/** Nodes one normalize visits at most: 32 full groups are 480. */
const VISIT_BUDGET = 4096
const MAX_ID_LENGTH = 64

const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined)

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH

function idFor(raw: unknown, ctx: CanonCtx): string {
  if (!ctx.remint && isId(raw) && !ctx.ids.has(raw)) {
    ctx.ids.add(raw)
    return raw
  }
  for (;;) {
    const id = ctx.mint()
    if (!ctx.ids.has(id)) {
      ctx.ids.add(id)
      return id
    }
  }
}

/**
 * One raw node as a canonical one, or null when nothing live is left. Prunes dead, duplicate and
 * over-cap leaves, drops empty splits, lifts a split's only child into its place, flattens a child
 * split of its parent's direction (its sizes scaled by its share), fits the shares. `depth` is the
 * raw nesting, checked before descending.
 */
function canonNode(raw: unknown, depth: number, ctx: CanonCtx, local: Set<string>): PaneNode | null {
  if (ctx.budget.left <= 0 || !isPlainObject(raw)) return null
  ctx.budget.left -= 1
  const tab = own(raw, 'tab')
  if (tab !== undefined) {
    if (typeof tab !== 'string') return null
    const id = ctx.tabOf(tab)
    if (id === undefined || ctx.taken.has(id) || local.has(id) || ctx.leaves >= ctx.maxLeaves) return null
    local.add(id)
    ctx.leaves += 1
    return { tab: id }
  }
  if (depth >= RAW_DEPTH_LIMIT) return null
  const dir = own(raw, 'dir')
  const children = own(raw, 'children')
  if ((dir !== 'row' && dir !== 'column') || !Array.isArray(children)) return null
  const rawSizes = own(raw, 'sizes')
  const sizes: unknown[] = Array.isArray(rawSizes) ? rawSizes : []
  // Shares of the raw children (fitted, so a NaN or a missing entry gets a fair share before the
  // pruned ones are dropped).
  const n = Math.min(children.length, ctx.budget.left)
  const rawShares = fitRaw(sizes.slice(0, n), n, 0)
  const outChildren: PaneNode[] = []
  const outSizes: number[] = []
  const id = own(raw, 'id')
  for (let i = 0; i < n; i++) {
    const c = canonNode(children[i], depth + 1, ctx, local)
    if (!c) continue
    const share = rawShares[i]!
    if (!isLeaf(c) && c.dir === dir) {
      // Same direction: the child's children join this split, each with its part of the share.
      c.children.forEach((cc, j) => {
        outChildren.push(cc)
        outSizes.push(share * c.sizes[j]!)
      })
    } else {
      outChildren.push(c)
      outSizes.push(share)
    }
  }
  if (outChildren.length === 0) return null
  if (outChildren.length === 1) return outChildren[0]!
  return { id: idFor(id, ctx), dir, children: outChildren, sizes: fitShares(outSizes, outChildren.length, ctx.minShare) }
}

/**
 * The canonical form of one raw group, or null when it has fewer than two live leaves left (it
 * dissolves). Its leaves join `ctx.taken` only when the group is kept, so a dissolved group frees
 * its tab for a later group.
 */
function canonGroup(raw: unknown, ctx: CanonCtx): TabGroup | null {
  if (!isPlainObject(raw)) return null
  ctx.leaves = 0
  const local = new Set<string>()
  // The group's id is claimed before its splits', so a split with the same id cannot take it.
  const rawId = own(raw, 'id')
  const keepId = !ctx.remint && isId(rawId) && !ctx.ids.has(rawId)
  if (keepId) ctx.ids.add(rawId)
  const root = canonNode(own(raw, 'root'), 0, ctx, local)
  if (!root || isLeaf(root)) {
    if (keepId) ctx.ids.delete(rawId)
    return null
  }
  const group: TabGroup = { id: keepId ? rawId : idFor(undefined, ctx), root }
  const name = checkGroupName(own(raw, 'name'))
  if (name.ok && name.value !== null) group.name = name.value
  for (const t of local) ctx.taken.add(t)
  return group
}

function canonCtx(
  tabOf: (raw: string) => string | undefined,
  mint: MintId,
  caps: GroupCaps,
  remint: boolean,
  maxLeaves: number
): CanonCtx {
  return {
    tabOf,
    taken: new Set(),
    ids: new Set(),
    mint,
    remint,
    minShare: caps.minShare,
    budget: { left: VISIT_BUDGET },
    leaves: 0,
    maxLeaves
  }
}

/** Mints `n1`, `n2`, ... : the fallback when a load is not given main's own minter. */
function counterMint(prefix: string): MintId {
  let n = 0
  return () => `${prefix}${++n}`
}

function sanitizeCaps(caps: GroupCaps): GroupCaps {
  const int = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : d)
  const share = typeof caps?.minShare === 'number' && caps.minShare >= 0 && caps.minShare < 0.5 ? caps.minShare : GROUP_CAPS.minShare
  return {
    maxPanes: int(caps?.maxPanes, GROUP_CAPS.maxPanes),
    maxDepth: int(caps?.maxDepth, GROUP_CAPS.maxDepth),
    maxGroups: int(caps?.maxGroups, GROUP_CAPS.maxGroups),
    minShare: share,
    pluginBelow: int(caps?.pluginBelow, GROUP_CAPS.pluginBelow)
  }
}

/**
 * Turn whatever a record (or a page) holds into valid groups over `liveTabIds`. Lenient: own keys
 * only, raw depth checked before descending, enum directions, sizes fitted (non-finite ones take a
 * fair share, then clamped to the minimum share and renormalized), same-direction children
 * flattened, duplicate tabs pruned (first wins, across groups), dead leaves pruned, a group under
 * two leaves dissolved, and the caps applied: a group's leaves past `maxPanes` (reading order) are
 * dropped, a group nested deeper than `maxDepth` after flattening is dropped (its tabs stay plain
 * tabs), groups past `maxGroups` are dropped. Ids are kept when valid and unique, else minted.
 * Never throws: a record it cannot read at all yields `[]`; a bad layout never loses a tab.
 */
export function normalizeGroups(
  raw: unknown,
  liveTabIds: Iterable<string>,
  caps: GroupCaps = GROUP_CAPS,
  mint: MintId = counterMint('n')
): TabGroup[] {
  const live = new Set(liveTabIds)
  return normalizeWith(raw, (t) => (live.has(t) ? t : undefined), caps, mint, false)
}

/**
 * The groups a saved record names, for the tabs a restore brought back. Saved leaves name the saved
 * `TabRecord.id`s; `idMap` maps each to the restored tab's new id, and a leaf whose tab did not
 * come back (a dropped plugin command tab, a revoked plugin, a failed spawn) is pruned. Every group
 * and split id is minted fresh. Then normalized as any load.
 */
export function restoreGroups(
  saved: unknown,
  idMap: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  mint: MintId = counterMint('r'),
  caps: GroupCaps = GROUP_CAPS
): TabGroup[] {
  const lookup =
    idMap instanceof Map
      ? (t: string): string | undefined => idMap.get(t)
      : (t: string): string | undefined => {
          const v = Object.hasOwn(idMap, t) ? (idMap as Record<string, unknown>)[t] : undefined
          return typeof v === 'string' ? v : undefined
        }
  return normalizeWith(saved, lookup, caps, mint, true)
}

function normalizeWith(
  raw: unknown,
  tabOf: (raw: string) => string | undefined,
  rawCaps: GroupCaps,
  mint: MintId,
  remint: boolean
): TabGroup[] {
  try {
    if (!Array.isArray(raw)) return []
    const caps = sanitizeCaps(rawCaps)
    const ctx = canonCtx(tabOf, mint, caps, remint, caps.maxPanes)
    const out: TabGroup[] = []
    const n = Math.min(raw.length, VISIT_BUDGET)
    for (let i = 0; i < n && out.length < caps.maxGroups && ctx.budget.left > 0; i++) {
      const g = canonGroup(raw[i], ctx)
      if (!g) continue
      if (depthOf(g.root) > caps.maxDepth) {
        // Its tabs were claimed by canonGroup; a dropped group gives them back.
        for (const t of leavesOf(g.root)) ctx.taken.delete(t)
        continue
      }
      out.push(g)
    }
    return out
  } catch {
    return []
  }
}

/** Every group again through the canonical form (no caps: an op checks them itself and refuses). */
function canonAll(
  groups: readonly unknown[],
  live: ReadonlySet<string>,
  caps: GroupCaps,
  mint: MintId = counterMint('m')
): TabGroup[] {
  const ctx = canonCtx((t) => (live.has(t) ? t : undefined), mint, caps, false, Infinity)
  ctx.budget.left = Infinity
  const out: TabGroup[] = []
  for (const g of groups) {
    const c = canonGroup(g, ctx)
    if (c) out.push(c)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Operations

/** A copy of `node` without the leaf `tabId` (its size entry dropped too); not yet canonical. */
function withoutLeaf(node: PaneNode, tabId: string): PaneNode | null {
  if (isLeaf(node)) return node.tab === tabId ? null : node
  const children: PaneNode[] = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    const next = withoutLeaf(c, tabId)
    if (next) {
      children.push(next)
      sizes.push(node.sizes[i]!)
    }
  })
  return children.length === 0 ? null : { ...node, children, sizes }
}

/**
 * A copy of `node` with `tabId` beside the leaf `at` on `edge`: a sibling when the parent runs in the
 * edge's direction, else the anchor leaf becomes a new split of the two (halves). As a sibling the
 * anchor's share is halved (the person's split: only the pane they split gives room, the others keep
 * the sizes they dragged), or with `even` (a plugin's `beside`) every child of that split gets an
 * equal share: a plugin stacking panes down one column (the Team plugin's room members) would
 * otherwise give them 1/2, 1/4, 1/8 and soon fall under PANE_MIN_CELLS. Not yet canonical
 * (canonGroup fits the shares and lifts a lone child).
 */
function withLeafBeside(node: PaneNode, at: string, tabId: string, edge: PaneEdge, mint: MintId, even = false): PaneNode {
  const dir: SplitDir = edge === 'left' || edge === 'right' ? 'row' : 'column'
  const before = edge === 'left' || edge === 'up'
  const pair = (anchor: PaneLeaf): PaneSplit => ({
    id: mint(),
    dir,
    children: before ? [{ tab: tabId }, anchor] : [anchor, { tab: tabId }],
    sizes: [0.5, 0.5]
  })
  if (isLeaf(node)) return node.tab === at ? pair(node) : node
  const i = node.children.findIndex((c) => isLeaf(c) && c.tab === at)
  if (i >= 0 && node.dir === dir) {
    const children = [...node.children]
    children.splice(before ? i : i + 1, 0, { tab: tabId })
    if (even) return { ...node, children, sizes: children.map(() => 1 / children.length) }
    const half = node.sizes[i]! / 2
    const sizes = [...node.sizes]
    sizes.splice(i, 1, half, half)
    return { ...node, children, sizes }
  }
  return { ...node, children: node.children.map((c) => withLeafBeside(c, at, tabId, edge, mint, even)) }
}

/** A size in terminal cells (floats in the model below; a pane gets whole cells only when drawn). */
export interface CellSize {
  cols: number
  rows: number
}

/** One split on the way from a group's root down to a pane: its direction, its child count, the share of the child taken. */
export interface PaneStep {
  dir: SplitDir
  n: number
  share: number
}

/**
 * The splits from `root` down to the leaf `tabId`, outermost first; undefined when the tab is not in the tree. A plain
 * tab's path is `[]` (its pane is the whole area). With extentFrom and cellsOf, main's "too small" check for a plugin's
 * `beside` (TabGroups.createBeside).
 */
export function pathTo(root: PaneNode, tabId: string): PaneStep[] | undefined {
  if (isLeaf(root)) return root.tab === tabId ? [] : undefined
  for (let i = 0; i < root.children.length; i++) {
    const below = pathTo(root.children[i]!, tabId)
    if (below) return [{ dir: root.dir, n: root.children.length, share: root.sizes[i]! }, ...below]
  }
  return undefined
}

/**
 * The cells of every pane of `root` drawn in a group of `extent` cells. The model: a split of L cells along its axis has
 * a 1-cell divider between two children and gives each child its share of the rest, (L - (n - 1)) * share; the other
 * axis is the split's own. Floats: the caller floors (a view draws whole cells, and its pixels round a little apart).
 */
export function cellsOf(root: PaneNode, extent: CellSize): Map<string, CellSize> {
  const out = new Map<string, CellSize>()
  const walk = (node: PaneNode, size: CellSize): void => {
    if (isLeaf(node)) {
      out.set(node.tab, size)
      return
    }
    const along = node.dir === 'row' ? size.cols : size.rows
    const inner = along - (node.children.length - 1)
    node.children.forEach((c, i) => {
      const part = inner * node.sizes[i]!
      walk(c, node.dir === 'row' ? { cols: part, rows: size.rows } : { cols: size.cols, rows: part })
    })
  }
  walk(root, extent)
  return out
}

/** cellsOf backwards: the group's extent from one pane's `size` and its `path` (outermost first). */
export function extentFrom(path: readonly PaneStep[], size: CellSize): CellSize {
  let { cols, rows } = size
  for (let i = path.length - 1; i >= 0; i--) {
    const s = path[i]!
    if (s.dir === 'row') cols = cols / s.share + (s.n - 1)
    else rows = rows / s.share + (s.n - 1)
  }
  return { cols, rows }
}

/**
 * Place `tabId` beside the pane of `at` on `edge` (drag to an edge, Show beside, a split, a plugin's
 * `beside`). A tab already in a group moves: its source group shrinks and may dissolve. `at` in a
 * group: the tab joins that group; `at` plain: a new group of the two. Refused for a tab not in
 * `order` (the project's live terminal tabs), a tab beside itself, a bad edge, and past the caps
 * (`full`, `too-deep`, `too-many-groups`; a plugin also `full` from `caps.pluginBelow` panes).
 * The placed tab moves next to its anchor in the order, and every group stays contiguous.
 */
export function place(
  groups: readonly TabGroup[],
  order: readonly string[],
  intent: PlaceIntent,
  opts: PlaceOptions
): GroupsResult {
  const caps = sanitizeCaps(opts.caps ?? GROUP_CAPS)
  if (!isPlainObject(intent)) return refuse('unknown-tab')
  const { tabId, at, edge } = intent
  const live = new Set(order)
  if (typeof tabId !== 'string' || typeof at !== 'string' || !live.has(tabId) || !live.has(at)) {
    return refuse('unknown-tab')
  }
  if (tabId === at) return refuse('same-tab')
  if (!isPaneEdge(edge)) return refuse('bad-edge')
  const source = groupOf(groups, tabId)
  const target = groupOf(groups, at)

  let next: unknown[]
  if (target) {
    const sameGroup = source === target
    const panes = leavesOf(target.root).length
    if (!sameGroup && panes >= caps.maxPanes) return refuse('full')
    if (!sameGroup && opts.plugin && panes >= caps.pluginBelow) return refuse('full')
    const stripped = sameGroup ? withoutLeaf(target.root, tabId) : target.root
    if (!stripped) return refuse('unknown-tab') // cannot happen: `at` is still in it
    const root = withLeafBeside(stripped, at, tabId, edge, opts.mint, opts.plugin === true)
    next = groups.map((g) => (g === target ? { ...g, root } : g === source ? shrunk(g, tabId) : g))
  } else {
    const fresh = { id: opts.mint(), root: withLeafBeside({ tab: at }, at, tabId, edge, opts.mint) }
    next = [...groups.map((g) => (g === source ? shrunk(g, tabId) : g)), fresh]
  }
  const canon = canonAll(next, live, caps, opts.mint)
  if (canon.length > caps.maxGroups) return refuse('too-many-groups')
  const result = canon.find((g) => leavesOf(g.root).includes(tabId))
  if (result && depthOf(result.root) > caps.maxDepth) return refuse('too-deep')
  // The placed tab moves next to its anchor first, so a new group sits where the anchor was and a
  // joined group keeps its place (contiguity alone would pull the block to the tab's old place).
  const without = order.filter((t) => t !== tabId)
  without.splice(without.indexOf(at) + 1, 0, tabId)
  return { ok: true, groups: canon, order: contiguousOrder(without, canon) }
}

/** `g` without `tabId`; not canonical (a root left with one leaf dissolves in canonAll). */
function shrunk(g: TabGroup, tabId: string): { id: string; name?: string; root: PaneNode | null } {
  return { ...g, root: withoutLeaf(g.root, tabId) }
}

/**
 * Take `tabId` out of its group: its siblings take its space; a group left with one pane dissolves.
 * A tab still in `order` (Move out of group) becomes a plain tab right after what is left of the
 * block; a tab no longer in `order` (it closed) is only pruned. `not-grouped` for a plain tab.
 */
export function removeLeaf(
  groups: readonly TabGroup[],
  order: readonly string[],
  tabId: string,
  caps: GroupCaps = GROUP_CAPS
): GroupsResult {
  const source = typeof tabId === 'string' ? groupOf(groups, tabId) : undefined
  if (!source) return refuse('not-grouped')
  const rest = leavesOf(source.root).filter((t) => t !== tabId)
  const live = new Set(order)
  const canon = canonAll(
    groups.map((g) => (g === source ? shrunk(g, tabId) : g)),
    live,
    sanitizeCaps(caps)
  )
  const others = contiguousOrder(
    order.filter((t) => t !== tabId),
    canon
  )
  if (live.has(tabId)) {
    let last = -1
    others.forEach((t, i) => {
      if (rest.includes(t)) last = i
    })
    others.splice(last + 1, 0, tabId)
  }
  return { ok: true, groups: canon, order: others }
}

/**
 * A guest's view of the arrangement (D-16): every tab `visible` says no to is removed from the order and
 * from its group, the siblings take its share (renormalised, as a closed pane's would), a group left with
 * one pane dissolves into a plain tab, and a group that lost any member loses its name (a name can say
 * what the hidden pane is). Group and split ids are kept, so a guest's later `groups.changed` matches.
 * Pure; the input is main's own snapshot, so nothing is refused.
 */
export function projectGroups(snapshot: GroupsSnapshot, visible: (tabId: string) => boolean): GroupsSnapshot {
  const order = snapshot.order.filter((t) => visible(t))
  const live = new Set(order)
  const projected = canonAll(snapshot.groups, live, GROUP_CAPS)
  const groups = projected.map((g) => {
    const before = snapshot.groups.find((o) => o.id === g.id)
    const lost = before !== undefined && leavesOf(before.root).some((t) => !live.has(t))
    if (!lost || g.name === undefined) return g
    const out = { ...g }
    delete out.name
    return out
  })
  return { seq: snapshot.seq, order: contiguousOrder(order, groups), groups }
}

/** Ungroup: the group's members become plain tabs where they are (the block stays); nothing closes. */
export function dissolve(groups: readonly TabGroup[], order: readonly string[], groupId: string): GroupsResult {
  if (!groups.some((g) => g.id === groupId)) return refuse('unknown-group')
  const next = groups.filter((g) => g.id !== groupId)
  return { ok: true, groups: next, order: contiguousOrder(order, next) }
}

/**
 * Set the shares of split `splitId` in group `groupId` (a divider drag, sent once on release;
 * shared by every view, D1). One finite positive number per child; they are scaled to sum 1 and
 * clamped to the minimum share, so no op makes a pane 0.
 */
export function setSizes(
  groups: readonly TabGroup[],
  groupId: string,
  splitId: string,
  sizes: readonly number[],
  caps: GroupCaps = GROUP_CAPS
): GroupsOnlyResult {
  const group = groups.find((g) => g.id === groupId)
  if (!group) return refuse('unknown-group')
  const split = findSplit(group.root, splitId)
  if (!split) return refuse('unknown-split')
  if (
    !Array.isArray(sizes) ||
    sizes.length !== split.children.length ||
    !sizes.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
  ) {
    return refuse('bad-sizes')
  }
  const fitted = fitShares(sizes, sizes.length, sanitizeCaps(caps).minShare)
  const root = replaceSplit(group.root, splitId, (s) => ({ ...s, sizes: fitted })) as PaneSplit
  return { ok: true, groups: groups.map((g) => (g === group ? { ...g, root } : g)) }
}

/** Name a group (checkGroupName: 1-60 characters), or clear its name with `null`. */
export function rename(groups: readonly TabGroup[], groupId: string, name: string | null): GroupsOnlyResult {
  const group = groups.find((g) => g.id === groupId)
  if (!group) return refuse('unknown-group')
  const checked = checkGroupName(name)
  if (!checked.ok) return refuse('bad-name')
  const next: TabGroup = { id: group.id, root: group.root }
  if (checked.value !== null) next.name = checked.value
  return { ok: true, groups: groups.map((g) => (g === group ? next : g)) }
}

function findSplit(node: PaneNode, id: string): PaneSplit | undefined {
  if (isLeaf(node)) return undefined
  if (node.id === id) return node
  for (const c of node.children) {
    const hit = findSplit(c, id)
    if (hit) return hit
  }
  return undefined
}

function replaceSplit(node: PaneNode, id: string, change: (s: PaneSplit) => PaneSplit): PaneNode {
  if (isLeaf(node)) return node
  if (node.id === id) return change(node)
  return { ...node, children: node.children.map((c) => replaceSplit(c, id, change)) }
}
