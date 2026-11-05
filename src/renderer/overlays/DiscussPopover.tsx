// Discuss with Claude (design-next §3.5): the toolbar's button and its popover. The popover lists
// this window's Claude tabs (name, status) and New session, preselects the opener's
// `discuss.tabId`, else the active Claude tab, else New session (shared/discuss.ts), and takes an
// optional note. Send asks main (`overlays.discuss`), which builds the text, checks the target
// again, sends it through the send gate or opens the new session, closes the overlay as
// `discussed` and selects the tab; an error comes back as text and is shown here, nothing sent.
//
// Keys: Up/Down move the target, Enter in the list sends, Cmd/Ctrl+Enter in the note sends, Esc
// closes the popover only (the latest `overlay.pop` handler wins, as for the "…" menu). A url
// overlay hides its native view while the popover is open (`onOpenChange`): it would cover it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MAX_DISCUSS_NOTE, preselectDiscussTarget, type DiscussTarget } from '../../shared/discuss'
import { registerHandlers } from '../commands/keybindings'
import { StatusDot } from '../status/StatusDot'
import { statusText } from '../status/strip-order'
import type { DiscussTab } from './discuss-tabs'

const NEW = 'new'

function targetKey(target: DiscussTarget): string {
  return target.kind === 'new' ? NEW : target.tabId
}

function targetOf(key: string): DiscussTarget {
  return key === NEW ? { kind: 'new' } : { kind: 'tab', tabId: key }
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
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const onOpenChange = useRef(props.onOpenChange)
  useEffect(() => {
    onOpenChange.current = props.onOpenChange
  })

  useEffect(() => {
    if (!open) return
    // Capture phase: a click elsewhere closes it, as for the "…" menu. Clicks inside are its own.
    const dismiss = (e: MouseEvent): void => {
      if (e.target instanceof Node && root.current?.contains(e.target)) return
      setOpen(false)
    }
    window.addEventListener('click', dismiss, true)
    return () => window.removeEventListener('click', dismiss, true)
  }, [open])

  // Esc closes the popover only; the owner hears open and close (a url view hides meanwhile), the
  // cleanup included, so a popover that goes while open never leaves the view hidden.
  useLayoutEffect(() => {
    if (!open) {
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
  }, [open])

  return (
    <div className="overlay-discuss" ref={root}>
      <button
        type="button"
        className={`cc-btn overlay-button overlay-discuss-button${props.primary ? ' cc-primary' : ''}`}
        title="Discuss with Claude"
        aria-haspopup="dialog"
        aria-expanded={open}
        ref={toggle}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="overlay-button-label">Discuss</span>
      </button>
      {open && (
        <DiscussPopover
          overlayId={props.overlayId}
          initial={preselectDiscussTarget(props.tabs, props.preferredTabId, props.activeTabId)}
          tabs={props.tabs}
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
  initial: DiscussTarget
  tabs: readonly DiscussTab[]
  onClose: () => void
}): React.JSX.Element {
  const { tabs } = props
  const [selected, setSelected] = useState(targetKey(props.initial))
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  // The selection stays on a tab that is listed: one that closed while the popover is open falls
  // back to New session (main would refuse it anyway).
  const keys = [...tabs.map((t) => t.tabId), NEW]
  const current = keys.includes(selected) ? selected : NEW

  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
  }, [])

  const send = (): void => {
    if (sending) return
    setSending(true)
    setError(null)
    window.cockpit
      .invoke('overlays.discuss', { overlayId: props.overlayId, target: targetOf(current), note })
      .then(
        // On success main closed the overlay, which takes this popover with it.
        (answer) => {
          if (!answer.ok) setError(answer.error)
        },
        (err: unknown) => setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setSending(false))
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
    <div className="discuss-popover" role="dialog" aria-label="Discuss with Claude">
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
            <span className="cc-row-meta">{statusText(tab.status, tab.tool)}</span>
          </div>
        ))}
        <div
          className="cc-row discuss-target"
          role="option"
          tabIndex={current === NEW ? 0 : -1}
          aria-selected={current === NEW}
          data-target={NEW}
          onClick={() => setSelected(NEW)}
        >
          <span className="cc-row-main">
            <span className="cc-row-title">New session</span>
          </span>
        </div>
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
        <button type="button" className="cc-btn cc-primary discuss-send" disabled={sending} aria-busy={sending || undefined} onClick={send}>
          {sending && <span className="cc-spinner overlay-button-spinner" aria-hidden="true" />}
          Send
        </button>
      </div>
    </div>
  )
}
