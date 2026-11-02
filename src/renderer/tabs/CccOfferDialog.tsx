import { useEffect, useId, useRef, useState } from 'react'
import type { CccCommandView } from '../../shared/ipc'
import { ipcErrorMessage } from '../ipc-error'

/**
 * "Install the ccc command?" at start-up, when `~/.local/bin/ccc` is missing (main decides, once
 * per launch: main/hooks/ccc-offer.ts). Built like CloseTabDialog and shown by TabsPane the same
 * way (zones inert, shell layer up so a webview panel cannot paint over it, no key reaches a
 * terminal): "No" has the focus, so Enter alone declines; Esc and a click outside decline too.
 *
 * Yes runs the Settings button's install (`settings.cccInstall`) and the dialog then shows the
 * outcome in place of the question: the result, the "not on your PATH" hint the Settings row has,
 * or the error. "Don't ask again" is saved (`settings.cccOfferSet`) on either answer.
 */
export function CccOfferDialog(props: { view: CccCommandView; onDone: () => void }): React.JSX.Element {
  const [dontAsk, setDontAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ view?: CccCommandView; error?: string } | null>(null)
  const first = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const textId = useId()

  // Take the keyboard from the terminal behind (it is inert now, but it held the focus); again
  // when the result replaces the buttons.
  useEffect(() => first.current?.focus(), [result])

  const saveDontAsk = (): Promise<unknown> =>
    dontAsk ? window.cockpit.invoke('settings.cccOfferSet', { value: false }).catch(() => undefined) : Promise.resolve()

  const decline = (): void => {
    if (busy) return
    void saveDontAsk().then(props.onDone)
  }

  const install = (): void => {
    if (busy) return
    setBusy(true)
    void saveDontAsk()
      .then(() => window.cockpit.invoke('settings.cccInstall'))
      .then(
        (view) => setResult({ view }),
        (err: unknown) => setResult({ error: ipcErrorMessage(err) })
      )
      .finally(() => setBusy(false))
  }

  const done = result !== null
  return (
    <div className="confirm-backdrop" onMouseDown={done ? props.onDone : decline}>
      <div
        className="confirm-dialog"
        data-testid="ccc-offer"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            if (done) props.onDone()
            else decline()
          }
        }}
      >
        <h2 id={titleId} className="confirm-title">
          {done ? (result.error ? 'Could not install ccc' : 'ccc is installed') : 'Install the ccc command?'}
        </h2>
        {!done && (
          <>
            <p id={textId}>
              Claude in your tabs, plugins and scripts use <code>ccc</code> to talk to this app. This links{' '}
              {props.view.linkPath} to the app&apos;s launcher.
            </p>
            <label className="confirm-check">
              <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
              {" Don't ask again"}
            </label>
            <div className="confirm-buttons">
              <button type="button" ref={first} disabled={busy} onClick={decline}>
                No
              </button>
              <button type="button" disabled={busy} onClick={install}>
                Yes
              </button>
            </div>
          </>
        )}
        {done && (
          <>
            <p id={textId} role={result.error ? 'alert' : 'status'}>
              {result.error ??
                (result.view && !result.view.onPath
                  ? `Linked ${result.view.linkPath}. ${result.view.binDir} is not on your shell's PATH; add it to use ccc there.`
                  : `Linked ${result.view?.linkPath ?? ''}.`)}
            </p>
            <div className="confirm-buttons">
              <button type="button" ref={first} onClick={props.onDone}>
                OK
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
