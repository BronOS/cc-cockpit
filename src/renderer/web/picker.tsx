// The web shell's project picker (plan Task 8): the projects that have a window open on the desktop
// now, each a link to the shell bound to it (`/?project=<id>`). Only open ones: a remote view
// binds to an open project window (design-web.md §2.1) and cannot open one on the host
// (`projects.openRecent` and the folder dialog are `no`-class), so the desktop picker's recent
// list and Open Folder have no place here. The list comes over HTTP (PROJECTS_PATH, signed-in
// devices only), before any socket: there is no window to bind one to yet.
import { useCallback, useEffect, useState } from 'react'
import { loadOpenProjects, projectHref, type Fetch, type ProjectsResult } from './picker-model'

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
        <p className="web-picker-note">No project is open on the desktop. Open one there, then refresh.</p>
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
      <button type="button" className="web-picker-refresh" onClick={load}>
        Refresh
      </button>
    </main>
  )
}
