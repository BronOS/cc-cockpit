import { useEffect, useMemo, useState } from 'react'
import type { SessionDetail, SessionsSnapshot } from '../../shared/ipc'

const EMPTY: SessionsSnapshot = { own: [] }

/**
 * This window's own Claude tabs as main reports them (statuses for the tab strip's dots, the
 * close dialog, Discuss). Other windows' tabs are not here: the top bar's strip of them is a
 * plugin's (`sessions-strip` slot, ctx.sessions.list({ scope: 'all' })). Events carry the whole
 * snapshot, so the latest one wins and nothing is merged. The initial `sessions.list` answers a
 * page that loaded between two events; it is dropped if an event arrived first, because the event
 * is newer.
 */
export function useSessions(): { own: ReadonlyMap<string, SessionDetail> } {
  const [snapshot, setSnapshot] = useState<SessionsSnapshot>(EMPTY)

  useEffect(() => {
    let sawEvent = false
    const off = window.cockpit.on('sessions.snapshot', (next) => {
      sawEvent = true
      setSnapshot(next)
    })
    window.cockpit
      .invoke('sessions.list')
      .then((initial) => {
        if (!sawEvent) setSnapshot(initial)
      })
      .catch(() => {
        // The dots stay at the tabs' own state until the first event; nothing else depends on it.
      })
    return off
  }, [])

  const own = useMemo(() => new Map(snapshot.own.map((d) => [d.tabId, d])), [snapshot])
  return { own }
}
