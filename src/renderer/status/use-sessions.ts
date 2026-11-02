import { useEffect, useMemo, useState } from 'react'
import type { SessionDetail, SessionsSnapshot } from '../../shared/ipc'

const EMPTY: SessionsSnapshot = { strip: [], own: [] }

/**
 * This window's view of the Claude tabs. Events carry the whole snapshot, so the latest one wins
 * and nothing is merged. The initial `sessions.list` answers a page that loaded between two
 * events (a second window opened while nothing changed); it is dropped if an event arrived
 * first, because the event is newer.
 */
export function useSessions(): { snapshot: SessionsSnapshot; own: ReadonlyMap<string, SessionDetail> } {
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
        // The strip stays empty until the first event; nothing else depends on it.
      })
    return off
  }, [])

  const own = useMemo(() => new Map(snapshot.own.map((d) => [d.tabId, d])), [snapshot])
  return { snapshot, own }
}
