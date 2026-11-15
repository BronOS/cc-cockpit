import { useEffect, useRef, useState } from 'react'
import type { SessionDetail, TabCommandMenu, TabInfo, TabStatus } from '../../shared/ipc'
import type { TabCommandLevel } from '../../shared/types'
import { splitChord } from '../../shared/keys'
import { FLAG_COLOR_LABEL, FLAG_COLORS, MAX_FLAG_NOTE_CHARS, type FlagColor, type FlagPatch } from '../../shared/tab-flag'
import { chordKeys, chordOf } from '../commands/keybindings'
import { usePrefs } from '../prefs/prefs-store'
import { QueuedChip } from '../status/QueuedChip'
import { StatusDot } from '../status/StatusDot'
import { useShellLayer } from '../zones/use-shell-layer'
import { acquireDrag } from '../zones/shell-layers'
import { ChevronDownGlyph, CloseGlyph, CommandGlyph, FileGlyph, PageGlyph, PlusGlyph, ShellGlyph, SplitGlyph } from '../window-icons'
import { groupOf, isPaneKind, leavesOf, type PaneEdge, type TabGroup } from '../../shared/tab-groups'
import { PANE_MODE_PX } from './pane-layout'
import { groupTitle, handleWords, leftSegment, stripRuns } from './strip-groups'
import { commandTooltip, pageTabMarks, tabLabel } from './tab-label'
import { DRAG_THRESHOLD, dropIndex, dropMarker } from './tab-drag'
import { hiddenFlags, type OverflowState, overflowState, scrollToReveal, wheelScrollsSideways } from './tab-overflow'
import { allTabsOrder, nextAttention, sameIds, statusesOf } from './tab-flags'
import { FlagSwatch } from './FlagSwatch'

/** A tab being dragged along the strip: where it started, how far it moved, where it would land. */
interface TabDrag {
  tabId: string
  pointerId: number
  from: number
  startX: number
  dx: number
  toIndex: number
  /** The handle of this group is dragged: the whole block moves (D9). */
  groupId?: string
  /** Pane mode: the pointer is well below the strip, over the terminal area (design §1). */
  pane?: boolean
}

/** What the [+] menu lists after Claude and Shell: the user's entries, app-wide then project. */
const COMMAND_GROUPS: Array<{ level: TabCommandLevel; name: string }> = [
  { level: 'app', name: 'App commands' },
  { level: 'project', name: 'Project commands' }
]

const mac = (): boolean => navigator.platform.toLowerCase().includes('mac')

/** The width of the strip's edge fade (the mask in styles.css): a tab whose centre is under it counts as hidden. */
const FADE_PX = 22

/**
 * Arrow keys walk a menu's enabled entries, wrapping, Home and End jump to the ends (a menu's own
 * convention; Escape is the window's). Left and Right walk too, so the flag colour row, laid out
 * sideways, reads naturally.
 */
function walkMenu(e: React.KeyboardEvent<HTMLElement>, sideways: boolean): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')]
  const at = items.indexOf(document.activeElement as HTMLElement)
  const go = (i: number): void => {
    e.preventDefault()
    items[(i + items.length) % items.length]?.focus()
  }
  if (e.key === 'ArrowDown' || (sideways && e.key === 'ArrowRight')) go(at + 1)
  else if (e.key === 'ArrowUp' || (sideways && e.key === 'ArrowLeft')) go(at < 0 ? -1 : at - 1)
  else if (e.key === 'Home') go(0)
  else if (e.key === 'End') go(-1)
}

/** A canonical chord (`shift+meta+l`) as aria-keyshortcuts writes it (`Shift+Meta+L`); `+` is `Plus` there. */
function ariaShortcut(chord: string): string | undefined {
  const parts = splitChord(chord)
  if (!parts) return undefined
  const cap = (p: string): string => (p === '+' ? 'Plus' : p.charAt(0).toUpperCase() + p.slice(1))
  return [...parts.mods, parts.key].map(cap).join('+')
}

/**
 * A chord as keycaps, one per key (⇧ ⌘ T). Hidden from assistive tech, which reads the row's
 * aria-keyshortcuts instead. On macOS the caps carry exactly displayChord's text (it joins with
 * nothing there); elsewhere the `+` stays between them as text, so the row's text reads as before.
 */
function Keys(props: { chord: string }): React.JSX.Element {
  const isMac = mac()
  const keys = chordKeys(props.chord, isMac)
  return (
    <span className="keys" aria-hidden="true">
      {keys.map((k, i) => (
        <span key={i} className="key-part">
          {i > 0 && !isMac && <span className="key-sep">+</span>}
          <kbd>{k}</kbd>
        </span>
      ))}
    </span>
  )
}

/**
 * The [+] menu's left-hand mark: where the entry opens. Every row carries one (Claude and Shell are
 * tabs too) so labels line up and the overlay rows stand out by shape, not by an extra word.
 * Drawn with currentColor so it follows the theme; hidden from assistive tech, which gets
 * `aria-description` on overlay rows instead.
 */
function OpenIcon(props: { open: 'tab' | 'overlay' }): React.JSX.Element {
  return (
    <svg
      className="menu-icon"
      data-open={props.open}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    >
      {props.open === 'tab' ? (
        // A window with a tab raised on its top-left edge.
        <path d="M1.5 5.5h13v8h-13zM1.5 5.5v-3h6v3" />
      ) : (
        // Two panes, the front one laid over the back one.
        <>
          <rect x="1.5" y="1.5" width="9" height="9" opacity="0.55" />
          <rect x="5.5" y="5.5" width="9" height="9" />
        </>
      )}
    </svg>
  )
}

function CoreEntry(props: { id: string; label: string; onClick: () => void }): React.JSX.Element {
  const key = chordOf(props.id)
  return (
    <button
      type="button"
      role="menuitem"
      className="menu-entry"
      onClick={props.onClick}
      aria-keyshortcuts={key ? ariaShortcut(key) : undefined}
    >
      <OpenIcon open="tab" />
      <span className="menu-label">{props.label}</span>
      {key && <Keys chord={key} />}
    </button>
  )
}

/**
 * The tab strip: select, close, a [+] menu (Claude / shell, then the user's command entries),
 * drag a tab left or right to reorder, and a context menu that does the same (move left / right)
 * for keyboard and assistive-tech users.
 *
 * The drag uses pointer events, not HTML5 drag and drop: a native drag session goes through the
 * window system (on Wayland, the compositor), shows a ghost image we don't control and can start a
 * drop into other apps, while a tab only ever moves within its own strip.
 */
export function TabBar(props: {
  tabs: TabInfo[]
  activeId: string | null
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onCreate: (kind: 'claude' | 'shell') => void
  /** A user entry of the [+] menu, by level and id: main looks its command up. */
  onCreateCommand: (level: TabCommandLevel, entryId: string) => void
  /** The user entries, as last read; null until the menu was first opened. */
  commands: TabCommandMenu | null
  /** The [+] menu is opening: read the entries again (they change in Settings). */
  onMenuOpen: () => void
  /** `delta` is -1 for left, +1 for right. */
  onMove: (tabId: string, delta: -1 | 1) => void
  /** Name a Claude tab, or `null` for Claude's own title (main checks the name). */
  onRename: (tabId: string, name: string | null) => void
  /** The person's flag: a colour, a note, both, or `null` to clear (main checks and stores it). */
  onFlag: (tabId: string, patch: FlagPatch | null) => void
  /**
   * The tab menu or one of its editors (rename, flag note) closed: they took the keyboard, so the
   * pane gives it back to the active terminal (TabsPane focusActive, which knows what is modal).
   */
  onMenuClosed: () => void
  /** A drag ended: put the tab at `toIndex` (its index after being taken out, as main's reorder). */
  onReorder: (tabId: string, toIndex: number) => void
  /** Status of the window's Claude tabs by tab id (shell tabs have none). */
  sessions: ReadonlyMap<string, SessionDetail>
  onCancelQueued: (tabId: string, itemId: string) => void
  /** The project's split groups (main's snapshot): members are drawn as one bracketed segment. */
  groups: readonly TabGroup[]
  /** The group this view shows (its segment is marked) and its zoom, for the handle's "zoomed (n hidden)". */
  zoom: { groupId: string; zoomTab?: string; auto: boolean } | undefined
  /** The handle's click: show the group, at this view's last focused pane there. */
  onSelectGroup: (groupId: string) => void
  onRenameGroup: (groupId: string, name: string | null) => void
  onEqualizeGroup: (groupId: string) => void
  onUngroup: (groupId: string) => void
  onCloseGroup: (groupId: string) => void
  /** The handle was dragged: the block goes to `toIndex` among the other tabs (D9). */
  onMoveGroup: (groupId: string, toIndex: number) => void
  /** A member was dragged out of its segment: it becomes a plain tab at `toIndex` (D9). */
  onDetach: (tabId: string, toIndex: number) => void
  /** Pane mode of a drag: the pointer over the terminal area (null: left it, or cancelled). */
  onPaneDrag: (tabId: string, point: { x: number; y: number } | null) => void
  /** Released in pane mode: place the tab at the previewed edge, if any. */
  onPaneDrop: (tabId: string) => void
  /** Why a split of the tab cannot be made (D5: the entry is disabled with this reason), or undefined. */
  splitBlocked: (tabId: string, edge: PaneEdge) => string | undefined
  onSplit: (tabId: string, edge: 'right' | 'down') => void
  /** Show beside: `tabId` goes at `edge` of `at`'s pane. */
  onShowBeside: (tabId: string, at: string, edge: 'right' | 'down') => void
  onMoveOut: (tabId: string) => void
}): React.JSX.Element {
  const { tabs, activeId, groups, onPaneDrag } = props
  // Settings › Appearance › Tabs; pushed by main, so every window's strip follows a pick.
  const { tabCloseSide } = usePrefs()
  const [createOpen, setCreateOpen] = useState(false)
  // The all-tabs list (shown only while tabs are hidden, see `overflow`).
  const [allOpen, setAllOpen] = useState(false)
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  // The Rename entry swaps the context menu for a one-line editor at the same place.
  const [renaming, setRenaming] = useState<{ tabId: string; x: number; y: number; value: string } | null>(null)
  // "Edit note…" swaps it for a one-line note editor the same way.
  const [noting, setNoting] = useState<{ tabId: string; x: number; y: number; value: string } | null>(null)
  // "Show beside ▸" swaps it for the list of the other tabs, each with Right and Below.
  const [beside, setBeside] = useState<{ tabId: string; x: number; y: number } | null>(null)
  // A group handle's menu (Rename, Equalize, Ungroup, Close all), and its Rename editor.
  const [groupMenu, setGroupMenu] = useState<{ groupId: string; x: number; y: number } | null>(null)
  const [groupRenaming, setGroupRenaming] = useState<{ groupId: string; x: number; y: number; value: string } | null>(null)

  // Any click elsewhere or Escape closes whichever menu is open.
  const anyOpen =
    createOpen || allOpen || menu !== null || renaming !== null || noting !== null || beside !== null || groupMenu !== null || groupRenaming !== null
  // A webview panel's native view would paint over the menu (shell-layers.ts).
  useShellLayer(anyOpen)
  useEffect(() => {
    if (!anyOpen) return
    const dismiss = (): void => {
      setCreateOpen(false)
      setAllOpen(false)
      setMenu(null)
      setRenaming(null)
      setNoting(null)
      setBeside(null)
      setGroupMenu(null)
      setGroupRenaming(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('click', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [anyOpen])

  const menuIndex = menu ? tabs.findIndex((t) => t.id === menu.tabId) : -1
  const menuTab = menuIndex >= 0 ? tabs[menuIndex] : undefined

  // The tab menu takes the keyboard when it opens (its first entry), so it works from Shift+F10 or
  // the context-menu key as well as from a right click; the editors take it with autoFocus. Once
  // the last of them goes, the pane gives the keyboard back to the terminal (onMenuClosed), else
  // it would be left on <body>, where typing reaches nothing.
  const ctxRef = useRef<HTMLDivElement>(null)
  const menuOpenId = menu?.tabId ?? (beside ? `beside:${beside.tabId}` : undefined) ?? (groupMenu ? `group:${groupMenu.groupId}` : undefined)
  useEffect(() => {
    if (menuOpenId === undefined) return
    ctxRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus()
  }, [menuOpenId])
  const tookFocus = menu !== null || renaming !== null || noting !== null || beside !== null || groupMenu !== null || groupRenaming !== null
  const hadFocus = useRef(false)
  const onMenuClosed = props.onMenuClosed
  useEffect(() => {
    if (hadFocus.current && !tookFocus) onMenuClosed()
    hadFocus.current = tookFocus
  }, [tookFocus, onMenuClosed])

  // Flagged Claude tabs that became waiting for input while another tab was shown pulse until the
  // person selects them (tab-flags.ts nextAttention). `seen` is each tab's status at the last pass.
  const seen = useRef(new Map<string, TabStatus>())
  const [attention, setAttention] = useState<ReadonlySet<string>>(() => new Set())
  const sessions = props.sessions
  useEffect(() => {
    const statusOf = (id: string): TabStatus | undefined => sessions.get(id)?.status
    const before = seen.current
    seen.current = statusesOf(tabs, statusOf)
    setAttention((a) => {
      const next = nextAttention(a, before, tabs, statusOf, activeId)
      return sameIds(a, next) ? a : next
    })
  }, [tabs, sessions, activeId])

  // Dragging. `press` is a primary-button press on a tab label that has not moved far enough to be
  // a drag yet (below DRAG_THRESHOLD it stays a click); `drag` is set once it has, and drives the
  // rendering (the tab follows the pointer, a marker shows where it would land).
  const listRef = useRef<HTMLDivElement>(null)
  // Tabs hidden past either edge of the strip: drives the edge fades and the all-tabs button.
  const [overflow, setOverflow] = useState<OverflowState>({ start: false, end: false })
  // The flag colour each edge hints at, when a flagged tab is hidden past it (hiddenFlags): a
  // flagged tab may scroll out of a crowded strip, but never without a mark saying it is there.
  const [flagHints, setFlagHints] = useState<{ start?: FlagColor; end?: FlagColor }>({})
  const measure = (): void => {
    const el = listRef.current
    if (!el) return
    const next = overflowState(el.scrollLeft, el.clientWidth, el.scrollWidth)
    setOverflow((o) => (o.start === next.start && o.end === next.end ? o : next))
    const b = el.getBoundingClientRect()
    const flagged = [...el.querySelectorAll<HTMLElement>('[data-tab-id][data-flag]')].map((t) => {
      const r = t.getBoundingClientRect()
      return { left: r.left, right: r.right, color: t.dataset.flag as FlagColor }
    })
    const hints = next.start || next.end ? hiddenFlags(b.left, b.right, flagged, FADE_PX) : {}
    setFlagHints((h) => (h.start === hints.start && h.end === hints.end ? h : hints))
  }
  // Re-measure on scroll (the listener below), when the strip is resized (a zone opens or closes,
  // the window changes) and when tabs come or go.
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // The wheel: a mouse wheel is vertical and the strip only scrolls sideways, so it would do
  // nothing there. Native and non-passive (React's onWheel is passive and cannot preventDefault).
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!wheelScrollsSideways(e.deltaX, e.deltaY, el.scrollWidth > el.clientWidth)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  // The active tab is brought into view whenever it changes or a tab is added (the new tab is
  // active; Ctrl+Tab and a click in the Sessions panel change it from outside the strip).
  useEffect(() => {
    const el = listRef.current
    if (!el || activeId === null) return
    const tabEl = [...el.querySelectorAll<HTMLElement>('[data-tab-id]')].find((t) => t.dataset.tabId === activeId)
    if (!tabEl) return
    // Offsets inside the scrolled content: both rects are in the viewport, scrollLeft links them.
    const l = tabEl.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    const left = l.left - b.left + el.scrollLeft
    el.scrollLeft = scrollToReveal(el.scrollLeft, el.clientWidth, left, left + l.width, 16)
    measure()
  }, [activeId, tabs.length])
  // A flag set or cleared changes the hints (and a flagged tab's minimum width, styles.css).
  const flagKey = tabs.map((t) => t.flag?.color ?? '').join(',')
  useEffect(() => {
    measure()
  }, [flagKey])
  const press = useRef<{ tabId: string; pointerId: number; startX: number; startY: number; groupId?: string } | null>(null)
  const [drag, setDrag] = useState<TabDrag | null>(null)
  const dragRef = useRef<TabDrag | null>(null)
  const setDragBoth = (d: TabDrag | null): void => {
    dragRef.current = d
    setDrag(d)
  }

  // The other tabs' ids and x centres, read from the DOM at each move: the strip scrolls
  // sideways, and a tab can be added or close (a plugin, a clean exit) while the pointer is down.
  const othersOf = (tabId: string, groupId?: string): { ids: string[]; centres: number[] } => {
    const ids: string[] = []
    const centres: number[] = []
    // A handle drag moves the whole block: none of its members is an "other" tab.
    const g = groupId !== undefined ? groups.find((x) => x.id === groupId) : undefined
    const skip = new Set(g ? leavesOf(g.root) : [tabId])
    for (const el of listRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? []) {
      const id = el.dataset.tabId
      if (id === undefined || skip.has(id)) continue
      const r = el.getBoundingClientRect()
      ids.push(id)
      centres.push(r.left + r.width / 2)
    }
    return { ids, centres }
  }

  // Escape while dragging puts the tab back; the menus' own Escape handler is not running then
  // (a drag starts only with no menu open, see onPointerDown).
  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        const d = dragRef.current
        if (d?.pane) onPaneDrag(d.tabId, null)
        press.current = null
        setDragBoth(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dragging, onPaneDrag])
  // Page frames ignore the pointer while a strip drag is up (it may end over one in pane mode).
  useEffect(() => (dragging ? acquireDrag() : undefined), [dragging])

  /** A press on a tab label, or on a group's handle (`groupId`: the block moves). */
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>, tabId: string, groupId?: string): void => {
    if (e.button !== 0 || anyOpen) return
    press.current = { tabId, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, ...(groupId ? { groupId } : {}) }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const p = press.current
    if (!p || p.pointerId !== e.pointerId) return
    const dx = e.clientX - p.startX
    let d = dragRef.current
    if (!d) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(e.clientY - p.startY) < DRAG_THRESHOLD) return
      const from = tabs.findIndex((t) => t.id === p.tabId)
      if (from < 0) return
      // Keep the pointer's events on this label even when it leaves the strip, so the release is
      // seen wherever it happens.
      e.currentTarget.setPointerCapture(e.pointerId)
      d = { tabId: p.tabId, pointerId: p.pointerId, from, startX: p.startX, dx, toIndex: from, ...(p.groupId ? { groupId: p.groupId } : {}) }
    }
    // Well below the strip a tab's drag turns into pane mode: the terminal area shows where it
    // would go (design §1). A group's handle only moves the block along the strip.
    const strip = listRef.current?.getBoundingClientRect()
    const paneable = isPaneKind(tabs.find((t) => t.id === d.tabId)?.kind)
    const pane = d.groupId === undefined && paneable && strip !== undefined && e.clientY > strip.bottom + PANE_MODE_PX
    if (pane) props.onPaneDrag(d.tabId, { x: e.clientX, y: e.clientY })
    else if (d.pane) props.onPaneDrag(d.tabId, null)
    const { centres } = othersOf(d.tabId, d.groupId)
    setDragBoth({ ...d, dx, toIndex: dropIndex(centres, e.clientX), pane })
  }

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>, drop: boolean): void => {
    if (press.current?.pointerId !== e.pointerId) return
    press.current = null
    const d = dragRef.current
    if (!d) return
    setDragBoth(null)
    if (d.pane) {
      if (drop) props.onPaneDrop(d.tabId)
      else props.onPaneDrag(d.tabId, null)
      return
    }
    if (!drop) return
    if (d.groupId !== undefined) {
      const g = groups.find((x) => x.id === d.groupId)
      const first = g ? tabs.findIndex((t) => leavesOf(g.root).includes(t.id)) : -1
      if (first >= 0 && d.toIndex !== first) props.onMoveGroup(d.groupId, d.toIndex)
      return
    }
    const g = groupOf(groups, d.tabId)
    if (g) {
      // D9: no reordering inside the segment; dropped outside it, the member leaves the group there.
      const seg = listRef.current?.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(g.id)}"]`)?.getBoundingClientRect()
      if (seg && leftSegment(seg, e.clientX)) props.onDetach(d.tabId, d.toIndex)
      return
    }
    if (d.toIndex !== d.from) props.onReorder(d.tabId, d.toIndex)
  }

  // From the props, not the DOM: the strip renders `tabs` in this order. None in pane mode, and
  // none for a member's drag inside its own segment (D9: no reordering there).
  const dragGroup = drag?.groupId !== undefined ? groups.find((g) => g.id === drag.groupId) : undefined
  const moving = new Set(dragGroup ? leavesOf(dragGroup.root) : drag ? [drag.tabId] : [])
  const marker =
    drag && !drag.pane && (dragGroup || !groupOf(groups, drag.tabId))
      ? dropMarker(tabs.filter((t) => !moving.has(t.id)).map((t) => t.id), drag.from, drag.toIndex)
      : null
  const statusOf = (id: string): TabStatus | undefined => props.sessions.get(id)?.status
  const labelOfId = (id: string): string => {
    const t = tabs.find((x) => x.id === id)
    const st = props.sessions.get(id)
    return t ? tabLabel(t, st?.title, st?.name) : 'tab'
  }
  const menuGroup = menuTab ? groupOf(groups, menuTab.id) : undefined
  const splitRight = menuTab ? props.splitBlocked(menuTab.id, 'right') : undefined
  const splitDown = menuTab ? props.splitBlocked(menuTab.id, 'down') : undefined
  const groupOfMenu = groupMenu ? groups.find((g) => g.id === groupMenu.groupId) : undefined
  // The tabs that may be panes (every tab kind: an overlay entry is never a tab): Show beside needs another one.
  const paneTabs = tabs.filter((t) => isPaneKind(t.kind)).length

  const renderTab = (tab: TabInfo): React.JSX.Element => {
    const status = props.sessions.get(tab.id)
    // In the DOM where it shows (not CSS `order`), so Tab moves through a tab's buttons in
    // the order the eye reads them.
    const close = (
      <button
        type="button"
        className="tab-close"
        aria-label={`Close ${tabLabel(tab, status?.title, status?.name)}`}
        onClick={() => props.onClose(tab.id)}
      >
        <CloseGlyph size={12} />
      </button>
    )
    const dragged = drag?.tabId === tab.id
    const markEdge = marker?.tabId === tab.id ? marker.edge : undefined
    // A command tab: what it runs, where, and which plugin opened it (tab-label.ts commandTooltip).
    const where = commandTooltip(tab) ?? (status?.title ? `${status.title}\n${tab.cwd}` : tab.cwd)
    const flag = tab.flag
    return (
    <div
      key={tab.id}
      data-tab-id={tab.id}
      data-drop={markEdge}
      // The stripe (styles.css .tab[data-flag]) and, while it waits for the person, its pulse.
      data-flag={flag?.color}
      data-attention={attention.has(tab.id) || undefined}
      className={`tab${tab.id === activeId ? ' active' : ''}${tab.exit ? ' exited' : ''}${dragged ? ' dragged' : ''}`}
      style={dragged ? { transform: `translateX(${drag.dx}px)` } : undefined}
    >
      {tabCloseSide === 'left' && close}
      <button
        type="button"
        role="tab"
        aria-selected={tab.id === activeId}
        className="tab-label"
        // The note is the tooltip's first line: the reminder is what the person flagged it for.
        title={flag?.note ? `${flag.note}\n${where}` : where}
        aria-description={
          [
            flag ? `flagged ${FLAG_COLOR_LABEL[flag.color].toLowerCase()}${flag.note ? `: ${flag.note}` : ''}` : undefined,
            ...pageTabMarks(tab)
          ]
            .filter((d) => d !== undefined)
            .join(', ') || undefined
        }
        onClick={() => props.onSelect(tab.id)}
        onPointerDown={(e) => onPointerDown(e, tab.id)}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
        onLostPointerCapture={(e) => endDrag(e, false)}
        onContextMenu={(e) => {
          e.preventDefault()
          setCreateOpen(false)
          setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
        }}
      >
        {/* The mark before the label says the tab's kind: a Claude tab's status dot (with a
            pulse while it works), a prompt for a shell, a window for a command entry. A
            Claude tab with no status yet shows nothing there, as before. */}
        {status && <StatusDot status={status.status} {...(status.tool ? { tool: status.tool } : {})} />}
        {tab.kind === 'shell' && <ShellGlyph size={14} className="tab-kind" />}
        {tab.kind === 'command' && <CommandGlyph size={14} className="tab-kind" />}
        {/* A page tab's icon is a NAME main checked (shared/page-tabs.ts), drawn as one of the
            shell's own glyphs, never anything the plugin sent. */}
        {tab.kind === 'page' && (tab.page?.icon === 'file' ? <FileGlyph size={14} className="tab-kind" /> : <PageGlyph size={14} className="tab-kind" />)}
        <span className="tab-text">
          {tabLabel(tab, status?.title, status?.name)}
          {tab.notStarted ? ' (not started)' : tab.exit ? ' (exited)' : ''}
        </span>
        {/* Core's marks (design-editor.md §1): unsaved text in some view, and opened while you
            were elsewhere. Neither is a flag, which is the person's alone. */}
        {tab.dirty && <span className="tab-dirty" aria-hidden="true" />}
        {tab.unseen && <span className="tab-unseen" aria-hidden="true" />}
      </button>
      {status && (
        <QueuedChip
          queue={status.queue}
          onCancel={(itemId) => props.onCancelQueued(tab.id, itemId)}
        />
      )}
      {tabCloseSide === 'right' && close}
    </div>
    )
  }

  return (
    <div className="tab-bar" data-close-side={tabCloseSide}>
      <div className="tab-strip">
      {flagHints.start && <span className="tab-flag-hint" data-side="start" data-flag={flagHints.start} aria-hidden="true" />}
      {flagHints.end && <span className="tab-flag-hint" data-side="end" data-flag={flagHints.end} aria-hidden="true" />}
      <div
        ref={listRef}
        role="tablist"
        className={`tab-list${drag ? ' dragging' : ''}`}
        data-fade-start={overflow.start || undefined}
        data-fade-end={overflow.end || undefined}
        onScroll={measure}
      >
        {stripRuns(tabs, groups).map((run) => {
          if (!run.group) return renderTab(run.tabs[0]!)
          const g = run.group
          const words = handleWords(g, props.zoom?.groupId === g.id ? props.zoom : undefined, statusOf, labelOfId)
          const shown = props.zoom?.groupId === g.id
          const movingThis = drag?.groupId === g.id
          return (
            <div
              key={`group:${g.id}:${run.tabs[0]!.id}`}
              className={`tab-group${shown ? ' shown' : ''}${movingThis ? ' dragged' : ''}`}
              role="group"
              aria-label={words.label}
              aria-description={words.asks}
              data-group-id={g.id}
              data-zoomed={words.zoomText !== undefined || undefined}
              style={movingThis ? { transform: `translateX(${drag.dx}px)` } : undefined}
            >
              <button
                type="button"
                className="tab-group-handle"
                data-group-handle={g.id}
                aria-label={words.label}
                aria-description={words.asks}
                aria-haspopup="menu"
                title={`${words.text}: click to show, drag to move, right-click for its menu`}
                onClick={() => props.onSelectGroup(g.id)}
                onPointerDown={(e) => onPointerDown(e, run.tabs[0]!.id, g.id)}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => endDrag(e, true)}
                onPointerCancel={(e) => endDrag(e, false)}
                onLostPointerCapture={(e) => endDrag(e, false)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setCreateOpen(false)
                  setMenu(null)
                  setGroupMenu({ groupId: g.id, x: e.clientX, y: e.clientY })
                }}
              >
                <SplitGlyph size={13} />
                {/* The name only as text, beside the members, never in place of a member's label or
                    dot: a group named "needs you" must not stand in for a real status. */}
                {g.name !== undefined && <span className="tab-group-name">{g.name}</span>}
                {words.zoomText !== undefined && <span className="tab-group-zoom">⤢ {words.zoomText}</span>}
              </button>
              {run.tabs.map(renderTab)}
            </div>
          )
        })}
      </div>
      </div>
      {(overflow.start || overflow.end || allOpen) && (
        <div className="tab-all">
          <button
            type="button"
            aria-label="All tabs"
            aria-haspopup="menu"
            aria-expanded={allOpen}
            // A flagged tab is hidden: the button carries its colour too (a dot), since the edge
            // hint alone is easy to miss next to the fade.
            data-flag={flagHints.start ?? flagHints.end}
            onClick={(e) => {
              e.stopPropagation()
              setMenu(null)
              setCreateOpen(false)
              setAllOpen(!allOpen)
            }}
          >
            <ChevronDownGlyph size={15} />
          </button>
          {allOpen && (
            <div
              className="menu"
              role="menu"
              aria-label="All tabs"
              // Arrow keys walk the entries (a menu's own convention); Escape is the window's.
              onKeyDown={(e) => walkMenu(e, false)}
            >
              {/* Flagged tabs first (tab-flags.ts allTabsOrder): what the person must not lose. */}
              {allTabsOrder(tabs).map((tab) => {
                const status = props.sessions.get(tab.id)
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="menuitem"
                    className={`menu-entry${tab.id === activeId ? ' active' : ''}`}
                    aria-current={tab.id === activeId ? 'true' : undefined}
                    ref={(el) => {
                      // Focus the current tab when the list opens, so Enter / arrows start there.
                      if (el && tab.id === activeId && document.activeElement === document.body) el.focus()
                    }}
                    onClick={() => props.onSelect(tab.id)}
                    data-flag={tab.flag?.color}
                    aria-description={tab.flag ? `flagged${tab.flag.note ? `: ${tab.flag.note}` : ''}` : undefined}
                  >
                    {status && <StatusDot status={status.status} {...(status.tool ? { tool: status.tool } : {})} />}
                    <span className="menu-label">{tabLabel(tab, status?.title, status?.name)}</span>
                    {tab.dirty && <span className="tab-dirty" aria-hidden="true" />}
                    {tab.unseen && <span className="tab-unseen" aria-hidden="true" />}
                    {tab.flag && (
                      <span className="menu-flag" aria-hidden="true">
                        {tab.flag.note && <span className="menu-flag-note">{tab.flag.note}</span>}
                        <FlagSwatch color={tab.flag.color} />
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
      <div className="tab-new">
        <button
          type="button"
          aria-label="New tab"
          aria-haspopup="menu"
          aria-expanded={createOpen}
          onClick={(e) => {
            // Stop the click reaching the window listener, which would close the menu again.
            e.stopPropagation()
            setMenu(null)
            if (!createOpen) props.onMenuOpen()
            setCreateOpen(!createOpen)
          }}
        >
          <PlusGlyph size={15} />
        </button>
        {createOpen && (
          <div className="menu" role="menu">
            <CoreEntry id="tab.newClaude" label="Claude" onClick={() => props.onCreate('claude')} />
            <CoreEntry id="tab.newShell" label="Shell" onClick={() => props.onCreate('shell')} />
            {COMMAND_GROUPS.map(({ level, name }) => {
              const items = props.commands?.[level] ?? []
              if (items.length === 0) return null
              return (
                <div key={level} role="group" aria-label={name} className="menu-group">
                  <div role="separator" className="menu-separator" />
                  {/* The group's name shown too; hidden from assistive tech, which already
                      gets it from aria-label (it would be read twice). */}
                  <div className="menu-caption" aria-hidden="true">
                    {name}
                  </div>
                  {items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      className="menu-entry"
                      data-level={level}
                      data-entry={item.id}
                      data-open={item.open}
                      onClick={() => props.onCreateCommand(level, item.id)}
                      aria-keyshortcuts={item.key ? ariaShortcut(item.key) : undefined}
                      aria-description={item.open === 'overlay' ? 'opens as an overlay' : undefined}
                    >
                      <OpenIcon open={item.open === 'overlay' ? 'overlay' : 'tab'} />
                      <span className="menu-label">{item.label}</span>
                      {/* Hidden from the accessible name (the label alone names the item);
                          aria-keyshortcuts carries the chord for assistive tech. */}
                      {item.key && <Keys chord={item.key} />}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {menu && menuTab && (
        <div
          ref={ctxRef}
          className="menu context-menu"
          role="menu"
          aria-label="Tab"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={(e) => walkMenu(e, true)}
        >
          <button
            type="button"
            role="menuitem"
            disabled={menuIndex === 0}
            onClick={() => props.onMove(menu.tabId, -1)}
          >
            Move left
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={menuIndex === tabs.length - 1}
            onClick={() => props.onMove(menu.tabId, 1)}
          >
            Move right
          </button>
          {tabs[menuIndex]?.kind === 'claude' && (
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                // Else the window's click listener closes the editor this opens.
                e.stopPropagation()
                const sid = menu.tabId
                const current = props.sessions.get(sid)
                setRenaming({ tabId: sid, x: menu.x, y: menu.y, value: current?.name ?? current?.title ?? '' })
                setMenu(null)
              }}
            >
              Rename
            </button>
          )}
          {/* The split view (design §1): a new pane beside this tab, this tab beside another, out of
              its group. A split too small to make is disabled with the reason (D5). Every tab kind has them. */}
          {isPaneKind(menuTab.kind) && (
            <>
              <div role="separator" className="menu-separator" />
              <button
                type="button"
                role="menuitem"
                disabled={splitRight !== undefined}
                title={splitRight}
                aria-description={splitRight}
                onClick={() => props.onSplit(menu.tabId, 'right')}
              >
                Split right
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={splitDown !== undefined}
                title={splitDown}
                aria-description={splitDown}
                onClick={() => props.onSplit(menu.tabId, 'down')}
              >
                Split down
              </button>
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                disabled={paneTabs < 2}
                onClick={(e) => {
                  // Else the window's click listener closes the list this opens.
                  e.stopPropagation()
                  setBeside({ tabId: menu.tabId, x: menu.x, y: menu.y })
                  setMenu(null)
                }}
              >
                Show beside ▸
              </button>
              {menuGroup && (
                <button type="button" role="menuitem" onClick={() => props.onMoveOut(menu.tabId)}>
                  Move out of group
                </button>
              )}
            </>
          )}
          <div role="separator" className="menu-separator" />
          {/* The person's flag (shared/tab-flag.ts), on any tab kind: a colour row, the note, clear. */}
          <div role="group" aria-label="Flag" className="menu-flag-row">
            <span className="menu-caption" aria-hidden="true">
              Flag
            </span>
            {FLAG_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="menuitemradio"
                aria-checked={menuTab.flag?.color === color}
                aria-label={`Flag ${FLAG_COLOR_LABEL[color]}`}
                title={FLAG_COLOR_LABEL[color]}
                className="flag-choice"
                data-flag={color}
                onClick={() => props.onFlag(menu.tabId, { color })}
              >
                <FlagSwatch color={color} />
              </button>
            ))}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              // Else the window's click listener closes the editor this opens.
              e.stopPropagation()
              setNoting({ tabId: menu.tabId, x: menu.x, y: menu.y, value: menuTab.flag?.note ?? '' })
              setMenu(null)
            }}
          >
            Edit note…
          </button>
          <button type="button" role="menuitem" disabled={!menuTab.flag} onClick={() => props.onFlag(menu.tabId, null)}>
            Clear flag
          </button>
          <div role="separator" className="menu-separator" />
          <button type="button" role="menuitem" onClick={() => props.onClose(menu.tabId)}>
            Close
          </button>
        </div>
      )}
      {beside && (
        <div
          ref={ctxRef}
          className="menu context-menu menu-beside"
          role="menu"
          aria-label={`Show ${labelOfId(beside.tabId)} beside`}
          style={{ left: beside.x, top: beside.y }}
          onKeyDown={(e) => walkMenu(e, true)}
        >
          <div className="menu-caption" aria-hidden="true">
            Show beside
          </div>
          {tabs
            .filter((t) => t.id !== beside.tabId && isPaneKind(t.kind))
            .map((t) => {
              const label = labelOfId(t.id)
              return (
                <div key={t.id} className="menu-beside-row">
                  <span className="menu-label" aria-hidden="true">
                    {label}
                  </span>
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={`Right of ${label}`}
                    title="Right"
                    onClick={() => props.onShowBeside(beside.tabId, t.id, 'right')}
                  >
                    →
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={`Below ${label}`}
                    title="Below"
                    onClick={() => props.onShowBeside(beside.tabId, t.id, 'down')}
                  >
                    ↓
                  </button>
                </div>
              )
            })}
        </div>
      )}
      {groupMenu && groupOfMenu && (
        <div
          ref={ctxRef}
          className="menu context-menu"
          role="menu"
          aria-label={`Split group ${groupTitle(groupOfMenu)}`}
          style={{ left: groupMenu.x, top: groupMenu.y }}
          onKeyDown={(e) => walkMenu(e, true)}
        >
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              // Else the window's click listener closes the editor this opens.
              e.stopPropagation()
              setGroupRenaming({ groupId: groupOfMenu.id, x: groupMenu.x, y: groupMenu.y, value: groupOfMenu.name ?? '' })
              setGroupMenu(null)
            }}
          >
            Rename
          </button>
          <button type="button" role="menuitem" onClick={() => props.onEqualizeGroup(groupOfMenu.id)}>
            Equalize
          </button>
          <button type="button" role="menuitem" onClick={() => props.onUngroup(groupOfMenu.id)}>
            Ungroup
          </button>
          <div role="separator" className="menu-separator" />
          <button type="button" role="menuitem" onClick={() => props.onCloseGroup(groupOfMenu.id)}>
            Close all
          </button>
        </div>
      )}
      {groupRenaming && (
        <form
          className="menu context-menu tab-rename"
          role="dialog"
          aria-label="Group name"
          style={{ left: groupRenaming.x, top: groupRenaming.y }}
          // The window's click listener would close the editor under the pointer.
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault()
            // Empty: no name (the handle shows the split mark alone). main checks the name.
            const name = groupRenaming.value.trim()
            props.onRenameGroup(groupRenaming.groupId, name === '' ? null : name)
            setGroupRenaming(null)
          }}
        >
          <input
            autoFocus
            aria-label="Group name"
            placeholder="Name (empty: none)"
            maxLength={60}
            value={groupRenaming.value}
            onChange={(e) => setGroupRenaming({ ...groupRenaming, value: e.target.value })}
          />
        </form>
      )}
      {noting && (
        <form
          className="menu context-menu tab-rename tab-flag-note"
          role="dialog"
          aria-label="Flag note"
          style={{ left: noting.x, top: noting.y }}
          // The window's click listener would close the editor under the pointer.
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault()
            const note = noting.value.trim()
            const flagged = tabs.find((t) => t.id === noting.tabId)?.flag !== undefined
            // An empty note on an unflagged tab sets nothing; otherwise main keeps the colour (or
            // takes the last-used one for an unflagged tab) and stores the note cleaned.
            if (note !== '' || flagged) props.onFlag(noting.tabId, { note: note === '' ? null : note })
            setNoting(null)
          }}
        >
          <input
            autoFocus
            aria-label="Note"
            placeholder="Note (empty: none)"
            maxLength={MAX_FLAG_NOTE_CHARS}
            value={noting.value}
            onChange={(e) => setNoting({ ...noting, value: e.target.value })}
          />
          <div className="menu-hint" aria-hidden="true">
            Enter saves · Esc cancels
          </div>
        </form>
      )}
      {renaming && (
        <form
          className="menu context-menu tab-rename"
          style={{ left: renaming.x, top: renaming.y }}
          // The window's click listener would close the editor under the pointer.
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault()
            // Empty goes back to Claude's own title.
            const name = renaming.value.trim()
            props.onRename(renaming.tabId, name === '' ? null : name)
            setRenaming(null)
          }}
        >
          <input
            autoFocus
            aria-label="Tab name"
            placeholder="Name (empty: Claude's title)"
            maxLength={60}
            value={renaming.value}
            onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
          />
        </form>
      )}
    </div>
  )
}
