// Zone sizes and collapsed zones per view (design-web.md §5.1, plan Task 8): the geometry helpers
// (shared/layout.ts), the browser's own store (renderer/zones/view-geometry.ts), LayoutSync in
// geometry mode (a remote view: its sizes are drawn, saved and never sent), and main's side
// (LayoutService.set keepGeometry), so a remote view's sizes never reach main's layout either way.
import { describe, expect, it } from 'vitest'
import { LayoutService } from '../../src/main/layout/layout-service'
import { LayoutSync, type LayoutBridge } from '../../src/renderer/zones/layout-sync'
import { browserGeometryStore, GEOMETRY_KEY_PREFIX, type StorageLike } from '../../src/renderer/zones/view-geometry'
import type { LayoutView, PanelInfo } from '../../src/shared/ipc'
import {
  defaultLayout,
  geometryOf,
  hidePanel,
  movePanel,
  normalizeGeometry,
  resizePanel,
  resizeZone,
  setZoneCollapsed,
  togglePanel,
  withGeometry,
  type LayoutState
} from '../../src/shared/layout'

/** The desktop's layout: Sessions open in the left zone (400 wide), Notes in the right. */
function desktopLayout(): LayoutState {
  const base = defaultLayout()
  return {
    ...base,
    zones: {
      left: { collapsed: false, size: 400, panels: [{ panelKey: 'p/sessions', open: true, size: 300 }] },
      right: { collapsed: false, size: 320, panels: [{ panelKey: 'p/notes', open: false, size: 240 }] },
      bottom: { collapsed: true, size: 200, panels: [] }
    }
  }
}

const panels: PanelInfo[] = [
  { panelKey: 'p/sessions', title: 'Sessions', icon: 'S' },
  { panelKey: 'p/notes', title: 'Notes', icon: 'N' }
]

describe('geometry helpers', () => {
  it('geometryOf takes zone sizes, collapsed zones and panel sizes, remembered ones too', () => {
    const layout = hidePanel(desktopLayout(), 'p/notes')
    expect(geometryOf(layout)).toEqual({
      zones: {
        left: { size: 400, collapsed: false },
        right: { size: 320, collapsed: false },
        bottom: { size: 200, collapsed: true }
      },
      panels: { 'p/sessions': 300, 'p/notes': 240 }
    })
  })

  it('withGeometry changes sizes and collapsed states only, and keeps the object when nothing changes', () => {
    const layout = desktopLayout()
    expect(withGeometry(layout, geometryOf(layout))).toBe(layout)
    const next = withGeometry(layout, { zones: { left: { size: 180, collapsed: true } }, panels: { 'p/notes': 90, 'x/unknown': 500 } })
    expect(next.zones.left).toEqual({ collapsed: true, size: 180, panels: [{ panelKey: 'p/sessions', open: true, size: 300 }] })
    expect(next.zones.right.panels[0]).toEqual({ panelKey: 'p/notes', open: false, size: 90 })
    expect(next.zones.bottom).toEqual(layout.zones.bottom)
    expect(next.hidden).toBe(layout.hidden)
    // A hidden panel's remembered size follows too.
    const hidden = hidePanel(layout, 'p/notes')
    expect(withGeometry(hidden, { zones: {}, panels: { 'p/notes': 77 } }).remembered['p/notes']?.size).toBe(77)
  })

  it('withGeometry clamps and ignores non-finite values', () => {
    const layout = desktopLayout()
    const next = withGeometry(layout, { zones: { left: { size: 1e9, collapsed: false }, right: { size: Number.NaN, collapsed: false } }, panels: { 'p/sessions': 1 } })
    expect(next.zones.left.size).toBe(4000)
    expect(next.zones.right.size).toBe(320)
    expect(next.zones.left.panels[0]?.size).toBe(48)
  })

  it('normalizeGeometry keeps only valid entries from whatever a store held', () => {
    expect(normalizeGeometry(null)).toEqual({ zones: {}, panels: {} })
    expect(normalizeGeometry('x')).toEqual({ zones: {}, panels: {} })
    expect(
      normalizeGeometry({
        zones: { left: { size: 10, collapsed: true }, right: { size: 'big', collapsed: false }, middle: { size: 100, collapsed: false } },
        panels: { 'p/a': 120, nokey: 100, 'p/b': 'x', __proto__: 5 }
      })
    ).toEqual({ zones: { left: { size: 48, collapsed: true } }, panels: { 'p/a': 120 } })
    const many: Record<string, number> = {}
    for (let i = 0; i < 500; i++) many[`p/${i}`] = 100
    expect(Object.keys(normalizeGeometry({ panels: many }).panels)).toHaveLength(200)
  })
})

/** localStorage stand-in; `broken` makes every call throw (blocked site data, full quota). */
function fakeStorage(): StorageLike & { data: Map<string, string>; broken: boolean } {
  const data = new Map<string, string>()
  return {
    data,
    broken: false,
    getItem(key) {
      if (this.broken) throw new Error('SecurityError')
      return data.get(key) ?? null
    },
    setItem(key, value) {
      if (this.broken) throw new Error('QuotaExceededError')
      data.set(key, value)
    }
  }
}

describe('browserGeometryStore', () => {
  it('stores per project and reads back a checked geometry', () => {
    const storage = fakeStorage()
    const a = browserGeometryStore(() => storage, 'aaaa')
    const b = browserGeometryStore(() => storage, 'bbbb')
    expect(a.load()).toBeUndefined()
    a.save({ zones: { left: { size: 150, collapsed: true } }, panels: {} })
    expect(a.load()).toEqual({ zones: { left: { size: 150, collapsed: true } }, panels: {} })
    expect(b.load()).toBeUndefined()
    expect([...storage.data.keys()]).toEqual([`${GEOMETRY_KEY_PREFIX}aaaa`])
    storage.data.set(`${GEOMETRY_KEY_PREFIX}bbbb`, '{"zones":{"left":{"size":-5,"collapsed":false}}}')
    expect(b.load()).toEqual({ zones: { left: { size: 48, collapsed: false } }, panels: {} })
    storage.data.set(`${GEOMETRY_KEY_PREFIX}bbbb`, 'not json')
    expect(b.load()).toBeUndefined()
  })

  it('without storage (missing, throwing) it lives in memory for the page', () => {
    const storage = fakeStorage()
    storage.broken = true
    const geometry = { zones: { right: { size: 99, collapsed: false } }, panels: {} }
    for (const store of [browserGeometryStore(() => storage, 'aaaa'), browserGeometryStore(() => undefined, 'aaaa'), browserGeometryStore(() => storage, undefined)]) {
      expect(store.load()).toBeUndefined()
      store.save(geometry)
      expect(store.load()).toEqual(geometry)
    }
    const throwingGetter = browserGeometryStore(() => {
      throw new Error('SecurityError')
    }, 'aaaa')
    throwingGetter.save(geometry)
    expect(throwingGetter.load()).toEqual(geometry)
  })
})

/** A bridge that answers `layout.set` like main with keepGeometry would, and records what was sent. */
function remoteBridge(stored: { layout: LayoutState }): {
  bridge: LayoutBridge
  sent: LayoutState[]
  emit(view: LayoutView): void
} {
  const sent: LayoutState[] = []
  const listeners = new Set<(view: LayoutView) => void>()
  const bridge = {
    invoke: async (channel: string, payload?: { layout: LayoutState }) => {
      if (channel === 'layout.get') return { layout: stored.layout, panels }
      if (channel === 'layout.set') {
        sent.push(payload!.layout)
        stored.layout = withGeometry(payload!.layout, geometryOf(stored.layout))
        return { layout: stored.layout, panels }
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: (_channel: string, listener: (view: LayoutView) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as unknown as LayoutBridge
  return {
    bridge,
    sent,
    emit: (view) => {
      for (const l of listeners) l(view)
    }
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('LayoutSync with a view geometry (the web shell)', () => {
  async function remote(storage = fakeStorage()): Promise<{
    sync: LayoutSync
    fake: ReturnType<typeof remoteBridge>
    stored: { layout: LayoutState }
    storage: ReturnType<typeof fakeStorage>
  }> {
    const stored = { layout: desktopLayout() }
    const fake = remoteBridge(stored)
    const sync = new LayoutSync(fake.bridge, browserGeometryStore(() => storage, 'aaaa'))
    sync.start()
    await settle()
    return { sync, fake, stored, storage }
  }

  it('starts from the desktop geometry when it has none of its own', async () => {
    const { sync } = await remote()
    expect(sync.get().layout).toEqual(desktopLayout())
  })

  it('a splitter drag, a panel resize or a collapse stays in the browser: nothing is sent to main', async () => {
    const { sync, fake, stored, storage } = await remote()
    sync.preview((l) => resizeZone(l, 'left', 200))
    sync.preview((l) => resizeZone(l, 'left', 180))
    sync.flush()
    sync.commit((l) => setZoneCollapsed(l, 'right', true))
    sync.commit((l) => resizePanel(l, 'p/sessions', 120))
    await settle()
    expect(fake.sent).toHaveLength(0)
    expect(stored.layout).toEqual(desktopLayout())
    expect(sync.get().layout.zones.left).toMatchObject({ size: 180, collapsed: false })
    expect(sync.get().layout.zones.right.collapsed).toBe(true)
    expect(sync.get().layout.zones.left.panels[0]?.size).toBe(120)
    expect(JSON.parse(storage.data.get(`${GEOMETRY_KEY_PREFIX}aaaa`)!)).toMatchObject({
      zones: { left: { size: 180, collapsed: false }, right: { size: 320, collapsed: true } },
      panels: { 'p/sessions': 120 }
    })
  })

  it('a shared edit is sent with main\'s geometry, and the answer keeps the view\'s own', async () => {
    const { sync, fake, stored } = await remote()
    sync.commit((l) => resizeZone(l, 'left', 150))
    sync.commit((l) => setZoneCollapsed(l, 'bottom', false))
    // Opening Notes is shared (open/closed and placement are the window's, not the view's).
    sync.commit((l) => togglePanel(l, 'p/notes'))
    sync.commit((l) => movePanel(l, 'p/notes', 'left'))
    await settle()
    expect(fake.sent.length).toBeGreaterThan(0)
    for (const layout of fake.sent) {
      expect(layout.zones.left.size).toBe(400)
      expect(layout.zones.bottom.collapsed).toBe(true)
    }
    expect(stored.layout.zones.left.panels.map((p) => [p.panelKey, p.open, p.size])).toEqual([
      ['p/sessions', true, 300],
      ['p/notes', true, 240]
    ])
    expect(stored.layout.zones.left.size).toBe(400)
    expect(sync.get().layout.zones.left.size).toBe(150)
    expect(sync.get().layout.zones.bottom.collapsed).toBe(false)
  })

  it('main\'s updates (the desktop resizing) do not move the view\'s own sizes', async () => {
    const { sync, fake } = await remote()
    sync.commit((l) => resizeZone(l, 'left', 150))
    await settle()
    const desktopResized = resizeZone(togglePanel(desktopLayout(), 'p/notes'), 'left', 600)
    fake.emit({ layout: desktopResized, panels })
    expect(sync.get().layout.zones.left.size).toBe(150)
    // The shared part (Notes opened on the desktop) comes through.
    expect(sync.get().layout.zones.right.panels[0]?.open).toBe(true)
    // Once the view has sized anything, its whole geometry is its own (taken at that edit).
    fake.emit({ layout: resizeZone(desktopResized, 'right', 500), panels })
    expect(sync.get().layout.zones.right.size).toBe(320)
    // A panel that is new to the window has no size of the view's yet: it comes with main's.
    const withNew = { ...desktopResized, zones: { ...desktopResized.zones, bottom: { ...desktopResized.zones.bottom, panels: [{ panelKey: 'p/log', open: true, size: 333 }] } } }
    fake.emit({ layout: withNew, panels: [...panels, { panelKey: 'p/log', title: 'Log', icon: 'L' }] })
    expect(sync.get().layout.zones.bottom.panels[0]?.size).toBe(333)
  })

  it('a later page (a reload, the next visit) draws the geometry it saved', async () => {
    const storage = fakeStorage()
    const first = await remote(storage)
    first.sync.commit((l) => setZoneCollapsed(resizeZone(l, 'right', 260), 'left', true))
    await settle()
    const second = await remote(storage)
    expect(second.sync.get().layout.zones.right.size).toBe(260)
    expect(second.sync.get().layout.zones.left.collapsed).toBe(true)
    expect(second.stored.layout).toEqual(desktopLayout())
  })

  it('without a geometry store (the desktop) sizes are sent as before', async () => {
    const stored = { layout: desktopLayout() }
    const sent: LayoutState[] = []
    const bridge = {
      invoke: async (channel: string, payload?: { layout: LayoutState }) => {
        if (channel === 'layout.set') sent.push(payload!.layout)
        return { layout: payload?.layout ?? stored.layout, panels }
      },
      on: () => () => undefined
    } as unknown as LayoutBridge
    const sync = new LayoutSync(bridge)
    sync.start()
    await settle()
    sync.commit((l) => resizeZone(l, 'left', 150))
    await settle()
    expect(sent.map((l) => l.zones.left.size)).toEqual([150])
  })
})

describe('LayoutService.set keepGeometry (main\'s side)', () => {
  const P = 'aaaaaaaaaaaaaaaa'
  function service(): { svc: LayoutService; stored: Map<string, LayoutState> } {
    const stored = new Map<string, LayoutState>([[P, desktopLayout()]])
    const svc = new LayoutService({ getLayout: (id) => stored.get(id), setLayout: (id, l) => stored.set(id, l), publish: () => {} })
    svc.setPluginPanels(P, 'p', [
      { id: 'sessions', title: 'Sessions', defaultZone: 'left' },
      { id: 'notes', title: 'Notes', defaultZone: 'right' }
    ])
    return { svc, stored }
  }

  it('takes the shared part of a remote view\'s layout and keeps the stored sizes and collapsed zones', () => {
    const { svc, stored } = service()
    let sent = movePanel(togglePanel(desktopLayout(), 'p/notes'), 'p/notes', 'left')
    sent = setZoneCollapsed(resizePanel(resizeZone(sent, 'left', 100), 'p/notes', 60), 'bottom', false)
    const view = svc.set(P, sent, { keepGeometry: true })!
    const layout = stored.get(P)!
    expect(layout.zones.left.size).toBe(400)
    expect(layout.zones.bottom.collapsed).toBe(true)
    expect(layout.zones.left.panels).toEqual([
      { panelKey: 'p/sessions', open: true, size: 300 },
      { panelKey: 'p/notes', open: true, size: 240 }
    ])
    expect(view.layout.zones.left.size).toBe(400)
  })

  it('the desktop\'s own edit stores its sizes as before', () => {
    const { svc, stored } = service()
    svc.set(P, resizeZone(desktopLayout(), 'left', 100))
    expect(stored.get(P)!.zones.left.size).toBe(100)
  })
})

describe('a layout edit in one view reaches the window\'s other views (design-web.md §5)', () => {
  const P = 'aaaaaaaaaaaaaaaa'

  /**
   * One window, two views over a real LayoutService: the desktop (no geometry store) and a remote
   * view (geometry mode, its layout.set with keepGeometry as the router does). An event goes to
   * every view, as sendToProject does, the sender's included.
   */
  async function mirror(): Promise<{ desktop: LayoutSync; remote: LayoutSync; stored: Map<string, LayoutState> }> {
    const stored = new Map<string, LayoutState>([[P, desktopLayout()]])
    const listeners = new Set<(view: LayoutView) => void>()
    const svc = new LayoutService({
      getLayout: (id) => stored.get(id),
      setLayout: (id, l) => stored.set(id, l),
      publish: (_id, view) => {
        for (const l of [...listeners]) l(view)
      }
    })
    svc.setPluginPanels(P, 'p', [
      { id: 'sessions', title: 'Sessions', defaultZone: 'left' },
      { id: 'notes', title: 'Notes', defaultZone: 'right' }
    ])
    const bridge = (remote: boolean): LayoutBridge =>
      ({
        invoke: async (channel: string, payload?: { layout: LayoutState }) => {
          if (channel === 'layout.get') return svc.view(P)
          if (channel === 'layout.set') return remote ? svc.set(P, payload!.layout, { keepGeometry: true }) : svc.set(P, payload!.layout)
          throw new Error(`unexpected ${channel}`)
        },
        on: (_channel: string, listener: (view: LayoutView) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }) as unknown as LayoutBridge
    const desktop = new LayoutSync(bridge(false))
    const remote = new LayoutSync(bridge(true), browserGeometryStore(() => fakeStorage(), P))
    desktop.start()
    remote.start()
    await settle()
    return { desktop, remote, stored }
  }

  const leftKeys = (l: LayoutState): string[] => l.zones.left.panels.map((p) => p.panelKey)

  it('a panel the remote view moves shows on the desktop, and a desktop splitter drag after it keeps it', async () => {
    const { desktop, remote, stored } = await mirror()
    remote.commit((l) => movePanel(togglePanel(l, 'p/notes'), 'p/notes', 'left'))
    await settle()
    expect(leftKeys(desktop.get().layout)).toEqual(['p/sessions', 'p/notes'])
    expect(desktop.get().layout.zones.left.panels[1]?.open).toBe(true)
    // The desktop's next edit is only a splitter; it must not write Notes back to the right.
    desktop.preview((l) => resizeZone(l, 'left', 250))
    desktop.flush()
    await settle()
    expect(leftKeys(stored.get(P)!)).toEqual(['p/sessions', 'p/notes'])
    expect(stored.get(P)!.zones.left.size).toBe(250)
    expect(leftKeys(remote.get().layout)).toEqual(['p/sessions', 'p/notes'])
  })

  it('a panel the desktop opens shows in the remote view, and the remote view\'s next shared edit keeps it', async () => {
    const { desktop, remote, stored } = await mirror()
    remote.commit((l) => resizeZone(l, 'left', 150))
    desktop.commit((l) => togglePanel(l, 'p/notes'))
    await settle()
    expect(remote.get().layout.zones.right.panels[0]?.open).toBe(true)
    // The remote view's own sizes stay its own.
    expect(remote.get().layout.zones.left.size).toBe(150)
    remote.commit((l) => hidePanel(l, 'p/sessions'))
    await settle()
    expect(stored.get(P)!.zones.right.panels[0]).toMatchObject({ panelKey: 'p/notes', open: true })
    expect(stored.get(P)!.hidden).toEqual(['p/sessions'])
    expect(stored.get(P)!.zones.left.size).toBe(400)
    expect(desktop.get().layout.hidden).toEqual(['p/sessions'])
    expect(desktop.get().layout.zones.right.panels[0]?.open).toBe(true)
  })
})
