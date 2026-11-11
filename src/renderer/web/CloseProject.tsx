import { useState } from 'react'
import { ipcErrorMessage } from '../ipc-error'
import { ApprovalDialog } from '../notices/ApprovalDialog'
import { CloseGlyph } from '../window-icons'

/**
 * Close project in a server's browser shell (design-web.md §9.8; TopStrip draws it only there,
 * shell-kind.ts `isServerView`). The close is for every device and ends the project's tabs, so it
 * asks first, in this view only, with the in-page approval (ApprovalDialog: never the default, not
 * reached by typing, live after a second), then calls `projects.close`, which names no project: main
 * closes the window it bound this view to. Every view of the project, this one included, then goes
 * back to the project list (web/main.tsx, bridge.ts `backToPicker`).
 */
export function CloseProjectButton({ name }: { name: string }): React.JSX.Element {
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const onAnswer = (close: boolean): void => {
    setAsking(false)
    if (!close) return
    window.cockpit.invoke('projects.close').catch((err: unknown) => setError(ipcErrorMessage(err)))
  }
  return (
    <>
      {error !== undefined && (
        <span role="alert" className="close-project-error" title={error}>
          Close failed: {error}
        </span>
      )}
      <button
        type="button"
        className="strip-close-project icon-button"
        aria-label="Close project"
        title="Close project"
        onClick={() => {
          setError(undefined)
          setAsking(true)
        }}
      >
        <CloseGlyph />
      </button>
      {asking && (
        <ApprovalDialog title={<CloseProjectTitle name={name} />} allowLabel="Close project" denyLabel="Cancel" onAnswer={onAnswer}>
          <p>Its tabs end.</p>
        </ApprovalDialog>
      )}
    </>
  )
}

/** The question, the project's name as plain text (React escapes it; it is the folder's name). */
export function CloseProjectTitle({ name }: { name: string }): React.JSX.Element {
  return <>Close {name} for every device?</>
}
