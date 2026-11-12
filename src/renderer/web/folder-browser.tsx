// Server mode's folder browser (design-web.md §9.8): an in-page dialog over the browser picker that
// lists folders on the server (FOLDERS_PATH, list-folders.ts), for "Open folder…" and a missing
// project's "Relink…". There is no native folder dialog on a server, and a typed server path was
// the only way before; the path field stays ("Go to path", with completion from the listings).
//
// How it is used:
//  - A click (a tap) on a folder goes into it; the breadcrumbs and Up go back. The button at the
//    bottom ("Open", "Relink here") takes the folder shown.
//  - A double click takes a folder at once. Its first click has already gone into the folder (the
//    list under the pointer changes before the second click lands, so a plain dblclick would hit
//    whatever row moved there): a second click within DOUBLE_CLICK_MS anywhere on the list takes
//    the folder the first click entered, which is also the folder now shown.
//  - Keyboard: the filter field has the focus on open; ↓ goes to the rows, ↑/↓ move between them,
//    Enter on a row takes that folder, → (or Space) goes into it, ← or Backspace goes up, Enter in the
//    filter goes into the highlighted folder, Alt+↑ goes up from anywhere, Esc clears the filter then
//    closes. Tab stays inside the dialog.
//
// Everything shown is text (folder names are the server's data); main checks every path it is sent.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { FolderGlyph } from '../picker/icons'
import { tildePath } from '../picker/picker-model'
import {
  breadcrumbs,
  childPath,
  commonPrefix,
  completions,
  completionTarget,
  expandHome,
  filterFolders,
  loadFolders,
  type Fetch,
  type FolderListing
} from './picker-model'
import type { WebFolderEntry } from '../../shared/web-protocol'

/** Two clicks this close (ms) are a double click (the OS default is about 500). */
const DOUBLE_CLICK_MS = 500
/** "Go to path" asks the server for completions this long after the last key. */
const COMPLETE_DELAY_MS = 150

/** A mouse or trackpad (not a phone): only there is the filter focused for the person, which would open a phone's keyboard. */
function finePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches
}

export interface FolderBrowserProps {
  fetch: Fetch
  /** The dialog's title ("Open folder", "Relink <name>"). */
  title: string
  /** One line under the title (Relink says which folder is gone); absent for none. */
  intro?: string
  /** The bottom button's text ("Open", "Relink here"). */
  chooseLabel: string
  /** A take is under way: the button waits. */
  busy: boolean
  /** The last take's failure, main's text (shown in the dialog, which stays open). */
  error: string | null
  onChoose(path: string): void
  onClose(): void
  onSignedOut(): void
}

export function FolderBrowser(props: FolderBrowserProps): React.JSX.Element {
  const { fetch: fetchFn, onChoose, onClose, onSignedOut } = props
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '')
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [loading, setLoading] = useState(true)
  /** A request the gateway refused or that got no answer (the listing stays as it was). */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [goTo, setGoTo] = useState('')

  const dialogRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  /** Only the newest request's answer is drawn: a slow listing must not replace a later one. */
  const seq = useRef(0)
  /** Where focus goes once the next listing is drawn: the first row (keyboard on a row) or the filter. */
  const focusNext = useRef<'rows' | 'filter' | null>(finePointer() ? 'filter' : null)
  /** The folder a pointer click just went into, for the double click (see the header); `at` is the event's timeStamp. */
  const lastClick = useRef<{ path: string; at: number } | null>(null)
  /**
   * Listings fetched for "Go to path" completion (and every listing shown), by `<hidden>:<folder>`,
   * for this dialog's life: typing back and forth asks the server once per folder.
   */
  const [cache, setCache] = useState<Readonly<Record<string, readonly WebFolderEntry[]>>>({})

  /** Asks for a folder and draws the answer when it is still the newest request (loading is set by the caller). */
  const fetchListing = useCallback(
    (path: string | undefined, showHidden: boolean, focus: 'rows' | 'filter' | null) => {
      const mine = ++seq.current
      focusNext.current = focus
      void loadFolders(fetchFn, path === undefined ? { hidden: showHidden } : { path, hidden: showHidden }).then((result) => {
        if (mine !== seq.current) return
        setLoading(false)
        if (!result.ok) {
          if (result.signedOut) onSignedOut()
          else setLoadError(result.error)
          return
        }
        const shown = result.listing
        setLoadError(null)
        setListing(shown)
        setQuery('')
        setHighlight(0)
        setGoTo(shown.path)
        if (!shown.error) setCache((c) => ({ ...c, [`${showHidden}:${shown.path}`]: shown.folders }))
      })
    },
    [fetchFn, onSignedOut]
  )
  const go = (path: string | undefined, showHidden: boolean, focus: 'rows' | 'filter' | null = finePointer() ? 'filter' : null): void => {
    setLoading(true)
    fetchListing(path, showHidden, focus)
  }

  // The start folder (ccc web set --start-folder, else home) on open; `loading` starts true.
  useEffect(() => fetchListing(undefined, false, finePointer() ? 'filter' : null), [fetchListing])

  // Back to what had the focus (the button that opened the dialog) when it closes.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!finePointer()) dialogRef.current?.focus()
    return () => before?.focus()
  }, [])

  const rows = useMemo(() => (listing && !listing.error ? filterFolders(listing.folders, query) : []), [listing, query])
  const current = Math.min(highlight, Math.max(0, rows.length - 1))

  useEffect(() => {
    if (loading || !listing) return
    const target = focusNext.current
    focusNext.current = null
    if (target === 'rows' && rows.length > 0) listRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    else if (target !== null) filterRef.current?.focus()
    // Only when a listing lands, not on every filter keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, listing])

  useEffect(() => {
    listRef.current?.children[current]?.scrollIntoView({ block: 'nearest' })
  }, [current])

  // "Go to path" completion: the subfolders of the folder typed so far, from a listing this dialog
  // already has, else asked of the server (debounced) into the cache, which draws them.
  const target = listing && goTo !== listing.path ? completionTarget(goTo, listing.home) : undefined
  const targetKey = target ? `${hidden}:${target.dir}` : undefined
  const suggestions = useMemo(() => {
    const folders = targetKey !== undefined ? cache[targetKey] : undefined
    return target && folders ? completions(folders, target) : []
    // `target` is derived from goTo and listing, both in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, targetKey, goTo, listing])
  const targetDir = target?.dir
  useEffect(() => {
    if (targetDir === undefined || targetKey === undefined || cache[targetKey] !== undefined) return
    let stale = false
    const timer = setTimeout(() => {
      void loadFolders(fetchFn, { path: targetDir, hidden }).then((result) => {
        if (stale || !result.ok || result.listing.error) return
        const folders = result.listing.folders
        setCache((c) => ({ ...c, [targetKey]: folders }))
      })
    }, COMPLETE_DELAY_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [targetDir, targetKey, cache, hidden, fetchFn])

  const path = listing?.path
  /** Up one folder; `focus` as `go`'s (undefined: its default). */
  const up = (focus?: 'rows' | 'filter' | null): void => {
    if (listing?.parent) go(listing.parent, hidden, focus)
  }
  const enter = (name: string, focus: 'rows' | 'filter' | null): void => {
    if (path !== undefined) go(childPath(path, name), hidden, focus)
  }
  const canChoose = listing !== null && !listing.error && !loading && !props.busy

  /** A pointer click on the list: a second one soon after takes the folder the first went into. */
  const pointerClick = (e: React.MouseEvent, name?: string): void => {
    const now = e.timeStamp
    const previous = lastClick.current
    if (previous && now - previous.at < DOUBLE_CLICK_MS) {
      lastClick.current = null
      if (!props.busy) onChoose(previous.path)
      return
    }
    if (name === undefined || path === undefined) return
    // A keyboard "click" (Space on a row) has detail 0: it only goes in.
    if (e.detail > 0) lastClick.current = { path: childPath(path, name), at: now }
    enter(name, e.detail > 0 ? null : 'rows')
  }

  const focusRow = (i: number): void => {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button.picker-open')
    const button = buttons?.[Math.max(0, Math.min(i, (buttons?.length ?? 1) - 1))]
    button?.focus()
  }

  const onRowKey = (e: React.KeyboardEvent, i: number, folder: WebFolderEntry): void => {
    if (e.key === 'Enter') {
      e.preventDefault() // the button's own Enter would click it: go in, not take
      if (path !== undefined && !props.busy) onChoose(childPath(path, folder.name))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      enter(folder.name, 'rows')
    } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
      e.preventDefault()
      up('rows')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusRow(i + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (i === 0) filterRef.current?.focus()
      else focusRow(i - 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusRow(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      focusRow(rows.length - 1)
    }
  }

  const onFilterKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusRow(current)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const folder = rows[current]
      if (folder) enter(folder.name, 'filter')
    } else if (e.key === 'Escape' && query !== '') {
      e.preventDefault()
      e.stopPropagation()
      setQuery('')
      setHighlight(0)
    }
  }

  const onGoToKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Tab' || e.shiftKey || !listing || suggestions.length === 0) return
    // Tab fills in what every suggestion shares (a shell's habit); with one left, its slash too.
    const typed = expandHome(goTo.trim(), listing.home)
    const shared = suggestions.length === 1 ? `${suggestions[0]}/` : commonPrefix(suggestions)
    if (shared.length > typed.length) {
      e.preventDefault()
      setGoTo(shared)
    }
  }

  // Esc closes; Alt+↑ goes up; Tab stays inside (a modal dialog).
  const onDialogKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowUp' && e.altKey) {
      e.preventDefault()
      up()
    } else if (e.key === 'Tab') {
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []
      )
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  const home = listing?.home ?? ''
  const crumbs = listing ? breadcrumbs(listing.path, listing.home) : []
  const titleId = `${uid}-title`
  const count = listing && !listing.error ? listing.folders.length : 0

  return (
    <div
      className="folder-browser-backdrop"
      onMouseDown={(e) => {
        // A press on the backdrop itself closes (nothing is lost); one that started in the dialog does not.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={dialogRef} className="folder-browser" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onDialogKey}>
        <header className="folder-browser-head">
          <h2 id={titleId}>{props.title}</h2>
          {props.intro !== undefined && <p className="folder-browser-intro">{props.intro}</p>}
        </header>

        <nav className="folder-crumbs" aria-label="Folder path">
          <button
            type="button"
            className="picker-quiet folder-up"
            disabled={!listing?.parent || loading}
            onClick={() => up()}
            title="Up one folder (Alt+↑)"
            aria-label="Up one folder"
          >
            ↑
          </button>
          <ol>
            {crumbs.map((c, i) => (
              <li key={c.path}>
                {i === crumbs.length - 1 ? (
                  <span aria-current="location" title={c.path}>
                    {c.label}
                  </span>
                ) : (
                  <button type="button" className="folder-crumb" title={c.path} onClick={() => go(c.path, hidden)}>
                    {c.label}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </nav>

        <div className="folder-tools">
          <label className="picker-search">
            <input
              ref={filterRef}
              type="text"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="Filter folders…"
              aria-label="Filter folders"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setHighlight(0)
              }}
              onKeyDown={onFilterKey}
            />
          </label>
          <label className="folder-hidden">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => {
                setHidden(e.target.checked)
                go(listing?.path, e.target.checked)
              }}
            />
            Hidden folders
          </label>
        </div>

        {listing?.note !== undefined && <p className="folder-note">{listing.note}</p>}
        {loadError !== null && (
          <p role="alert" className="picker-error folder-inline-error">
            {loadError}
          </p>
        )}

        <div className="folder-list-wrap" aria-busy={loading} onClick={(e) => pointerClick(e)}>
          {listing === null ? (
            <p className="picker-empty">{loading ? 'Loading…' : 'Nothing to show.'}</p>
          ) : listing.error !== undefined ? (
            <p role="alert" className="picker-empty folder-unreadable">
              {listing.error}
            </p>
          ) : rows.length === 0 ? (
            <p className="picker-empty">
              {query.trim() !== ''
                ? `No folders match “${query.trim()}”.`
                : listing.hiddenCount > 0
                  ? `No folders here, ${listing.hiddenCount} hidden.`
                  : 'No folders here.'}
            </p>
          ) : (
            <ul ref={listRef} className="picker-list folder-list" aria-label="Folders">
              {rows.map((f, i) => {
                const rowId = `${uid}-f${i}`
                const marks = [f.git ? 'git repository' : '', f.project ? 'cc-cockpit project' : '', f.link ? 'symbolic link' : ''].filter((m) => m !== '')
                return (
                  <li
                    key={f.name}
                    className={`picker-row${i === current ? ' highlighted' : ''}`}
                    onMouseMove={() => {
                      if (i !== current) setHighlight(i)
                    }}
                  >
                    <button
                      type="button"
                      id={rowId}
                      className="picker-open"
                      aria-labelledby={`${rowId}-name`}
                      aria-describedby={marks.length > 0 ? `${rowId}-marks` : undefined}
                      title={path !== undefined ? childPath(path, f.name) : f.name}
                      onFocus={() => setHighlight(i)}
                      onClick={(e) => {
                        e.stopPropagation()
                        pointerClick(e, f.name)
                      }}
                      onKeyDown={(e) => onRowKey(e, i, f)}
                    >
                      <FolderGlyph />
                      <span className="picker-row-name folder-name" id={`${rowId}-name`}>
                        {f.name}
                      </span>
                      {f.link && (
                        <span className="picker-badge" aria-hidden="true">
                          link
                        </span>
                      )}
                      {f.git && (
                        <span className="picker-badge" aria-hidden="true">
                          git
                        </span>
                      )}
                      {f.project && (
                        <span className="picker-badge folder-project-badge" aria-hidden="true">
                          project
                        </span>
                      )}
                      {marks.length > 0 && (
                        <span className="visually-hidden" id={`${rowId}-marks`}>
                          {marks.join(', ')}
                        </span>
                      )}
                      <span className="folder-chevron" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <p className="folder-status" aria-live="polite">
          {loading
            ? 'Loading…'
            : listing && !listing.error
              ? [
                  `${count} folder${count === 1 ? '' : 's'}`,
                  listing.hiddenCount > 0 ? `${listing.hiddenCount} hidden` : '',
                  listing.truncated ? `only the first ${count} shown: type a path below to go further` : ''
                ]
                  .filter((t) => t !== '')
                  .join(' · ')
              : ''}
        </p>

        <form
          className="folder-goto"
          onSubmit={(e) => {
            e.preventDefault()
            const typed = expandHome(goTo.trim(), home)
            if (typed === '') return
            if (!typed.startsWith('/')) {
              setLoadError('Type a full path, starting with / or ~')
              return
            }
            go(typed, hidden)
          }}
        >
          <label htmlFor={`${uid}-goto`}>Go to path</label>
          <input
            id={`${uid}-goto`}
            type="text"
            list={`${uid}-goto-list`}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            placeholder="/srv/project or ~/src"
            value={goTo}
            onChange={(e) => setGoTo(e.target.value)}
            onKeyDown={onGoToKey}
          />
          <datalist id={`${uid}-goto-list`}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <button type="submit" className="picker-quiet">
            Go
          </button>
        </form>

        {props.error !== null && (
          <p role="alert" className="picker-error folder-inline-error">
            Cannot open: {props.error}
          </p>
        )}

        <footer className="folder-browser-foot">
          <p className="folder-here" title={path}>
            {path !== undefined && (
              <>
                <span className="folder-here-path">{tildePath(path, home)}</span>
                {listing?.here.git && <span className="picker-badge">git</span>}
                {listing?.here.project && <span className="picker-badge folder-project-badge">project</span>}
              </>
            )}
          </p>
          <button type="button" className="picker-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="picker-primary" disabled={!canChoose} onClick={() => path !== undefined && onChoose(path)}>
            {props.chooseLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
