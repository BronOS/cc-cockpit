import { useEffect, useRef } from 'react'
import type { SessionDetail, TabInfo } from '../../shared/ipc'
import { StatusDot } from '../status/StatusDot'
import { CommandGlyph, ShellGlyph } from '../window-icons'
import { tabLabel } from './tab-label'

/**
 * The Ctrl+Tab overlay (tab-switcher.ts has the rules): the window's tabs, most recent first, with
 * the one a release would pick highlighted. The keys stay with the pane's window handler, which
 * swallows them while the switcher is open, so the focus never leaves the terminal and nothing
 * here takes it: a row is picked on mouse down with the default prevented (no focus move, no
 * text selection), and the backdrop cancels the same way.
 */
export function TabSwitcher(props: {
  tabs: readonly TabInfo[]
  index: number
  sessions: ReadonlyMap<string, SessionDetail>
  onPick: (tabId: string) => void
  onHover: (index: number) => void
  onCancel: () => void
}): React.JSX.Element {
  const listRef = useRef<HTMLUListElement>(null)
  // Where the pointer was first seen over the overlay. Chromium sends a mousemove when an element
  // appears under a still pointer, and taking that for the user reaching for a row would make the
  // switcher wait for a click after the release; a row is hovered only once the pointer moved.
  const firstAt = useRef<{ x: number; y: number } | null>(null)
  const moved = (e: React.MouseEvent): boolean => {
    const at = firstAt.current
    if (!at) {
      firstAt.current = { x: e.clientX, y: e.clientY }
      return false
    }
    return Math.abs(e.clientX - at.x) + Math.abs(e.clientY - at.y) > 4
  }
  // Keep the highlighted row in view when a long list scrolls.
  useEffect(() => {
    listRef.current?.children[props.index]?.scrollIntoView({ block: 'nearest' })
  }, [props.index])
  return (
    <div
      className="switcher-backdrop"
      onMouseMove={(e) => {
        if (e.target === e.currentTarget) moved(e)
      }}
      onMouseDown={(e) => {
        e.preventDefault()
        if (e.target === e.currentTarget) props.onCancel()
      }}
    >
      <div className="switcher" role="dialog" aria-label="Switch tab">
        <ul ref={listRef} role="listbox" aria-label="Open tabs" className="switcher-list">
          {props.tabs.map((tab, i) => {
            const status = props.sessions.get(tab.id)
            const folder = tab.cwd.split(/[\\/]/).filter(Boolean).pop() ?? tab.cwd
            const note = tab.notStarted ? 'not started' : tab.exit ? 'exited' : ''
            return (
              <li
                key={tab.id}
                role="option"
                aria-selected={i === props.index}
                data-tab-id={tab.id}
                className={i === props.index ? 'selected' : ''}
                onMouseMove={(e) => {
                  if (moved(e)) props.onHover(i)
                }}
                onMouseDown={(e) => {
                  e.preventDefault()
                  if (e.button === 0) props.onPick(tab.id)
                }}
              >
                <span className="switcher-mark">
                  {status && <StatusDot status={status.status} {...(status.tool ? { tool: status.tool } : {})} />}
                  {tab.kind === 'shell' && <ShellGlyph size={14} className="tab-kind" />}
                  {tab.kind === 'command' && <CommandGlyph size={14} className="tab-kind" />}
                </span>
                <span className="switcher-label">{tabLabel(tab, status?.title, status?.name)}</span>
                <span className="switcher-note">{note || folder}</span>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
