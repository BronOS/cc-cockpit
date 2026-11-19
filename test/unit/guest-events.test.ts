// What a guest's connection receives (main/web/guest-events.ts, design-guests §5, D-18, D-23, D-33): one rule
// per event channel at the guest sink, the same filters on the `ready` snapshot, and the asks reduced to a
// file's name. The pure filters themselves are guest-filter.test.ts's; here: that every channel has a rule,
// that the table cannot be fooled by a prototype key, and that the asks and the snapshot apply them.
import { describe, expect, it } from 'vitest'
import {
  GUEST_EVENT,
  guestContext,
  guestDownloadOffer,
  guestEvent,
  guestSnapshot,
  guestTrashAsk,
  type GuestContextSources,
  type GuestEventContext
} from '../../src/main/web/guest-events'
import type { DownloadOffer } from '../../src/shared/downloads'
import type { GuestOnlyAccess, PresenceSnapshot } from '../../src/shared/guests'
import { EVENT_CHANNELS, type IpcEventMap, type LayoutView, type TabInfo } from '../../src/shared/ipc'
import { defaultLayout } from '../../src/shared/layout'
import type { WebSnapshot } from '../../src/shared/web-protocol'

const guest = (role: 'read' | 'write' = 'write'): GuestOnlyAccess => ({
  kind: 'guest',
  id: 'g1',
  name: 'Bob',
  role,
  projectId: 'p1',
  scope: ['t1']
})

/** A guest that sees tab t1 and plugin a.files; the offer `offer-1` came from t1, `offer-2` from t9, `offer-3` from no tab. */
function ctx(over: Partial<GuestEventContext> = {}): GuestEventContext {
  const origins: Record<string, string> = { 'offer-1': 't1', 'offer-2': 't9' }
  return {
    viewId: 'web:9',
    access: guest(),
    tabVisible: (t) => t === 't1',
    pluginVisible: (p) => p === 'a.files',
    overlayVisible: () => false,
    personOf: () => undefined,
    tabOrder: () => ['t1', 't9'],
    downloadOrigin: (id) => (Object.hasOwn(origins, id) ? origins[id] : undefined),
    ownerName: () => 'Oleg',
    ...over
  }
}

const trash = (pluginId = 'a.files'): IpcEventMap['trash.ask'] => ({
  requestId: 'trash-1',
  path: '/Users/host/secret-project/notes/todo.md',
  kind: 'file',
  pluginId
})

const offer = (requestId = 'offer-1'): DownloadOffer => ({
  requestId,
  path: '/Users/host/secret-project/out/report.pdf',
  real: '/Volumes/private/report.pdf',
  name: 'report.pdf',
  outside: false,
  runnable: false,
  kind: 'file',
  size: 12
})

describe('GUEST_EVENT', () => {
  it('has one rule per event channel, no more and no fewer', () => {
    // The type makes a missing rule a compile error; this catches a stray extra key and a runtime drift.
    expect(Object.keys(GUEST_EVENT).sort()).toEqual([...EVENT_CHANNELS].sort())
    expect(Object.isFrozen(GUEST_EVENT)).toBe(true)
  })
})

describe('guestEvent', () => {
  it('drops a channel the table does not have, prototype keys included', () => {
    // `Object.hasOwn`: `GUEST_EVENT['toString']` is a function on the prototype, which a plain lookup would
    // call as a filter and send whatever it returned.
    for (const name of ['nope.channel', 'toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf', '']) {
      expect(guestEvent(name, { secret: 1 }, ctx()), name).toBeUndefined()
    }
  })

  it('drops what is the owner\'s: terminals, notices, link asks, access, the guest list', () => {
    for (const name of ['notices.show', 'notices.gone', 'links.ask', 'webAccess.changed', 'guests.changed', 'tabs.data', 'rooms.changed', 'sessions.closeAsk', 'tabs.guestCloseAsk', 'overlays.message', 'window.state']) {
      expect(GUEST_EVENT[name as keyof typeof GUEST_EVENT], name).toBe('drop')
      expect(guestEvent(name, { anything: true }, ctx()), name).toBeUndefined()
    }
  })

  it('passes exactly the design\'s pass rows (§16.3); everything else is dropped or filtered', () => {
    const passing = Object.entries(GUEST_EVENT).filter(([, rule]) => rule === 'pass').map(([name]) => name).sort()
    expect(passing).toEqual(['downloads.failed', 'downloads.settled', 'downloads.start', 'prefs.changed', 'theme.changed', 'trash.settled'])
  })

  it('passes a pass rule as is (the same object)', () => {
    const p = { theme: 'dark' }
    expect(guestEvent('theme.changed', p, ctx())).toBe(p)
  })

  it('project.updated loses its folder (D-33)', () => {
    const got = guestEvent('project.updated', { id: 'p1', name: 'Proj', path: '/Users/host/secret-project', missing: false, color: 'red' }, ctx())
    expect(got).toEqual({ id: 'p1', name: 'Proj', path: '', missing: false, color: 'red' })
  })

  it('presence.changed: a person on a tab the guest cannot see is elsewhere, with no tab id', () => {
    const s: PresenceSnapshot = {
      seq: 3,
      people: [
        { id: 'owner', name: 'Oleg', role: 'owner', color: 0, state: 'live', tabId: 't9', typing: true },
        { id: 'g1', name: 'Bob', role: 'write', color: 2, state: 'live', tabId: 't1', typing: false }
      ],
      lastTyped: { t9: 'owner', t1: 'g1' }
    }
    expect(guestEvent('presence.changed', s, ctx())).toEqual({
      seq: 3,
      people: [
        { id: 'owner', name: 'Oleg', role: 'owner', color: 0, state: 'live', tabId: null, elsewhere: true, typing: true },
        { id: 'g1', name: 'Bob', role: 'write', color: 2, state: 'live', tabId: 't1', typing: false }
      ],
      lastTyped: { t1: 'g1' }
    })
  })
})

describe('trash.ask (D-33)', () => {
  it('never reaches a read guest', () => {
    expect(guestEvent('trash.ask', trash(), ctx({ access: guest('read') }))).toBeUndefined()
    expect(guestTrashAsk(trash(), ctx({ access: guest('read') }))).toBeUndefined()
  })

  it('never reaches a write guest who does not see the plugin', () => {
    expect(guestEvent('trash.ask', trash('hidden.plugin'), ctx())).toBeUndefined()
  })

  it('reaches a write guest who sees the plugin with the file name only, not the host path', () => {
    expect(guestEvent('trash.ask', trash(), ctx())).toEqual({ requestId: 'trash-1', path: 'todo.md', kind: 'file', pluginId: 'a.files' })
  })
})

describe('downloads.offer (D-23)', () => {
  it('drops an offer with no origin tab, from a tab the guest cannot see, or to a read guest', () => {
    expect(guestEvent('downloads.offer', offer('offer-3'), ctx())).toBeUndefined()
    expect(guestEvent('downloads.offer', offer('offer-2'), ctx())).toBeUndefined()
    expect(guestEvent('downloads.offer', offer('offer-1'), ctx({ access: guest('read') }))).toBeUndefined()
  })

  it('a write guest who sees the origin tab gets the name only: no host path, no link target', () => {
    const got = guestEvent('downloads.offer', offer('offer-1'), ctx()) as DownloadOffer
    expect(got).toEqual({ requestId: 'offer-1', path: 'report.pdf', name: 'report.pdf', outside: false, runnable: false, kind: 'file', size: 12 })
    expect('real' in got).toBe(false)
    // The caller's payload is left alone (the owner's views get the same object).
    const original = offer('offer-1')
    guestDownloadOffer(original, ctx())
    expect(original.real).toBe('/Volumes/private/report.pdf')
  })
})

describe('guestSnapshot', () => {
  const tab = (id: string): TabInfo => ({ id, kind: 'claude', cwd: '/Users/host/secret-project', gen: 1 })
  const layout: LayoutView = { layout: defaultLayout(), panels: [] }
  const full = (): WebSnapshot => ({
    tabs: [tab('t1'), tab('t9')],
    layout,
    overlays: [],
    closeAsks: [{ secret: 'close' } as never],
    linkAsks: [{ secret: 'link' } as never],
    trashAsks: [trash(), trash('hidden.plugin')],
    downloadOffers: [offer('offer-1'), offer('offer-2'), offer('offer-3')],
    roomRemoveAsks: [{ secret: 'room' } as never],
    notices: [{ secret: 'notice' } as never],
    signIns: [{ secret: 'sign-in' } as never],
    server: true
  })

  it('empties the owner\'s asks and notices, filters tabs and asks, and sets guest for the banner', () => {
    const s = guestSnapshot(full(), ctx())
    expect(s.closeAsks).toEqual([])
    expect(s.linkAsks).toEqual([])
    expect(s.roomRemoveAsks).toEqual([])
    expect(s.notices).toEqual([])
    expect(s.signIns).toEqual([])
    expect(s.tabs.map((t) => t.id)).toEqual(['t1'])
    expect(s.tabs[0]!.cwd).toBe('')
    expect(s.trashAsks).toEqual([{ ...trash(), path: 'todo.md' }])
    expect(s.downloadOffers?.map((o) => [o.requestId, o.path])).toEqual([['offer-1', 'report.pdf']])
    expect(s.guest).toEqual({ id: 'g1', name: 'Bob', role: 'write', ownerName: 'Oleg' })
    expect(s.server).toBe(true)
    expect(JSON.stringify(s)).not.toContain('secret-project')
  })

  it('a read guest gets no asks at all; server absent stays absent', () => {
    const src = full()
    delete src.server
    const s = guestSnapshot(src, ctx({ access: guest('read') }))
    expect(s.trashAsks).toEqual([])
    expect(s.downloadOffers).toEqual([])
    expect(s.guest).toMatchObject({ role: 'read' })
    expect('server' in s).toBe(false)
  })
})

describe('guestContext', () => {
  it('asks the live sources with the guest\'s own id and project; no download source means no origin', () => {
    const calls: string[] = []
    const src: GuestContextSources = {
      guests: {
        tabVisible: (id, tab) => (calls.push(`tab ${id} ${tab}`), true),
        pluginVisible: (projectId, plugin) => (calls.push(`plugin ${projectId} ${plugin}`), false)
      },
      overlayVisible: (id, overlay) => (calls.push(`overlay ${id} ${overlay}`), true),
      personOf: (v) => (v === 'web:9' ? 'Bob' : undefined),
      tabOrder: (projectId) => (calls.push(`order ${projectId}`), ['t1']),
      ownerName: () => 'Oleg'
    }
    const g = guestContext(src, 'web:9', guest())
    expect(g.viewId).toBe('web:9')
    expect(g.tabVisible('t1')).toBe(true)
    expect(g.pluginVisible('x.y')).toBe(false)
    expect(g.overlayVisible('o1')).toBe(true)
    expect(g.tabOrder()).toEqual(['t1'])
    expect(g.personOf('web:9')).toBe('Bob')
    expect(g.ownerName()).toBe('Oleg')
    expect(g.downloadOrigin('offer-1')).toBeUndefined()
    expect(calls).toEqual(['tab g1 t1', 'plugin p1 x.y', 'overlay g1 o1', 'order p1'])
    // With no download source, no offer reaches the guest at all.
    expect(guestEvent('downloads.offer', offer('offer-1'), g)).toBeUndefined()
  })

  it("asks the download source with the guest view's own id (its window picks the offer, 03b's offerOrigin)", () => {
    const asked: string[] = []
    const g = guestContext(
      {
        guests: { tabVisible: () => true, pluginVisible: () => true },
        overlayVisible: () => false,
        personOf: () => undefined,
        tabOrder: () => [],
        ownerName: () => 'Host',
        downloadOrigin: (viewId, id) => (asked.push(`${viewId} ${id}`), 't1')
      },
      'web:4',
      guest()
    )
    expect(g.downloadOrigin('offer-2')).toBe('t1')
    expect(asked).toEqual(['web:4 offer-2'])
  })
})
