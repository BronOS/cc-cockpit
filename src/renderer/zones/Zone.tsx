import { useState } from 'react'
import type { PanelInfo } from '../../shared/ipc'
import {
  hidePanel,
  layoutIndexOf,
  placePanelAt,
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
 * horizontal bar at the window's bottom edge. A side zone the window auto-hid for a narrow
 * terminal (auto-hide.ts) is drawn the same as a collapsed one, its stored layout untouched.
 */
export function Zone(props: {
  zone: ZoneId
  controller: LayoutController
  /** Auto-hidden for a narrow terminal (side zones only). */
  autoHidden?: boolean
  /** The person asked to see this auto-hidden zone. */
  onReveal?: () => void
}): React.JSX.Element {
  const { zone, controller } = props
  const { layout, panels } = controller
  const autoHidden = props.autoHidden === true
  const state = layout.zones[zone]
  const collapsed = state.collapsed || autoHidden
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
      onToggle={(key) => {
        // An auto-hidden zone looks collapsed: a click shows it, opening the panel if it was
        // closed (never closing one the person cannot see). Opening one would reveal it anyway
        // (newlyShown); revealing first covers an icon whose panel is already open.
        if (autoHidden) {
          props.onReveal?.()
          const placement = layout.zones[zone].panels.find((p) => p.panelKey === key)
          if (placement && !placement.open) controller.commit((l) => togglePanel(l, key))
          return
        }
        controller.commit((l) => {
          // An icon click in a collapsed zone must show something: for a panel that is already
          // open that means expanding the zone, not closing a panel the user cannot see.
          const placement = l.zones[zone].panels.find((p) => p.panelKey === key)
          return l.zones[zone].collapsed && placement?.open
            ? setZoneCollapsed(l, zone, false)
            : togglePanel(l, key)
        })
      }}
      onMove={(key, to) => controller.commit((l) => movePanel(l, key, to))}
      onPlace={(key, to, index) =>
        controller.commit((l) =>
          // `index` counts icons; the layout may hold panels main has no info for yet.
          placePanelAt(l, key, to, layoutIndexOf(l, to, key, index, (k) => byKey.has(k)))
        )
      }
      onHide={(key) => controller.commit((l) => hidePanel(l, key))}
      onUnhide={(key) => controller.commit((l) => unhidePanel(l, key))}
      menu={menu}
      setMenu={setMenu}
      collapsed={collapsed}
    />
  )
  const area =
    !collapsed && open.length > 0 ? (
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
    <div
      className={`zone zone-${zone}${collapsed ? ' collapsed' : ''}${autoHidden ? ' auto-hidden' : ''}`}
      data-zone={zone}
      data-auto-hidden={autoHidden ? 'true' : undefined}
    >
      {zone === 'left' && strip}
      {area}
      {zone !== 'left' && strip}
    </div>
  )
}
