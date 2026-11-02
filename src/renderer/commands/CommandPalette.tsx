import { useEffect, useMemo, useRef, useState } from 'react'
import type { CommandInfo } from '../../shared/ipc'
import { displayChord, fuzzyFilter } from './keybindings'

/**
 * Cmd+Shift+P. A text field that filters command titles by fuzzy match; Enter runs the highlighted
 * one, arrows move, Escape or a click outside closes. The palette closes before the command runs,
 * so a command that focuses something (a new tab's terminal) keeps the focus.
 */
export function CommandPalette(props: {
  commands: CommandInfo[]
  mac: boolean
  onRun: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const matches = useMemo(() => fuzzyFilter(props.commands, query), [props.commands, query])

  useEffect(() => input.current?.focus(), [])

  // Close once: Esc, a click outside and the blur that follows them can all land.
  const closed = useRef(false)
  const close = (): void => {
    if (closed.current) return
    closed.current = true
    props.onClose()
  }

  const run = (id: string | undefined): void => {
    if (id === undefined || closed.current) return
    close()
    props.onRun(id)
  }

  const current = Math.min(index, Math.max(0, matches.length - 1))

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => {
          e.stopPropagation()
          // Clicking a row must not blur the input: the blur below closes the palette before the
          // click lands. The input itself keeps its default (caret placement).
          if (e.target !== input.current) e.preventDefault()
        }}
      >
        <input
          ref={input}
          className="palette-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-label="Command"
          placeholder="Type a command"
          value={query}
          // Focus left the field (Tab, another window, devtools): nothing in the palette can be
          // typed into any more, so it must not stay open over the terminal.
          onBlur={close}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              close()
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(matches[current]?.id)
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex(Math.min(matches.length - 1, current + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex(Math.max(0, current - 1))
            }
          }}
        />
        <ul id="palette-list" role="listbox" className="palette-list">
          {matches.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === current}
              className={i === current ? 'selected' : ''}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(c.id)}
            >
              <span>{c.title}</span>
              {c.key && <kbd>{displayChord(c.key, props.mac)}</kbd>}
            </li>
          ))}
          {matches.length === 0 && <li className="palette-empty">No matching command</li>}
        </ul>
      </div>
    </div>
  )
}
