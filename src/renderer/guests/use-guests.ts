// The guest feature's live data for the top bar and the tab strip (design-guests §10, §16.2, §16.7).
// TabBar and TopStrip read it themselves through these hooks (TabsPane passes them nothing). Events
// carry whole snapshots, so the newest wins and nothing is merged; an initial read that lands after an
// event is dropped, as use-sessions.ts does.

import { useEffect, useState } from 'react'
import type { GuestView, PresenceSnapshot } from '../../shared/guests'
import { isGuestView, isServerView, isWebShell } from '../shell-kind'
import { newerSnapshot } from './presence-model'

/**
 * Every project's guests and invites (`guests.list` + `guests.changed`), or null until known. Only an
 * owner view asks (`enabled`): a guest view is refused the channel and never gets the event, so it
 * does not even try (a refused call would only be noise in main's log).
 */
export function useGuests(enabled: boolean): GuestView[] | null {
  const [guests, setGuests] = useState<GuestView[] | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    let sawEvent = false
    const off = window.cockpit.on('guests.changed', (next) => {
      sawEvent = true
      setGuests(next)
    })
    window.cockpit.invoke('guests.list').then(
      (initial) => {
        if (live && !sawEvent) setGuests(initial)
      },
      // Main without the guest service (or a refusal): no guests is the right picture.
      () => undefined
    )
    return () => {
      live = false
      off()
    }
  }, [enabled])
  return enabled ? guests : null
}

/** Who is here and on which tab (`presence.get` + `presence.changed`), every view; null until known. */
export function usePresence(): PresenceSnapshot | null {
  const [snapshot, setSnapshot] = useState<PresenceSnapshot | null>(null)
  useEffect(() => {
    let live = true
    const take = (next: PresenceSnapshot): void => {
      if (live) setSnapshot((held) => (newerSnapshot(held, next) ? next : held))
    }
    const off = window.cockpit.on('presence.changed', take)
    window.cockpit.invoke('presence.get').then(take, () => undefined)
    return () => {
      live = false
      off()
    }
  }, [])
  return snapshot
}

// The window's project never changes for a page's life (a project window is one project), so one read serves
// every hook in the page.
let projectIdRead: Promise<string | undefined> | undefined

/** This window's project id (`window.info`), for filtering `guests.list`; undefined until known or in the picker. */
export function useProjectId(): string | undefined {
  const [id, setId] = useState<string | undefined>(undefined)
  useEffect(() => {
    let live = true
    projectIdRead ??= window.cockpit.invoke('window.info').then(
      (info) => (info.kind === 'project' ? info.project.id : undefined),
      () => undefined
    )
    void projectIdRead.then((value) => {
      if (live) setId(value)
    })
    return () => {
      live = false
    }
  }, [])
  return id
}

/**
 * Whether this owner view may widen guest access (invite, write, D-11): the desktop page, or a server's
 * browser (behind an armed confirm). A browser of a desktop host may only narrow. A hint: main decides.
 */
export function canWidenGuests(): boolean {
  return !isGuestView() && (!isWebShell() || isServerView())
}

/** Whether this page is an owner view (the guest UI's owner parts are drawn only there). */
export function isOwnerView(): boolean {
  return !isGuestView()
}

/**
 * Whether web access is on, for the Share button: a browser view is on it by definition; the desktop
 * reads its setting (`settings.webAccess`) at first, on every `webAccess.changed` and whenever
 * `refresh` changes (TopStrip passes its `inert`, which drops when the settings screen closes, where
 * the switch is).
 */
export function useWebAccessOn(refresh: unknown): boolean {
  const [on, setOn] = useState(isWebShell())
  useEffect(() => {
    if (isWebShell() || isGuestView()) return
    let live = true
    const read = (): void => {
      window.cockpit.invoke('settings.webAccess').then(
        (view) => {
          if (live) setOn(view.form.enabled)
        },
        () => undefined
      )
    }
    read()
    const off = window.cockpit.on('webAccess.changed', read)
    return () => {
      live = false
      off()
    }
  }, [refresh])
  return on
}
