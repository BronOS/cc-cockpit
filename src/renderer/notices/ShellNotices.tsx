import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isWebShell } from '../shell-kind'
import { addLinkAsk, canAllowLink, dropLinkAsk, linkNoticeUrl, type LinkAsk } from './notice-state'

/**
 * What the shell shows for things only the desktop can do, or that need the person's own screen
 * (design-web.md §6.1): a clickable notice for a link the host would have opened in its browser,
 * and the in-page confirm of `ccc plugin link`. Both come from main as events, so they work the
 * same in the Electron window and in the web shell.
 */
export function ShellNotices(): React.JSX.Element {
  return (
    <>
      <LinkNotice />
      <LinkConfirm />
    </>
  )
}

/**
 * `app.linkNotice`: a link a page or plugin asked to open. A browser cannot open a tab without a
 * click, and the host's browser is not this screen, so the link is shown to click. The last one only;
 * `noopener noreferrer` so the opened page learns nothing about this one.
 */
function LinkNotice(): React.JSX.Element | null {
  const [url, setUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    return window.cockpit.on('app.linkNotice', (p) => setUrl(linkNoticeUrl(p)))
  }, [])
  if (url === undefined) return null
  return (
    <div className="link-notice" role="status">
      <span className="link-notice-text">A link wants to open:</span>
      <a href={url} target="_blank" rel="noopener noreferrer" className="link-notice-link" onClick={() => setUrl(undefined)}>
        {url}
      </a>
      <button type="button" className="link-notice-close" aria-label="Dismiss" onClick={() => setUrl(undefined)}>
        ×
      </button>
    </div>
  )
}

/**
 * `links.ask`: the confirm of `ccc plugin link` while a browser view is attached. Every view of the
 * window shows it, the first answer wins and `links.settled` takes it down in the others. Deny has the
 * focus and is the Esc / backdrop answer, so Enter alone never links a plugin (as the native dialog).
 * Only the desktop may Allow (main refuses a remote Allow); a browser offers Deny and points to the desktop.
 */
function LinkConfirm(): React.JSX.Element | null {
  const [asks, setAsks] = useState<readonly LinkAsk[]>([])
  useEffect(() => {
    const offAsk = window.cockpit.on('links.ask', (ask) => setAsks((prev) => addLinkAsk(prev, ask)))
    const offSettled = window.cockpit.on('links.settled', ({ requestId }) => setAsks((prev) => dropLinkAsk(prev, requestId)))
    return () => {
      offAsk()
      offSettled()
    }
  }, [])
  const ask = asks[0]
  if (!ask) return null
  return (
    <LinkDialog
      key={ask.requestId}
      ask={ask}
      canAllow={canAllowLink(isWebShell())}
      onAnswer={(allow) => {
        setAsks((prev) => dropLinkAsk(prev, ask.requestId))
        window.cockpit.invoke('links.answer', { requestId: ask.requestId, allow }).catch(() => {})
      }}
    />
  )
}

function LinkDialog(props: { ask: LinkAsk; canAllow: boolean; onAnswer: (allow: boolean) => void }): React.JSX.Element {
  const { ask, canAllow } = props
  const deny = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const textId = useId()
  const answered = useRef(false)
  const answer = (allow: boolean): void => {
    if (answered.current) return
    answered.current = true
    props.onAnswer(allow)
  }
  // The Esc listener below is added once; it reaches the current props through this ref.
  const answerRef = useRef(answer)
  useEffect(() => {
    answerRef.current = answer
  })
  // Portalled out of #root, which goes inert meanwhile: nothing behind (a terminal) can take a key
  // typed while this is up, where a stray Enter or y could answer a Claude permission prompt. Esc is
  // heard on the document, not the dialog: a click on the dialog's text moves the focus to <body>,
  // where a keydown on the dialog would never fire. The focus #root had (a terminal) comes back when
  // the dialog goes, after #root is no longer inert (an inert element cannot take it).
  useEffect(() => {
    const root = document.getElementById('root')
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root?.setAttribute('inert', '')
    deny.current?.focus()
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
  return createPortal(
    <div className="confirm-backdrop confirm-over-all" onMouseDown={() => answer(false)}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* The id first: the name is the plugin's own text and could imitate a second parenthesis. */}
        <h2 id={titleId} className="confirm-title">
          Link plugin {ask.id} (named “{ask.name}”)?
        </h2>
        <p id={textId}>
          {ask.caller === 'tab'
            ? 'A "ccc plugin link" command in a tab of this window'
            : 'A "ccc plugin link" command run outside the app\'s tabs (naming this project with --project)'}{' '}
          asked to link the plugin in <code>{ask.path}</code>. A linked plugin runs with full access to the host computer, like any program
          you start, and stays until it is unlinked. Allow only a plugin you wrote or trust.
        </p>
        <div className="confirm-buttons">
          {canAllow ? null : <span className="confirm-note">Approve on the desktop</span>}
          <button type="button" ref={deny} onClick={() => answer(false)}>
            Deny
          </button>
          {canAllow ? (
            <button type="button" className="confirm-danger" onClick={() => answer(true)}>
              Allow
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  )
}
