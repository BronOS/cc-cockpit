import { Fragment, useRef } from 'react'
import type { PanelInfo } from '../../shared/ipc'
import { MIN_SIZE, type PanelPlacement, type ZoneId, type ZoneState } from '../../shared/layout'
import { SessionsMeta, SessionsPanel } from '../sessions/SessionsPanel'
import { MoreGlyph } from '../window-icons'
import { MENU_WIDTH, ZONE_MENU_TRIGGER } from './IconStrip'
import { PanelHeaderActions, PanelHeaderMeta } from './PanelHeaderBar'
import { PluginPanel } from './PluginPanel'
import { Splitter } from './Splitter'

/** Room the terminal keeps beside (or above) a zone that is dragged wider (taller). */
const MIN_CENTRE = 160
/** Mirrors the 70vw / 70vh cap on .panel-area in styles.css (also the width auto-hide counts, use-auto-hide.ts). */
export const MAX_ZONE_SHARE = 0.7

/** Rendered length of an element along x (width) or y (height); 0 for none. */
function lengthOf(el: Element | null | undefined, horizontal: boolean): number {
  if (!el) return 0
  const r = el.getBoundingClientRect()
  return horizontal ? r.width : r.height
}

/** What a panel shows: the built-in Sessions panel, or a plugin's page (PluginPanel). */
function PanelBody(props: { info: PanelInfo }): React.JSX.Element {
  if (props.info.panelKey === 'core/sessions') {
    return (
      <div className="panel-body" data-panel-body={props.info.panelKey}>
        <SessionsPanel />
      </div>
    )
  }
  return <PluginPanel info={props.info} />
}

/**
 * The open panels of one zone: stacked vertically in a left or right zone, side by side in the
 * bottom zone, with a draggable splitter between neighbours and one on the edge facing the
 * terminal that sizes the zone. The last open panel takes the rest of the space; the others keep
 * their saved size, which is why dragging a splitter resizes the panel before it.
 */
export function PanelArea(props: {
  zone: ZoneId
  state: ZoneState
  open: Array<{ placement: PanelPlacement; info: PanelInfo }>
  onResizeZone: (size: number) => void
  onResizePanel: (panelKey: string, size: number) => void
  onCommit: () => void
  /** A header's "…": open (or close) the zone's move / hide menu for that panel, at x / y. */
  onPanelMenu: (panelKey: string, x: number, y: number) => void
}): React.JSX.Element {
  const { zone, state, open } = props
  const bottom = zone === 'bottom'
  const area = useRef<HTMLDivElement>(null)
  const stack = useRef<HTMLDivElement>(null)

  // Sizes are clamped to what is on screen while dragging, not only to MIN_SIZE..MAX_SIZE: with
  // pointer capture a drag can run past the window edge, and a size past the zone (or the window)
  // pushed the later panels and their splitters out of view, where no mouse could reach them,
  // and was stored that way. The CSS lets fixed panels and zones shrink too (a window made
  // smaller), so the drag starts from the rendered size (Splitter `measure`).

  /** The zone may take the terminal's room down to MIN_CENTRE, and no more than the CSS cap. */
  const zoneMax = (): number => {
    const el = area.current
    const cap = (bottom ? window.innerHeight : window.innerWidth) * MAX_ZONE_SHARE
    const centre = bottom
      ? el?.closest('.zones')?.querySelector(':scope > .zones-upper')
      : el?.closest('.zones-upper')?.querySelector(':scope > .zones-centre')
    if (!el || !centre) return cap
    return Math.min(cap, lengthOf(el, !bottom) + lengthOf(centre, !bottom) - MIN_CENTRE)
  }
  const panelEl = (panelKey: string): HTMLElement | undefined =>
    Array.from(stack.current?.querySelectorAll<HTMLElement>(':scope > section.panel') ?? []).find(
      (el) => el.dataset.panel === panelKey
    )
  /** A panel grows only into the last panel's room, which keeps MIN_SIZE. */
  const panelMax = (panelKey: string): number => {
    const last = stack.current?.querySelector(':scope > section.panel:last-of-type')
    const own = panelEl(panelKey)
    if (!own || !last || own === last) return Infinity
    return lengthOf(own, bottom) + lengthOf(last, bottom) - MIN_SIZE
  }

  // The splitter along the zone's inner edge: right of a left zone, left of a right zone, above
  // the bottom zone. Dragging toward the terminal grows a left zone, away from it a right/bottom one.
  const edge = (
    <Splitter
      axis={bottom ? 'y' : 'x'}
      value={state.size}
      measure={() => lengthOf(area.current, !bottom)}
      invert={zone !== 'left'}
      label={`Resize ${zone} zone`}
      onResize={(size) => props.onResizeZone(Math.min(size, zoneMax()))}
      onCommit={props.onCommit}
    />
  )
  return (
    <div
      ref={area}
      className={`panel-area panel-area-${zone}`}
      data-zone={zone}
      style={bottom ? { height: state.size } : { width: state.size }}
    >
      {zone !== 'left' && edge}
      <div ref={stack} className={`panel-stack panel-stack-${bottom ? 'row' : 'column'}`}>
        {open.map(({ placement, info }, i) => {
          const last = i === open.length - 1
          return (
            <Fragment key={placement.panelKey}>
              <section
                className="panel"
                aria-label={info.title}
                data-panel={placement.panelKey}
                // Fixed panels may shrink (to the MIN_SIZE floor in styles.css) when the zone gets
                // shorter than their sizes, so the last panel and the splitters stay on screen.
                style={{ flex: last ? '1 1 0' : `0 1 ${placement.size}px` }}
              >
                <header className="panel-header">
                  <span className="panel-title">{info.title}</span>
                  {/* Core's own count for Sessions; a plugin panel's meta and actions are what
                      its plugin set with ctx.panels.header (main only ever has them for those). */}
                  {placement.panelKey === 'core/sessions' && <SessionsMeta />}
                  <PanelHeaderMeta header={info.header} />
                  <span className="panel-header-spacer" />
                  <PanelHeaderActions panelKey={placement.panelKey} header={info.header} />
                  {/* The zone menu (Move to … / Hide) without hunting for the icon's right-click,
                      which still works. Always last, after any plugin actions. Named after what it does, not "<title> menu": the specs
                      (and a screen-reader user) find the panel's icon by a name starting with
                      its title, which this must not also match. */}
                  <button
                    type="button"
                    className="panel-menu-button icon-button sm"
                    aria-label={`Move or hide ${info.title}`}
                    aria-haspopup="menu"
                    title="Move or hide this panel"
                    {...{ [ZONE_MENU_TRIGGER]: zone }}
                    onClick={(e) => {
                      // The menu's right edge under the button's, a little below it; IconStrip
                      // clamps it into the window.
                      const r = e.currentTarget.getBoundingClientRect()
                      props.onPanelMenu(placement.panelKey, r.right - MENU_WIDTH, r.bottom + 4)
                    }}
                  >
                    <MoreGlyph />
                  </button>
                </header>
                <PanelBody info={info} />
              </section>
              {!last && (
                <Splitter
                  axis={bottom ? 'x' : 'y'}
                  value={placement.size}
                  measure={() => {
                    const el = panelEl(placement.panelKey)
                    return el ? lengthOf(el, bottom) : placement.size
                  }}
                  label={`Resize ${info.title}`}
                  onResize={(size) =>
                    props.onResizePanel(placement.panelKey, Math.min(size, panelMax(placement.panelKey)))
                  }
                  onCommit={props.onCommit}
                />
              )}
            </Fragment>
          )
        })}
      </div>
      {zone === 'left' && edge}
    </div>
  )
}
