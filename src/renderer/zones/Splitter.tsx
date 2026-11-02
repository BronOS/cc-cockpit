import { useEffect, useRef } from 'react'
import { acquireLayer } from './shell-layers'

const KEY_STEP = 16

/**
 * A draggable divider. `axis` is the direction it moves along ('x' for a vertical bar between
 * side-by-side things). It reports absolute sizes: the size `value` had when the drag began plus
 * the pointer's travel (negated with `invert`, for a bar on the near edge of the thing it sizes).
 * Arrow keys nudge it, so the bar is usable without a mouse.
 *
 * A drag holds a shell layer (shell-layers.ts): a webview panel's native view would take the
 * pointer from the drag wherever the bar passes over it, so views hide until the drag ends.
 */
export function Splitter(props: {
  axis: 'x' | 'y'
  /** The size this bar controls now. */
  value: number
  /**
   * The size as rendered, when CSS may hold it below `value` (a window made smaller, a stored size
   * from before a clamp existed). A drag starts from this, or it would first have to travel back
   * through a dead zone where the stored size changes and nothing on screen does.
   */
  measure?: () => number
  invert?: boolean
  label: string
  /** Called on every move while dragging; the caller clamps. */
  onResize: (size: number) => void
  /** The drag (or key press) ended: persist. */
  onCommit: () => void
}): React.JSX.Element {
  const { axis, value, measure, invert, onResize, onCommit } = props
  const current = (): number => measure?.() ?? value
  const drag = useRef<{ start: number; startValue: number; release: () => void } | null>(null)
  const sign = invert ? -1 : 1
  // Unmounted mid-drag (the zone collapsed by a key): the layer must not stay up for good.
  useEffect(
    () => () => {
      drag.current?.release()
      drag.current = null
    },
    []
  )
  /** The drag ended (up, cancel, lost capture): release its layer and persist. */
  const end = (): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    d.release()
    onCommit()
  }
  const pos = (e: { clientX: number; clientY: number }): number => (axis === 'x' ? e.clientX : e.clientY)

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={props.label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(value)}
      className={`splitter splitter-${axis}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        // Capture keeps the move events coming when the pointer leaves the thin bar or the
        // window, and over the terminal canvas.
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current?.release()
        drag.current = { start: pos(e), startValue: current(), release: acquireLayer() }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d) onResize(d.startValue + (pos(e) - d.start) * sign)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      // Chromium also drops the capture without an up, e.g. on a buttonless mouse move from the
      // OS cursor (seen in the zones e2e). The drag must end there, or every later hover over the
      // bar would keep resizing with no button held, and the size would never be stored.
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        const grow = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
        const shrink = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
        if (e.key !== grow && e.key !== shrink) return
        e.preventDefault()
        onResize(current() + (e.key === grow ? KEY_STEP : -KEY_STEP) * sign)
        onCommit()
      }}
    />
  )
}
