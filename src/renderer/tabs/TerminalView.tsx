import { useEffect, useRef } from 'react'
import type { TabInfo } from '../../shared/ipc'
import { isOwnView, isWebShell, viewAccessHint } from '../shell-kind'
import { ExitedBanner } from './ExitedBanner'
import { takesUploads } from './terminal-drop'
import type { SessionRegistry } from './terminal-session'

/**
 * One tab's terminal. Every tab stays mounted and an inactive one is only hidden (display:none),
 * so its xterm and scrollback survive switching tabs; unmounting would throw the buffer away.
 *
 * `shown`: laid out now (the selected tab, or a visible pane of its split group). `focused`: it has
 * this view's keys (the selected tab, unless D3 took the keys off); only one terminal ever does.
 */
export function TerminalView(props: {
  tab: TabInfo
  shown: boolean
  focused: boolean
  sessions: SessionRegistry
  onRestart: () => void
  onClose: () => void
  /** Restart and Close on the exited banner (default): not for a read-only guest. */
  canWrite?: boolean
  /**
   * Selects this pane, as a press on it does (SplitArea's onPanePress): a file drop on the terminal
   * counts as a click there (design-upload.md §4.1).
   */
  onSelect?: () => void
}): React.JSX.Element {
  const { tab, shown, focused, sessions } = props
  const host = useRef<HTMLDivElement>(null)
  // Read at the drop, so the attach below does not run again on every render's new callback.
  const select = useRef(props.onSelect)
  useEffect(() => {
    select.current = props.onSelect
  }, [props.onSelect])
  const kind = tab.kind

  useEffect(() => {
    const el = host.current
    if (!el) return
    const session = sessions.get(tab.id)
    // Uploads from this device (design-upload.md §4.1): a Claude or shell tab of the web shell, not a
    // read guest's view (a UI hint: main refuses by the view's role); command and page tabs take nothing.
    const entry = takesUploads(kind, isWebShell(), viewAccessHint()) ? { tabId: tab.id, select: () => select.current?.() } : undefined
    session.attach(el, entry)
    return () => session.detach()
  }, [sessions, tab.id, kind])

  useEffect(() => {
    if (focused) sessions.get(tab.id).focus()
  }, [focused, sessions, tab.id])

  // Which device typed last, when it was another view (design-web.md §5.2 "Input from any view"):
  // keys from two places interleave, and this says where the last ones came from. Never shown for
  // this view's own typing, so with web access off (one view) it never shows. `device` is a
  // browser's own text: plain text in React, never markup.
  const typedBy = tab.typedBy && !isOwnView(tab.typedBy.viewId) ? tab.typedBy.device : undefined

  return (
    <div className="terminal-view" hidden={!shown} role="tabpanel">
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
          actions={props.canWrite !== false}
        />
      )}
    </div>
  )
}
