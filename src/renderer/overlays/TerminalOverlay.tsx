import { useEffect, useRef } from 'react'
import type { SessionRegistry } from '../tabs/terminal-session'

/**
 * A terminal overlay's xterm. The session lives in OverlayStack's registry (output can arrive
 * before this mounts), wired to the overlay channels; this only shows it and takes the keyboard
 * while the overlay is on top. Esc is the program's here: OverlayStack does not claim it.
 */
export function TerminalOverlay(props: {
  overlayId: string
  active: boolean
  sessions: SessionRegistry
}): React.JSX.Element {
  const { overlayId, active, sessions } = props
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const session = sessions.get(overlayId)
    session.attach(el)
    return () => session.detach()
  }, [sessions, overlayId])

  useEffect(() => {
    if (active) sessions.get(overlayId).focus()
  }, [active, sessions, overlayId])

  return <div className="terminal-host overlay-terminal" ref={host} />
}
