// Discuss with Claude (design-next §3.5): the toolbar's split button and its menu. The main part
// discusses in a new Claude session straight away (no picker, no note); the ▾ part opens a popover
// listing only this window's existing Claude tabs (name, status), the preselected one first (the
// opener's `discuss.tabId`, else the active Claude tab: shared/discuss.ts), then waiting, then busy
// ones marked queued, then not-ready ones (no turn since start: Send is off for them), and takes an optional note. Send asks main (`overlays.discuss`), which builds
// the text, checks the target again, sends it through the send gate or opens the new session,
// closes the overlay as `discussed` and selects the tab; an error comes back as text and is shown
// here, nothing sent. No "remember last choice": the main part always means a new session.
//
// Keys: Alt+ArrowDown on the main part opens the menu; Up/Down move the target, Enter in the list
// sends, Cmd/Ctrl+Enter in the note sends, Esc closes the popover only and gives the ▾ the focus
// (the latest `overlay.pop` handler wins, as for the "…" menu). A url overlay hides its native view
// while the popover is open (`onOpenChange`): it would cover it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MAX_DISCUSS_NOTE, preselectDiscussTarget, type DiscussTarget } from '../../shared/discuss'
import { registerHandlers } from '../commands/keybindings'
import { StatusDot } from '../status/StatusDot'
import { statusText } from '../status/strip-order'
import { discussReadiness, discussRowMeta, existingMenuTitle, orderDiscussTabs, type DiscussTab } from './discuss-tabs'

type Answer = { ok: true } | { ok: false; error: string }

function askDiscuss(overlayId: string, target: DiscussTarget, note: string): Promise<string | null> {
  return window.cockpit.invoke('overlays.discuss', { overlayId, target, note }).then(
    // On success main closed the overlay, which takes this button with it.
    (answer: Answer) => (answer.ok ? null : answer.error),
    (err: unknown) => (err instanceof Error ? err.message : String(err))
  )
}

export function DiscussButton(props: {
  overlayId: string
  /** The opener's preselected tab (OverlayInfo.discuss.tabId). */
  preferredTabId?: string
  /** This window's Claude tabs, in tab order. */
  tabs: readonly DiscussTab[]
  /** The window's selected tab, if any. */
  activeTabId: string | null
  /** The opener asked for the accent style (handle.setDiscussPrimary). */
  primary?: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const onOpenChange = useRef(props.onOpenChange)
  useEffect(() => {
    onOpenChange.current = props.onOpenChange
  })
  const none = props.tabs.length === 0
  // The last session closed while the menu is open: nothing left to pick.
  const shown = open && !none

  useEffect(() => {
    if (!shown && error === null) return
    // Capture phase: a click elsewhere closes it, as for the "…" menu. Clicks inside are its own.
    const dismiss = (e: MouseEvent): void => {
      if (e.target instanceof Node && root.current?.contains(e.target)) return
      setOpen(false)
      setError(null)
    }
    window.addEventListener('click', dismiss, true)
    return () => window.removeEventListener('click', dismiss, true)
  }, [shown, error])

  // Esc closes the popover only; the owner hears open and close (a url view hides meanwhile), the
  // cleanup included, so a popover that goes while open never leaves the view hidden.
  useLayoutEffect(() => {
    if (!shown) {
      if (wasOpen.current && (document.activeElement === null || document.activeElement === document.body)) {
        toggle.current?.focus()
      }
      wasOpen.current = false
      return
    }
    wasOpen.current = true
    onOpenChange.current?.(true)
    const off = registerHandlers({ 'overlay.pop': () => setOpen(false) })
    return () => {
      off()
      onOpenChange.current?.(false)
    }
  }, [shown])

  const startNew = (): void => {
    if (starting) return
    setStarting(true)
    setOpen(false)
    setError(null)
    void askDiscuss(props.overlayId, { kind: 'new' }, '').then((err) => {
      setError(err)
      setStarting(false)
    })
  }

  const preselected = preselectDiscussTarget(props.tabs, props.preferredTabId, props.activeTabId)
  const primary = props.primary ? ' cc-primary' : ''
  return (
    <div className={`overlay-discuss${primary ? ' overlay-discuss-primary' : ''}`} ref={root}>
      <div className="overlay-discuss-split" role="group" aria-label="Discuss with Claude">
        <button
          type="button"
          className={`cc-btn overlay-button overlay-discuss-button overlay-discuss-main${primary}`}
          title="Discuss in a new Claude session"
          aria-label="Discuss in a new Claude session"
          disabled={starting}
          aria-busy={starting || undefined}
          onClick={startNew}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && e.altKey && !none) {
              e.preventDefault()
              setError(null)
              setOpen(true)
            }
          }}
        >
          {starting && <span className="cc-spinner overlay-button-spinner" aria-hidden="true" />}
          <span className="overlay-button-label">Discuss</span>
        </button>
        <button
          type="button"
          className={`cc-btn overlay-button overlay-discuss-button overlay-discuss-more${primary}`}
          title={existingMenuTitle(props.tabs)}
          aria-label="Discuss in an existing session"
          aria-haspopup="menu"
          aria-expanded={shown}
          disabled={none}
          ref={toggle}
          onClick={() => {
            setError(null)
            setOpen((v) => !v)
          }}
        >
          <span aria-hidden="true">▾</span>
        </button>
      </div>
      {error !== null && !shown && (
        <div className="discuss-popover" role="alert">
          <div className="cc-error-line discuss-error">{error}</div>
        </div>
      )}
      {shown && (
        <DiscussPopover
          overlayId={props.overlayId}
          tabs={orderDiscussTabs(props.tabs, preselected.kind === 'tab' ? preselected.tabId : undefined)}
          onClose={() => {
            setOpen(false)
            toggle.current?.focus()
          }}
        />
      )}
    </div>
  )
}

function DiscussPopover(props: {
  overlayId: string
  /** At least one, in menu order (orderDiscussTabs): the first is the initial target. */
  tabs: readonly DiscussTab[]
  onClose: () => void
}): React.JSX.Element {
  const { tabs } = props
  const [selected, setSelected] = useState(tabs[0]!.tabId)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  // The selection stays on a tab that is listed: one that closed while the popover is open falls
  // back to the first listed (main would refuse it anyway).
  const keys = tabs.map((t) => t.tabId)
  const current = keys.includes(selected) ? selected : keys[0]!
  const notReady = discussReadiness(tabs.find((t) => t.tabId === current)!) === 'not-ready'

  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
  }, [])

  const send = (): void => {
    if (sending || notReady) return
    setSending(true)
    setError(null)
    void askDiscuss(props.overlayId, { kind: 'tab', tabId: current }, note).then((err) => {
      setError(err)
      setSending(false)
    })
  }

  const onListKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const at = keys.indexOf(current)
      const next = keys[(at + (e.key === 'ArrowDown' ? 1 : keys.length - 1)) % keys.length]!
      setSelected(next)
      list.current?.querySelector<HTMLElement>(`[data-target="${CSS.escape(next)}"]`)?.focus()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="discuss-popover" role="dialog" aria-label="Discuss in an existing session">
      <div className="discuss-caption">Send to</div>
      <div className="cc-list cc-compact discuss-targets" role="listbox" aria-label="Send to" ref={list} onKeyDown={onListKey}>
        {tabs.map((tab) => (
          <div
            key={tab.tabId}
            className="cc-row discuss-target"
            role="option"
            tabIndex={current === tab.tabId ? 0 : -1}
            aria-selected={current === tab.tabId}
            data-target={tab.tabId}
            onClick={() => setSelected(tab.tabId)}
          >
            <StatusDot status={tab.status} tool={tab.tool} />
            <span className="cc-row-main">
              <span className="cc-row-title">{tab.label}</span>
            </span>
            <span className="cc-row-meta">
              {discussRowMeta(tab, statusText(tab.status, tab.tool))}
            </span>
          </div>
        ))}
      </div>
      <label className="discuss-note">
        <span className="discuss-caption">Note (optional)</span>
        <textarea
          value={note}
          maxLength={MAX_DISCUSS_NOTE}
          rows={3}
          placeholder="What should Claude look at?"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send()
            }
          }}
        />
      </label>
      {error !== null && (
        <div className="cc-error-line discuss-error" role="alert">
          {error}
        </div>
      )}
      <div className="discuss-actions">
        <button type="button" className="cc-btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="cc-btn cc-primary discuss-send" disabled={sending || notReady}
          title={notReady ? 'This session has not answered since it started; run a prompt in it first' : undefined}
          aria-busy={sending || undefined}
          onClick={send}
        >
          {sending && <span className="cc-spinner overlay-button-spinner" aria-hidden="true" />}
          Send
        </button>
      </div>
    </div>
  )
}
