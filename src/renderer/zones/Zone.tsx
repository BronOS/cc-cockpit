import { useState } from 'react'
import type { PanelInfo } from '../../shared/ipc'
import {
  hidePanel,
  movePanel,
  resizePanel,
  resizeZone,
  setZoneCollapsed,
  togglePanel,
  unhidePanel,
  type LayoutState,
  type PanelPlacement,
  type ZoneId
} from '../../shared/layout'
import { IconStrip, type MenuState } from './IconStrip'
import { PanelArea } from './PanelArea'
import type { LayoutController } from './use-layout'

type Placed = Array<{ placement: PanelPlacement; info: PanelInfo }>

/** The panels placed in a zone that main has info for, in zone order. */
export function placedIn(layout: LayoutState, zone: ZoneId, panels: readonly PanelInfo[]): Placed {
  const byKey = new Map(panels.map((p) => [p.panelKey, p]))
  const out: Placed = []
  for (const placement of layout.zones[zone].panels) {
    const info = byKey.get(placement.panelKey)
    if (info) out.push({ placement, info })
  }
  return out
}

/**
 * One zone: its icon strip and, unless the zone is collapsed or nothing in it is open, its panel
 * area. A collapsed zone keeps its strip so the panels stay reachable (an icon click reopens it).
 * Left: strip then area; right: area then strip; bottom: area above its strip, so the strip is a
 * horizontal bar at the window's bottom edge.
 */
export function Zone(props: { zone: ZoneId; controller: LayoutController }): React.JSX.Element {
  const { zone, controller } = props
  const { layout, panels } = controller
  const state = layout.zones[zone]
  const placed = placedIn(layout, zone, panels)
  const open = placed.filter((p) => p.placement.open)
  const byKey = new Map(panels.map((p) => [p.panelKey, p]))
  const hidden = layout.hidden.flatMap((key) => byKey.get(key) ?? [])
  // One menu per zone: the hidden-panels list, or move / hide for a panel, opened from its icon
  // (right-click) or its header's "…" button. Drawn by the strip either way.
  const [menu, setMenu] = useState<MenuState | null>(null)

  const strip = (
    <IconStrip
      zone={zone}
      placed={placed}
      hidden={hidden}
      onToggle={(key) =>
        controller.commit((l) => {
          // An icon click in a collapsed zone must show something: for a panel that is already
          // open that means expanding the zone, not closing a panel the user cannot see.
          const placement = l.zones[zone].panels.find((p) => p.panelKey === key)
          return l.zones[zone].collapsed && placement?.open
            ? setZoneCollapsed(l, zone, false)
            : togglePanel(l, key)
        })
      }
      onMove={(key, to) => controller.commit((l) => movePanel(l, key, to))}
      onHide={(key) => controller.commit((l) => hidePanel(l, key))}
      onUnhide={(key) => controller.commit((l) => unhidePanel(l, key))}
      menu={menu}
      setMenu={setMenu}
      collapsed={state.collapsed}
    />
  )
  const area =
    !state.collapsed && open.length > 0 ? (
      <PanelArea
        zone={zone}
        state={state}
        open={open}
        onResizeZone={(size) => controller.preview((l) => resizeZone(l, zone, size))}
        onResizePanel={(key, size) => controller.preview((l) => resizePanel(l, key, size))}
        onCommit={controller.flush}
        onPanelMenu={(panelKey, x, y) =>
          setMenu(menu?.kind === 'panel' && menu.panelKey === panelKey ? null : { kind: 'panel', panelKey, x, y })
        }
      />
    ) : null

  return (
    <div className={`zone zone-${zone}${state.collapsed ? ' collapsed' : ''}`} data-zone={zone}>
      {zone === 'left' && strip}
      {area}
      {zone !== 'left' && strip}
    </div>
  )
}
