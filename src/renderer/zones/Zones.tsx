import { useEffect, useRef } from 'react'
import { setZoneCollapsed } from '../../shared/layout'
import { registerHandlers } from '../commands/keybindings'
import type { SideZone } from './auto-hide'
import { useAutoHide } from './use-auto-hide'
import { Zone } from './Zone'
import type { LayoutController } from './use-layout'

/**
 * The window below the top strip (design §4): left, right and bottom zones around the centre,
 * which holds `children` (the tab bar and terminals). `children` keeps one position in the tree
 * whatever the layout does, so a panel moving or a zone collapsing never remounts a terminal.
 */
export function Zones(props: {
  children: React.ReactNode
  /** The window's layout (useLayout, made by TabsPane: the top bar reads its app slots too). */
  controller: LayoutController
  /** A modal screen covers the window (settings): nothing here may take the focus or a key. */
  inert?: boolean
}): React.JSX.Element {
  const { controller } = props
  const upper = useRef<HTMLDivElement>(null)
  // Side zones the window hid for a narrow terminal (auto-hide.ts): drawn collapsed, stored as they are.
  const autoHide = useAutoHide(upper, controller.layout, controller.panels)
  // The key handlers are registered once but must act on the current controller and auto-hide.
  const latest = useRef({ controller, autoHide })
  useEffect(() => {
    latest.current = { controller, autoHide }
  })

  useEffect(() => {
    // Collapse keys go through the command registry like every other command; main resolves the
    // chords (Cmd+B / Cmd+J / Cmd+Shift+B by default, user overrides applied).
    // On an auto-hidden zone the key shows it: it looks collapsed, so that is what the person asks
    // for, and collapsing it for real would make it theirs to reopen.
    const toggleSide = (zone: SideZone): void => {
      const { controller, autoHide } = latest.current
      if (autoHide.hidden.includes(zone)) autoHide.reveal(zone)
      else controller.commit((l) => setZoneCollapsed(l, zone))
    }
    return registerHandlers({
      'zone.toggleLeft': () => toggleSide('left'),
      'zone.toggleBottom': () => latest.current.controller.commit((l) => setZoneCollapsed(l, 'bottom')),
      'zone.toggleRight': () => toggleSide('right')
    })
  }, [])

  return (
    <div className="zones" inert={props.inert}>
      <div ref={upper} className="zones-upper">
        <Zone
          zone="left"
          controller={controller}
          autoHidden={autoHide.hidden.includes('left')}
          onReveal={() => autoHide.reveal('left')}
        />
        <div className="zones-centre">{props.children}</div>
        <Zone
          zone="right"
          controller={controller}
          autoHidden={autoHide.hidden.includes('right')}
          onReveal={() => autoHide.reveal('right')}
        />
      </div>
      <Zone zone="bottom" controller={controller} />
    </div>
  )
}
