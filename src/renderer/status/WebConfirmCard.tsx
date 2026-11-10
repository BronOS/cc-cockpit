import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WebConfirmAsk } from '../../shared/web-access'
import { confirmCodeReady, confirmLeft } from '../settings/web-access-model'

/**
 * A browser asking to sign in by desktop confirm (design-web.md §4.2): every desktop window shows this
 * card while the request waits, and the first answer takes it down everywhere (`webAccess.changed`).
 *
 * Built so nothing but a deliberate act lets a browser in:
 * - Non-modal: a card over the corner of the window, not a dialog. The person may be typing to Claude
 *   when it appears; nothing is focused for them (no autofocus), so their keystrokes keep going where
 *   they were going, and nothing behind it is blocked.
 * - No default button and no form: Enter in the code field does nothing, and both buttons are plain
 *   `type="button"`, so no key press alone answers it.
 * - The person types the code the browser shows; this card never knows it (main keeps it), so a
 *   request from someone else, made at the same moment, cannot be allowed by clicking through.
 * - The name is the requester's own text: shown as plain text, in quotes, and said to be so.
 */
export function WebConfirmCard(props: { ask: WebConfirmAsk }): React.JSX.Element {
  // Out of the top bar: a fixed card must not be clipped or offset by the bar's own layout.
  return createPortal(<WebConfirmPanel key={props.ask.id} ask={props.ask} />, document.body)
}

/** The card itself (exported for its unit test, which renders it without a DOM). */
export function WebConfirmPanel(props: { ask: WebConfirmAsk }): React.JSX.Element | null {
  const { ask } = props
  const id = useId()
  const [code, setCode] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const left = confirmLeft(ask, now)
  // Lapsed: main drops it too (and says so with webAccess.changed); hide it at once meanwhile.
  if (left === '') return null
  const answer = (allow: boolean): void => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    window.cockpit.invoke('webAccess.confirmAnswer', allow ? { id: ask.id, allow, code } : { id: ask.id, allow }).then(
      (reply) => {
        setBusy(false)
        if (!reply.ok) setProblem(reply.reason)
      },
      () => {
        setBusy(false)
        setProblem('The answer did not reach the app.')
      }
    )
  }
  return (
    <section className="web-confirm-card" role="region" aria-labelledby={`${id}-title`} data-testid="web-confirm-card">
      <h2 id={`${id}-title`} className="web-confirm-title">
        A browser asks to control cc-cockpit
      </h2>
      <p className="web-confirm-text">
        It calls itself <q className="web-confirm-name">{ask.name}</q> (its own words, not checked). Allowed, it can read and
        type in your terminals and run Claude, as if at this desk.
      </p>
      <label className="web-confirm-text" htmlFor={`${id}-code`}>
        If this is you, type the code that browser shows:
      </label>
      <div className="web-confirm-row">
        <input
          id={`${id}-code`}
          className="web-confirm-code"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          maxLength={16}
          value={code}
          disabled={busy}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            // Never an answer by key: no form submits it, and this keeps a browser default from trying.
            if (e.key === 'Enter') e.preventDefault()
          }}
        />
        <button type="button" className="danger" disabled={busy} onClick={() => answer(false)}>
          Deny
        </button>
        <button type="button" disabled={busy || !confirmCodeReady(code)} onClick={() => answer(true)}>
          Allow
        </button>
      </div>
      {problem !== null && (
        <p role="alert" className="web-confirm-problem">
          {problem}
        </p>
      )}
      <p className="web-confirm-meta">Expires in {left}. Not you? Deny it.</p>
    </section>
  )
}
