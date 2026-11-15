import { useEffect, useId, useRef, useState } from 'react'
import { ApprovalDialog } from '../notices/ApprovalDialog'
import { closeQuestionText, type CloseQuestion } from './close-confirm'

/**
 * "Close <tab>?" before a user's close of a tab that is still running, or of a page tab with unsaved
 * changes in any view (close-confirm.ts decides when; server mode's browsers ask the latter with
 * CloseTabApproval instead). A modal of the renderer's own, like the palette: TabsPane makes the strip and the zones
 * inert while it is shown and its key handler runs no command meanwhile, so no key typed here can
 * reach a terminal (where a stray Enter or y could answer a Claude permission prompt).
 *
 * Cancel has the focus, so Enter alone keeps the tab (the safe answer); Tab to Close, then Enter,
 * or a click, closes it. Esc and a click outside cancel. "Don't ask again" turns the setting off
 * together with Close (closeAnswer).
 */
export function CloseTabDialog(props: {
  question: CloseQuestion
  onAnswer: (choice: 'close' | 'cancel', dontAskAgain: boolean) => void
}): React.JSX.Element {
  const [dontAsk, setDontAsk] = useState(false)
  const cancel = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const textId = useId()
  const groupUnsaved = (props.question.group?.unsaved.length ?? 0) > 0

  // Take the keyboard from the terminal behind (it is inert now, but it held the focus).
  useEffect(() => cancel.current?.focus(), [])

  // Answer once: a click and the key that follows it (or Esc on a pressed button) can both land.
  const answered = useRef(false)
  const answer = (choice: 'close' | 'cancel'): void => {
    if (answered.current) return
    answered.current = true
    props.onAnswer(choice, dontAsk)
  }

  return (
    <div className="confirm-backdrop" onMouseDown={() => answer('cancel')}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            answer('cancel')
          }
        }}
      >
        <h2 id={titleId} className="confirm-title">
          {props.question.group ? `Close all tabs of “${props.question.title}”?` : `Close “${props.question.title}”?`}
        </h2>
        <p id={textId}>{closeQuestionText(props.question)}</p>
        {props.question.group && (
          <ul className="confirm-list">
            {props.question.group.running.map((r, i) => (
              <li key={i}>
                {r.title}
                {r.status ? ` (Claude is ${r.status})` : ''}
              </li>
            ))}
            {props.question.group.unsavedTitles.map((t, i) => (
              <li key={`u${i}`}>{t} (unsaved changes)</li>
            ))}
          </ul>
        )}
        {/* The setting is about running processes; unsaved text always asks (close-confirm.ts). A group
            question with unsaved members has no "Don't ask again" either: it would not stop that ask. */}
        {!props.question.unsaved && !groupUnsaved && (
          <label className="confirm-check">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
            {" Don't ask again"}
          </label>
        )}
        <div className="confirm-buttons">
          <button type="button" ref={cancel} onClick={() => answer('cancel')}>
            Cancel
          </button>
          <button type="button" className="confirm-danger" onClick={() => answer('close')}>
            {/* Close all discards a group's unsaved members too, so it says so (as CloseTabApproval does). */}
            {props.question.unsaved
              ? 'Discard and Close'
              : props.question.group
                ? groupUnsaved
                  ? 'Discard and Close all'
                  : 'Close all'
                : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The unsaved-changes ask in server mode's browsers (design-editor.md §1: an ApprovalDialog there):
 * every signed-in device is the owner and may be typing to Claude when it shows, so the discard is
 * never the default, is not reached by typing, and is live only after a second (ApprovalDialog).
 */
export function CloseTabApproval(props: { question: CloseQuestion; onAnswer: (choice: 'close' | 'cancel') => void }): React.JSX.Element {
  const group = props.question.group
  return (
    <ApprovalDialog
      title={group ? <>Close all tabs of “{props.question.title}”?</> : <>Close “{props.question.title}”?</>}
      allowLabel={group ? 'Discard and Close all' : 'Discard and Close'}
      denyLabel="Cancel"
      onAnswer={(allow) => props.onAnswer(allow ? 'close' : 'cancel')}
    >
      <p>{closeQuestionText(props.question)}</p>
      {group && (
        <ul className="confirm-list">
          {group.running.map((r, i) => (
            <li key={i}>
              {r.title}
              {r.status ? ` (Claude is ${r.status})` : ''}
            </li>
          ))}
          {group.unsavedTitles.map((t, i) => (
            <li key={`u${i}`}>{t} (unsaved changes)</li>
          ))}
        </ul>
      )}
    </ApprovalDialog>
  )
}
