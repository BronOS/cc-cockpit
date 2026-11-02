import { describe, expect, it } from 'vitest'
import type { LayoutView, PanelInfo } from '../../src/shared/ipc'
import {
  defaultLayout,
  resizeZone,
  setZoneCollapsed,
  togglePanel,
  type LayoutState
} from '../../src/shared/layout'
import { LayoutSync, type LayoutBridge } from '../../src/renderer/zones/layout-sync'

// The zones UI itself (strips, splitters, menus) needs a DOM and is covered end to end in
// test/e2e/zones.spec.ts; this plays out the ordering races that e2e cannot pin down.

interface Deferred<T> {
  resolve(value: T): void
  reject(err: Error): void
}

/** A bridge whose answers the test releases by hand, in any order. */
function fakeBridge(): {
  bridge: LayoutBridge
  gets: Array<Deferred<LayoutView>>
  sets: Array<{ layout: LayoutState } & Deferred<LayoutView>>
  emit(view: LayoutView): void
  listeners: number
} {
  const gets: Array<Deferred<LayoutView>> = []
  const sets: Array<{ layout: LayoutState } & Deferred<LayoutView>> = []
  const listeners = new Set<(view: LayoutView) => void>()
  const bridge = {
    invoke: (channel: string, payload?: { layout: LayoutState }) =>
      new Promise<LayoutView>((resolve, reject) => {
        if (channel === 'layout.get') gets.push({ resolve, reject })
        else if (channel === 'layout.set') sets.push({ layout: payload!.layout, resolve, reject })
        else reject(new Error(`unexpected ${channel}`))
      }),
    on: (_channel: string, listener: (view: LayoutView) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as unknown as LayoutBridge
  return {
    bridge,
    gets,
    sets,
    emit: (view) => {
      for (const l of listeners) l(view)
    },
    get listeners() {
      return listeners.size
    }
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const sessions: PanelInfo = { panelKey: 'core/sessions', title: 'Sessions', icon: 'S' }

/** A stored layout that differs from the default: the Sessions panel placed, open, left zone 400. */
function storedView(panels: PanelInfo[] = [sessions]): LayoutView {
  const base = defaultLayout()
  const layout: LayoutState = {
    ...base,
    zones: {
      ...base.zones,
      left: { collapsed: false, size: 400, panels: [{ panelKey: 'core/sessions', open: true, size: 240 }] }
    }
  }
  return { layout, panels }
}

async function started(): Promise<{ sync: LayoutSync; fake: ReturnType<typeof fakeBridge> }> {
  const fake = fakeBridge()
  const sync = new LayoutSync(fake.bridge)
  sync.start()
  fake.gets[0]!.resolve(storedView())
  await settle()
  return { sync, fake }
}

describe('LayoutSync', () => {
  it('ignores edits until the first view arrives, so a key cannot store the empty default', async () => {
    const fake = fakeBridge()
    const sync = new LayoutSync(fake.bridge)
    sync.start()
    sync.commit((l) => setZoneCollapsed(l, 'left'))
    sync.preview((l) => resizeZone(l, 'left', 500))
    sync.flush()
    expect(fake.sets).toHaveLength(0)
    expect(sync.get().layout).toEqual(defaultLayout())

    // A failed `layout.get` keeps edits off too.
    fake.gets[0]!.reject(new Error('gone'))
    await settle()
    sync.commit((l) => setZoneCollapsed(l, 'left'))
    expect(fake.sets).toHaveLength(0)

    // The first view (here an event) turns them on, and the edit builds on that view.
    fake.emit(storedView())
    sync.commit((l) => setZoneCollapsed(l, 'left'))
    expect(fake.sets).toHaveLength(1)
    expect(fake.sets[0]!.layout.zones.left).toMatchObject({ collapsed: true, size: 400 })
  })

  it('keeps a drag when an event lands between the last move and the flush', async () => {
    const { sync, fake } = await started()
    sync.preview((l) => resizeZone(l, 'left', 520))
    // A badge publish carries main's (older) layout.
    const badged = storedView([{ ...sessions, badge: { kind: 'dot' } }])
    fake.emit(badged)
    expect(sync.get().panels[0]!.badge).toEqual({ kind: 'dot' })
    expect(sync.get().layout.zones.left.size).toBe(520)
    sync.flush()
    expect(fake.sets[0]!.layout.zones.left.size).toBe(520)
  })

  it('does not revert a click while its layout.set is in flight, nor build the next edit on old state', async () => {
    const { sync, fake } = await started()
    sync.commit((l) => setZoneCollapsed(l, 'left'))
    // main published before it handled the set: its view still has the zone expanded.
    fake.emit(storedView())
    expect(sync.get().layout.zones.left.collapsed).toBe(true)
    sync.commit((l) => togglePanel(l, 'core/sessions'))
    expect(fake.sets[1]!.layout.zones.left).toMatchObject({ collapsed: true })
    expect(fake.sets[1]!.layout.zones.left.panels[0]!.open).toBe(false)
  })

  it('drops the answer to an older set and takes the answer to the latest', async () => {
    const { sync, fake } = await started()
    sync.commit((l) => resizeZone(l, 'left', 300))
    sync.commit((l) => resizeZone(l, 'left', 350))
    const answer = (layout: LayoutState): LayoutView => ({ layout, panels: [sessions] })
    fake.sets[0]!.resolve(answer(fake.sets[0]!.layout))
    await settle()
    expect(sync.get().layout.zones.left.size).toBe(350)
    // Still unanswered: an event must not touch the layout yet.
    fake.emit(storedView())
    expect(sync.get().layout.zones.left.size).toBe(350)

    fake.sets[1]!.resolve(answer(fake.sets[1]!.layout))
    await settle()
    expect(sync.get().layout.zones.left.size).toBe(350)
    // Everything answered: main's events apply in full again.
    fake.emit(storedView())
    expect(sync.get().layout.zones.left.size).toBe(400)
  })

  it('a start / stop / start (StrictMode) leaves one subscription', () => {
    const fake = fakeBridge()
    const sync = new LayoutSync(fake.bridge)
    const stop = sync.start()
    stop()
    sync.start()
    expect(fake.listeners).toBe(1)
  })
})
