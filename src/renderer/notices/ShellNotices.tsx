import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isServerView, isWebShell } from '../shell-kind'
import { ApprovalDialog } from './ApprovalDialog'
import {
  addLinkAsk,
  addSharedAsk,
  canAllowLink,
  dropLinkAsk,
  dropSharedAsk,
  dropUnseen,
  linkNoticeAction,
  noteUnseen,
  titleWithMark,
  type LinkAsk,
  type PageNotice,
  type TrashAsk
} from './notice-state'

/**
 * What the shell shows for things only the desktop can do, or that need the person's own screen
 * (design-web.md §6.1): a clickable notice for a link the host would have opened in its browser,
 * the in-page confirm of `ccc plugin link`, the in-page Move to Trash confirm and a server's in-page
 * notifications. All come from main as events, so they work the same in the Electron window and in
 * the web shell.
 */
export function ShellNotices(): React.JSX.Element {
  return (
    <>
      <LinkNotice />
      <LinkConfirm />
      <TrashConfirm />
      <PageNotices />
    </>
  )
}

/**
 * `notices.show`: a plugin's ctx.notify or a `ccc notify` in server mode (design-web.md §9.9; main
 * sends them to browser views only, so the hidden page and the desktop never draw one). Shared like an
 * ask: the action button or the ✕ in any view ends the notice for all (`notices.gone`), main deciding
 * by the window it bound this view to. The texts are plain text (React escapes them). Nothing here
 * takes the keyboard focus: a key typed for Claude stays in the terminal. While some came with the tab
 * in the background, the tab's title counts them (titleWithMark).
 */
function PageNotices(): React.JSX.Element | null {
  const [notices, setNotices] = useState<readonly PageNotice[]>([])
  const [unseen, setUnseen] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    const offShow = window.cockpit.on('notices.show', (notice) => {
      setNotices((prev) => addSharedAsk(prev, notice))
      setUnseen((prev) => noteUnseen(prev, notice.requestId, document.visibilityState === 'hidden'))
    })
    const offGone = window.cockpit.on('notices.gone', ({ requestId }) => {
      setNotices((prev) => dropSharedAsk(prev, requestId))
      setUnseen((prev) => dropUnseen(prev, requestId))
    })
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') setUnseen((prev) => (prev.size === 0 ? prev : new Set()))
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      offShow()
      offGone()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
  // The page's own title, read once: the mark is put on and taken off around it.
  const baseTitle = useRef(document.title)
  useEffect(() => {
    document.title = titleWithMark(baseTitle.current, unseen.size)
  }, [unseen])
  useEffect(() => {
    const base = baseTitle.current
    return () => {
      document.title = base
    }
  }, [])
  if (notices.length === 0) return null
  const end = (notice: PageNotice, channel: 'notices.click' | 'notices.dismiss'): void => {
    setNotices((prev) => dropSharedAsk(prev, notice.requestId))
    setUnseen((prev) => dropUnseen(prev, notice.requestId))
    window.cockpit.invoke(channel, { requestId: notice.requestId }).catch(() => {})
  }
  return (
    <section className="page-notices" aria-label="Notifications">
      {notices.map((notice) => (
        <div key={notice.requestId} className="page-notice" role="status" data-testid="page-notice">
          <div className="page-notice-body">
            <strong className="page-notice-title">{notice.title}</strong>
            <p className="page-notice-text">{notice.text}</p>
          </div>
          {notice.action !== undefined ? (
            <button type="button" className="page-notice-action" onClick={() => end(notice, 'notices.click')}>
              {notice.action}
            </button>
          ) : null}
          <button type="button" className="page-notice-close" aria-label="Dismiss notification" onClick={() => end(notice, 'notices.dismiss')}>
            ×
          </button>
        </div>
      ))}
    </section>
  )
}

/**
 * `app.linkNotice`: a link a page or plugin asked to open, in a browser view (the host's browser is
 * not this screen). While the click that asked for it still counts as the person's (transient
 * activation, linkNoticeAction) the link opens in a new tab at once; otherwise a browser would block
 * the tab, so the link is shown to click. One open per event, never retried. The last notice only;
 * `noopener noreferrer` so the opened page learns nothing about this one.
 */
function LinkNotice(): React.JSX.Element | null {
  const [url, setUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    return window.cockpit.on('app.linkNotice', (p) => {
      const action = linkNoticeAction(p, {
        webShell: isWebShell(),
        // Absent in an older browser: no way to know, so the notice.
        activationActive: navigator.userActivation?.isActive === true
      })
      if (action.kind === 'none') return
      if (action.kind === 'open') {
        try {
          // Null even on success with noopener; activation was checked above, a throw is the one failure seen here.
          window.open(action.url, '_blank', 'noopener,noreferrer')
          return
        } catch {
          // Fall through to the notice.
        }
      }
      setUrl(action.url)
    })
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
 * On the desktop only the desktop may Allow (main refuses a remote Allow); a browser offers Deny and
 * points to the desktop. A server's browser views are the owner (design-web.md §9.6): they get the
 * guarded ApprovalDialog, which takes no focus and arms Allow after a second, with Allow offered.
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
  const onAnswer = (allow: boolean): void => {
    setAsks((prev) => dropLinkAsk(prev, ask.requestId))
    window.cockpit.invoke('links.answer', { requestId: ask.requestId, allow }).catch(() => {})
  }
  if (isServerView()) {
    return (
      <ApprovalDialog key={ask.requestId} title={<LinkAskTitle ask={ask} />} canAllow={canAllowLink(true, true)} onAnswer={onAnswer}>
        <LinkAskText ask={ask} />
      </ApprovalDialog>
    )
  }
  return <LinkDialog key={ask.requestId} ask={ask} canAllow={canAllowLink(isWebShell())} onAnswer={onAnswer} />
}

/**
 * `trash.ask`: ctx.files.trash's confirm (main/files/trash-asks.ts) in server mode, or on the desktop
 * while a browser view is attached. Every view of the window shows it, the first answer wins and
 * `trash.settled` takes it down in the others; any view may answer. The guarded ApprovalDialog
 * everywhere: it takes no focus from a terminal and arms Move a second after it is seen, so neither a
 * key typed for Claude nor a click on its way moves anything. The path and the plugin id are plain
 * text (React escapes them; main made them display-safe).
 */
function TrashConfirm(): React.JSX.Element | null {
  const [asks, setAsks] = useState<readonly TrashAsk[]>([])
  useEffect(() => {
    const offAsk = window.cockpit.on('trash.ask', (ask) => setAsks((prev) => addSharedAsk(prev, ask)))
    const offSettled = window.cockpit.on('trash.settled', ({ requestId }) => setAsks((prev) => dropSharedAsk(prev, requestId)))
    return () => {
      offAsk()
      offSettled()
    }
  }, [])
  const ask = asks[0]
  if (!ask) return null
  const onAnswer = (move: boolean): void => {
    setAsks((prev) => dropSharedAsk(prev, ask.requestId))
    window.cockpit.invoke('trash.answer', { requestId: ask.requestId, move }).catch(() => {})
  }
  return (
    <ApprovalDialog
      key={ask.requestId}
      title={<TrashAskTitle ask={ask} />}
      canAllow
      allowLabel="Move to Trash"
      denyLabel="Cancel"
      onAnswer={onAnswer}
    >
      <TrashAskText ask={ask} />
    </ApprovalDialog>
  )
}

export function TrashAskTitle({ ask }: { ask: TrashAsk }): React.JSX.Element {
  return (
    <>
      Move the {ask.kind === 'folder' ? 'folder' : 'file'} <code>{ask.path}</code> to the Trash?
    </>
  )
}

export function TrashAskText({ ask }: { ask: TrashAsk }): React.JSX.Element {
  return (
    <p>
      The plugin <code>{ask.pluginId}</code> asked to move it{ask.kind === 'folder' ? ', with everything in it' : ''}. It can be restored
      from the Trash on the host.
    </p>
  )
}

/** The id first: the name is the plugin's own text and could imitate a second parenthesis. */
function LinkAskTitle({ ask }: { ask: LinkAsk }): React.JSX.Element {
  return (
    <>
      Link plugin {ask.id} (named “{ask.name}”)?
    </>
  )
}

function LinkAskText({ ask }: { ask: LinkAsk }): React.JSX.Element {
  return (
    <p>
      {ask.caller === 'tab'
        ? 'A "ccc plugin link" command in a tab of this window'
        : 'A "ccc plugin link" command run outside the app\'s tabs (naming this project with --project)'}{' '}
      asked to link the plugin in <code>{ask.path}</code>. A linked plugin runs with full access to the host computer, like any program
      you start, and stays until it is unlinked. Allow only a plugin you wrote or trust.
    </p>
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
        <h2 id={titleId} className="confirm-title">
          <LinkAskTitle ask={ask} />
        </h2>
        <div id={textId}>
          <LinkAskText ask={ask} />
        </div>
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
