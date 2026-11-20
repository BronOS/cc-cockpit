import { useEffect, useState } from 'react'
import { ipcErrorMessage } from '../ipc-error'
import { copyText } from '../guests/copy-text'
import { ApprovalArm } from '../notices/approval-model'

// The parts the "Claude Code was not found" dialog (ClaudeOfferDialog) and Settings › Claude Code share:
// a command line with Copy, and the armed "Install in a new tab" button. Every text comes from main's
// view (main/hooks/claude-offer.ts); the button sends only the intent (`claude.install`).

/** One command, in monospace and selectable, with its Copy button (Copied for a moment), as the picker's. */
export function CommandLine(props: { text: string; label: string; testId: string }): React.JSX.Element {
  const [copied, setCopied] = useState<boolean | null>(null)
  useEffect(() => {
    if (copied === null) return
    const timer = setTimeout(() => setCopied(null), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className="connect-command">
      <code data-testid={props.testId}>{props.text}</code>
      <button type="button" className="picker-quiet" aria-label={`Copy ${props.label}`} onClick={() => setCopied(copyText(props.text))}>
        {copied === true ? 'Copied' : copied === false ? 'Select it to copy' : 'Copy'}
      </button>
    </div>
  )
}

/**
 * True once the page has been visible and focused for about a second (ApprovalArm, as ApprovalDialog's
 * Allow): the installer runs `curl … | bash` on the host (on a server, the server), and in a browser this
 * dialog pops up unasked as the page loads, so a click on its way to the page must not land on it.
 */
export function useArmedAfterVisible(): boolean {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const arm = new ApprovalArm(setArmed)
    const update = (): void => arm.visible(document.visibilityState === 'visible' && document.hasFocus())
    // A `blur` is read after the focus settled: one that only moves into a frame of the page keeps hasFocus().
    let blurCheck: ReturnType<typeof setTimeout> | undefined
    const onBlur = (): void => {
      clearTimeout(blurCheck)
      blurCheck = setTimeout(update, 0)
    }
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', onBlur)
    update()
    return () => {
      clearTimeout(blurCheck)
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', onBlur)
      arm.dispose()
    }
  }, [])
  return armed
}

/**
 * "Install in a new tab": asks main to open its installer tab (`claude.install`, the intent alone). Disabled
 * until armed and while the call runs; `before` runs first (the dialog's "Don't ask again"), `onOpened`
 * after the tab opened, `onError` with the refusal's text.
 */
export function InstallInTabButton(props: {
  disabled?: boolean
  before?: () => Promise<unknown>
  onOpened: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const armed = useArmedAfterVisible()
  const [busy, setBusy] = useState(false)
  const install = (): void => {
    if (busy || !armed) return
    setBusy(true)
    void (props.before?.() ?? Promise.resolve())
      .then(() => window.cockpit.invoke('claude.install'))
      .then(
        () => props.onOpened(),
        (err: unknown) => props.onError(ipcErrorMessage(err))
      )
      .finally(() => setBusy(false))
  }
  return (
    <button type="button" disabled={props.disabled === true || busy || !armed} onClick={install}>
      Install in a new tab
    </button>
  )
}
