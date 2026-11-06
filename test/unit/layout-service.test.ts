import { describe, expect, it } from 'vitest'
import { LayoutService } from '../../src/main/layout/layout-service'
import type { LayoutView } from '../../src/shared/ipc'
import { defaultLayout, hidePanel, movePanel, placePanelAt, zoneOf, type LayoutState } from '../../src/shared/layout'

const P = 'aaaaaaaaaaaaaaaa'

/** A plugin panel that is there from the start in setup(), default zone right. */
const sessionsDef = { id: 'sessions', title: 'Sessions', defaultZone: 'right' as const }

function setup(): {
  service: LayoutService
  stored: Map<string, LayoutState>
  writes: number[]
  published: LayoutView[]
} {
  const stored = new Map<string, LayoutState>([[P, defaultLayout()]])
  const writes: number[] = []
  const published: LayoutView[] = []
  const service = new LayoutService({
    getLayout: (id) => stored.get(id),
    setLayout: (id, layout) => {
      writes.push(1)
      stored.set(id, layout)
    },
    publish: (_id, view) => published.push(view)
  })
  // Core has no panels of its own: a plugin's panel stands in as the one every test can move.
  service.setPluginPanels(P, 'base', [sessionsDef])
  published.length = 0
  return { service, stored, writes, published }
}

const notes = { id: 'notes', title: 'Notes', defaultZone: 'right' as const }

describe('LayoutService.view', () => {
  it('has no core panels: a project whose plugins declare none has none', () => {
    const stored = new Map<string, LayoutState>([[P, defaultLayout()]])
    const bare = new LayoutService({ getLayout: (id) => stored.get(id), setLayout: () => {}, publish: () => {} })
    expect(bare.view(P)!.panels).toEqual([])
    expect(bare.view(P)!.layout).toEqual(defaultLayout())
  })

  it('places a declared panel in its default zone, closed, without storing anything', () => {
    const { service, writes } = setup()
    const view = service.view(P)!
    expect(zoneOf(view.layout, 'base/sessions')).toBe('right')
    expect(view.layout.zones.right.panels[0]).toMatchObject({ panelKey: 'base/sessions', open: false })
    expect(view.panels.map((p) => p.panelKey)).toEqual(['base/sessions'])
    expect(service.view(P)!.layout).toEqual(view.layout)
    expect(writes).toHaveLength(0)
  })

  it('keeps a plugin panel in its place across a read made before the plugin declared it', () => {
    const { service, stored, published } = setup()
    service.setPluginPanels(P, 'jira', [{ ...notes, defaultZone: 'left' }])
    // The user puts Notes above Sessions.
    const base = published.at(-1)!.layout
    service.set(P, movePanel(base, 'base/sessions', 'left'))
    expect(stored.get(P)!.zones.left.panels.map((p) => p.panelKey)).toEqual([
      'jira/notes',
      'base/sessions'
    ])
    // Window reopened: `layout.get` runs before the plugin declares its panels again.
    service.closeProject(P)
    expect(zoneOf(service.view(P)!.layout, 'jira/notes')).toBeUndefined()
    service.setPluginPanels(P, 'base', [sessionsDef])
    service.setPluginPanels(P, 'jira', [{ ...notes, defaultZone: 'left' }])
    expect(published.at(-1)!.layout.zones.left.panels.map((p) => p.panelKey)).toEqual([
      'jira/notes',
      'base/sessions'
    ])
  })

  it('answers undefined for an unknown project', () => {
    expect(setup().service.view('ffffffffffffffff')).toBeUndefined()
    expect(setup().service.set('ffffffffffffffff', {})).toBeUndefined()
  })
})

describe('LayoutService.set', () => {
  it('stores a valid layout as sent', () => {
    const { service, stored } = setup()
    const base = service.view(P)!.layout
    const moved = movePanel(base, 'base/sessions', 'bottom')
    const view = service.set(P, moved)!
    expect(zoneOf(view.layout, 'base/sessions')).toBe('bottom')
    expect(stored.get(P)).toEqual(view.layout)
  })

  it('cannot place a panel that does not exist, and repairs garbage', () => {
    const { service } = setup()
    const forged = {
      zones: {
        left: { collapsed: false, size: 280, panels: [{ panelKey: 'evil/panel', open: true, size: 100 }] }
      }
    }
    const view = service.set(P, forged)!
    expect(zoneOf(view.layout, 'evil/panel')).toBeUndefined()
    expect(zoneOf(view.layout, 'base/sessions')).toBe('right')
    expect(service.set(P, 'nonsense')!.layout.zones.right.panels).toHaveLength(1)
  })

  it('accepts a reorder, and a forged order stays a permutation of existing panels', () => {
    const { service, stored } = setup()
    service.setPluginPanels(P, 'jira', [notes, { id: 'board', title: 'Board', defaultZone: 'right' }])
    const base = service.view(P)!.layout
    const order = (l: LayoutState): string[] => l.zones.right.panels.map((p) => p.panelKey)
    const all = order(base).sort()
    expect(all).toHaveLength(3)
    const top = service.set(P, placePanelAt(base, 'jira/board', 'right', 0))!
    expect(order(top.layout)[0]).toBe('jira/board')
    expect(order(stored.get(P)!)[0]).toBe('jira/board')
    // Duplicates, an unknown key and an omitted panel: nothing is invented, nothing is lost.
    const mk = (panelKey: string) => ({ panelKey, open: false, size: 100 })
    const forged = {
      zones: {
        left: { collapsed: false, size: 280, panels: [mk('evil/x'), mk('jira/board'), mk('jira/board')] },
        right: { collapsed: false, size: 320, panels: [mk('jira/board'), mk('base/sessions')] }
      }
    }
    const view = service.set(P, forged)!
    const placed = ['left', 'right', 'bottom'].flatMap((z) =>
      view.layout.zones[z as 'left'].panels.map((p) => p.panelKey)
    )
    expect(placed.sort()).toEqual(all)
  })

  it('keeps a hidden panel hidden', () => {
    const { service } = setup()
    const base = service.view(P)!.layout
    const view = service.set(P, hidePanel(base, 'base/sessions'))!
    expect(view.layout.hidden).toEqual(['base/sessions'])
  })
})

describe('LayoutService.set before the plugins declared their panels', () => {
  const a = { id: 'a', title: 'A', defaultZone: 'left' as const }
  const b = { id: 'b', title: 'B', defaultZone: 'left' as const }
  const c = { id: 'c', title: 'C', defaultZone: 'left' as const }

  /** A stored layout with x.p/a, x.p/b in the left zone (in that order) and x.p/c hidden. */
  function withStoredPlugin(enabled: string[]) {
    const stored = new Map<string, LayoutState>()
    const service = new LayoutService({
      getLayout: (id) => stored.get(id),
      setLayout: (id, layout) => void stored.set(id, layout),
      publish: () => {},
      enabledPlugins: () => enabled
    })
    stored.set(P, defaultLayout())
    service.setPluginPanels(P, 'x.p', [a, b, c])
    service.set(P, hidePanel(service.view(P)!.layout, 'x.p/c'))
    // A new window: the plugin has not declared yet (its host is still launching).
    const fresh = new LayoutService({
      getLayout: (id) => stored.get(id),
      setLayout: (id, layout) => void stored.set(id, layout),
      publish: () => {},
      enabledPlugins: () => enabled
    })
    // The stand-in panel (setup()) is declared at once in the new window, x.p's are not yet.
    fresh.setPluginPanels(P, 'base', [sessionsDef])
    return { stored, service: fresh }
  }

  it('an edit sent before the host declared keeps an enabled plugin\'s panels in place', () => {
    const { stored, service } = withStoredPlugin(['x.p'])
    const before = stored.get(P)!.zones.left.panels.map((p) => p.panelKey)
    expect(before).toEqual(['x.p/a', 'x.p/b'])
    // The page only knows the declared panels; it moves Sessions to the left zone (appended).
    const view = service.set(P, movePanel(service.view(P)!.layout, 'base/sessions', 'left'))!
    // The reply holds only panels the page can show.
    expect(view.layout.zones.left.panels.map((p) => p.panelKey)).toEqual(['base/sessions'])
    // What is stored keeps the plugin's panels where they were, and the hidden one hidden.
    expect(stored.get(P)!.zones.left.panels.map((p) => p.panelKey)).toEqual(['x.p/a', 'x.p/b', 'base/sessions'])
    expect(stored.get(P)!.hidden).toEqual(['x.p/c'])
    expect(stored.get(P)!.remembered['x.p/c']).toMatchObject({ hidden: true, zone: 'left' })
    // Once the host declares, the view shows them in that order.
    service.setPluginPanels(P, 'x.p', [a, b, c])
    expect(service.view(P)!.layout.zones.left.panels.map((p) => p.panelKey)).toEqual([
      'x.p/a',
      'x.p/b',
      'base/sessions'
    ])
  })

  it('a disabled plugin is not pending: its panels go to remembered as before', () => {
    const { stored, service } = withStoredPlugin([])
    service.set(P, service.view(P)!.layout)
    expect(stored.get(P)!.zones.left.panels).toEqual([])
    expect(stored.get(P)!.remembered['x.p/a']).toMatchObject({ zone: 'left' })
  })
})

describe('LayoutService.move', () => {
  it('moves a panel to the end of another zone, stores it and publishes', () => {
    const { service, stored, published } = setup()
    service.setPluginPanels(P, 'jira', [notes])
    const view = service.move(P, 'base/sessions', 'bottom')!
    expect(zoneOf(view.layout, 'base/sessions')).toBe('bottom')
    expect(zoneOf(view.layout, 'jira/notes')).toBe('right')
    expect(stored.get(P)).toEqual(view.layout)
    expect(published.at(-1)).toEqual(view)
  })

  it('does not store or publish when the panel is already in that zone', () => {
    const { service, writes, published } = setup()
    const before = published.length
    service.move(P, 'base/sessions', 'right')
    expect(writes).toHaveLength(0)
    expect(published).toHaveLength(before)
  })

  it('brings a hidden panel back into the chosen zone', () => {
    const { service } = setup()
    service.set(P, hidePanel(service.view(P)!.layout, 'base/sessions'))
    const view = service.move(P, 'base/sessions', 'left')!
    expect(view.layout.hidden).toEqual([])
    expect(zoneOf(view.layout, 'base/sessions')).toBe('left')
  })

  it('refuses a zone or a panel that does not exist, and stores nothing', () => {
    const { service, writes } = setup()
    expect(() => service.move(P, 'base/sessions', 'sideways')).toThrow('unknown zone')
    expect(() => service.move(P, 'jira/notes', 'left')).toThrow('unknown panel')
    expect(() => service.move(P, 'evil/panel', 'left')).toThrow('unknown panel')
    expect(writes).toHaveLength(0)
  })

  it('answers undefined for an unknown project', () => {
    expect(setup().service.move('ffffffffffffffff', 'base/sessions', 'left')).toBeUndefined()
  })
})

describe('plugin panels', () => {
  it('adds a plugin panel to its default zone and publishes', () => {
    const { service, published } = setup()
    service.view(P)
    service.setPluginPanels(P, 'jira', [notes])
    const view = published.at(-1)!
    expect(view.panels.map((p) => p.panelKey)).toEqual(['base/sessions', 'jira/notes'])
    expect(zoneOf(view.layout, 'jira/notes')).toBe('right')
  })

  it('remembers placement while the plugin is off and restores it when it returns', () => {
    const { service, published } = setup()
    service.setPluginPanels(P, 'jira', [notes])
    const placed = movePanel(published.at(-1)!.layout, 'jira/notes', 'bottom')
    service.set(P, placed)
    service.setPluginPanels(P, 'jira', [])
    expect(published.at(-1)!.panels.map((p) => p.panelKey)).toEqual(['base/sessions'])
    expect(zoneOf(published.at(-1)!.layout, 'jira/notes')).toBeUndefined()
    service.setPluginPanels(P, 'jira', [notes])
    expect(zoneOf(published.at(-1)!.layout, 'jira/notes')).toBe('bottom')
  })

  it("gives a plugin panel with an entry its page's cc-plugin:// URL, and none without one", () => {
    const { service, published } = setup()
    service.setPluginPanels(P, 'acme.jira', [
      { id: 'board', title: 'Board', defaultZone: 'left', entry: 'panels/my board.html' },
      { id: 'bare', title: 'Bare', defaultZone: 'left' }
    ])
    const panels = published.at(-1)!.panels
    expect(panels.find((p) => p.panelKey === 'acme.jira/board')?.src).toBe('cc-plugin://acme.jira/panels/my%20board.html')
    expect(panels.find((p) => p.panelKey === 'acme.jira/bare')).not.toHaveProperty('src')
    expect(panels.find((p) => p.panelKey === 'base/sessions')).not.toHaveProperty('src')
  })

  it("gives a plugin panel with an icon file its cc-plugin:// image URL instead of a glyph", () => {
    const { service, published } = setup()
    service.setPluginPanels(P, 'acme.jira', [
      { id: 'board', title: 'Board', defaultZone: 'left', icon: 'icons/board icon.svg' },
      { id: 'bare', title: 'Bare', defaultZone: 'left' }
    ])
    const panels = published.at(-1)!.panels
    const board = panels.find((p) => p.panelKey === 'acme.jira/board')
    expect(board?.iconSrc).toBe('cc-plugin://acme.jira/icons/board%20icon.svg')
    expect(board).not.toHaveProperty('icon')
    expect(panels.find((p) => p.panelKey === 'acme.jira/bare')).not.toHaveProperty('iconSrc')
  })

  it('falls back to the left zone for a bad default zone', () => {
    const { service, published } = setup()
    service.setPluginPanels(P, 'jira', [{ id: 'x', title: 'X', defaultZone: 'sideways' as never }])
    expect(zoneOf(published.at(-1)!.layout, 'jira/x')).toBe('left')
  })
})

describe('panel status', () => {
  it('shows a badge and an error on the panel info and publishes', () => {
    const { service, published } = setup()
    expect(
      service.setStatus(P, 'base/sessions', { badge: { kind: 'count', count: 3 }, error: 'boom' })
    ).toBe(true)
    expect(published.at(-1)!.panels[0]).toMatchObject({
      panelKey: 'base/sessions',
      badge: { kind: 'count', count: 3 },
      error: 'boom'
    })
    service.setStatus(P, 'base/sessions', undefined)
    expect(published.at(-1)!.panels[0]!.badge).toBeUndefined()
    expect(published.at(-1)!.panels[0]!.error).toBeUndefined()
  })

  it('refuses a panel that does not exist', () => {
    const { service, published } = setup()
    expect(service.setStatus(P, 'jira/notes', { badge: { kind: 'dot' } })).toBe(false)
    expect(published).toHaveLength(0)
  })

  it('cleans a count (floor, clamp; zero or NaN shows nothing) and a dot', () => {
    const { service, published } = setup()
    service.setStatus(P, 'base/sessions', { badge: { kind: 'count', count: 2.9 } })
    expect(published.at(-1)!.panels[0]!.badge).toEqual({ kind: 'count', count: 2 })
    service.setStatus(P, 'base/sessions', { badge: { kind: 'count', count: 1e9 } })
    expect(published.at(-1)!.panels[0]!.badge).toEqual({ kind: 'count', count: 99_999 })
    service.setStatus(P, 'base/sessions', { badge: { kind: 'count', count: 0 } })
    expect(published.at(-1)!.panels[0]!.badge).toBeUndefined()
    service.setStatus(P, 'base/sessions', { badge: { kind: 'count', count: NaN } })
    expect(published.at(-1)!.panels[0]!.badge).toBeUndefined()
    service.setStatus(P, 'base/sessions', { badge: { kind: 'dot' } })
    expect(published.at(-1)!.panels[0]!.badge).toEqual({ kind: 'dot' })
  })

  it('sets the badge and the error separately, each keeping the other', () => {
    const { service, published } = setup()
    service.setPluginPanels(P, 'jira', [notes])
    const info = (): unknown => published.at(-1)!.panels.find((p) => p.panelKey === 'jira/notes')
    expect(service.setBadge(P, 'jira/notes', { kind: 'count', count: 4 })).toBe(true)
    expect(service.setError(P, 'jira/notes', 'job failed')).toBe(true)
    expect(info()).toMatchObject({ badge: { kind: 'count', count: 4 }, error: 'job failed' })
    // The ⚠ goes (the job recovered): the badge stays.
    service.setError(P, 'jira/notes', undefined)
    expect(info()).toMatchObject({ badge: { kind: 'count', count: 4 } })
    expect((info() as { error?: string }).error).toBeUndefined()
    service.setError(P, 'jira/notes', 'again')
    service.setBadge(P, 'jira/notes', null)
    expect(info()).toEqual({ panelKey: 'jira/notes', title: 'Notes', error: 'again' })
    // The same badge again publishes nothing.
    service.setBadge(P, 'jira/notes', { kind: 'dot' })
    const count = published.length
    service.setBadge(P, 'jira/notes', { kind: 'dot' })
    expect(published).toHaveLength(count)
    expect(service.setBadge(P, 'jira/other', { kind: 'dot' })).toBe(false)
    expect(service.setError(P, 'jira/other', 'x')).toBe(false)
  })

  it('carries the settings gear target of a panel into its info', () => {
    const { service, published } = setup()
    service.setPluginPanels(P, 'jira', [{ ...notes, settings: 'project' }])
    expect(published.at(-1)!.panels.find((p) => p.panelKey === 'jira/notes')).toEqual({ panelKey: 'jira/notes', title: 'Notes', settings: 'project' })
    service.setPluginPanels(P, 'jira', [notes])
    expect(published.at(-1)!.panels.find((p) => p.panelKey === 'jira/notes')).toEqual({ panelKey: 'jira/notes', title: 'Notes' })
  })

  it('sets the header apart from the badge and error, publishing only a change', () => {
    const { service, published } = setup()
    service.setPluginPanels(P, 'jira', [notes])
    const info = (): unknown => published.at(-1)!.panels.find((p) => p.panelKey === 'jira/notes')
    const header = { meta: '3 open', actions: [{ id: 'refresh', title: 'Refresh', icon: 'refresh' as const }] }
    service.setBadge(P, 'jira/notes', { kind: 'dot' })
    expect(service.setHeader(P, 'jira/notes', header)).toBe(true)
    service.setError(P, 'jira/notes', 'job failed')
    expect(info()).toEqual({ panelKey: 'jira/notes', title: 'Notes', badge: { kind: 'dot' }, error: 'job failed', header })
    const count = published.length
    service.setHeader(P, 'jira/notes', { ...header })
    expect(published).toHaveLength(count)
    service.setBadge(P, 'jira/notes', null)
    service.setError(P, 'jira/notes', undefined)
    expect(info()).toEqual({ panelKey: 'jira/notes', title: 'Notes', header })
    service.setHeader(P, 'jira/notes', null)
    expect(info()).toEqual({ panelKey: 'jira/notes', title: 'Notes' })
    expect(service.setHeader(P, 'jira/other', header)).toBe(false)
    // A panel that goes takes its header with it: it does not come back when the plugin does.
    service.setHeader(P, 'jira/notes', header)
    service.setPluginPanels(P, 'jira', [])
    service.setPluginPanels(P, 'jira', [notes])
    expect(info()).toEqual({ panelKey: 'jira/notes', title: 'Notes' })
  })

  it('drops the status of a panel whose plugin goes away', () => {
    const { service, published } = setup()
    service.setPluginPanels(P, 'jira', [notes])
    service.setStatus(P, 'jira/notes', { badge: { kind: 'dot' } })
    service.setPluginPanels(P, 'jira', [])
    service.setPluginPanels(P, 'jira', [notes])
    expect(published.at(-1)!.panels.find((p) => p.panelKey === 'jira/notes')!.badge).toBeUndefined()
  })

  it('forgets everything about a closed project', () => {
    const { service } = setup()
    service.setPluginPanels(P, 'jira', [notes])
    service.closeProject(P)
    expect(service.view(P)!.panels).toEqual([])
  })
})

describe('LayoutService slots (design-next §2)', () => {
  type Provider = { pluginId: string; entry: string; minHeight: number; maxHeight: number; epoch: number }
  function slotSetup(): {
    service: LayoutService
    published: LayoutView[]
    providers: Map<string, Provider>
    changes: string[][]
    logs: string[]
  } {
    const stored = new Map<string, LayoutState>([[P, defaultLayout()]])
    const published: LayoutView[] = []
    const providers = new Map<string, Provider>()
    const changes: string[][] = []
    const logs: string[] = []
    const service = new LayoutService({
      getLayout: (id) => stored.get(id),
      setLayout: (id, layout) => void stored.set(id, layout),
      publish: (_id, view) => void published.push(view),
      slotProvider: (_id, type) => providers.get(type),
      framesChanged: (_id, ids) => void changes.push([...ids]),
      slotLog: (_id, pluginId, text) => void logs.push(`${pluginId}: ${text}`)
    })
    service.setPluginPanels(P, 'a.inbox', [{ id: 'main', title: 'Inbox', defaultZone: 'left', slots: ['agenda'] }])
    return { service, published, providers, changes, logs }
  }
  const cal: Provider = { pluginId: 'a.cal', entry: 'slots/agenda.html', minHeight: 48, maxHeight: 320, epoch: 1 }
  const framesOf = (view: LayoutView | undefined, key = 'a.inbox/main') => view?.panels.find((p) => p.panelKey === key)?.slots

  it('draws a placement only with a provider, its page and its height clamped to the provider', () => {
    const { service, providers } = slotSetup()
    expect(service.setSlots(P, 'a.inbox/main', [{ type: 'agenda', position: 'top', height: 600, params: { day: 1 } }])).toBe(true)
    // No provider (none, "None", ambiguous, not running): no frame, the column is just the panel.
    expect(framesOf(service.view(P))).toBeUndefined()
    providers.set('agenda', cal)
    const [frame] = framesOf(service.view(P))!
    expect(frame).toEqual({
      id: expect.stringMatching(/^s\d+$/),
      type: 'agenda',
      pluginId: 'a.cal',
      src: 'cc-plugin://a.cal/slots/agenda.html',
      position: 'top',
      height: 320,
      minHeight: 48
    })
    // The params stay in main: the frame record has them, the window's view does not.
    expect(JSON.stringify(service.view(P))).not.toContain('"day"')
    expect(service.slotFrame(P, frame!.id)).toMatchObject({ host: { kind: 'panel', pluginId: 'a.inbox', panelId: 'main' }, params: { day: 1 } })
    service.setSlots(P, 'a.inbox/main', [{ type: 'agenda', position: 'bottom', height: 24 }])
    expect(framesOf(service.view(P))![0]).toMatchObject({ position: 'bottom', height: 48 })
  })

  it('keeps a frame id while nothing it shows changes; a new provider copy or new params remount it', () => {
    const { service, providers, changes } = slotSetup()
    providers.set('agenda', cal)
    service.setSlots(P, 'a.inbox/main', [{ type: 'agenda', position: 'top', height: 100 }])
    const first = framesOf(service.view(P))![0]!.id
    expect(changes.at(-1)).toEqual([first])
    // The height alone: the same frame.
    service.setSlots(P, 'a.inbox/main', [{ type: 'agenda', position: 'top', height: 120 }])
    expect(framesOf(service.view(P))![0]!.id).toBe(first)
    // The provider reloaded (a new epoch): a new frame, and the old id is reported gone.
    providers.set('agenda', { ...cal, epoch: 2 })
    const second = framesOf(service.view(P))![0]!.id
    expect(second).not.toBe(first)
    expect(changes.at(-1)).toEqual([second])
    service.setSlots(P, 'a.inbox/main', [{ type: 'agenda', position: 'top', height: 120, params: 'x' }])
    expect(framesOf(service.view(P))![0]!.id).not.toBe(second)
    // The provider turned off or gone: no frame, an empty set.
    providers.delete('agenda')
    expect(framesOf(service.view(P))).toBeUndefined()
    expect(changes.at(-1)).toEqual([])
    expect(service.slotFrame(P, second)).toBeUndefined()
  })

  it('places the app slot in the top bar, first, and draws at most 8 frames per window (logged once)', () => {
    const { service, providers, logs } = slotSetup()
    providers.set('agenda', cal)
    providers.set('sessions-strip', { pluginId: 'cockpit.sessions', entry: 'strip.html', minHeight: 24, maxHeight: 40, epoch: 1 })
    service.setPluginPanels(P, 'a.more', [
      { id: 'one', title: 'One', defaultZone: 'left', slots: ['agenda'] },
      { id: 'two', title: 'Two', defaultZone: 'left', slots: ['agenda'] }
    ])
    const four = Array.from({ length: 4 }, (_, i) => ({ type: 'agenda', position: 'top' as const, height: 50 + i }))
    service.setSlots(P, 'a.inbox/main', four)
    service.setSlots(P, 'a.more/one', four)
    service.setSlots(P, 'a.more/two', four)
    const view = service.view(P)!
    expect(view.appSlots).toEqual([expect.objectContaining({ type: 'sessions-strip', position: 'top-bar', pluginId: 'cockpit.sessions', height: 24 })])
    expect(framesOf(view)).toHaveLength(4)
    expect(framesOf(view, 'a.more/one')).toHaveLength(3)
    expect(framesOf(view, 'a.more/two')).toBeUndefined()
    // Five placements over the cap, each logged once in its host plugin's log, not on every view.
    service.view(P)
    expect(logs).toHaveLength(5)
    expect(logs[0]).toBe('a.more: slot "agenda" of panel one is not drawn: at most 8 slot frames per window')
    // App slots draw with no panel at all.
    service.setSlots(P, 'a.inbox/main', null)
    expect(framesOf(service.view(P))).toBeUndefined()
  })

  it('refuses a core or unknown panel and drops the placements of a panel that goes', () => {
    const { service, providers } = slotSetup()
    providers.set('agenda', cal)
    const one = [{ type: 'agenda', position: 'top' as const, height: 60 }]
    expect(service.setSlots(P, 'base/sessions', one)).toBe(false)
    expect(service.setSlots(P, 'a.inbox/nope', one)).toBe(false)
    service.setSlots(P, 'a.inbox/main', one)
    service.setPluginPanels(P, 'a.inbox', [])
    service.setPluginPanels(P, 'a.inbox', [{ id: 'main', title: 'Inbox', defaultZone: 'left', slots: ['agenda'] }])
    expect(framesOf(service.view(P))).toBeUndefined()
  })

  it('publishes on refreshSlots only when the frames changed; the same placements publish nothing', () => {
    const { service, providers, published } = slotSetup()
    const one = [{ type: 'agenda', position: 'top' as const, height: 60 }]
    service.setSlots(P, 'a.inbox/main', one)
    const count = published.length
    service.setSlots(P, 'a.inbox/main', one)
    service.refreshSlots(P)
    expect(published).toHaveLength(count)
    // A pick (or a provider starting) makes the frame appear: one publish, then nothing more.
    providers.set('agenda', cal)
    service.refreshSlots(P)
    expect(published).toHaveLength(count + 1)
    expect(framesOf(published.at(-1))).toHaveLength(1)
    service.refreshSlots(P)
    expect(published).toHaveLength(count + 1)
    providers.delete('agenda')
    service.refreshSlots(P)
    expect(framesOf(published.at(-1))).toBeUndefined()
  })

  it("keeps a page's setHeight within [minHeight, the frame's height]; never in the top bar", () => {
    const { service, providers } = slotSetup()
    providers.set('agenda', cal)
    providers.set('sessions-strip', { ...cal, pluginId: 'cockpit.sessions' })
    service.setSlots(P, 'a.inbox/main', [{ type: 'agenda', position: 'top', height: 200 }])
    const view = service.view(P)!
    const id = framesOf(view)![0]!.id
    expect(service.setSlotHeight(P, id, 10)).toBe(true)
    expect(framesOf(service.view(P))![0]!.pageHeight).toBe(48)
    expect(service.setSlotHeight(P, id, 999)).toBe(true)
    expect(framesOf(service.view(P))![0]!.pageHeight).toBe(200)
    expect(service.setSlotHeight(P, id, Number.NaN)).toBe(false)
    expect(service.setSlotHeight(P, 's999999', 100)).toBe(false)
    expect(service.setSlotHeight(P, view.appSlots![0]!.id, 30)).toBe(false)
  })

  it('reports every frame gone when the project closes', () => {
    const { service, providers, changes } = slotSetup()
    providers.set('agenda', cal)
    service.setSlots(P, 'a.inbox/main', [{ type: 'agenda', position: 'top', height: 60 }])
    service.view(P)
    service.closeProject(P)
    expect(changes.at(-1)).toEqual([])
  })
})
