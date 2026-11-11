import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WebAccessRisk } from '../../shared/types'
import { WEB_RISK_TEXT } from '../../shared/web-access'

/**
 * The §4.3 confirm of a dangerous web access choice (design-web.md): no sign-in on a network
 * address, or plain http on one. Main refused the change with `needsConfirm`, nothing is saved yet;
 * this says in plain words what the choice means, one risk at a time (the worse one first), and only
 * when every one is accepted does the page send the change again with `confirm`. Cancel, Esc or a
 * click outside at any step leaves every setting as it was (a loopback bind stays loopback).
 *
 * Cancel has the focus, so Enter alone never takes the risk. Portalled out of #root, which goes inert
 * meanwhile (as the link confirm, ShellNotices.tsx): no key reaches the settings page or a terminal
 * behind it. The texts are WEB_RISK_TEXT, the one copy main's badge uses too.
 */
export function RiskConfirmDialog(props: { risks: readonly WebAccessRisk[]; onAnswer: (accepted: boolean) => void }): React.JSX.Element | null {
  const [step, setStep] = useState(0)
  const cancel = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const textId = useId()
  const answered = useRef(false)
  const answer = (accepted: boolean): void => {
    if (answered.current) return
    answered.current = true
    props.onAnswer(accepted)
  }
  const answerRef = useRef(answer)
  useEffect(() => {
    answerRef.current = answer
  })
  useEffect(() => {
    const root = document.getElementById('root')
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root?.setAttribute('inert', '')
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      answerRef.current(false)
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      root?.removeAttribute('inert')
      if (before?.isConnected && root?.contains(before)) before.focus()
    }
  }, [])
  // Every step starts on Cancel: accepting the first risk must not leave the focus on the button
  // that accepts the second.
  useEffect(() => cancel.current?.focus(), [step])
  const risk = props.risks[step]
  if (risk === undefined) return null
  const text = WEB_RISK_TEXT[risk]
  const last = step === props.risks.length - 1
  return createPortal(
    <div className="confirm-backdrop" onMouseDown={() => answer(false)}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        data-testid="web-access-risk-confirm"
        data-risk={risk}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="confirm-title">
          {text.title}
        </h2>
        <div id={textId}>
          {text.paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
        <div className="confirm-buttons">
          {props.risks.length > 1 && (
            <span className="confirm-note">
              {step + 1} of {props.risks.length}
            </span>
          )}
          <button type="button" ref={cancel} onClick={() => answer(false)}>
            Cancel
          </button>
          <button type="button" className="confirm-danger" onClick={() => (last ? answer(true) : setStep(step + 1))}>
            {text.accept}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
