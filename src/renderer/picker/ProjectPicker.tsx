import { useEffect, useMemo, useRef, useState } from 'react'
import type { PickerInfo, ProjectSummary } from '../../shared/ipc'
import { displayChord } from '../commands/keybindings'
import { splitChord } from '../../shared/keys'
import { ipcErrorMessage } from '../ipc-error'
import { ProjectDot } from '../status/ProjectDot'
import { AppIcon, FolderGlyph, SearchGlyph } from './icons'
import { filterProjects, firstOpenable, moveHighlight, tildePath } from './picker-model'

const mac = (): boolean => navigator.platform.toLowerCase().includes('mac')

/**
 * Shown when no project window is open, and on request from an open one (the top strip's "+",
 * File › Open Project): recent projects plus "Open Folder…". Opening or focusing a project closes
 * this window (main does that). Asked for again while it is open, main only focuses it, so the
 * recent list is read again whenever the window gains the focus: projects opened since it was
 * first drawn move to the top.
 *
 * Keyboard: the filter field has the focus; ↑/↓ move the highlighted row (missing folders are
 * skipped, Enter could not open them), Enter opens it, Esc clears the filter. The Open Folder
 * chord is NOT handled here: the application menu's accelerator owns it while the picker is
 * focused (menu.ts resolves the '' key table for it), and a handler here would open two dialogs.
 */
export function ProjectPicker({ info }: { info: PickerInfo }): React.JSX.Element {
  const [recent, setRecent] = useState<ProjectSummary[] | null>(null)
  const [picker, setPicker] = useState<PickerInfo>(info)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // The highlighted row by project id, not index: the list is re-read on every focus and an index
  // would land on whichever project moved into that slot. Unset (or naming a row the filter hid)
  // means the first openable row, so Enter in a fresh picker opens the most recent project.
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const load = (): void => {
    window.cockpit
      .invoke('projects.recent')
      .then(setRecent)
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
    // The Open Folder chord can be rebound in a project window's settings while this one is open.
    window.cockpit
      .invoke('window.info')
      .then((next) => {
        if (next.kind === 'picker') setPicker(next)
      })
      .catch(() => {}) // keep the hint we have; the list's own error is the one worth showing
  }
  useEffect(() => {
    load()
    window.addEventListener('focus', load)
    // A project's colour set in another window while this one is open (it is modal over one
    // window only): main says so, and the rows' dots follow without waiting for the focus.
    const off = window.cockpit.on('projects.changed', load)
    return () => {
      window.removeEventListener('focus', load)
      off()
    }
  }, [])

  const rows = useMemo(() => (recent ? filterProjects(recent, query, picker.home) : []), [recent, query, picker.home])
  const picked = rows.findIndex((p) => p.id === highlightId && !p.missing)
  const highlight = picked >= 0 ? picked : firstOpenable(rows)

  useEffect(() => {
    if (highlight < 0) return
    // `nearest` scrolls only when the row is out of view, so a mouse hover never jolts the list.
    listRef.current?.children[highlight]?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  const run = (action: Promise<unknown>): void => {
    setError(null)
    action.catch((err: unknown) => setError(ipcErrorMessage(err)))
  }
  const open = (p: ProjectSummary): void => run(window.cockpit.invoke('projects.openRecent', { id: p.id }))

  const onFilterKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault() // the caret would jump to the start or end of the text
      const next = moveHighlight(rows, highlight, e.key === 'ArrowDown' ? 1 : -1)
      setHighlightId(rows[next]?.id ?? null)
    } else if (e.key === 'Enter') {
      // Enter on the field only: a focused row or button handles its own Enter natively.
      e.preventDefault()
      const row = rows[highlight]
      if (row && !row.missing) open(row)
    } else if (e.key === 'Escape' && query !== '') {
      e.preventDefault()
      setQuery('')
      setHighlightId(null)
    }
  }

  // A modal picker (a sheet over a project window) closes on Esc and Cancel; main refuses the
  // request for a standalone one. The filter's own Esc (clear the text first) preventDefaults, and
  // React's root listener runs before this document one, so one Esc does one thing.
  const modal = picker.modal === true
  useEffect(() => {
    if (!modal) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        window.cockpit.invoke('projects.closePicker').catch(() => {})
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [modal])

  const shortcut = picker.openFolderKey ? displayChord(picker.openFolderKey, mac()) : undefined
  const rowId = (i: number): string => `picker-row-${i}`

  return (
    <main className="picker">
      <header className="picker-header">
        <AppIcon size={56} />
        <div className="picker-title">
          <h1>cc-cockpit</h1>
          <p className="picker-tagline">Claude Code sessions, one cockpit</p>
        </div>
        <button
          type="button"
          className="picker-primary"
          aria-keyshortcuts={picker.openFolderKey ? ariaShortcut(picker.openFolderKey) : undefined}
          onClick={() => run(window.cockpit.invoke('projects.openFolder'))}
        >
          Open Folder…
          {shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
        </button>
        {modal && (
          <button type="button" className="picker-cancel" onClick={() => run(window.cockpit.invoke('projects.closePicker'))}>
            Cancel
          </button>
        )}
      </header>

      {error && (
        <p role="alert" className="picker-error">
          {error}
        </p>
      )}

      <section className="picker-recent" aria-labelledby="picker-recent-title">
        <h2 id="picker-recent-title">Recent projects</h2>
        <div className="picker-panel">
          {recent === null ? null : recent.length === 0 ? (
            <p className="picker-empty">No recent projects.</p>
          ) : (
            <>
              <label className="picker-search">
                <SearchGlyph />
                <input
                  type="text"
                  autoFocus
                  spellCheck={false}
                  placeholder="Search recent projects…"
                  aria-label="Search recent projects"
                  aria-controls="picker-list"
                  aria-activedescendant={highlight >= 0 ? rowId(highlight) : undefined}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setHighlightId(null)
                  }}
                  onKeyDown={onFilterKey}
                />
              </label>
              {rows.length === 0 ? (
                <p className="picker-empty">No projects match “{query.trim()}”.</p>
              ) : (
                <ul id="picker-list" className="picker-list" ref={listRef}>
                  {rows.map((p, i) => (
                    <li
                      key={p.id}
                      className={`picker-row${p.missing ? ' missing' : ''}${i === highlight ? ' highlighted' : ''}`}
                      onMouseMove={() => {
                        if (!p.missing && i !== highlight) setHighlightId(p.id)
                      }}
                    >
                      <button
                        type="button"
                        id={rowId(i)}
                        className="picker-open"
                        disabled={p.missing}
                        // The name alone is the button's name (specs and screen readers find a
                        // project by it); the path, and that it is missing, describe it.
                        aria-labelledby={`${rowId(i)}-name`}
                        aria-describedby={`${rowId(i)}-path`}
                        title={p.missing ? `${p.path} (folder missing)` : p.path}
                        onClick={() => open(p)}
                      >
                        <FolderGlyph />
                        <span className="picker-row-text">
                          <span className="picker-row-line">
                            <ProjectDot color={p.color} />
                            <span className="picker-row-name" id={`${rowId(i)}-name`}>
                              {p.name}
                            </span>
                            {p.missing && (
                              <span className="picker-badge" aria-hidden="true">
                                missing
                              </span>
                            )}
                          </span>
                          <span className="picker-row-path" id={`${rowId(i)}-path`}>
                            {tildePath(p.path, picker.home)}
                            {p.missing && <span className="visually-hidden"> (missing)</span>}
                          </span>
                        </span>
                        {!p.missing && (
                          <kbd className="picker-enter" aria-hidden="true">
                            ↵
                          </kbd>
                        )}
                      </button>
                      {p.missing && (
                        // A folder that moved: pick the new one (opens the project, without its old
                        // tabs). A folder that is gone for good: forget the project.
                        <span className="picker-row-actions">
                          <button
                            type="button"
                            className="picker-quiet"
                            onClick={() => run(window.cockpit.invoke('projects.relink', { id: p.id }).then(load))}
                          >
                            Relink…
                          </button>
                          <button
                            type="button"
                            className="picker-quiet"
                            onClick={() => run(window.cockpit.invoke('projects.forget', { id: p.id }).then(load))}
                          >
                            Forget
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  )
}

/** A canonical chord in `aria-keyshortcuts` form (`meta+o` -> `Meta+O`); undefined if unparsable. */
function ariaShortcut(chord: string): string | undefined {
  const parts = splitChord(chord)
  if (!parts) return undefined
  const name = (p: string): string => (p === '+' ? 'Plus' : p.length <= 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1))
  return [...parts.mods, parts.key].map(name).join('+')
}
