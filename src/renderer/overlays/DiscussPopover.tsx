// Discuss with Claude (design-next §3.5): the toolbar's split button and its menu. The main part
// discusses in a new Claude session straight away (no picker); the ▾ part opens a popover
// listing only this window's existing Claude tabs (name, status), the preselected one first (the
// opener's `discuss.tabId`, else the active Claude tab: shared/discuss.ts), then waiting, then busy
// ones marked queued, then not-ready (idle) ones, Send off for them. Send asks main (`overlays.discuss`), which builds
// the text, checks the target again, sends it through the send gate or opens the new session,
// closes the overlay as `discussed` and selects the tab; an error comes back as text and is shown
// here, nothing sent. No "remember last choice": the main part always means a new session.
//
// A page-opened popover (`mode: 'page'`, spec-review S6, page-discuss-model.ts): the overlay's own page asked for it
// (`ccPanel.overlay.discuss()`), so it lists New session first and then the Claude tabs, takes no focus (the page
// keeps the keyboard), blocks Enter and Space inside, and arms Send only after about a second of being seen
// (PagePopoverArm); a press begun before that does not count. Closing it without a send is a cancel
// (`onPageCancel`: the cooldown).
//
// Keys: Alt+ArrowDown on the main part opens the menu; Up/Down move the target, Enter in the list
// sends, Esc closes the popover only and gives the ▾ the focus
// (the latest `overlay.pop` handler wins, as for the "…" menu). A url overlay hides its native view
// while the popover is open (`onOpenChange`): it would cover it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { preselectDiscussTarget, type DiscussTarget } from '../../shared/discuss'
import { registerHandlers } from '../commands/keybindings'
import { StatusDot } from '../status/StatusDot'
import { statusText } from '../status/strip-order'
import { discussReadiness, discussRowMeta, existingMenuTitle, orderDiscussTabs, type DiscussTab } from './discuss-tabs'
import { pagePopoverKey, PagePopoverArm, popoverTakesFocus, type DiscussPopoverMode } from './page-discuss-model'

/** The page popover's row for a new session (a tab id is a UUID, never this). */
const NEW_SESSION = 'new'

type Answer = { ok: true } | { ok: false; error: string }

function askDiscuss(overlayId: string, target: DiscussTarget): Promise<string | null> {
  return window.cockpit.invoke('overlays.discuss', { overlayId, target }).then(
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
  /**
   * The page asked for the popover (OverlayStack's gate let it through): a new number opens it in page mode. Never
   * while it is open (the gate answers `already-open`), so a repeated request never re-arms Send.
   */
  pageRequest?: number
  /** A page-opened popover closed without a send (Cancel, a click outside, Esc in the shell, the ▾). */
  onPageCancel?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<DiscussPopoverMode>('menu')
  const onPageCancel = useRef(props.onPageCancel)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const onOpenChange = useRef(props.onOpenChange)
  useEffect(() => {
    onOpenChange.current = props.onOpenChange
    onPageCancel.current = props.onPageCancel
  })
  const none = props.tabs.length === 0
  // The last session closed while the menu is open: nothing left to pick. A page-opened one still has New session.
  const shown = open && (mode === 'page' || !none)

  // The page's request: opened in page mode. Read from the number only (a re-render with the same one does nothing).
  const lastRequest = useRef(props.pageRequest)
  useEffect(() => {
    if (props.pageRequest === undefined || props.pageRequest === lastRequest.current) return
    lastRequest.current = props.pageRequest
    setError(null)
    setMode('page')
    setOpen(true)
  }, [props.pageRequest])

  /** Closes the popover; a page-opened one closing unsent is a cancel (the cooldown). */
  const close = (): void => {
    setOpen(false)
    if (mode === 'page' && open) onPageCancel.current?.()
  }

  useEffect(() => {
    if (!shown && error === null) return
    // Capture phase: a click elsewhere closes it, as for the "…" menu. Clicks inside are its own.
    const dismiss = (e: MouseEvent): void => {
      if (e.target instanceof Node && root.current?.contains(e.target)) return
      close()
      setError(null)
    }
    window.addEventListener('click', dismiss, true)
    return () => window.removeEventListener('click', dismiss, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `close` reads this render's mode; re-bound with shown
  }, [shown, error, mode])

  // Esc closes the popover only; the owner hears open and close (a url view hides meanwhile), the
  // cleanup included, so a popover that goes while open never leaves the view hidden.
  useLayoutEffect(() => {
    if (!shown) {
      // A page-opened popover never took the focus, so it gives none back either (the page keeps it).
      if (wasOpen.current && mode === 'menu' && (document.activeElement === null || document.activeElement === document.body)) {
        toggle.current?.focus()
      }
      wasOpen.current = false
      return
    }
    wasOpen.current = true
    onOpenChange.current?.(true)
    const off = registerHandlers({ 'overlay.pop': () => close() })
    return () => {
      off()
      onOpenChange.current?.(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `close` reads this render's mode; re-bound with shown
  }, [shown, mode])

  const startNew = (): void => {
    if (starting) return
    setStarting(true)
    setOpen(false)
    setError(null)
    void askDiscuss(props.overlayId, { kind: 'new' }).then((err) => {
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
              // The person's own open: the ▾'s menu, never the page mode a page request left set.
              setMode('menu')
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
          disabled={none && !shown}
          ref={toggle}
          onClick={() => {
            setError(null)
            if (open) close()
            else {
              setMode('menu')
              setOpen(true)
            }
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
          mode={mode}
          tabs={orderDiscussTabs(props.tabs, preselected.kind === 'tab' ? preselected.tabId : undefined)}
          {...(preselected.kind === 'tab' ? { preselected: preselected.tabId } : {})}
          onClose={() => {
            close()
            if (mode === 'menu') toggle.current?.focus()
          }}
        />
      )}
    </div>
  )
}

function DiscussPopover(props: {
  overlayId: string
  /** `menu`: the ▾'s own; `page`: the page asked for it (New session first, armed Send, no focus). */
  mode: DiscussPopoverMode
  /** In menu order (orderDiscussTabs): the first is the initial target. At least one in `menu` mode. */
  tabs: readonly DiscussTab[]
  /** `page` mode: the tab to start on (the opener's or the active Claude tab); else New session. */
  preselected?: string
  onClose: () => void
}): React.JSX.Element {
  const { tabs, mode } = props
  const page = mode === 'page'
  const [selected, setSelected] = useState(page ? (props.preselected ?? NEW_SESSION) : tabs[0]!.tabId)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  // The page mode's rows: New session first, then the tabs.
  const keys = page ? [NEW_SESSION, ...tabs.map((t) => t.tabId)] : tabs.map((t) => t.tabId)
  // The selection stays on a row that is listed: a tab that closed while the popover is open falls
  // back to the first listed (main would refuse it anyway).
  const current = keys.includes(selected) ? selected : keys[0]!
  const currentTab = tabs.find((t) => t.tabId === current)
  const notReady = currentTab !== undefined && discussReadiness(currentTab) === 'not-ready'

  // Page mode: Send armed after about a second of the popover seen in a focused window (PagePopoverArm).
  const [armed, setArmed] = useState(!page)
  const arm = useRef<PagePopoverArm | null>(null)
  useEffect(() => {
    if (!page) return
    const current = new PagePopoverArm(setArmed)
    arm.current = current
    const onVisibility = (): void => current.visible(document.visibilityState === 'visible' && document.hasFocus())
    // Read once the focus has settled: a blur that only moves it into a frame (the page) keeps `hasFocus()` true.
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
      current.dispose()
      if (arm.current === current) arm.current = null
    }
  }, [page])

  useLayoutEffect(() => {
    // A page-opened popover leaves the keyboard where it is (the page's frame).
    if (popoverTakesFocus(props.mode)) list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the mode is fixed for one mount
  }, [])

  const send = (): void => {
    if (sending || notReady) return
    if (page && arm.current?.armed !== true) return
    setSending(true)
    setError(null)
    const target: DiscussTarget = current === NEW_SESSION ? { kind: 'new' } : { kind: 'tab', tabId: current }
    void askDiscuss(props.overlayId, target).then((err) => {
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
      // A page-opened popover takes no key as a send (pagePopoverKey blocks it on the popover too).
      if (!page) send()
    }
  }

  return (
    <div
      className="discuss-popover"
      role="dialog"
      aria-label={page ? 'Discuss with Claude' : 'Discuss in an existing session'}
      data-mode={mode}
      // Recorded on the popover, not on Send: a disabled button may get no pointer events, and a press begun while
      // disarmed must never read as "no press seen".
      onPointerDownCapture={page ? () => arm.current?.pressBegan() : undefined}
      onKeyDownCapture={
        page
          ? (e) => {
              if (pagePopoverKey(e.key) !== 'block') return
              e.preventDefault()
              e.stopPropagation()
            }
          : undefined
      }
    >
      <div className="discuss-caption">Send to</div>
      <div className="cc-list cc-compact discuss-targets" role="listbox" aria-label="Send to" ref={list} onKeyDown={onListKey}>
        {page && (
          <div
            className="cc-row discuss-target"
            role="option"
            tabIndex={current === NEW_SESSION ? 0 : -1}
            aria-selected={current === NEW_SESSION}
            data-target={NEW_SESSION}
            onClick={() => setSelected(NEW_SESSION)}
          >
            <span className="cc-row-main">
              <span className="cc-row-title">New Claude session</span>
            </span>
          </div>
        )}
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
      {error !== null && (
        <div className="cc-error-line discuss-error" role="alert">
          {error}
        </div>
      )}
      <div className="discuss-actions">
        <button type="button" className="cc-btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="cc-btn cc-primary discuss-send" disabled={sending || notReady || !armed}
          title={notReady ? 'This session is idle and would not take the text until you run a prompt in it' : undefined}
          aria-busy={sending || undefined}
          onClick={() => {
            // Page mode: only an armed press counts (PagePopoverArm.click); the ▾'s own popover sends on any click.
            if (page && arm.current?.click() !== true) return
            send()
          }}
        >
          {sending && <span className="cc-spinner overlay-button-spinner" aria-hidden="true" />}
          Send
        </button>
      </div>
    </div>
  )
}
