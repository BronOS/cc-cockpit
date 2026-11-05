// The overlay's toolbar (design-next §3.2): one row of title · the opener's buttons · a divider ·
// the buttons other plugins registered for the overlay's type (plugin-title order) · Discuss with
// Claude · a divider · ✕ (that divider only when the ✕ is on the right), the ✕ before or after the title by the tabs' close-side setting. More than six
// buttons fold into a "…" menu (overlay-toolbar.ts decides which). Everything is React text from
// main's clean copy (overlay-manager.ts), every control a real button, so Tab reaches each one;
// there are no chords for them, and Esc keeps its meaning (it pops the overlay; with the "…" menu
// open it closes the menu only). A url overlay's native view is hidden while the menu is open
// (OverlayStack UrlBody): it paints above the renderer and would cover the menu.
//
// Also the loader of the overlay's body (§3.4): drawn over the body while main says the overlay is
// loading, with "Still loading…" after 10 s. It takes no pointer events, so a click or a key still
// reaches what is under it (a terminal that has printed nothing yet), and the ✕ above always works.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { OverlayButtonInfo, OverlayInfo } from '../../shared/ipc'
import { registerHandlers } from '../commands/keybindings'
import { CloseGlyph, MoreGlyph } from '../window-icons'
import { MaskIcon } from '../zones/IconStrip'
import { GLYPHS } from '../zones/PanelHeaderBar'
import { inert, stillLoadingTimer, toolbarLayout, type ToolbarEntry } from './overlay-toolbar'

function OverlayClose(props: { onClose: () => void }): React.JSX.Element {
  return (
    <button type="button" className="overlay-close" aria-label="Close overlay" title="Close" onClick={props.onClose}>
      <CloseGlyph size={14} />
    </button>
  )
}

/** A core icon by name, or a plugin's `.svg` as a mask; one that fails to load shows nothing (the label is there). */
function ButtonIcon(props: { button: OverlayButtonInfo }): React.JSX.Element | null {
  const { button } = props
  const [failed, setFailed] = useState<string | undefined>(undefined)
  if (button.icon) {
    const Glyph = GLYPHS[button.icon]
    if (Glyph) return <Glyph size={14} />
  }
  if (button.iconSrc && failed !== button.iconSrc) {
    return <MaskIcon src={button.iconSrc} onFail={setFailed} className="overlay-button-img" />
  }
  return null
}

function entryKey(entry: ToolbarEntry): string {
  return entry.source === 'opener' ? `opener/${entry.button.id}` : `type/${entry.pluginId}/${entry.button.id}`
}

function ToolbarButton(props: { entry: ToolbarEntry; onClick: (entry: ToolbarEntry) => void }): React.JSX.Element {
  const { entry } = props
  const { button } = entry
  return (
    <button
      type="button"
      className={`cc-btn overlay-button${button.primary ? ' cc-primary' : ''}`}
      title={button.label}
      data-source={entry.source}
      data-button-id={button.id}
      // A busy button looks enabled (it shows a spinner) but takes no click, like a panel header
      // action: `disabled` would drop it from the tab order mid-run.
      aria-busy={button.busy ? true : undefined}
      aria-disabled={button.busy ? true : undefined}
      disabled={button.disabled}
      onClick={() => {
        if (!inert(button)) props.onClick(entry)
      }}
    >
      {button.busy ? <span className="cc-spinner overlay-button-spinner" aria-hidden="true" /> : <ButtonIcon button={button} />}
      <span className="overlay-button-label">{button.label}</span>
    </button>
  )
}

/** "…" and the buttons that did not fit in the row. */
function MoreMenu(props: {
  entries: ToolbarEntry[]
  onClick: (entry: ToolbarEntry) => void
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const onOpenChange = useRef(props.onOpenChange)
  useEffect(() => {
    onOpenChange.current = props.onOpenChange
  })

  useEffect(() => {
    if (!open) return
    // Capture phase: a click another control stops still closes the menu. Clicks inside are its own.
    const dismiss = (e: MouseEvent): void => {
      if (e.target instanceof Node && root.current?.contains(e.target)) return
      setOpen(false)
    }
    window.addEventListener('click', dismiss, true)
    return () => window.removeEventListener('click', dismiss, true)
  }, [open])

  // Esc closes the menu only: the latest handler of `overlay.pop` wins (keybindings.ts), and
  // removing it gives Esc back to the overlay. A layout effect, so it is in place before the next key.
  // The owner hears open and close here (a url overlay hides its native view meanwhile, which
  // would cover the menu), the cleanup included: a menu that goes while open (its buttons
  // changed, the overlay closed) must not leave the view hidden.
  useLayoutEffect(() => {
    if (!open) {
      // Closed by Esc, a chosen item or a click on nothing focusable: the focused item went with
      // the menu and the focus fell to the body, so the next Tab would start from the top of the
      // window. Give it back to "…". A click on another control keeps the focus it took.
      if (wasOpen.current && (document.activeElement === null || document.activeElement === document.body)) {
        toggle.current?.focus()
      }
      wasOpen.current = false
      return
    }
    wasOpen.current = true
    onOpenChange.current?.(true)
    list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const off = registerHandlers({ 'overlay.pop': () => setOpen(false) })
    return () => {
      off()
      onOpenChange.current?.(false)
    }
  }, [open])

  return (
    <div className="overlay-more" ref={root}>
      <button
        type="button"
        className="cc-btn cc-icon overlay-more-button"
        aria-label="More buttons"
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        ref={toggle}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreGlyph size={14} />
      </button>
      {open && (
        <div className="menu overlay-more-menu" role="menu" ref={list}>
          {props.entries.map((entry) => (
            <button
              key={entryKey(entry)}
              type="button"
              role="menuitem"
              data-source={entry.source}
              data-button-id={entry.button.id}
              aria-busy={entry.button.busy ? true : undefined}
              aria-disabled={entry.button.busy ? true : undefined}
              disabled={entry.button.disabled}
              onClick={() => {
                if (inert(entry.button)) return
                setOpen(false)
                props.onClick(entry)
              }}
            >
              {entry.button.busy ? <span className="cc-spinner overlay-button-spinner" aria-hidden="true" /> : <ButtonIcon button={entry.button} />}
              {entry.button.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function OverlayToolbar(props: {
  overlay: OverlayInfo
  closeSide: 'left' | 'right'
  onClose: () => void
  /** A click on a button that takes clicks (not busy, not disabled). */
  onButton: (entry: ToolbarEntry) => void
  /** Discuss with Claude, drawn just before the ✕ when present. */
  discuss?: React.ReactNode
  /** The "…" menu opened or closed (closed also when it goes while open). */
  onMenuOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const { overlay, closeSide } = props
  const layout = toolbarLayout(overlay.buttons, overlay.typeButtons)
  const opener = layout.row.slice(0, layout.openerCount)
  const typed = layout.row.slice(layout.openerCount)
  return (
    // Moved in the DOM (not CSS order) so the focus order matches what the eye sees.
    <header className="overlay-header" data-close-side={closeSide}>
      {closeSide === 'left' && <OverlayClose onClose={props.onClose} />}
      <span className="overlay-title" title={overlay.title}>
        {overlay.title}
      </span>
      {opener.length > 0 && (
        <div className="overlay-buttons" data-group="opener">
          {opener.map((entry) => (
            <ToolbarButton key={entryKey(entry)} entry={entry} onClick={props.onButton} />
          ))}
        </div>
      )}
      {opener.length > 0 && (typed.length > 0 || layout.menu.length > 0) && (
        <span className="overlay-divider" role="separator" aria-orientation="vertical" />
      )}
      {typed.length > 0 && (
        <div className="overlay-buttons" data-group="type">
          {typed.map((entry) => (
            <ToolbarButton key={entryKey(entry)} entry={entry} onClick={props.onButton} />
          ))}
        </div>
      )}
      {layout.menu.length > 0 && (
        <MoreMenu entries={layout.menu} onClick={props.onButton} onOpenChange={props.onMenuOpenChange} />
      )}
      {props.discuss}
      {/* The actions are one group, the ✕ apart from them: a divider between, when there are any. */}
      {closeSide === 'right' && (layout.row.length > 0 || layout.menu.length > 0 || props.discuss) && (
        <span className="overlay-divider" data-before="close" role="separator" aria-orientation="vertical" />
      )}
      {closeSide === 'right' && <OverlayClose onClose={props.onClose} />}
    </header>
  )
}

/** The body's loader while main says the overlay is loading; "Still loading…" after 10 s. */
export function OverlayLoader(props: { loading: boolean }): React.JSX.Element | null {
  const { loading } = props
  const [still, setStill] = useState(false)
  // Reset during render (React's documented way to derive state from props), so a loader that comes
  // back (the renderer reloaded the page) starts its clock again from "loading".
  if (!loading && still) setStill(false)
  useEffect(() => (loading ? stillLoadingTimer(() => setStill(true)) : undefined), [loading])
  if (!loading) return null
  return (
    <div className="overlay-loader" role="status" aria-live="polite">
      <span className="cc-spinner" aria-hidden="true" />
      {still ? <span className="overlay-loader-text">Still loading…</span> : <span className="visually-hidden">Loading…</span>}
    </div>
  )
}
