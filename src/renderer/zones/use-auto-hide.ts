import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PanelInfo } from '../../shared/ipc'
import { zoneOf, type LayoutState } from '../../shared/layout'
import { usePrefs } from '../prefs/prefs-store'
import {
  decideAutoHide,
  INITIAL_AUTO_HIDE,
  newlyShown,
  revealZone,
  type AutoHideInput,
  type SideZone
} from './auto-hide'
import { MAX_ZONE_SHARE } from './PanelArea'
import { placedIn } from './Zone'

export interface AutoHide {
  /** The side zones auto-hidden now (drawn like collapsed ones, the stored layout untouched). */
  hidden: readonly SideZone[]
  /** The person asked to see an auto-hidden zone (an icon click, its toggle key). */
  reveal(zone: SideZone): void
}

/**
 * The zone auto-hide of one window (auto-hide.ts has the rules): measures the zones' row, feeds the
 * layout and the settings to `decideAutoHide`, and turns the person's requests to see a zone into
 * `revealZone`. `upper` is the row holding the left zone, the centre and the right zone.
 */
export function useAutoHide(
  upper: React.RefObject<HTMLElement | null>,
  layout: LayoutState,
  panels: readonly PanelInfo[]
): AutoHide {
  const { zoneAutoHide, minTerminalWidth } = usePrefs()
  const [room, setRoom] = useState(0)
  const [state, setState] = useState(INITIAL_AUTO_HIDE)
  const prevLayout = useRef(layout)

  // The row's width minus the icon strips, which are on screen whatever is hidden. The row follows
  // the window, so this is the window resize.
  useLayoutEffect(() => {
    const el = upper.current
    if (!el) return
    const measure = (): void => {
      let strips = 0
      for (const strip of el.querySelectorAll(':scope > .zone > .icon-strip')) strips += strip.getBoundingClientRect().width
      setRoom(Math.round(el.getBoundingClientRect().width - strips))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [upper])

  // ctx.panels.show / `ccc panel show` of a panel already open: the layout does not change, so
  // only the view's `reveal` says the zone must come back.
  useEffect(
    () =>
      window.cockpit.on('layout.updated', (view) => {
        if (view.reveal === undefined) return
        const zone = zoneOf(view.layout, view.reveal)
        if (zone === 'left' || zone === 'right') setState((s) => revealZone(s, zone))
      }),
    []
  )

  // A layout effect: a zone that must hide is gone before the frame is painted, not a frame later.
  useLayoutEffect(() => {
    // Something newly shown in an auto-hidden zone is a request to see it; applied before the
    // decision, which then leaves it (no shrink, no check).
    const shown = newlyShown(prevLayout.current, layout)
    prevLayout.current = layout
    // The CSS caps a side panel area at 70vw (styles.css .panel-area-left/right).
    const cap = window.innerWidth * MAX_ZONE_SHARE
    const open = (zone: SideZone): boolean =>
      !layout.zones[zone].collapsed && placedIn(layout, zone, panels).some((p) => p.placement.open)
    const input: AutoHideInput = {
      enabled: zoneAutoHide,
      minWidth: minTerminalWidth,
      room,
      sizes: { left: Math.min(layout.zones.left.size, cap), right: Math.min(layout.zones.right.size, cap) },
      open: { left: open('left'), right: open('right') },
      panels: panels.map((p) => p.panelKey)
    }
    setState((s) => decideAutoHide(shown.reduce(revealZone, s), input))
  }, [layout, panels, room, zoneAutoHide, minTerminalWidth])

  const reveal = useCallback((zone: SideZone) => setState((s) => revealZone(s, zone)), [])
  return { hidden: state.hidden, reveal }
}
