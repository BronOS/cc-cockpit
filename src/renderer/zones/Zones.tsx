import { useEffect, useRef } from 'react'
import { setZoneCollapsed } from '../../shared/layout'
import { registerHandlers } from '../commands/keybindings'
import { Zone } from './Zone'
import { useLayout } from './use-layout'

/**
 * The window below the top strip (design §4): left, right and bottom zones around the centre,
 * which holds `children` (the tab bar and terminals). `children` keeps one position in the tree
 * whatever the layout does, so a panel moving or a zone collapsing never remounts a terminal.
 */
export function Zones(props: {
  children: React.ReactNode
  /** A modal screen covers the window (settings): nothing here may take the focus or a key. */
  inert?: boolean
}): React.JSX.Element {
  const controller = useLayout()
  // The key handlers are registered once but must act on the current controller.
  const latest = useRef(controller)
  useEffect(() => {
    latest.current = controller
  })

  useEffect(() => {
    // Collapse keys go through the command registry like every other command; main resolves the
    // chords (Cmd+B / Cmd+J / Cmd+Shift+B by default, user overrides applied).
    return registerHandlers({
      'zone.toggleLeft': () => latest.current.commit((l) => setZoneCollapsed(l, 'left')),
      'zone.toggleBottom': () => latest.current.commit((l) => setZoneCollapsed(l, 'bottom')),
      'zone.toggleRight': () => latest.current.commit((l) => setZoneCollapsed(l, 'right'))
    })
  }, [])

  return (
    <div className="zones" inert={props.inert}>
      <div className="zones-upper">
        <Zone zone="left" controller={controller} />
        <div className="zones-centre">{props.children}</div>
        <Zone zone="right" controller={controller} />
      </div>
      <Zone zone="bottom" controller={controller} />
    </div>
  )
}
