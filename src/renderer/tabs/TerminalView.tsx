import { useEffect, useRef } from 'react'
import type { TabInfo } from '../../shared/ipc'
import { isOwnView } from '../shell-kind'
import { ExitedBanner } from './ExitedBanner'
import type { SessionRegistry } from './terminal-session'

/**
 * One tab's terminal. Every tab stays mounted and an inactive one is only hidden (display:none),
 * so its xterm and scrollback survive switching tabs; unmounting would throw the buffer away.
 */
export function TerminalView(props: {
  tab: TabInfo
  active: boolean
  sessions: SessionRegistry
  onRestart: () => void
  onClose: () => void
}): React.JSX.Element {
  const { tab, active, sessions } = props
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const session = sessions.get(tab.id)
    session.attach(el)
    return () => session.detach()
  }, [sessions, tab.id])

  useEffect(() => {
    if (active) sessions.get(tab.id).focus()
  }, [active, sessions, tab.id])

  // Which device typed last, when it was another view (design-web.md §5.2 "Input from any view"):
  // keys from two places interleave, and this says where the last ones came from. Never shown for
  // this view's own typing, so with web access off (one view) it never shows. `device` is a
  // browser's own text: plain text in React, never markup.
  const typedBy = tab.typedBy && !isOwnView(tab.typedBy.viewId) ? tab.typedBy.device : undefined

  return (
    <div className="terminal-view" hidden={!active} role="tabpanel">
      <div className="terminal-host" ref={host} />
      {typedBy !== undefined && (
        <div className="terminal-typed" role="status">
          Typed last on {typedBy}
        </div>
      )}
      {tab.exit && (
        <ExitedBanner
          exit={tab.exit}
          notStarted={tab.notStarted === true}
          onRestart={props.onRestart}
          onClose={props.onClose}
        />
      )}
    </div>
  )
}
