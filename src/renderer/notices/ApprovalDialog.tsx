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
  allowLabel?: string
  /** The other button's label; default Deny. */
  denyLabel?: string
  onAnswer(allow: boolean): void
}

/** The dialog itself (exported for its unit test, which renders it without a DOM). */
export function ApprovalBox(props: ApprovalDialogProps): React.JSX.Element {
  const titleId = useId()
  const textId = useId()
  const [armed, setArmed] = useState(false)
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
    // Visible and focused: a visible but unfocused window (behind another one) would otherwise arm,
    // and the click that focuses it could land on Allow.
    const onVisibility = (): void => arm.visible(document.visibilityState === 'visible' && document.hasFocus())
    // A `blur` is read after the focus has settled: one that only moves the focus into a frame of the
    // page (a plugin panel) leaves `hasFocus()` true, and the arm ignores an unchanged state.
    let blurCheck: ReturnType<typeof setTimeout> | undefined
    const onBlur = (): void => {
      clearTimeout(blurCheck)
      blurCheck = setTimeout(onVisibility, 0)
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onVisibility)
    window.addEventListener('blur', onBlur)
    onVisibility()
    return () => {
      clearTimeout(blurCheck)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onVisibility)
      window.removeEventListener('blur', onBlur)
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
        // Recorded on the dialog, not on Allow: a disabled button may get no pointer events, and a
        // press begun while disarmed must never read as "no press seen".
        onPointerDownCapture={() => {
          pressArmed.current = armed
        }}
        // Space presses a focused button on keyup (and Firefox clicks after a keydown-only block).
        onKeyUp={(e) => {
          if (approvalKey(e.key) === 'block') {
            e.preventDefault()
            e.stopPropagation()
          }
        }}
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
          <button type="button" onClick={() => answer(false)}>
            {props.denyLabel ?? 'Deny'}
          </button>
          <button
            type="button"
            className="confirm-danger"
            disabled={!armed}
            onClick={() => {
              const counts = allowClickCounts(armed, pressArmed.current)
              pressArmed.current = undefined
              if (counts) answer(true)
            }}
          >
            {props.allowLabel ?? 'Allow'}
          </button>
        </div>
      </div>
    </div>
  )
}
