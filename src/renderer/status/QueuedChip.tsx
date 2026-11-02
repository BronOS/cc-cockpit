import { useEffect, useRef, useState } from 'react'
import type { QueuedItem } from '../../shared/ipc'
import { useShellLayer } from '../zones/use-shell-layer'

/** The longest a queued text is shown in the list; the full text is in the tooltip. */
const PREVIEW_CHARS = 80

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS - 1)}…` : oneLine
}

/**
 * "queued N" on a tab: texts the send gate holds until the session can take them. A click lists
 * them, each with a cancel button. Cancel asks main by item id; the chip updates when the next
 * snapshot no longer has the item, so it never shows a cancel that did not happen.
 */
export function QueuedChip(props: {
  queue: readonly QueuedItem[]
  onCancel: (itemId: string) => void
}): React.JSX.Element | null {
  // Where the list is drawn: `position: fixed` under the chip, because the tab strip scrolls
  // horizontally and would clip an absolutely positioned list (the tab context menu does the same).
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const open = pos !== null
  // A webview panel's native view would paint over the list (shell-layers.ts).
  useShellLayer(open)
  const count = props.queue.length
  const root = useRef<HTMLSpanElement>(null)

  // The queue can empty without the Cancel button (the gate delivers the last item on Stop, the tab
  // restarts and drops it). The chip is gone then, so close the list too, or the next queued text
  // would reopen it by itself at a stale position. Reset during render (React's documented way to
  // derive state from props) rather than in an effect, which would paint one stale frame.
  if (count === 0 && pos !== null) setPos(null)

  useEffect(() => {
    if (!open) return
    // Capture phase, so a click that another control stops (the "New tab" button does) still closes
    // this list. Clicks inside the chip are its own: the button toggles, the list handles itself.
    const dismiss = (e: MouseEvent): void => {
      if (e.target instanceof Node && root.current?.contains(e.target)) return
      setPos(null)
    }
    const dismissKey = (): void => setPos(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismissKey()
    }
    window.addEventListener('click', dismiss, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', dismiss, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (count === 0) return null
  return (
    <span className="queued-chip" ref={root}>
      <button
        type="button"
        className="queued-chip-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${count} queued text${count === 1 ? '' : 's'}`}
        onClick={(e) => {
          // Not stopped: the click must reach TabBar's window listener so an open tab menu closes
          // instead of sitting next to this list.
          const rect = e.currentTarget.getBoundingClientRect()
          setPos(open ? null : { x: rect.left, y: rect.bottom })
        }}
      >
        queued {count}
      </button>
      {pos && (
        <ul
          className="queued-list menu"
          role="menu"
          style={{ left: pos.x, top: pos.y }}
        >
          {props.queue.map((item) => (
            <li key={item.id} role="none" className="queued-item">
              <span className="queued-text" title={item.text}>
                {preview(item.text)}
              </span>
              <button
                type="button"
                role="menuitem"
                className="queued-cancel"
                aria-label={`Cancel queued text: ${preview(item.text)}`}
                onClick={() => {
                  props.onCancel(item.id)
                  // Close with it: an emptied queue hides the chip, and a list left open would pop up
                  // again with the next queued text.
                  setPos(null)
                }}
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  )
}
