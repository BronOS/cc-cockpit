// Ask Claude from a page tab (design-editor.md §4 "Ask Claude"): core's question box, drawn by the
// shell over the tab when its page asks (`ccPanel.tab.discuss()`, the editor's Ctrl+L or context menu).
// The person types a question and picks where it goes: the Claude tab they used last in this view
// (preselected), another Claude tab of the window, or a new session. Send asks main
// (`pageTabs.discuss`), which gets the context from the plugin's `onDiscuss` in this view, composes
// `About: <title>`, the context and the question, and sends it as the person's own text through the
// send gate (typed now when that tab waits for input, else queued), then selects that Claude tab. An
// error comes back as text and is shown here, nothing sent.
//
// A modal of the renderer's own, like the close dialog: TabsPane makes the strip, the zones and the
// page tab layer inert while it is up and runs no command meanwhile. Keys: Ctrl/Cmd+Enter sends from
// the question field, Esc or a click outside cancels.
import { useEffect, useId, useRef, useState } from 'react'
import { MAX_DISCUSS_QUESTION, preselectDiscussTarget } from '../../shared/discuss'
import type { DiscussAnswer, TabInfo } from '../../shared/ipc'
import { ipcErrorMessage } from '../ipc-error'
import { discussReadiness, discussRowMeta, orderDiscussTabs, type DiscussTab } from '../overlays/discuss-tabs'
import { statusText } from '../status/strip-order'
import { tabLabel } from './tab-label'

/** The select's value for a new session (a tab id is a UUID, never this). */
const NEW_SESSION = 'new'

export function PageTabDiscussDialog(props: {
  /** The page tab asked about. */
  tab: TabInfo
  /** This window's Claude tabs, in tab order (discussTabsOf). */
  claudeTabs: readonly DiscussTab[]
  /** The Claude tab this view showed last, when the box opened. */
  lastClaudeTabId?: string
  onClose: () => void
}): React.JSX.Element {
  const pre = preselectDiscussTarget(props.claudeTabs, props.lastClaudeTabId, undefined)
  const preTab = pre.kind === 'tab' ? props.claudeTabs.find((t) => t.tabId === pre.tabId) : undefined
  // A tab that would not take the text (idle) is listed but not picked for the person.
  const initial = preTab && discussReadiness(preTab) !== 'not-ready' ? preTab.tabId : NEW_SESSION
  const [question, setQuestion] = useState('')
  const [target, setTarget] = useState(initial)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const titleId = useId()
  const ordered = orderDiscussTabs(props.claudeTabs, initial === NEW_SESSION ? undefined : initial)
  // The pick stays on a listed tab: one that closed while the box is up falls back to a new session.
  const current = target === NEW_SESSION || ordered.some((t) => t.tabId === target) ? target : NEW_SESSION
  const currentTab = ordered.find((t) => t.tabId === current)
  const notReady = currentTab !== undefined && discussReadiness(currentTab) === 'not-ready'

  // Take the keyboard from the page behind (it is inert now, but its frame held the focus).
  useEffect(() => field.current?.focus(), [])

  const send = (): void => {
    if (sending || notReady) return
    setSending(true)
    setError(null)
    const t = current === NEW_SESSION ? { kind: 'new' as const } : { kind: 'tab' as const, tabId: current }
    window.cockpit.invoke('pageTabs.discuss', { tabId: props.tab.id, question, target: t }).then(
      (answer: DiscussAnswer) => {
        if (answer.ok) props.onClose()
        else {
          setError(answer.error)
          setSending(false)
        }
      },
      (err: unknown) => {
        setError(ipcErrorMessage(err))
        setSending(false)
      }
    )
  }

  const title = props.tab.page?.title ?? tabLabel(props.tab)
  return (
    <div className="confirm-backdrop" onMouseDown={props.onClose}>
      <div
        className="confirm-dialog page-tab-discuss"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            props.onClose()
          }
        }}
      >
        <h2 id={titleId} className="confirm-title">
          Ask Claude about “{title}”
        </h2>
        <textarea
          ref={field}
          className="page-tab-discuss-question"
          aria-label="Your question"
          placeholder="Your question (optional)"
          rows={4}
          maxLength={MAX_DISCUSS_QUESTION}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              send()
            }
          }}
        />
        <label className="page-tab-discuss-target">
          <span className="discuss-caption">Send to</span>
          <select value={current} onChange={(e) => setTarget(e.target.value)}>
            {ordered.map((tab) => (
              <option key={tab.tabId} value={tab.tabId}>
                {`${tab.label} · ${discussRowMeta(tab, statusText(tab.status, tab.tool))}`}
              </option>
            ))}
            <option value={NEW_SESSION}>New Claude session</option>
          </select>
        </label>
        {error !== null && (
          <div className="cc-error-line discuss-error" role="alert">
            {error}
          </div>
        )}
        <div className="confirm-buttons">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="page-tab-discuss-send"
            disabled={sending || notReady}
            title={notReady ? 'This session is idle and would not take the text until you run a prompt in it' : undefined}
            aria-busy={sending || undefined}
            onClick={send}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
