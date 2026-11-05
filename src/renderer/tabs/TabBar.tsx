import { useEffect, useRef, useState } from 'react'
import type { SessionDetail, TabCommandMenu, TabInfo } from '../../shared/ipc'
import type { TabCommandLevel } from '../../shared/types'
import { splitChord } from '../../shared/keys'
import { chordKeys, chordOf } from '../commands/keybindings'
import { usePrefs } from '../prefs/prefs-store'
import { QueuedChip } from '../status/QueuedChip'
import { StatusDot } from '../status/StatusDot'
import { useShellLayer } from '../zones/use-shell-layer'
import { CloseGlyph, CommandGlyph, PlusGlyph, ShellGlyph } from '../window-icons'
import { tabLabel } from './tab-label'
import { DRAG_THRESHOLD, dropIndex, dropMarker } from './tab-drag'

/** A tab being dragged along the strip: where it started, how far it moved, where it would land. */
interface TabDrag {
  tabId: string
  pointerId: number
  from: number
  startX: number
  dx: number
  toIndex: number
}

/** What the [+] menu lists after Claude and Shell: the user's entries, app-wide then project. */
const COMMAND_GROUPS: Array<{ level: TabCommandLevel; name: string }> = [
  { level: 'app', name: 'App commands' },
  { level: 'project', name: 'Project commands' }
]

const mac = (): boolean => navigator.platform.toLowerCase().includes('mac')

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
  /** A drag ended: put the tab at `toIndex` (its index after being taken out, as main's reorder). */
  onReorder: (tabId: string, toIndex: number) => void
  /** Status of the window's Claude tabs by tab id (shell tabs have none). */
  sessions: ReadonlyMap<string, SessionDetail>
  onCancelQueued: (tabId: string, itemId: string) => void
}): React.JSX.Element {
  const { tabs, activeId } = props
  // Settings › Appearance and keys › Tabs; pushed by main, so every window's strip follows a pick.
  const { tabCloseSide } = usePrefs()
  const [createOpen, setCreateOpen] = useState(false)
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  // The Rename entry swaps the context menu for a one-line editor at the same place.
  const [renaming, setRenaming] = useState<{ tabId: string; x: number; y: number; value: string } | null>(null)

  // Any click elsewhere or Escape closes whichever menu is open.
  const anyOpen = createOpen || menu !== null || renaming !== null
  // A webview panel's native view would paint over the menu (shell-layers.ts).
  useShellLayer(anyOpen)
  useEffect(() => {
    if (!anyOpen) return
    const dismiss = (): void => {
      setCreateOpen(false)
      setMenu(null)
      setRenaming(null)
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

  // Dragging. `press` is a primary-button press on a tab label that has not moved far enough to be
  // a drag yet (below DRAG_THRESHOLD it stays a click); `drag` is set once it has, and drives the
  // rendering (the tab follows the pointer, a marker shows where it would land).
  const listRef = useRef<HTMLDivElement>(null)
  const press = useRef<{ tabId: string; pointerId: number; startX: number } | null>(null)
  const [drag, setDrag] = useState<TabDrag | null>(null)
  const dragRef = useRef<TabDrag | null>(null)
  const setDragBoth = (d: TabDrag | null): void => {
    dragRef.current = d
    setDrag(d)
  }

  // The other tabs' ids and x centres, read from the DOM at each move: the strip scrolls
  // sideways, and a tab can be added or close (a plugin, a clean exit) while the pointer is down.
  const othersOf = (tabId: string): { ids: string[]; centres: number[] } => {
    const ids: string[] = []
    const centres: number[] = []
    for (const el of listRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? []) {
      const id = el.dataset.tabId
      if (id === undefined || id === tabId) continue
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
        press.current = null
        setDragBoth(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dragging])

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>, tabId: string): void => {
    if (e.button !== 0 || anyOpen) return
    press.current = { tabId, pointerId: e.pointerId, startX: e.clientX }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const p = press.current
    if (!p || p.pointerId !== e.pointerId) return
    const dx = e.clientX - p.startX
    let d = dragRef.current
    if (!d) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return
      const from = tabs.findIndex((t) => t.id === p.tabId)
      if (from < 0) return
      // Keep the pointer's events on this label even when it leaves the strip, so the release is
      // seen wherever it happens.
      e.currentTarget.setPointerCapture(e.pointerId)
      d = { tabId: p.tabId, pointerId: p.pointerId, from, startX: p.startX, dx, toIndex: from }
    }
    const { centres } = othersOf(d.tabId)
    setDragBoth({ ...d, dx, toIndex: dropIndex(centres, e.clientX) })
  }

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>, drop: boolean): void => {
    if (press.current?.pointerId !== e.pointerId) return
    press.current = null
    const d = dragRef.current
    if (!d) return
    setDragBoth(null)
    if (drop && d.toIndex !== d.from) props.onReorder(d.tabId, d.toIndex)
  }

  // From the props, not the DOM: the strip renders `tabs` in this order.
  const marker = drag
    ? dropMarker(tabs.filter((t) => t.id !== drag.tabId).map((t) => t.id), drag.from, drag.toIndex)
    : null

  return (
    <div className="tab-bar" data-close-side={tabCloseSide}>
      <div ref={listRef} role="tablist" className={`tab-list${drag ? ' dragging' : ''}`}>
        {tabs.map((tab) => {
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
          return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            data-drop={markEdge}
            className={`tab${tab.id === activeId ? ' active' : ''}${tab.exit ? ' exited' : ''}${dragged ? ' dragged' : ''}`}
            style={dragged ? { transform: `translateX(${drag.dx}px)` } : undefined}
          >
            {tabCloseSide === 'left' && close}
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === activeId}
              className="tab-label"
              title={
                tab.kind === 'command' && tab.command !== undefined
                  ? `${tab.command}\n${tab.cwd}`
                  : status?.title
                    ? `${status.title}\n${tab.cwd}`
                    : tab.cwd
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
              <span className="tab-text">
                {tabLabel(tab, status?.title, status?.name)}
                {tab.notStarted ? ' (not started)' : tab.exit ? ' (exited)' : ''}
              </span>
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
        })}
      </div>
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
      {menu && menuIndex >= 0 && (
        <div className="menu context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
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
          <button type="button" role="menuitem" onClick={() => props.onClose(menu.tabId)}>
            Close
          </button>
        </div>
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
