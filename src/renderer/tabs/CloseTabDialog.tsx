import { useEffect, useId, useRef, useState } from 'react'
import { closeQuestionText, type CloseQuestion } from './close-confirm'

/**
 * "Close <tab>?" before a user's close of a tab that is still running (close-confirm.ts decides
 * when). A modal of the renderer's own, like the palette: TabsPane makes the strip and the zones
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
          Close “{props.question.title}”?
        </h2>
        <p id={textId}>{closeQuestionText(props.question)}</p>
        <label className="confirm-check">
          <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
          {" Don't ask again"}
        </label>
        <div className="confirm-buttons">
          <button type="button" ref={cancel} onClick={() => answer('cancel')}>
            Cancel
          </button>
          <button type="button" className="confirm-danger" onClick={() => answer('close')}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
