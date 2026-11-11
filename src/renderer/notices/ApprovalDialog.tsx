import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { allowClickCounts, ApprovalArm, approvalKey } from './approval-model'

/**
 * An in-page approval (design-web.md §9.6): a question only the owner may answer with Allow, in a
 * page where the owner may be typing to Claude when it appears (server mode's browsers, where every
 * signed-in device is the owner). Built so that neither keys typed for Claude nor a click already on
 * its way can approve:
 * - It takes no keyboard focus by itself (no autofocus, nothing behind it made inert): keys typed
 *   into a terminal keep going there, as with the desktop-confirm card (WebConfirmCard.tsx).
 * - Allow is never the default: no form, plain `type="button"` buttons, and inside the dialog Enter
 *   and Space do nothing (approval-model.ts `approvalKey`); Esc there is Deny.
 * - Allow is enabled only after the dialog has been visible for about a second (ApprovalArm), and a
 *   press begun before that does not count when it is released after (`allowClickCounts`).
 * - The backdrop blocks clicks to what is behind it but answers nothing: a click on its way to a
 *   terminal lands there and neither allows nor denies.
 */
export function ApprovalDialog(props: ApprovalDialogProps): React.JSX.Element {
  return createPortal(<ApprovalBox {...props} />, document.body)
}

export interface ApprovalDialogProps {
  title: ReactNode
  children: ReactNode
  /** Whether this view may Allow; false shows `note` in its place (a desktop-only approval in a browser). */
  canAllow: boolean
  note?: string
  allowLabel?: string
  onAnswer(allow: boolean): void
  /** Starts armed (unit tests of the markup only). */
  initiallyArmed?: boolean
}

/** The dialog itself (exported for its unit test, which renders it without a DOM). */
export function ApprovalBox(props: ApprovalDialogProps): React.JSX.Element {
  const { canAllow } = props
  const titleId = useId()
  const textId = useId()
  const [armed, setArmed] = useState(props.initiallyArmed === true)
  const answered = useRef(false)
  // How the last press on Allow began: armed or not (undefined: no press seen).
  const pressArmed = useRef<boolean | undefined>(undefined)
  const answer = (allow: boolean): void => {
    if (answered.current) return
    answered.current = true
    props.onAnswer(allow)
  }
  useEffect(() => {
    const arm = new ApprovalArm(setArmed)
    const onVisibility = (): void => arm.visible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      arm.dispose()
    }
  }, [])
  return (
    <div className="confirm-backdrop confirm-over-all" data-testid="approval-backdrop">
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onKeyDown={(e) => {
          const action = approvalKey(e.key)
          if (action === 'pass') return
          e.preventDefault()
          e.stopPropagation()
          if (action === 'deny') answer(false)
        }}
      >
        <h2 id={titleId} className="confirm-title">
          {props.title}
        </h2>
        <div id={textId}>{props.children}</div>
        <div className="confirm-buttons">
          {canAllow ? null : props.note !== undefined ? <span className="confirm-note">{props.note}</span> : null}
          <button type="button" onClick={() => answer(false)}>
            Deny
          </button>
          {canAllow ? (
            <button
              type="button"
              className="confirm-danger"
              disabled={!armed}
              onPointerDown={() => {
                pressArmed.current = armed
              }}
              onClick={() => {
                const counts = allowClickCounts(armed, pressArmed.current)
                pressArmed.current = undefined
                if (counts) answer(true)
              }}
            >
              {props.allowLabel ?? 'Allow'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
