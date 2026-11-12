// The dropdown a browser draws for a streamed page's `<select>` (design-web-browser.md §4.4): the
// page does not paint its own popup, so main sends the options (`webviews.select`) and this listbox
// answers (`webviews.selectChoose`, through `onDone`). It has the keyboard while open: arrows,
// Home/End, PageUp/PageDown, type-ahead, Enter or Space to choose, Escape or Tab to close with no
// choice; a click on an enabled option chooses it, a press anywhere else or the focus leaving it
// closes it. Placement and key math are in webview-select.ts.

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { IpcEventMap } from '../../shared/ipc'
import { groupRuns, initialActive, moveActive, TYPE_AHEAD_MS, typeAhead, type MenuPlace } from './webview-select'

export type SelectPopup = IpcEventMap['webviews.select']

export function WebviewSelectMenu(props: {
  popup: SelectPopup
  place: MenuPlace
  /** The chosen option's index in the select (`WebviewSelectOption.index`), or null for none. */
  onDone: (index: number | null) => void
}): React.JSX.Element {
  const { popup, place, onDone } = props
  const { options } = popup
  const [active, setActive] = useState(() => initialActive(options, popup.selected))
  const list = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', at: 0 })
  // One answer per popup: a click's blur, Escape and the outside press must not answer twice.
  const done = useRef(false)
  const finish = (index: number | null): void => {
    if (done.current) return
    done.current = true
    onDone(index)
  }
  const domId = useId()
  const optionId = (i: number): string => `${domId}-o${i}`

  useLayoutEffect(() => {
    list.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' })
    // optionId is derived from domId, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  // A press anywhere outside closes it with no choice (and goes on to whatever it pressed: a press on
  // the page then reaches the page, as after a native popup).
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!list.current?.contains(e.target as Node)) finish(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
    // finish only reads refs and the stable onDone of this popup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const choose = (at: number): void => {
    const o = options[at]
    if (o && !o.disabled) finish(o.index)
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Everything stays here: the panel's own key handlers would send it to the page.
    e.stopPropagation()
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      finish(null)
      return
    }
    const now = e.timeStamp
    const searching = typed.current.text !== '' && now - typed.current.at < TYPE_AHEAD_MS
    if (e.key === 'Enter' || (e.key === ' ' && !searching)) {
      e.preventDefault()
      choose(active)
      return
    }
    const moved = moveActive(options, active, e.key)
    if (moved !== undefined) {
      e.preventDefault()
      typed.current = { text: '', at: 0 }
      setActive(moved)
      return
    }
    if ([...e.key].length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      const text = (searching ? typed.current.text : '') + e.key
      typed.current = { text, at: now }
      const found = typeAhead(options, active, text)
      if (found >= 0) setActive(found)
    }
  }

  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Choose an option"
      aria-activedescendant={active >= 0 ? optionId(active) : undefined}
      tabIndex={0}
      className="webview-select-menu"
      style={{ left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}
      onKeyDown={onKeyDown}
      onBlur={() => finish(null)}
      // The list keeps the focus while an option is pressed.
      onMouseDown={(e) => e.preventDefault()}
    >
      {options.length === 0 && (
        <div role="option" aria-disabled="true" aria-selected={false} className="webview-select-note">
          No options
        </div>
      )}
      {groupRuns(options).map((run) => {
        const rows = run.items.map((o, k) => {
          const at = run.from + k
          return (
            <div
              key={o.index}
              id={optionId(at)}
              role="option"
              aria-selected={o.index === popup.selected}
              aria-disabled={o.disabled || undefined}
              className={at === active ? 'webview-select-option active' : 'webview-select-option'}
              onMouseMove={() => {
                if (!o.disabled && at !== active) setActive(at)
              }}
              onClick={() => choose(at)}
            >
              {o.label === '' ? '\u00a0' : o.label}
            </div>
          )
        })
        return run.group === undefined ? (
          <Fragment key={`r${run.from}`}>{rows}</Fragment>
        ) : (
          <div key={`g${run.from}`} role="group" aria-label={run.group} className="webview-select-group">
            <div role="presentation" className="webview-select-heading">
              {run.group}
            </div>
            {rows}
          </div>
        )
      })}
    </div>
  )
}
