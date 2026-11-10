import { useEffect, useState } from 'react'
import type { WindowInfo } from '../shared/ipc'
import { ProjectPicker } from './picker/ProjectPicker'
import { currentShellChrome } from './shell-kind'
import { startSeeThrough } from './theme/apply-see-through'
import { TabsPane } from './tabs/TabsPane'

/**
 * Every window loads the same page; main says which one this is (picker or which project). The
 * renderer never decides that from its URL or anything else it could be handed.
 */
export function App(): React.JSX.Element {
  const [info, setInfo] = useState<WindowInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // main's word on this window's project after it changed (its colour, set here or anywhere):
    // only the project part moves, and only in a project window (a picker is never sent one).
    const off = window.cockpit.on('project.updated', (project) => {
      setInfo((prev) => (prev?.kind === 'project' ? { ...prev, project } : prev))
    })
    window.cockpit
      .invoke('window.info')
      .then((next) => {
        // Before the shell renders: its tab terminals pick their palette when they are made.
        // Never in the web shell: the glass is the desktop window's (shell-kind.ts).
        if (next.kind === 'project' && next.transparent === true && currentShellChrome().seeThrough) startSeeThrough()
        setInfo(next)
      })
      .catch((err: unknown) => setError(String(err)))
    return off
  }, [])

  if (error) return <main role="alert">{error}</main>
  if (!info) return <main />
  if (info.kind === 'picker') return <ProjectPicker info={info} />
  // TabsPane hosts the terminal tabs, the zones with plugin panels, the overlay stack and the
  // settings overlay.
  return <TabsPane project={info.project} fullScreen={info.fullScreen === true} />
}
