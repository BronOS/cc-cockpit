import { describe, expect, it } from 'vitest'
import { ViewRegistry, type ViewSink } from '../../src/main/views/view-registry'
import { remoteViewId } from '../../src/shared/views'

interface FakePort {
  name: string
}

/** A view's sink that records what it got; `closed` flips it to gone, `broken` makes sends throw. */
class FakeSink implements ViewSink<FakePort> {
  events: Array<{ channel: string; payload: unknown }> = []
  ports: Array<{ channel: string; payload: unknown; port: FakePort }> = []
  closed = false
  broken = false

  constructor(private readonly takesPorts = true) {
    if (!takesPorts) this.postPort = undefined
  }

  send(channel: string, payload: unknown): void {
    if (this.broken) throw new Error('render frame was disposed')
    this.events.push({ channel, payload })
  }

  postPort?: (channel: string, payload: unknown, port: FakePort) => void = (channel, payload, port) => {
    this.ports.push({ channel, payload, port })
  }

  isClosed(): boolean {
    return this.closed
  }
}

/** Project p1 in window 1, p2 in window 2; anything else has no window. */
function registry(log: string[] = []): ViewRegistry<FakePort> {
  const windows: Record<string, number> = { p1: 1, p2: 2 }
  return new ViewRegistry<FakePort>({ windowIdOf: (projectId) => windows[projectId], log: (m) => log.push(m) })
}

describe('ViewRegistry', () => {
  it('fans an event out to every view of the project window, desktop and remote', () => {
    const views = registry()
    const desktop = new FakeSink()
    const remote = new FakeSink()
    expect(views.addDesktop(1, desktop)).toBe('desktop:1')
    views.addRemote(1, remoteViewId(1), remote)
    views.toProject('p1', 'tabs.select', { tabId: 't1' })
    expect(desktop.events).toEqual([{ channel: 'tabs.select', payload: { tabId: 't1' } }])
    expect(remote.events).toEqual([{ channel: 'tabs.select', payload: { tabId: 't1' } }])
    expect(views.viewsOf(1)).toEqual(['desktop:1', 'web:1'])
  })

  it('scopes project and window events to that window only', () => {
    const views = registry()
    const one = new FakeSink()
    const two = new FakeSink()
    const twoRemote = new FakeSink()
    views.addDesktop(1, one)
    views.addDesktop(2, two)
    views.addRemote(2, remoteViewId(7), twoRemote)
    views.toProject('p1', 'layout.updated', 'a')
    views.toWindow(2, 'window.state', 'b')
    // A project with no window reaches nobody.
    views.toProject('gone', 'layout.updated', 'c')
    expect(one.events.map((e) => e.payload)).toEqual(['a'])
    expect(two.events.map((e) => e.payload)).toEqual(['b'])
    expect(twoRemote.events.map((e) => e.payload)).toEqual(['b'])
  })

  it("toOthers reaches the window's views but the acting one, never another window's or a closed view", () => {
    const views = registry()
    const desktop = new FakeSink()
    const acting = new FakeSink()
    const other = new FakeSink()
    const closed = new FakeSink()
    const elsewhere = new FakeSink()
    views.addDesktop(1, desktop)
    views.addRemote(1, remoteViewId(1), acting)
    views.addRemote(1, remoteViewId(2), other)
    views.addRemote(1, remoteViewId(3), closed)
    views.addDesktop(2, elsewhere)
    closed.closed = true
    views.toOthers(1, 'web:1', 'tabs.removed', { tabId: 't1', gen: 1 })
    expect(desktop.events).toEqual([{ channel: 'tabs.removed', payload: { tabId: 't1', gen: 1 } }])
    expect(other.events).toHaveLength(1)
    expect(acting.events).toEqual([])
    expect(closed.events).toEqual([])
    expect(elsewhere.events).toEqual([])
    // From the desktop: every browser of the window, not the desktop.
    views.toOthers(1, 'desktop:1', 'tabs.added', { id: 't2' })
    expect(desktop.events).toHaveLength(1)
    expect(acting.events.map((e) => e.channel)).toEqual(['tabs.added'])
  })

  it('toAll reaches every view of every window (the picker too)', () => {
    const views = registry()
    const sinks = [new FakeSink(), new FakeSink(), new FakeSink()]
    views.addDesktop(1, sinks[0]!)
    views.addDesktop(9, sinks[1]!) // a picker: no project
    views.addRemote(1, remoteViewId(2), sinks[2]!)
    views.toAll('theme.changed', { kind: 'dark' })
    for (const s of sinks) expect(s.events).toEqual([{ channel: 'theme.changed', payload: { kind: 'dark' } }])
  })

  it('toBrowserViews reaches the browser views of one window or of all, never a desktop view, and counts them', () => {
    const views = registry()
    const desk1 = new FakeSink()
    const desk2 = new FakeSink()
    const web1 = new FakeSink()
    const web2 = new FakeSink()
    const web3 = new FakeSink()
    views.addDesktop(1, desk1)
    views.addDesktop(2, desk2)
    views.addRemote(1, remoteViewId(1), web1)
    views.addRemote(1, remoteViewId(2), web2)
    views.addRemote(2, remoteViewId(3), web3)
    expect(views.toBrowserViews(1, 'app.linkNotice', { url: 'https://a/' })).toBe(2)
    expect(web1.events).toEqual([{ channel: 'app.linkNotice', payload: { url: 'https://a/' } }])
    expect(web2.events).toHaveLength(1)
    expect(web3.events).toEqual([])
    expect(views.toBrowserViews('all', 'app.linkNotice', { url: 'https://b/' })).toBe(3)
    expect(web3.events).toHaveLength(1)
    // The desktop views (the hidden page in server mode) never get it.
    expect(desk1.events).toEqual([])
    expect(desk2.events).toEqual([])
    // A closed or throwing view is not counted; a window with no browser reaches none.
    web1.closed = true
    web2.broken = true
    expect(views.toBrowserViews(1, 'app.linkNotice', { url: 'https://c/' })).toBe(0)
    expect(views.toBrowserViews(9, 'app.linkNotice', { url: 'https://c/' })).toBe(0)
  })

  it('toView reaches only that view', () => {
    const views = registry()
    const desktop = new FakeSink()
    const remote = new FakeSink()
    views.addDesktop(1, desktop)
    views.addRemote(1, remoteViewId(3), remote)
    expect(views.toView('web:3', 'tabs.select', { tabId: 't2' })).toBe(true)
    expect(views.toView('web:4', 'tabs.select', { tabId: 't2' })).toBe(false)
    expect(desktop.events).toEqual([])
    expect(remote.events).toHaveLength(1)
  })

  it('skips a closed view, and toWindow says whether any view took the event', () => {
    const views = registry()
    const desktop = new FakeSink()
    const remote = new FakeSink()
    views.addDesktop(1, desktop)
    views.addRemote(1, remoteViewId(1), remote)
    remote.closed = true
    expect(views.toWindow(1, 'sessions.closeAsk', { requestId: 1, tabId: 't' })).toBe(true)
    expect(remote.events).toEqual([])
    expect(views.viewsOf(1)).toEqual(['desktop:1'])
    expect(views.windowOf('web:1')).toBeUndefined()
    desktop.closed = true
    expect(views.toWindow(1, 'sessions.closeAsk', { requestId: 2, tabId: 't' })).toBe(false)
    expect(views.toView('desktop:1', 'tabs.select', {})).toBe(false)
  })

  it('a view whose send throws does not keep the event from the others', () => {
    const log: string[] = []
    const views = registry(log)
    const broken = new FakeSink()
    const fine = new FakeSink()
    broken.broken = true
    views.addDesktop(1, broken)
    views.addRemote(1, remoteViewId(1), fine)
    expect(views.toWindow(1, 'prefs.changed', {})).toBe(true)
    expect(fine.events).toHaveLength(1)
    expect(log).toEqual(['event prefs.changed to view desktop:1 failed: render frame was disposed'])
  })

  it('removing a remote view or the window stops its events', () => {
    const views = registry()
    const desktop = new FakeSink()
    const remote = new FakeSink()
    views.addDesktop(1, desktop)
    const remove = views.addRemote(1, remoteViewId(1), remote)
    remove()
    views.toWindow(1, 'window.state', 1)
    expect(remote.events).toEqual([])
    // A second remove is harmless, and does not touch a later view under the same id.
    const later = new FakeSink()
    views.addRemote(1, remoteViewId(1), later)
    remove()
    expect(views.viewsOf(1)).toEqual(['desktop:1', 'web:1'])
    views.removeWindow(1)
    views.toWindow(1, 'window.state', 2)
    expect(desktop.events.map((e) => e.payload)).toEqual([1])
    expect(later.events).toEqual([])
    expect(views.viewsOf(1)).toEqual([])
  })

  it('tells each view of a closing window, after it left the registry; a throwing one does not stop the rest', () => {
    const logs: string[] = []
    const views = new ViewRegistry<FakePort>({ windowIdOf: () => 1, log: (m) => logs.push(m) })
    const seenDuring: string[][] = []
    const told: string[] = []
    views.addDesktop(1, new FakeSink())
    views.addRemote(1, remoteViewId(1), {
      send: () => undefined,
      isClosed: () => false,
      windowClosed: () => {
        seenDuring.push(views.viewsOf(1))
        throw new Error('socket gone')
      }
    })
    views.addRemote(1, remoteViewId(2), { send: () => undefined, isClosed: () => false, windowClosed: () => told.push('web:2') })
    views.addRemote(2, remoteViewId(3), { send: () => undefined, isClosed: () => false, windowClosed: () => told.push('web:3') })
    views.removeWindow(1)
    expect(seenDuring).toEqual([[]])
    expect(told).toEqual(['web:2'])
    expect(logs.join('\n')).toMatch(/web:1: window close failed: socket gone/)
    expect(views.viewsOf(2)).toEqual(['web:3'])
  })

  it('refuses a remote view id that is already registered', () => {
    const views = registry()
    views.addRemote(1, remoteViewId(1), new FakeSink())
    expect(() => views.addRemote(2, remoteViewId(1), new FakeSink())).toThrow(/already registered/)
  })

  it('posts a port to exactly the view named', () => {
    const views = registry()
    const one = new FakeSink()
    const two = new FakeSink()
    const remote = new FakeSink()
    views.addDesktop(1, one)
    views.addDesktop(2, two)
    views.addRemote(2, remoteViewId(1), remote)
    const port = { name: 'p' }
    views.postPort('desktop:2', 'panels.port', { panelKey: 'a/b', nonce: 1 }, port)
    expect(two.ports).toEqual([{ channel: 'panels.port', payload: { panelKey: 'a/b', nonce: 1 }, port }])
    expect(one.ports).toEqual([])
    expect(remote.ports).toEqual([])
  })

  it('throws on a port post to a gone, closed or portless view (the caller closes both ends)', () => {
    const views = registry()
    const closed = new FakeSink()
    closed.closed = true
    views.addDesktop(1, closed)
    views.addRemote(1, remoteViewId(1), new FakeSink(false))
    const port = { name: 'p' }
    expect(() => views.postPort('desktop:1', 'panels.port', {}, port)).toThrow(/gone/)
    expect(() => views.postPort('desktop:5', 'panels.port', {}, port)).toThrow(/gone/)
    expect(() => views.postPort('web:1', 'panels.port', {}, port)).toThrow(/cannot take a port/)
  })
})
