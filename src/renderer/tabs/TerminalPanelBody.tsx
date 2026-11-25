import { Fragment, useContext, useEffect, useRef, useState } from 'react'
import { chordKeys, chordOf } from '../commands/keybindings'
import { isHiddenPage } from '../shell-kind'
import { CloseGlyph, CommandGlyph, PlusGlyph, ShellGlyph } from '../window-icons'
import { useShellLayer } from '../zones/use-shell-layer'
import { keepSelectedInView } from './panel-strip-scroll'
import { panelTabParts } from './panel-tab-parts'
import { TerminalPanelContext, type TerminalPanelApi } from './terminal-panel-context'
import { TerminalView } from './TerminalView'

/** How far a press on a strip tab moves before it is a drag rather than a click. */
const DRAG_THRESHOLD = 5

/** What the [+] menu lists after Shell: the user's entries, app-wide then project (TabBar's groups). */
const COMMAND_GROUPS = [
  { level: 'app', name: 'App commands' },
  { level: 'project', name: 'Project commands' }
] as const

const mac = (): boolean => navigator.platform.toLowerCase().includes('mac')

/** A canonical chord as keycaps (TabBar's look), hidden from assistive tech. */
function ChordKeys(props: { chord: string }): React.JSX.Element {
  const isMac = mac()
  return (
    <span className="keys" aria-hidden="true">
      {chordKeys(props.chord, isMac).map((k, i) => (
        <span key={i} className="key-part">
          {i > 0 && !isMac && <span className="key-sep">+</span>}
          <kbd>{k}</kbd>
        </span>
      ))}
    </span>
  )
}

/** Arrow keys walk a menu's enabled entries, wrapping (TabBar's convention). */
function walkMenu(e: React.KeyboardEvent<HTMLElement>): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')]
  const at = items.indexOf(document.activeElement as HTMLElement)
  const go = (i: number): void => {
    e.preventDefault()
    items[(i + items.length) % items.length]?.focus()
  }
  if (e.key === 'ArrowDown') go(at + 1)
  else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1)
  else if (e.key === 'Home') go(0)
  else if (e.key === 'End') go(-1)
}

/** The strip's index (among the other tabs) the pointer at `x` would drop `tabId` at. */
function dropIndexAt(list: HTMLElement | null, tabId: string, x: number): number {
  const others = Array.from(list?.querySelectorAll<HTMLElement>('[data-panel-tab-id]') ?? []).filter((el) => el.dataset.panelTabId !== tabId)
  let index = 0
  for (const el of others) {
    const r = el.getBoundingClientRect()
    if (x > r.left + r.width / 2) index++
  }
  return index
}

/**
 * The Terminal panel's body (design-terminal-panel.md §1, §4): a strip of the panel's shell and command
 * tabs over the selected one's terminal. The terminals stay outside React (TabsPane's one
 * SessionRegistry): this attaches the selected tab's TerminalSession and detaches it when another is
 * selected or the body unmounts (the panel closed or hidden, its zone collapsed, the panel moved to
 * another zone); a detach never disposes a session, so a hidden panel's shells keep their scrollback
 * and keep acking output. Nothing here is drawn in server mode's hidden page (§4 "Server mode").
 */
export function TerminalPanelBody(): React.JSX.Element | null {
  const api = useContext(TerminalPanelContext)
  if (!api || isHiddenPage()) return null
  return <PanelBody api={api} />
}

function PanelBody({ api }: { api: TerminalPanelApi }): React.JSX.Element {
  const { tabs, activeId, sessions, canWrite } = api
  const shown = api.shown
  // On screen while mounted: TabsPane sends `tabs.panelSelected` only then, and the toggle reads it.
  useEffect(() => {
    shown(true)
    return () => shown(false)
  }, [shown])

  // The [+] menu, fixed at its button (the panel clips what overflows it): below, or above when the
  // panel sits low in the window (the bottom zone) and the room below is short.
  const [createAt, setCreateAt] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  const createOpen = createAt !== null
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const anyOpen = createOpen || menu !== null
  useShellLayer(anyOpen)
  useEffect(() => {
    if (!anyOpen) return
    const dismiss = (): void => {
      setCreateAt(null)
      setMenu(null)
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
  // The tab menu takes the keyboard at its first entry; once it goes, the keyboard is given back.
  const ctxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (menu) ctxRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus()
  }, [menu])
  const hadMenu = useRef(false)
  const menuClosed = api.menuClosed
  useEffect(() => {
    if (hadMenu.current && menu === null) menuClosed()
    hadMenu.current = menu !== null
  }, [menu, menuClosed])

  // A focus ask (the toggle, New Terminal, a pick in the strip, the person's own close, main's exit
  // focus): run once, after the selected tab's TerminalView attached (a child's effect runs first).
  // The ask is consumed by `take` (panel-focus.ts), so a remounted body has nothing to replay.
  const shellButton = useRef<HTMLButtonElement>(null)
  const { focusAsks, focusSeq } = api
  const tabIds = tabs.map((t) => t.id).join(' ')
  useEffect(() => {
    const target = focusAsks.take(activeId, tabIds === '' ? [] : tabIds.split(' '))
    if (target === undefined) return
    if ('shell' in target) shellButton.current?.focus()
    else sessions.get(target.tabId).focus()
  }, [focusAsks, focusSeq, activeId, tabIds, sessions])

  // Drag to reorder within the strip (pointer events, as TabBar: no native drag session).
  const listRef = useRef<HTMLDivElement>(null)
  // A narrow zone (a side zone) holds fewer tabs than there are: the strip scrolls past the names'
  // minimum width (QA Q1), so the selected tab is kept in view, on selection and on every change of the
  // strip's width (QR-N1: narrowing a side zone by its divider), and a plain wheel scrolls sideways.
  useEffect(() => {
    const list = listRef.current
    if (activeId === null || list === null) return
    return keepSelectedInView(list, activeId)
  }, [activeId])
  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    const list = e.currentTarget
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && list.scrollWidth > list.clientWidth) list.scrollLeft += e.deltaY
  }
  const press = useRef<{ tabId: string; x: number; pointerId: number } | null>(null)
  const [drag, setDrag] = useState<{ tabId: string; toIndex: number } | null>(null)
  const dragRef = useRef(drag)
  const setDragBoth = (next: { tabId: string; toIndex: number } | null): void => {
    dragRef.current = next
    setDrag(next)
  }
  const justDragged = useRef(false)
  const onPointerDown = (e: React.PointerEvent, tabId: string): void => {
    if (e.button !== 0 || !canWrite) return
    press.current = { tabId, x: e.clientX, pointerId: e.pointerId }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const p = press.current
    if (!p || p.pointerId !== e.pointerId) return
    if (!dragRef.current && Math.abs(e.clientX - p.x) < DRAG_THRESHOLD) return
    if (!dragRef.current) (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    setDragBoth({ tabId: p.tabId, toIndex: dropIndexAt(listRef.current, p.tabId, e.clientX) })
  }
  const endDrag = (e: React.PointerEvent): void => {
    const p = press.current
    press.current = null
    const d = dragRef.current
    setDragBoth(null)
    if (!p || !d || p.pointerId !== e.pointerId) return
    // The release's click is the drag's tail, not a pick.
    justDragged.current = true
    setTimeout(() => {
      justDragged.current = false
    }, 0)
    const from = tabs.findIndex((t) => t.id === d.tabId)
    if (from >= 0 && d.toIndex !== from) api.reorder(d.tabId, d.toIndex)
  }

  const active = tabs.find((t) => t.id === activeId)
  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) : undefined
  const menuIndex = menuTab ? tabs.indexOf(menuTab) : -1
  const newChord = chordOf('terminal.new')

  return (
    <div className="panel-body terminal-panel" data-terminal-panel="" data-testid="terminal-panel">
      <div className="terminal-panel-bar">
        <div
          ref={listRef}
          className="terminal-panel-tabs"
          role="tablist"
          aria-label="Terminal tabs"
          onWheel={onWheel}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {tabs.map((tab) => {
            const label = api.labelOf(tab)
            const parts = panelTabParts(tab, label)
            const selected = tab.id === activeId
            return (
              <div
                key={tab.id}
                className={`terminal-panel-tab${selected ? ' active' : ''}${tab.exit ? ' exited' : ''}${drag?.tabId === tab.id ? ' dragged' : ''}`}
                data-panel-tab-id={tab.id}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="terminal-panel-tab-label"
                  title={parts.title}
                  onPointerDown={(e) => onPointerDown(e, tab.id)}
                  onClick={() => {
                    if (!justDragged.current) api.select(tab.id)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    if (!canWrite) return
                    setCreateAt(null)
                    setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
                  }}
                  onKeyDown={(e) => {
                    // Shift+F10 / the context-menu key: the tab menu from the keyboard.
                    if (!canWrite || !(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return
                    e.preventDefault()
                    const r = e.currentTarget.getBoundingClientRect()
                    setMenu({ tabId: tab.id, x: r.left, y: r.bottom + 2 })
                  }}
                >
                  {/* The state is a shape on the icon (panel-tab-parts.ts), never visible text or a colour alone. */}
                  <span className="terminal-panel-tab-icon" data-state={parts.state ?? undefined}>
                    {parts.icon === 'command' ? <CommandGlyph size={12} className="tab-kind" /> : <ShellGlyph size={12} className="tab-kind" />}
                  </span>
                  <span className="terminal-panel-tab-name">{parts.name}</span>
                  {parts.stateText !== '' && <span className="visually-hidden">{parts.stateText}</span>}
                </button>
                {canWrite && (
                  <button type="button" className="terminal-panel-tab-close icon-button sm" aria-label={`Close ${label}`} onClick={() => api.close(tab.id)}>
                    <CloseGlyph size={12} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {canWrite && (
          <div className="terminal-panel-new">
            <button
              type="button"
              className="icon-button sm"
              aria-label="New terminal"
              aria-haspopup="menu"
              aria-expanded={createOpen}
              title="New terminal"
              onClick={(e) => {
                e.stopPropagation()
                setMenu(null)
                if (createOpen) {
                  setCreateAt(null)
                  return
                }
                api.loadCommands()
                const r = e.currentTarget.getBoundingClientRect()
                const left = Math.max(8, r.right - 200)
                setCreateAt(window.innerHeight - r.bottom < 260 ? { left, bottom: window.innerHeight - r.top + 4 } : { left, top: r.bottom + 4 })
              }}
            >
              <PlusGlyph size={14} />
            </button>
            {createAt && (
              <div className="menu context-menu terminal-panel-menu" role="menu" aria-label="New terminal" style={createAt} onKeyDown={walkMenu}>
                <button type="button" role="menuitem" className="menu-entry" onClick={() => api.createShell()}>
                  <span className="menu-label">Shell</span>
                  {newChord && <ChordKeys chord={newChord} />}
                </button>
                {COMMAND_GROUPS.map(({ level, name }) => {
                  const items = api.commands?.[level] ?? []
                  if (items.length === 0) return null
                  return (
                    <div key={level} role="group" aria-label={name} className="menu-group">
                      <div role="separator" className="menu-separator" />
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
                          aria-description={item.open === 'overlay' ? 'opens as an overlay' : undefined}
                          onClick={() => api.createCommand(level, item.id)}
                        >
                          <span className="menu-label">{item.label}</span>
                        </button>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="terminal-panel-body">
        {active ? (
          <TerminalView
            key={active.id}
            tab={active}
            shown
            // The keyboard comes by the panel's focus asks only (the toggle, a pick, a close), never by a prop.
            focused={false}
            sessions={sessions}
            onRestart={() => api.restart(active.id)}
            onClose={() => api.close(active.id)}
            canWrite={canWrite}
            uploads={false}
          />
        ) : (
          <div className="terminal-panel-empty" data-testid="terminal-panel-empty">
            <p>No terminals</p>
            {canWrite && (
              <button ref={shellButton} type="button" onClick={() => api.createShell()}>
                Shell
              </button>
            )}
          </div>
        )}
      </div>
      {menu && menuTab && (
        <div
          ref={ctxRef}
          className="menu context-menu"
          role="menu"
          aria-label="Terminal tab"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={walkMenu}
        >
          <button type="button" role="menuitem" disabled={menuIndex <= 0} onClick={() => api.move(menuTab.id, -1)}>
            Move left
          </button>
          <button type="button" role="menuitem" disabled={menuIndex === tabs.length - 1} onClick={() => api.move(menuTab.id, 1)}>
            Move right
          </button>
          <div role="separator" className="menu-separator" />
          {menuTab.exit && (
            <button type="button" role="menuitem" onClick={() => api.restart(menuTab.id)}>
              Restart
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => api.moveToMain(menuTab.id)}>
            Move to tab area
          </button>
          <Fragment>
            <div role="separator" className="menu-separator" />
            <button type="button" role="menuitem" onClick={() => api.close(menuTab.id)}>
              Close
            </button>
          </Fragment>
        </div>
      )}
    </div>
  )
}

