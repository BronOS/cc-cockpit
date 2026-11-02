// The terminal font family dropdown (Settings › Appearance and keys › Terminal): an editable
// combobox (WAI-ARIA APG "combobox with listbox popup, list autocomplete"). Closed, the field
// shows the font's name in its own face; a click, ↓ or typing opens the list and what is typed
// filters it. ↑/↓ move the highlight, Enter picks, Esc closes (and only closes: the Settings
// dialog's Esc handler skips a handled key), Tab leaves. The logic is in font-picker-model.ts.
//
// The list is portalled to the Settings dialog and placed with position: fixed: the settings card
// it sits in clips its overflow (rounded corners) and draws a hairline between its children, so a
// popup inside it would be cut off at the card's edge.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  fontLabel,
  fontList,
  moveActive,
  selectedOptionId,
  type FontOption,
  type InstalledFonts
} from './font-picker-model'
import { ChevronDownIcon } from './icons'
import { installedMonospaceFamilies } from './local-fonts'

/** Drawn in each option's own face: braces, an arrow and the look-alikes a code font must tell apart. */
const SAMPLE = '{} => 0O 1lI'

/** Tallest the list grows before it scrolls, and the least room below before it opens upwards. */
const MAX_LIST_HEIGHT = 340
const MIN_ROOM_BELOW = 220

interface Placement {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
}

function placementFor(anchor: HTMLElement): Placement {
  const r = anchor.getBoundingClientRect()
  const below = window.innerHeight - r.bottom - 8
  const above = r.top - 8
  // Wider than the field: a name and its sample side by side ("JetBrains Mono Nerd Font" in its
  // own, wide face would be cut off at the field's width).
  const width = Math.max(r.width, 380)
  // Kept inside the window on the right: the field sits at the card's right edge.
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
  if (below < MIN_ROOM_BELOW && above > below) {
    return { left, width, bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(MAX_LIST_HEIGHT, above) }
  }
  return { left, width, top: r.bottom + 4, maxHeight: Math.min(MAX_LIST_HEIGHT, below) }
}

export function TerminalFontPicker(props: {
  id: string
  /** The stored CSS font list. */
  value: string
  disabled: boolean
  /** A font was picked (its CSS font list), or Custom… (null). */
  onPick: (value: string | null) => void
}): React.JSX.Element {
  const { id, value, disabled, onPick } = props
  const listId = `${id}-list`
  const input = useRef<HTMLInputElement>(null)
  // Open: where the list is portalled (the Settings dialog) and placed. Both are read from the
  // field in the event that opens it, never during a render.
  const [popup, setPopup] = useState<{ host: Element; place: Placement } | null>(null)
  const open = popup !== null
  // What is typed while open; null until the user types (the field shows the font's name).
  const [query, setQuery] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [installed, setInstalled] = useState<InstalledFonts>({ state: 'idle' })

  const list = useMemo(() => fontList(installed, query ?? ''), [installed, query])
  const optionDomId = (optionId: string): string => `${id}-opt-${optionId}`
  // The highlight, or where it falls back when the list no longer has it (the installed list
  // arrived, a filter dropped it): the selected font with nothing typed, else the first match, so
  // Enter always has something to pick.
  const active = !open
    ? null
    : list.options.some((o) => o.id === highlight)
      ? highlight
      : query === null || query.trim() === ''
        ? selectedOptionId(value, list.options)
        : (list.options[0]?.id ?? null)

  const close = (): void => {
    setPopup(null)
    setQuery(null)
    setHighlight(null)
  }

  // Busy (a save in flight) disables the field; a list left open over it could still pick.
  // Adjusted during the render that brings `disabled` (React's pattern), not in an effect.
  if (disabled && open) close()

  /**
   * Open from a click or a key: both are the user activation queryLocalFonts needs, so the query
   * starts here, in the event, not in an effect after it. The list is kept for the page's life;
   * a failure is asked again on the next open (the API may have refused for want of activation).
   */
  const openList = (): void => {
    const field = input.current
    const host = field?.closest('[role="dialog"]')
    if (open || disabled || !field || !host) return
    setPopup({ host, place: placementFor(field) })
    setHighlight(selectedOptionId(value, list.options))
    if (installed.state === 'idle' || installed.state === 'unavailable') {
      setInstalled({ state: 'loading' })
      void installedMonospaceFamilies().then((families) =>
        setInstalled(families === null ? { state: 'unavailable' } : { state: 'ready', families })
      )
    }
  }

  const pick = (option: FontOption): void => {
    close()
    onPick(option.kind === 'custom' ? null : option.value)
  }

  // Follow the field while open: the settings page scrolls under it, and the window resizes.
  useEffect(() => {
    const field = input.current
    if (!open || !field) return
    const update = (): void => setPopup((p) => (p ? { ...p, place: placementFor(field) } : p))
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  // Keep the highlighted option in view as ↑/↓ walk a long installed list.
  useEffect(() => {
    if (active !== null) document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, id])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault()
        if (!open) {
          openList()
          return
        }
        setHighlight(moveActive(list.options, active, e.key === 'ArrowDown' ? 1 : -1))
        return
      }
      case 'Enter': {
        if (!open) return
        e.preventDefault()
        const option = list.options.find((o) => o.id === active)
        if (option) pick(option)
        return
      }
      case 'Escape': {
        // Closed, Esc is the Settings dialog's (close Settings), as in every other field.
        if (!open) return
        e.preventDefault()
        close()
        return
      }
      case 'Tab':
        if (open) close()
        return
    }
  }

  return (
    <span className="settings-select font-picker">
      <input
        ref={input}
        id={id}
        type="text"
        role="combobox"
        className="font-picker-field"
        aria-label="Terminal font family"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active !== null ? optionDomId(active) : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        // Closed: the font's name, drawn in the font (a custom list draws with all of its names,
        // as the terminal does). Open: the filter, empty at first with the name as its hint, so
        // what is typed after a click is not appended to the name.
        value={open ? (query ?? '') : fontLabel(value)}
        placeholder={open ? fontLabel(value) : undefined}
        style={query ? undefined : { fontFamily: value }}
        onMouseDown={() => {
          // mousedown, not click: the list opens as the button goes down, like a native select's.
          // A second press closes it, unless the user is typing a filter (placing the caret).
          if (!open) openList()
          else if (query === null) close()
        }}
        onChange={(e) => {
          openList()
          setQuery(e.target.value)
        }}
        onFocus={(e) => {
          // Tabbed to: the first key typed replaces the name (and opens the list filtered by it).
          e.currentTarget.select()
        }}
        onBlur={() => {
          // An option's mousedown keeps the focus here (preventDefault), so a blur is a click
          // elsewhere or Tab: the list goes, nothing is picked.
          close()
        }}
        onKeyDown={onKeyDown}
      />
      <ChevronDownIcon size={14} className="settings-select-chevron" />
      {popup &&
        createPortal(
          <div
            id={listId}
            role="listbox"
            aria-label="Terminal fonts"
            className="font-picker-list"
            style={{
              left: popup.place.left,
              width: popup.place.width,
              top: popup.place.top,
              bottom: popup.place.bottom,
              maxHeight: popup.place.maxHeight
            }}
            // The field keeps the focus (and the keyboard) while the list is clicked.
            onMouseDown={(e) => e.preventDefault()}
          >
            {list.sections.map((section) => {
              const headId = `${id}-head-${section.id}`
              const rows = section.entries.map((entry, i) =>
                entry.kind === 'note' ? (
                  <div key={`note-${i}`} role="option" aria-disabled="true" aria-selected={false} className="font-picker-note">
                    {entry.text}
                  </div>
                ) : (
                  <div
                    key={entry.option.id}
                    id={optionDomId(entry.option.id)}
                    role="option"
                    aria-selected={entry.option.kind === 'custom' ? false : entry.option.value === value}
                    className={entry.option.id === active ? 'font-picker-option active' : 'font-picker-option'}
                    onMouseMove={() => {
                      if (active !== entry.option.id) setHighlight(entry.option.id)
                    }}
                    onClick={() => pick(entry.option)}
                  >
                    {entry.option.kind === 'custom' ? (
                      <span className="font-picker-name">{entry.option.label}</span>
                    ) : (
                      <>
                        <span className="font-picker-name" style={{ fontFamily: entry.option.value }}>
                          {entry.option.label}
                        </span>
                        <span className="font-picker-sample" style={{ fontFamily: entry.option.value }} aria-hidden="true">
                          {SAMPLE}
                        </span>
                      </>
                    )}
                  </div>
                )
              )
              return section.title === null ? (
                <div key={section.id} role="group" aria-label="Other" className="font-picker-group">
                  {rows}
                </div>
              ) : (
                <div key={section.id} role="group" aria-labelledby={headId} className="font-picker-group">
                  <div id={headId} role="presentation" className="font-picker-heading">
                    {section.title}
                  </div>
                  {rows}
                </div>
              )
            })}
          </div>,
          popup.host
        )}
    </span>
  )
}
