import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SessionDetail, TabInfo } from '../../shared/ipc'
import { rectsOf, type PaneEdge, type PaneRect, type PaneSplit } from '../../shared/tab-groups'
import type { PaneView } from '../state/groups-state'
import { StatusDot } from '../status/StatusDot'
import { statusText } from '../status/strip-order'
import { Splitter } from '../zones/Splitter'
import { CommandGlyph, ShellGlyph } from '../window-icons'
import {
  dragMinShare,
  edgePreview,
  edgeWords,
  evenSizes,
  moveDivider,
  PANE_CHROME,
  sizesOf,
  toPx,
  withSizes,
  type Size
} from './pane-layout'
import { PageTabArea, pageFrames, usePageUnavailable } from './PageTabArea'
import { pageTabMarks, tabLabel } from './tab-label'
import type { SessionRegistry } from './terminal-session'
import { TerminalView } from './TerminalView'

/** How long a pane waits for its tab before it stops drawing as "Starting…" (design.md §1). */
const STARTING_MS = 2000

/** The pane mode preview of a strip drag: where the dragged tab would go. */
export interface PaneDrop {
  /** The anchor pane's tab. */
  at: string
  edge: PaneEdge
  /** The anchor's label, for "Right of npm dev". */
  label: string
}

/**
 * A divider being dragged (`live`: drawn scaled, nothing sent) or released and sent to main, drawn
 * at those sizes until main's snapshot comes back (else it would jump back for a round trip).
 */
interface DividerDrag {
  groupId: string
  splitId: string
  /** The split's sizes when the drag began; each move is applied to these, not to the last move. */
  base: number[]
  sizes: number[]
  live: boolean
  /** Each visible pane's body in pixels when the drag began: drawn at that size, scaled, while live. */
  startPx: Record<string, Size>
}

/** Terminal statuses the person must not miss in a pane they cannot see the strip dot of (role 6). */
const ASKS = new Set(['waiting', 'needs-permission'])

/** Percent CSS box of a fractional rect. */
const box = (r: PaneRect): React.CSSProperties => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.w * 100}%`,
  height: `${r.h * 100}%`
})

/**
 * The terminal area with split panes (design.md §1; decisions D2, D3, D5, D8).
 *
 * Every tab's TerminalView stays in ONE flat list keyed by tab id, in the same wrapper whatever its
 * group: a pane is positioned by `rectsOf` (absolute, in percent), never nested in a component per
 * split. Nesting would reparent the terminal when a group changes shape, and React remounts a
 * reparented component, which throws away its xterm, its scrollback and the session's state.
 *
 * A divider drag draws the panes scaled (each body kept at its pixel size from the drag's start
 * and CSS-scaled into the new box), so no terminal refits and no pty gets a resize until the
 * release, which sends one `groups.resize`: a live drag would be a SIGWINCH storm into Claude.
 */
export function SplitArea(props: {
  tabs: readonly TabInfo[]
  activeId: string | null
  view: PaneView
  keysOff: boolean
  sessions: SessionRegistry
  details: ReadonlyMap<string, SessionDetail>
  /** One terminal cell (measured when a terminal has one), for the D5 limits of a divider drag. */
  cell: () => Size
  onArea: (size: Size) => void
  /** A press in a pane (any button): the person picks it. */
  onPanePress: (tabId: string) => void
  /** Sends `groups.resize`; resolves whether main took it. */
  onResize: (groupId: string, splitId: string, sizes: number[]) => Promise<boolean>
  onRestart: (tabId: string) => void
  onClose: (tabId: string) => void
  drop: PaneDrop | null
  /** The pane's first `tabs.list` answered (PageTabArea's `sync`). */
  listed: boolean
  /** The zones are inert (a dialog, the settings screen, an overlay): so is the page tab layer. */
  inert: boolean
}): React.JSX.Element {
  const { tabs, activeId, view, keysOff, sessions, details } = props
  const areaRef = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState<Size>({ width: 0, height: 0 })
  const onArea = props.onArea
  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const next = { width: el.clientWidth, height: el.clientHeight }
      setArea((a) => (a.width === next.width && a.height === next.height ? a : next))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => onArea(area), [area, onArea])

  const [drag, setDrag] = useState<DividerDrag | null>(null)
  const dragRef = useRef<DividerDrag | null>(null)
  const setDragBoth = (d: DividerDrag | null): void => {
    dragRef.current = d
    setDrag(d)
  }
  // main's snapshot came (a new group object) or the group went: a released drag has done its job.
  const group = view.group
  useEffect(() => {
    if (dragRef.current && !dragRef.current.live) setDragBoth(null)
  }, [group])

  const tiled = group !== undefined && view.zoomTab === undefined
  const root: PaneSplit | undefined =
    group && drag && drag.groupId === group.id ? withSizes(group.root, drag.splitId, drag.sizes) : group?.root
  const layout = useMemo(() => (tiled && root ? rectsOf(root) : undefined), [tiled, root])
  const rectOf = (tabId: string): PaneRect => layout?.panes.find((p) => p.tab === tabId) ?? { x: 0, y: 0, w: 1, h: 1 }
  const many = view.visible.length > 1
  const unavailable = usePageUnavailable()

  // D3: the keys went off (this view's focused pane was taken away from elsewhere). The terminal
  // that had them may still hold the DOM focus (a pane moved out stays mounted, hidden): drop it,
  // so nothing typed now reaches any terminal until the person clicks a pane or uses a chord.
  // A page pane's frame is not in the area (it lives in the layer on <body>): it is blurred too.
  useEffect(() => {
    if (!keysOff) return
    const el = document.activeElement
    if (el instanceof HTMLElement && areaRef.current?.contains(el)) el.blur()
    pageFrames().blurKeyboard()
  }, [keysOff])

  const bodyPx = (r: PaneRect): Size => {
    const px = toPx(r, area)
    return { width: px.w, height: Math.max(0, px.h - (many ? PANE_CHROME.header : 0)) }
  }

  const startDrag = (splitId: string): DividerDrag | undefined => {
    if (!group || !layout) return undefined
    const base = sizesOf(group.root, splitId)
    if (!base) return undefined
    const startPx: Record<string, Size> = {}
    for (const p of layout.panes) startPx[p.tab] = bodyPx(p)
    return { groupId: group.id, splitId, base, sizes: base, live: true, startPx }
  }
  const commit = (): void => {
    const d = dragRef.current
    if (!d || !d.live) return
    const changed = d.sizes.some((s, i) => Math.abs(s - (d.base[i] ?? s)) > 1e-6)
    if (!changed) {
      setDragBoth(null)
      return
    }
    const sent: DividerDrag = { ...d, live: false }
    setDragBoth(sent)
    props.onResize(d.groupId, d.splitId, d.sizes).then(
      (ok) => {
        if (!ok && dragRef.current === sent) setDragBoth(null)
      },
      () => {
        if (dragRef.current === sent) setDragBoth(null)
      }
    )
  }

  const held = new Set(tabs.map((t) => t.id))
  const waiting = view.visible.filter((id) => !held.has(id))
  const waitingKey = waiting.join(' ')
  // A pane drawn as "Starting…" whose tab never arrives (a missed tabs.added, a tab that died before
  // it was announced) is dropped from drawing after about 2 s; the next snapshot fixes the group.
  const [gaveUp, setGaveUp] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (waitingKey === '') return
    const ids = waitingKey.split(' ')
    const timer = setTimeout(() => setGaveUp((prev) => new Set([...prev, ...ids])), STARTING_MS)
    return () => clearTimeout(timer)
  }, [waitingKey])
  const starting = waiting.filter((id) => !gaveUp.has(id))
  // The anchor's box as drawn: its pane in the layout, or the whole area (a plain tab, a zoom).
  const dropRect = props.drop ? edgePreview(tiled ? rectOf(props.drop.at) : { x: 0, y: 0, w: 1, h: 1 }, props.drop.edge) : undefined

  return (
    <div
      className={`terminals${many ? ' split' : ''}`}
      ref={areaRef}
      data-split-area=""
      data-split={many || undefined}
      // D19: whether the shown group is zoomed here, by the person (⌘⇧Enter) or by D5's narrow view.
      data-zoom={view.zoomTab === undefined ? undefined : view.auto ? 'auto' : 'manual'}
    >
      {tabs.length === 0 && <p className="tabs-empty">No tabs yet. Use + to start Claude or a shell.</p>}
      {tabs.map((tab) => {
        const shown = view.visible.includes(tab.id)
        const r = shown && tiled ? rectOf(tab.id) : { x: 0, y: 0, w: 1, h: 1 }
        const focused = tab.id === activeId && !keysOff
        const detail = details.get(tab.id)
        const label = tabLabel(tab, detail?.title, detail?.name)
        const asking = detail && ASKS.has(detail.status) ? statusText(detail.status, detail.tool) : undefined
        // While live, the body keeps its size from the drag's start and is scaled into the new box.
        const start = drag?.live && tab.kind !== 'page' ? drag.startPx[tab.id] : undefined
        let bodyStyle: React.CSSProperties | undefined
        if (start && start.width > 0 && start.height > 0) {
          const now = bodyPx(r)
          bodyStyle = {
            flex: 'none',
            width: start.width,
            height: start.height,
            transform: `scale(${now.width / start.width}, ${now.height / start.height})`,
            transformOrigin: '0 0'
          }
        }
        return (
          <section
            key={tab.id}
            className="pane"
            data-pane={tab.id}
            // The focused pane (this view's keys) while more than one pane shows; the tests' hook too.
            data-focused-pane={many && focused ? tab.id : undefined}
            hidden={!shown}
            role="region"
            aria-label={`${label}${asking ? `, ${asking}` : ''}`}
            style={box(r)}
            // Capture: xterm takes the press on its own elements first. Any button: a right click
            // into a pane is a pick too. The take itself is the session's (its own pointerdown).
            // A frame holding the keyboard gives it to the pressed terminal at once (the parent may
            // focus while a child frame has the keyboard; design-split-pages.md §4).
            onPointerDownCapture={() => {
              props.onPanePress(tab.id)
              if (tab.kind !== 'page' && pageFrames().keyboardTab() !== null) sessions.get(tab.id).focus()
            }}
          >
            {many && <PaneHeader tab={tab} label={label} detail={detail} asking={asking} focused={focused} />}
            {tab.kind === 'page' ? (
              // A page pane's body is empty: its frame lies over it, in PageTabArea's layer
              // (design-split-pages.md §2), and moves live with a divider (no CSS scaling: a scaled
              // frame blurs its text and misplaces clicks; a page has no pty to spare a resize).
              // A press reaches this body on the inset band around the frame, or through a frame
              // blurred for want of evidence (which lets the pointer through until it moves,
              // frame-focus.ts): the pane press above picks the pane and its
              // frame takes the keyboard, which the press's default (focus to nothing, as for any
              // press on an unfocusable element) would take away again.
              <div className="pane-body pane-page-body" onMouseDown={(e) => e.preventDefault()}>
                {unavailable.has(tab.id) && <p className="pane-page-unavailable">This page is not available: its plugin is off or did not load.</p>}
              </div>
            ) : (
              <div className="pane-body" style={bodyStyle}>
                <TerminalView
                  tab={tab}
                  shown={shown}
                  focused={focused}
                  sessions={sessions}
                  onRestart={() => props.onRestart(tab.id)}
                  onClose={() => props.onClose(tab.id)}
                />
              </div>
            )}
          </section>
        )
      })}
      {/* A pane main named that this page does not hold yet (its create reply or `tabs.added` is
          on the way): drawn as starting rather than dropped, so the group keeps its shape. */}
      {starting.map((id) => (
        <section key={`starting:${id}`} className="pane pane-starting" role="region" aria-label="Starting tab" style={box(tiled ? rectOf(id) : { x: 0, y: 0, w: 1, h: 1 })}>
          <p className="pane-starting-text">Starting…</p>
        </section>
      ))}
      {tiled &&
        group &&
        layout?.dividers.map((d) => {
          const splitPx = d.dir === 'row' ? d.area.w * area.width : d.area.h * area.height
          const sizes = (drag && drag.splitId === d.splitId ? drag.sizes : sizesOf(group.root, d.splitId)) ?? []
          const style: React.CSSProperties =
            d.dir === 'row'
              ? { left: `${d.x * 100}%`, top: `${d.y * 100}%`, height: `${d.length * 100}%` }
              : { left: `${d.x * 100}%`, top: `${d.y * 100}%`, width: `${d.length * 100}%` }
          return (
            <div
              key={`${d.splitId}:${d.index}`}
              className={`pane-divider pane-divider-${d.dir}`}
              style={style}
              // Double-click equalizes this split (D16: one resize per split).
              onDoubleClick={() => {
                const n = sizes.length
                if (n > 1) void props.onResize(group.id, d.splitId, evenSizes(n))
              }}
            >
              <Splitter
                axis={d.dir === 'row' ? 'x' : 'y'}
                value={(sizes[d.index] ?? 0) * splitPx}
                label="Resize panes"
                hook={`${d.splitId}:${d.index}`}
                onResize={(px) => {
                  if (!(splitPx > 0)) return
                  const cur = dragRef.current?.splitId === d.splitId && dragRef.current.live ? dragRef.current : startDrag(d.splitId)
                  if (!cur) return
                  const min = dragMinShare(splitPx, d.dir, props.cell())
                  const next = moveDivider(cur.base, d.index, px / splitPx - (cur.base[d.index] ?? 0), min)
                  setDragBoth({ ...cur, sizes: next })
                }}
                onCommit={commit}
              />
            </div>
          )
        })}
      {/* Page tabs' frames live in a layer outside the React root, laid over this placeholder while
          any page pane shows here; each frame placed at its pane's body box (frameBoxes). */}
      <PageTabArea
        tabs={tabs}
        listed={props.listed}
        activeId={activeId}
        keysOff={keysOff}
        inert={props.inert}
        visible={view.visible}
        zoomed={view.zoomTab !== undefined}
        root={root}
        many={many}
      />
      {props.drop && dropRect && (
        <div className="pane-drop-preview" style={box(dropRect)} aria-hidden="true">
          <span className="pane-drop-label">
            {edgeWords(props.drop.edge)} {props.drop.label}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * The thin pane header (D8): label, status dot, and "Opened by <plugin>" for a tab a plugin opened,
 * so a look-alike pane cannot pass for another. A waiting or needs-permission state is spelled out
 * in text, never only the dot's colour.
 */
function PaneHeader(props: {
  tab: TabInfo
  label: string
  detail: SessionDetail | undefined
  asking: string | undefined
  focused: boolean
}): React.JSX.Element {
  const { tab, detail } = props
  // A page tab's plugin is named from TabInfo.page: a page can draw anything, a look-alike Claude
  // terminal included, and this header (with the plugin's name) is the one line it cannot draw.
  const by = tab.openedBy !== undefined ? (tab.openedByName ?? tab.openedBy) : tab.kind === 'page' ? tab.page?.plugin : undefined
  const marks = pageTabMarks(tab)
  return (
    <div className="pane-header" data-pane-header="" data-focused={props.focused || undefined}>
      {detail && <StatusDot status={detail.status} {...(detail.tool ? { tool: detail.tool } : {})} />}
      {tab.kind === 'shell' && <ShellGlyph size={12} className="tab-kind" />}
      {tab.kind === 'command' && <CommandGlyph size={12} className="tab-kind" />}
      <span className="pane-header-label">
        {props.label}
        {tab.notStarted ? ' (not started)' : tab.exit ? ' (exited)' : ''}
      </span>
      {marks.length > 0 && <span className="pane-header-marks">{marks.join(', ')}</span>}
      {props.asking && <span className="pane-header-ask">{props.asking}</span>}
      {by !== undefined && <span className="pane-header-by">Opened by {by}</span>}
    </div>
  )
}

/** The visible pane under a viewport point, and its box (pane mode of a strip drag); none outside the area. */
export function paneAtPoint(area: HTMLElement | null, x: number, y: number): { tabId: string; rect: PaneRect } | undefined {
  if (!area) return undefined
  for (const el of area.querySelectorAll<HTMLElement>('[data-pane]')) {
    if (el.hidden) continue
    const b = el.getBoundingClientRect()
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
      const tabId = el.dataset.pane
      if (tabId !== undefined) return { tabId, rect: { x: b.left, y: b.top, w: b.width, h: b.height } }
    }
  }
  return undefined
}
