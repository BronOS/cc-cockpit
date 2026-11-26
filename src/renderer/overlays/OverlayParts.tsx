import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OverlayInfo } from '../../shared/ipc'
import { dragPartFraction, loadPartFraction, partShares, partSplitMode, savePartFraction, type PartSplitMode, type PartStorage } from './part-split'

/** `window.localStorage`, read inside part-split's try (reading it throws where site data is blocked). */
const storage = (): PartStorage | undefined => window.localStorage

/** A part's share is remembered by its plugin (one part per plugin in a window). */
const keyOf = (part: OverlayInfo): string => part.pluginId ?? part.id

/**
 * An html overlay's body with its parts (shared/design-parts.md §4): the opener's page, then up to 2 parts in attach
 * order, each under a core strip naming its plugin with a ✕. Side by side when the body is wide, stacked below that,
 * one frame behind a switch when narrow (part-split.ts).
 *
 * The opener's frame is always this element's first child, with or without parts and in every mode: a part that
 * attaches or detaches, or a resize that changes the mode, never moves or remounts it (moving an iframe in the DOM
 * reloads its page). The switch comes last in the DOM and is put first by CSS `order`; a frame not shown behind the
 * switch is `display: none`, which keeps its page running.
 *
 * Nothing here decides what a part may do: main lists a part only to a view that may see it (visibleTo), its frame is
 * its own plugin's sandboxed page with its own port, and the ✕ is OverlayStack's close (`overlays.close`, a read
 * guest's `overlays.release { hide: true }`).
 */
export function OverlayParts(props: {
  parent: OverlayInfo
  /** The parent's parts this view shows, in attach order. */
  parts: readonly OverlayInfo[]
  /** The opener's page. */
  children: React.ReactNode
  /** A part's page with its loader (OverlayStack's: the copy states and hides are its). */
  renderPart: (part: OverlayInfo) => React.ReactNode
  onClosePart: (part: OverlayInfo) => void
}): React.JSX.Element {
  const { parent, parts } = props
  const opener = parent.pluginId ?? ''
  const el = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY)
  /** Shares dragged in this window (saved to storage at the drag's end). */
  const [fractions, setFractions] = useState<Readonly<Record<string, number>>>({})
  // This device's remembered shares, read when the set of part plugins changes.
  const partKeys = parts.map(keyOf).join('|')
  const stored = useMemo(
    () => Object.fromEntries(partKeys.split('|').filter((k) => k !== '').map((k) => [k, loadPartFraction(storage, opener, k)])) as Record<string, number>,
    [partKeys, opener]
  )
  const fractionOf = (part: OverlayInfo): number => fractions[keyOf(part)] ?? stored[keyOf(part)] ?? Number.NaN
  /** Behind the switch: the frame shown (the opener's id or a part's). */
  const [selected, setSelected] = useState(parent.id)

  useLayoutEffect(() => {
    const node = el.current
    if (!node) return
    const measure = (): void => setWidth(node.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // A part that went while it was the one shown: back to the opener's page.
  const shownId = selected === parent.id || parts.some((p) => p.id === selected) ? selected : parent.id
  const mode: PartSplitMode = parts.length === 0 ? 'side' : partSplitMode(width)
  const shares = partShares(parts.map(fractionOf))
  const openerShare = 1 - shares.reduce((a, b) => a + b, 0)
  const shown = (id: string): boolean => mode !== 'switch' || shownId === id
  const flexOf = (share: number): string => `${share} 1 0`

  /** A divider drag (pointer captured by the divider, so a frame under the pointer never takes the move). */
  const startDrag = (index: number, event: React.PointerEvent<HTMLDivElement>): void => {
    const node = el.current
    const part = parts[index]
    if (!node || !part || mode === 'switch') return
    event.preventDefault()
    const divider = event.currentTarget
    divider.setPointerCapture(event.pointerId)
    const after = shares.slice(index + 1).reduce((a, b) => a + b, 0)
    let last: number | undefined
    const move = (e: PointerEvent): void => {
      const rect = node.getBoundingClientRect()
      last = mode === 'side' ? dragPartFraction(e.clientX - rect.left, rect.width, after) : dragPartFraction(e.clientY - rect.top, rect.height, after)
      const value = last
      setFractions((prev) => ({ ...prev, [keyOf(part)]: value }))
    }
    const end = (): void => {
      divider.removeEventListener('pointermove', move)
      divider.removeEventListener('pointerup', end)
      divider.removeEventListener('pointercancel', end)
      if (last !== undefined) savePartFraction(storage, opener, keyOf(part), last)
    }
    divider.addEventListener('pointermove', move)
    divider.addEventListener('pointerup', end)
    divider.addEventListener('pointercancel', end)
  }

  return (
    <div
      ref={el}
      className="overlay-parts"
      data-mode={mode}
      style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: mode === 'side' ? 'row' : 'column' }}
    >
      <div
        key="opener"
        className="overlay-part-opener"
        style={{ position: 'relative', flex: flexOf(parts.length === 0 ? 1 : openerShare), minHeight: 0, minWidth: 0, display: shown(parent.id) ? 'flex' : 'none', flexDirection: 'column' }}
      >
        {props.children}
      </div>
      {parts.map((part, i) => {
        const name = part.pluginTitle ?? part.title
        return [
          mode !== 'switch' && (
            <div
              key={`divider-${part.id}`}
              className="overlay-part-divider"
              role="separator"
              aria-orientation={mode === 'side' ? 'vertical' : 'horizontal'}
              aria-label={`Resize ${name}`}
              onPointerDown={(e) => startDrag(i, e)}
              style={{
                flex: '0 0 6px',
                cursor: mode === 'side' ? 'col-resize' : 'row-resize',
                background: 'var(--cc-border, rgba(127, 127, 127, 0.3))',
                touchAction: 'none'
              }}
            />
          ),
          <section
            key={part.id}
            className="overlay-part"
            aria-label={name}
            data-part-plugin={part.pluginId}
            style={{ position: 'relative', flex: flexOf(shares[i] ?? 0), minHeight: 0, minWidth: 0, display: shown(part.id) ? 'flex' : 'none', flexDirection: 'column' }}
          >
            <div
              className="overlay-part-strip"
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 8px', fontSize: 12, borderBottom: '1px solid var(--cc-border, rgba(127, 127, 127, 0.3))' }}
            >
              <span style={{ flex: 1, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
              <button type="button" className="overlay-part-close" aria-label={`Close ${name}`} title={`Close ${name}`} onClick={() => props.onClosePart(part)}>
                ✕
              </button>
            </div>
            <div className="overlay-part-body" style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {props.renderPart(part)}
            </div>
          </section>
        ]
      })}
      {mode === 'switch' && (
        <div key="switch" className="overlay-parts-switch" role="tablist" aria-label="Shown here" style={{ order: -1, display: 'flex', gap: 4, padding: 4 }}>
          {[parent, ...parts].map((o) => (
            <button
              key={o.id}
              type="button"
              role="tab"
              aria-selected={shownId === o.id}
              // Shape as well as colour: the shown one is bold and underlined.
              style={{ fontWeight: shownId === o.id ? 700 : 400, textDecoration: shownId === o.id ? 'underline' : 'none' }}
              onClick={() => setSelected(o.id)}
            >
              {o === parent ? parent.title : (o.pluginTitle ?? o.title)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
