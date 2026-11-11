// The web shell's project picker (plan Task 8): the projects that have a window open now, each a
// link to the shell bound to it (`/?project=<id>`). On the desktop only open ones: a remote view
// binds to an open project window (design-web.md §2.1) and cannot open one on the host
// (`projects.openRecent` and the folder dialog are `no`-class), so the desktop picker's recent
// list and Open Folder have no place here. In server mode (§9.8) there is no desktop picker, so
// this one lists the recent projects (a missing one shown as missing: relink and forget wait for a
// later version) and has "Open folder…" with a path on the server; main opens it and the page goes
// on to `/?project=<id>`. The list comes over HTTP (PROJECTS_PATH, signed-in devices only), before
// any socket: there is no window to bind one to yet.
import { useCallback, useEffect, useState } from 'react'
import type { WebOpenProjectRequest } from '../../shared/web-protocol'
import { loadOpenProjects, openProject, projectHref, type Fetch, type ProjectsResult } from './picker-model'

/** The picker page. `onSignedOut`: the device went away (the page shows the signed-out text). */
export function WebPicker(props: { fetch: Fetch; onSignedOut: () => void }): React.JSX.Element {
  const { fetch: fetchFn, onSignedOut } = props
  const [result, setResult] = useState<ProjectsResult | null>(null)
  const load = useCallback(() => {
    void loadOpenProjects(fetchFn).then((next) => {
      if (!next.ok && next.signedOut) onSignedOut()
      else setResult(next)
    })
  }, [fetchFn, onSignedOut])
  useEffect(() => {
    load()
    // Projects opened or closed on the desktop while this page sat in the background.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  // Server mode's open (a recent row or the path form): one at a time, its error in this view only.
  const [busy, setBusy] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [pathOpen, setPathOpen] = useState(false)
  const [path, setPath] = useState('')
  const open = (request: WebOpenProjectRequest): void => {
    if (busy) return
    setBusy(true)
    setOpenError(null)
    void openProject(fetchFn, request).then((result) => {
      if (result.ok) {
        // Relative, so it stays on whatever origin the page has; the shell binds to the new window.
        location.assign(projectHref(result.id))
        return
      }
      setBusy(false)
      if (result.signedOut) onSignedOut()
      else setOpenError(result.error)
    })
  }
  const server = result?.ok === true && result.server

  return (
    <main className="web-picker">
      <h1>cc-cockpit</h1>
      {result === null && <p className="web-picker-note">Loading...</p>}
      {result !== null && !result.ok && (
        <p className="web-picker-note" role="alert">
          {result.signedOut ? 'Not signed in.' : `Cannot list projects: ${result.error}.`}
        </p>
      )}
      {result?.ok === true && result.projects.length === 0 && (
        <p className="web-picker-note">
          {server ? 'No project is open.' : 'No project is open on the desktop. Open one there, then refresh.'}
        </p>
      )}
      {result?.ok === true && result.projects.length > 0 && (
        <ul className="web-picker-list" aria-label="Open projects">
          {result.projects.map((p) => (
            <li key={p.id}>
              {/* Text only: names and paths are the person's folders, drawn as text. */}
              <a href={projectHref(p.id)}>
                <span className="web-picker-name">{p.name}</span>
                <span className="web-picker-path">{p.path}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {result?.ok === true && server && result.recent.length > 0 && (
        <>
          <h2 className="web-picker-heading">Recent</h2>
          <ul className="web-picker-list" aria-label="Recent projects">
            {result.recent.map((p) => (
              <li key={p.id}>
                {p.missing ? (
                  // Shown so the person knows where it went; open the folder by its new path instead.
                  <div className="web-picker-row web-picker-missing" aria-disabled="true">
                    <span className="web-picker-name">
                      {p.name} <span className="web-picker-badge">missing</span>
                    </span>
                    <span className="web-picker-path">{p.path}</span>
                  </div>
                ) : (
                  <button type="button" className="web-picker-row" disabled={busy} onClick={() => open({ reopen: p.id })}>
                    <span className="web-picker-name">{p.name}</span>
                    <span className="web-picker-path">{p.path}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {server && pathOpen && (
        <form
          className="web-picker-open"
          onSubmit={(e) => {
            e.preventDefault()
            const value = path.trim()
            if (value !== '') open({ open: value })
          }}
        >
          <label htmlFor="web-picker-path">Folder on the server</label>
          <input
            id="web-picker-path"
            type="text"
            value={path}
            placeholder="/home/me/project"
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setPath(e.target.value)}
          />
          <button type="submit" disabled={busy || path.trim() === ''}>
            Open
          </button>
        </form>
      )}
      {openError !== null && (
        <p className="web-picker-error" role="alert">
          Cannot open: {openError}
        </p>
      )}
      <div className="web-picker-actions">
        {server && !pathOpen && (
          <button type="button" className="web-picker-refresh" onClick={() => setPathOpen(true)}>
            Open folder…
          </button>
        )}
        <button type="button" className="web-picker-refresh" onClick={load}>
          Refresh
        </button>
      </div>
    </main>
  )
}
