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
//
// The page, not the person, opens the box, and what it sends is the person's own text to a Claude tab
// (typed ones too). So, as core's approvals (ApprovalDialog), a send needs a deliberate act on a box
// the person has seen (page-tab-discuss-model.ts): Send and Ctrl/Cmd+Enter are armed only after about
// a second of visibility, a press begun before that does not count, and Ctrl/Cmd+Enter counts only as
// a fresh chord (no auto-repeat, the modifier pressed after the box opened). The question field takes
// the keyboard at once: it can only have come from the page's own frame (page-frames.ts takes the ask
// only from the shown frame with the focus), never from a terminal, and keys landing there show.
import { useEffect, useId, useRef, useState } from 'react'
import { allowClickCounts, ApprovalArm } from '../notices/approval-model'
import { MAX_DISCUSS_QUESTION, preselectDiscussTarget } from '../../shared/discuss'
import type { DiscussAnswer, TabInfo } from '../../shared/ipc'
import { ipcErrorMessage } from '../ipc-error'
import { discussReadiness, discussRowMeta, orderDiscussTabs, type DiscussTab } from '../overlays/discuss-tabs'
import { statusText } from '../status/strip-order'
import { DiscussKeys } from './page-tab-discuss-model'
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
  /** The box goes: `sent` after a send main accepted, false for a cancel (Esc, Cancel, a click outside). */
  onClose: (sent: boolean) => void
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

  const [armed, setArmed] = useState(false)
  // Read by the handlers, which may run before the render `setArmed` causes.
  const armedNow = useRef(false)
  const keys = useRef(new DiscussKeys())
  // How the last press on Send began: armed or not (undefined: no press seen).
  const pressArmed = useRef<boolean | undefined>(undefined)

  // Take the keyboard from the page behind (it is inert now, but its frame held the focus).
  useEffect(() => field.current?.focus(), [])

  // Armed after about a second of the box visible in a focused window (as ApprovalDialog: a window in
  // the background shows nothing, and the click that focuses it must not land on an armed Send).
  useEffect(() => {
    const arm = new ApprovalArm((on) => {
      armedNow.current = on
      setArmed(on)
    })
    const onVisibility = (): void => {
      const seen = document.visibilityState === 'visible' && document.hasFocus()
      // A modifier released while the window was away sends no keyup here.
      if (!seen) keys.current.reset()
      arm.visible(seen)
    }
    // Read once the focus has settled: a blur that only moves it into a frame keeps `hasFocus()` true.
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

  const send = (): void => {
    if (sending || notReady || !armedNow.current) return
    setSending(true)
    setError(null)
    const t = current === NEW_SESSION ? { kind: 'new' as const } : { kind: 'tab' as const, tabId: current }
    window.cockpit.invoke('pageTabs.discuss', { tabId: props.tab.id, question, target: t }).then(
      (answer: DiscussAnswer) => {
        if (answer.ok) props.onClose(true)
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
    <div className="confirm-backdrop" onMouseDown={() => props.onClose(false)}>
      <div
        className="confirm-dialog page-tab-discuss"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        // Recorded on the box, not on Send: a disabled button may get no pointer events, and a press
        // begun while disarmed must never read as "no press seen".
        onPointerDownCapture={() => {
          pressArmed.current = armedNow.current
        }}
        onKeyUp={(e) => keys.current.keyUp(e.key)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            props.onClose(false)
            return
          }
          // Modifiers are tracked from anywhere in the box (the person may press Ctrl on the select).
          keys.current.keyDown({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, repeat: e.repeat }, false)
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
            // The box's own handler (bubbling after this one) records modifiers; only Enter is read here.
            if (e.key !== 'Enter') return
            const action = keys.current.keyDown({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, repeat: e.repeat }, armedNow.current)
            if (action === 'pass') return
            e.preventDefault()
            if (action === 'send') send()
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
          <button type="button" onClick={() => props.onClose(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="page-tab-discuss-send"
            disabled={sending || notReady || !armed}
            title={notReady ? 'This session is idle and would not take the text until you run a prompt in it' : undefined}
            aria-busy={sending || undefined}
            onClick={() => {
              const counts = allowClickCounts(armedNow.current, pressArmed.current)
              pressArmed.current = undefined
              if (counts) send()
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
