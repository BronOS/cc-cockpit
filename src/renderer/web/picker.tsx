// The web shell's project picker (plan Task 8), drawn from the desktop picker's parts
// (picker/parts.tsx: header, panels, rows, empty states), so the two look alike and a change to a
// row reaches both. The list comes over HTTP (PROJECTS_PATH, signed-in devices only), before any
// socket: there is no window to bind one to yet.
//
// On the desktop (web access on a desktop app) it lists only the projects that have a window open
// now, each a link to the shell bound to it (`/?project=<id>`): a remote view binds to an open
// project window (design-web.md §2.1) and cannot open one on the host (`projects.openRecent` and the
// folder dialog are `no`-class), so the desktop picker's recent list and Open Folder have no place
// here.
//
// In server mode (§9.8) there is no desktop picker, so this one is the picker: the open projects, the
// recent ones (reopened with a POST; a missing one offers Relink… and Forget, the desktop picker's
// buttons, with Forget confirmed inline in its row), and "Open folder…", which opens the folder
// browser (folder-browser.tsx) on the server's folders. With nothing open and nothing recent (a new
// server) the page is a welcome: which server and user this is, and one Open folder button. Main
// opens, relinks or forgets and answers the project id; the page goes on to `/?project=<id>`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WebOpenProjectRequest, WebRecentProject } from '../../shared/web-protocol'
import { PickerEmpty, PickerError, PickerHeader, PickerSearch, PickerSection, ProjectRow } from '../picker/parts'
import { filterProjects, firstOpenable, moveHighlight, openedAgo, tildePath } from '../picker/picker-model'
import { FolderBrowser } from './folder-browser'
import { loadOpenProjects, openProject, projectHref, type Fetch, type ProjectsResult } from './picker-model'

/** What the folder browser is open for: a new folder, or a missing project's new place. */
type Browsing = { kind: 'open' } | { kind: 'relink'; project: WebRecentProject }

/** A mouse or trackpad: the recent filter takes the focus on load only there (a phone would open its keyboard). */
function finePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches
}

/** The picker page. `onSignedOut`: the device went away (the page shows the signed-out text). */
export function WebPicker(props: { fetch: Fetch; onSignedOut: () => void }): React.JSX.Element {
  const { fetch: fetchFn, onSignedOut } = props
  const [result, setResult] = useState<ProjectsResult | null>(null)
  /** When the list was read: the rows' "3 days ago" are as of then (render stays pure). */
  const [loadedAt, setLoadedAt] = useState(0)
  const load = useCallback(() => {
    void loadOpenProjects(fetchFn).then((next) => {
      if (!next.ok && next.signedOut) onSignedOut()
      else {
        setLoadedAt(Date.now())
        setResult(next)
      }
    })
  }, [fetchFn, onSignedOut])
  useEffect(() => {
    load()
    // Projects opened or closed elsewhere while this page sat in the background.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  // Server mode's requests (a recent row, the folder browser, relink, forget): one at a time, the
  // error in this view only (in the folder browser while it is open, else at the top).
  const [busy, setBusy] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState<Browsing | null>(null)
  const [browseError, setBrowseError] = useState<string | null>(null)
  /** The missing project whose row shows "Forget? … Forget / Cancel". */
  const [confirmForget, setConfirmForget] = useState<string | null>(null)
  const send = (request: WebOpenProjectRequest): void => {
    if (busy) return
    setBusy(true)
    setOpenError(null)
    setBrowseError(null)
    void openProject(fetchFn, request).then((reply) => {
      if (reply.ok && 'forget' in request) {
        setBusy(false)
        setConfirmForget(null)
        load()
        return
      }
      if (reply.ok) {
        // Relative, so it stays on whatever origin the page has; the shell binds to the new window.
        location.assign(projectHref(reply.id))
        return
      }
      setBusy(false)
      if (reply.signedOut) onSignedOut()
      else if (browsing !== null) setBrowseError(reply.error)
      else setOpenError(reply.error)
    })
  }
  const browse = (next: Browsing): void => {
    setBrowseError(null)
    setOpenError(null)
    setBrowsing(next)
  }

  const ok = result?.ok === true ? result : null
  const server = ok?.server === true
  const home = ok?.host?.home

  // The recent list's filter and keyboard highlight, as the desktop picker's (by id: the list is
  // read again on every visibility change, an index would land on another project).
  const [query, setQuery] = useState('')
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const rows = useMemo(() => (ok ? filterProjects(ok.recent, query, home) : []), [ok, query, home])
  const picked = rows.findIndex((p) => p.id === highlightId && !p.missing)
  const highlight = picked >= 0 ? picked : firstOpenable(rows)
  useEffect(() => {
    if (highlight >= 0) listRef.current?.children[highlight]?.scrollIntoView({ block: 'nearest' })
  }, [highlight])
  const onFilterKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = moveHighlight(rows, highlight, e.key === 'ArrowDown' ? 1 : -1)
      setHighlightId(rows[next]?.id ?? null)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[highlight]
      if (row && !row.missing) send({ reopen: row.id })
    } else if (e.key === 'Escape' && query !== '') {
      e.preventDefault()
      setQuery('')
      setHighlightId(null)
    }
  }
  const rowId = (i: number): string => `web-picker-row-${i}`
  const openRowId = (i: number): string => `web-picker-open-${i}`

  // A new server: nothing open, nothing recent. The welcome takes the page, with the one button.
  const firstRun = ok !== null && server && ok.projects.length === 0 && ok.recent.length === 0
  const tagline = server && ok?.host ? `${ok.host.user} on ${ok.host.name}` : 'Claude Code sessions, one cockpit'

  return (
    <main className="picker picker-web">
      <PickerHeader tagline={tagline}>
        {server && !firstRun && (
          <button type="button" className="picker-primary" disabled={busy} onClick={() => browse({ kind: 'open' })}>
            Open folder…
          </button>
        )}
        <button type="button" className="picker-cancel" onClick={load}>
          Refresh
        </button>
      </PickerHeader>

      {openError !== null && <PickerError>Cannot open: {openError}</PickerError>}
      {result !== null && !result.ok && (
        <PickerError>{result.signedOut ? 'Not signed in.' : `Cannot list projects: ${result.error}.`}</PickerError>
      )}
      {result === null && <p className="picker-loading">Loading…</p>}

      {firstRun && (
        <section className="picker-welcome" aria-labelledby="web-picker-welcome">
          <h2 id="web-picker-welcome">Welcome to cc-cockpit</h2>
          <p>
            {ok?.host ? (
              <>
                You are on <strong>{ok.host.name}</strong> as <strong>{ok.host.user}</strong>.{' '}
              </>
            ) : null}
            A project is a folder on this server, with its own Claude Code and terminal tabs. Open one to start.
          </p>
          <button type="button" className="picker-primary" disabled={busy} onClick={() => browse({ kind: 'open' })}>
            Open folder…
          </button>
          <p className="picker-welcome-hint">Projects you open are listed here next time, from any device you sign in with.</p>
        </section>
      )}

      {ok !== null && !firstRun && (ok.projects.length > 0 || !server) && (
        <PickerSection id="web-picker-open-title" title="Open projects" className="picker-section-fixed">
          {ok.projects.length === 0 ? (
            <PickerEmpty>No project is open on the desktop. Open one there, then refresh.</PickerEmpty>
          ) : (
            <ul className="picker-list" aria-label="Open projects">
              {ok.projects.map((p, i) => (
                <ProjectRow
                  key={p.id}
                  rowId={openRowId(i)}
                  name={p.name}
                  path={tildePath(p.path, home)}
                  title={p.path}
                  color={p.color}
                  missing={false}
                  highlighted={false}
                  href={projectHref(p.id)}
                />
              ))}
            </ul>
          )}
        </PickerSection>
      )}

      {ok !== null && server && !firstRun && (
        <PickerSection id="web-picker-recent-title" title="Recent projects">
          {ok.recent.length === 0 ? (
            <PickerEmpty>No other recent projects.</PickerEmpty>
          ) : (
            <>
              <PickerSearch
                label="Search recent projects"
                autoFocus={finePointer() && browsing === null}
                placeholder="Search recent projects…"
                aria-controls="web-picker-recent-list"
                aria-activedescendant={highlight >= 0 ? rowId(highlight) : undefined}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setHighlightId(null)
                }}
                onKeyDown={onFilterKey}
              />
              {rows.length === 0 ? (
                <PickerEmpty>No projects match “{query.trim()}”.</PickerEmpty>
              ) : (
                <ul id="web-picker-recent-list" className="picker-list" aria-label="Recent projects" ref={listRef}>
                  {rows.map((p, i) => (
                    <ProjectRow
                      key={p.id}
                      rowId={rowId(i)}
                      name={p.name}
                      path={tildePath(p.path, home)}
                      title={p.missing ? `${p.path} (folder missing)` : p.path}
                      color={p.color}
                      missing={p.missing}
                      highlighted={i === highlight}
                      disabled={busy}
                      {...(p.lastOpenedAt !== undefined ? { meta: openedAgo(p.lastOpenedAt, loadedAt) } : {})}
                      onHover={() => {
                        if (!p.missing && i !== highlight) setHighlightId(p.id)
                      }}
                      onOpen={() => send({ reopen: p.id })}
                      actions={
                        p.missing && (
                          <MissingActions
                            project={p}
                            confirming={confirmForget === p.id}
                            busy={busy}
                            onRelink={() => browse({ kind: 'relink', project: p })}
                            onForget={() => setConfirmForget(p.id)}
                            onConfirm={() => send({ forget: p.id })}
                            onCancel={() => setConfirmForget(null)}
                          />
                        )
                      }
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </PickerSection>
      )}

      {browsing !== null && (
        <FolderBrowser
          fetch={fetchFn}
          title={browsing.kind === 'open' ? 'Open folder' : `Relink ${browsing.project.name}`}
          {...(browsing.kind === 'relink'
            ? { intro: `Its folder ${browsing.project.path} is gone. Pick where it is now: the project opens there, without its old tabs.` }
            : {})}
          chooseLabel={browsing.kind === 'open' ? 'Open' : 'Relink here'}
          busy={busy}
          error={browseError}
          onChoose={(path) => send(browsing.kind === 'open' ? { open: path } : { relink: browsing.project.id, path })}
          onClose={() => {
            setBrowsing(null)
            setBrowseError(null)
          }}
          onSignedOut={onSignedOut}
        />
      )}
    </main>
  )
}

/**
 * A missing project's buttons, as the desktop picker's (a folder that moved: pick the new one; gone for
 * good: forget the project), and Forget's confirm in their place: it removes the record and its
 * saved tabs, which nothing brings back, so it asks in the row (never a browser `confirm()`, which a
 * server's page must not rely on). Cancel takes the focus, so an Enter does not forget.
 */
function MissingActions(props: {
  project: WebRecentProject
  confirming: boolean
  busy: boolean
  onRelink(): void
  onForget(): void
  onConfirm(): void
  onCancel(): void
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (props.confirming) cancelRef.current?.focus()
  }, [props.confirming])
  if (props.confirming) {
    return (
      <span className="picker-row-actions picker-row-confirm" role="group" aria-label={`Forget ${props.project.name}?`}>
        <span className="picker-confirm-text">Forget it and its saved tabs?</span>
        <button type="button" className="picker-quiet picker-danger" disabled={props.busy} onClick={props.onConfirm}>
          Forget
        </button>
        <button type="button" className="picker-quiet" ref={cancelRef} onClick={props.onCancel}>
          Cancel
        </button>
      </span>
    )
  }
  return (
    <span className="picker-row-actions">
      <button type="button" className="picker-quiet" disabled={props.busy} onClick={props.onRelink}>
        Relink…
      </button>
      <button type="button" className="picker-quiet" disabled={props.busy} onClick={props.onForget}>
        Forget
      </button>
    </span>
  )
}
