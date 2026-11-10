import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { IpcEventMap } from '../../shared/ipc'

type LinkAsk = IpcEventMap['links.ask']

/** Only an http(s) address becomes a link (main checked it too: `app.linkNotice` is main's own event). */
function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

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
    return window.cockpit.on('app.linkNotice', (p) => setUrl(typeof p?.url === 'string' && isWebUrl(p.url) ? p.url : undefined))
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
 */
function LinkConfirm(): React.JSX.Element | null {
  const [asks, setAsks] = useState<LinkAsk[]>([])
  useEffect(() => {
    const offAsk = window.cockpit.on('links.ask', (ask) => {
      setAsks((prev) => (prev.some((a) => a.requestId === ask.requestId) ? prev : [...prev, ask]))
    })
    const offSettled = window.cockpit.on('links.settled', ({ requestId }) => {
      setAsks((prev) => prev.filter((a) => a.requestId !== requestId))
    })
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
      onAnswer={(allow) => {
        setAsks((prev) => prev.filter((a) => a.requestId !== ask.requestId))
        window.cockpit.invoke('links.answer', { requestId: ask.requestId, allow }).catch(() => {})
      }}
    />
  )
}

function LinkDialog(props: { ask: LinkAsk; onAnswer: (allow: boolean) => void }): React.JSX.Element {
  const { ask } = props
  const deny = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const textId = useId()
  // Portalled out of #root, which goes inert meanwhile: nothing behind (a terminal) can take a key
  // typed while this is up, where a stray Enter or y could answer a Claude permission prompt.
  useEffect(() => {
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    deny.current?.focus()
    return () => root?.removeAttribute('inert')
  }, [])
  const answered = useRef(false)
  const answer = (allow: boolean): void => {
    if (answered.current) return
    answered.current = true
    props.onAnswer(allow)
  }
  return createPortal(
    <div className="confirm-backdrop" onMouseDown={() => answer(false)}>
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
            answer(false)
          }
        }}
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
          <button type="button" ref={deny} onClick={() => answer(false)}>
            Deny
          </button>
          <button type="button" className="confirm-danger" onClick={() => answer(true)}>
            Allow
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
