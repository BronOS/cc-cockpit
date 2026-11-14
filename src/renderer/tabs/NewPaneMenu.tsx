import { useEffect, useRef } from 'react'
import type { TabCommandMenu } from '../../shared/ipc'
import type { TabCommandLevel } from '../../shared/types'
import { CommandGlyph, ShellGlyph } from '../window-icons'

/** Split right / down waiting for the person's pick (D13): the anchor pane, the side, where the menu sits. */
export interface SplitMenu {
  anchor: string
  edge: 'right' | 'down'
  x: number
  y: number
}

/** What a new pane runs: the [+] menu's choices that open a tab (overlay entries are not panes). */
export type NewPaneChoice = { kind: 'claude' } | { kind: 'shell' } | { kind: 'command'; level: TabCommandLevel; entryId: string }

/** A choice as the key remembered for "the last used for a split in this project" (D13). */
export function choiceKey(c: NewPaneChoice): string {
  return c.kind === 'command' ? `cmd:${c.level}:${c.entryId}` : c.kind
}

const storageKey = (projectId: string | undefined): string => `cc-cockpit.splitLast.${projectId ?? ''}`

/**
 * The entry a split's menu starts on: the last one used for a split in this project, else Shell
 * (D13). Per view (browser storage): a convenience, never shared state; storage may be unavailable.
 */
export function lastSplitChoice(projectId: string | undefined): string {
  try {
    return localStorage.getItem(storageKey(projectId)) ?? 'shell'
  } catch {
    return 'shell'
  }
}

export function rememberSplitChoice(projectId: string | undefined, c: NewPaneChoice): void {
  try {
    localStorage.setItem(storageKey(projectId), choiceKey(c))
  } catch {
    // Not kept: the next split starts on Shell.
  }
}

/**
 * The New tab menu at a new pane's place (split right / down): Claude, Shell and the user's tab
 * commands that open a tab, the last one used for a split focused. Arrow keys walk it, Enter picks,
 * Escape or a click outside cancels (nothing is made).
 */
export function NewPaneMenu(props: {
  menu: SplitMenu
  commands: TabCommandMenu | null
  initial: string
  onPick: (choice: NewPaneChoice) => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const { onClose } = props
  const commands = [...(props.commands?.app ?? []).map((c) => ({ ...c, level: 'app' as const })), ...(props.commands?.project ?? []).map((c) => ({ ...c, level: 'project' as const }))].filter(
    (c) => c.open !== 'overlay'
  )
  const initial = props.initial
  const loaded = props.commands !== null
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const wanted = el.querySelector<HTMLElement>(`[data-choice="${CSS.escape(initial)}"]`) ?? el.querySelector<HTMLElement>('[data-choice="shell"]')
    wanted?.focus()
    // The entries arrive with the command list: refocus once it is in, the last choice may be one.
  }, [initial, loaded])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [onClose])
  const walk = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
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
  return (
    <div
      ref={ref}
      className="menu context-menu new-pane-menu"
      role="menu"
      aria-label={props.menu.edge === 'right' ? 'New pane on the right' : 'New pane below'}
      style={{ left: props.menu.x, top: props.menu.y }}
      onKeyDown={walk}
    >
      <div className="menu-caption">{props.menu.edge === 'right' ? 'New pane on the right' : 'New pane below'}</div>
      <button type="button" role="menuitem" className="menu-entry" data-choice="claude" onClick={() => props.onPick({ kind: 'claude' })}>
        <span className="menu-label">Claude</span>
      </button>
      <button type="button" role="menuitem" className="menu-entry" data-choice="shell" onClick={() => props.onPick({ kind: 'shell' })}>
        <ShellGlyph size={14} className="tab-kind" />
        <span className="menu-label">Shell</span>
      </button>
      {commands.map((c) => (
        <button
          key={`${c.level}:${c.id}`}
          type="button"
          role="menuitem"
          className="menu-entry"
          data-choice={`cmd:${c.level}:${c.id}`}
          onClick={() => props.onPick({ kind: 'command', level: c.level, entryId: c.id })}
        >
          <CommandGlyph size={14} className="tab-kind" />
          <span className="menu-label">{c.label}</span>
        </button>
      ))}
    </div>
  )
}
