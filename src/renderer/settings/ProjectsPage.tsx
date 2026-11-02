import { useState } from 'react'
import type { SettingsProject } from '../../shared/ipc'
import { FolderIcon } from './icons'
import { Empty, PageHeader } from './ui'
import { useAction } from './use-action'
import { useLoaded } from './use-loaded'

const loadProjects = (): Promise<SettingsProject[]> => window.cockpit.invoke('settings.projects')

/**
 * Settings › Projects: every project main knows. Open (or focus) one, point a project whose
 * folder moved at the new place, or forget one. A project with a window can be neither relinked
 * nor removed (main refuses; the buttons are not offered): close its window first.
 */
export function ProjectsPage(): React.JSX.Element {
  const { data, error: loadError, reload } = useLoaded(loadProjects)
  const { busy, error, run } = useAction()
  // The project whose Remove awaits its confirmation.
  const [confirming, setConfirming] = useState<string | null>(null)

  const act = (label: string, fn: () => Promise<unknown>): void => {
    void run(label, fn).then(reload)
  }

  return (
    <section aria-label="Projects">
      <PageHeader
        title="Projects"
        description="Every folder opened as a project. Close a project's window to relink or remove it."
      />
      {(error ?? loadError) && <p role="alert" className="settings-alert">{error ?? loadError}</p>}
      {data === null ? null : data.length === 0 ? (
        <div className="settings-card">
          <Empty>No projects yet. Use File › Open Folder.</Empty>
        </div>
      ) : (
        <ul className="settings-card settings-list">
          {data.map((p) => (
            <li key={p.id} className={p.missing ? 'settings-item missing' : 'settings-item'} data-project={p.name}>
              <FolderIcon className="settings-item-glyph" />
              <div className="settings-item-main">
                <div className="settings-item-title">
                  {p.name}
                  {p.open && <span className="settings-badge accent">open</span>}
                  {p.missing && <span className="settings-badge warn">folder missing</span>}
                </div>
                <div className="settings-item-meta">{p.path}</div>
              </div>
              <div className="settings-item-actions">
                {confirming === p.id && !p.open ? (
                  <>
                    <span className="settings-confirm">Forget its settings and saved tabs?</span>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy !== null}
                      onClick={() => {
                        setConfirming(null)
                        act('remove', () => window.cockpit.invoke('settings.projectRemove', { id: p.id }))
                      }}
                    >
                      Yes, remove
                    </button>
                    <button type="button" className="quiet" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={busy !== null || p.missing}
                      onClick={() => act('open', () => window.cockpit.invoke('settings.projectOpen', { id: p.id }))}
                    >
                      Open
                    </button>
                    {p.missing && !p.open && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          act('relink', () => window.cockpit.invoke('settings.projectRelink', { id: p.id }))
                        }
                      >
                        Relink…
                      </button>
                    )}
                    {!p.open && (
                      <button type="button" className="quiet" disabled={busy !== null} onClick={() => setConfirming(p.id)}>
                        Remove
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
