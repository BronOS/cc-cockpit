import { describe, expect, it } from 'vitest'
import { CORE_PANELS, LayoutService } from '../../src/main/layout/layout-service'
import type { LayoutView } from '../../src/shared/ipc'
import { defaultLayout, hidePanel, movePanel, zoneOf, type LayoutState } from '../../src/shared/layout'

const P = 'aaaaaaaaaaaaaaaa'

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
  return { service, stored, writes, published }
}

const notes = { id: 'notes', title: 'Notes', defaultZone: 'right' as const }

describe('LayoutService.view', () => {
  it('places the core panel in its default zone, closed, without storing anything', () => {
    const { service, writes } = setup()
    const view = service.view(P)!
    expect(zoneOf(view.layout, 'core/sessions')).toBe('right')
    expect(view.layout.zones.right.panels[0]).toMatchObject({ panelKey: 'core/sessions', open: false })
    expect(view.panels.map((p) => p.panelKey)).toEqual(CORE_PANELS.map((p) => p.panelKey))
    expect(service.view(P)!.layout).toEqual(view.layout)
    expect(writes).toHaveLength(0)
  })

  it('keeps a plugin panel in its place across a read made before the plugin declared it', () => {
    const { service, stored, published } = setup()
    service.setPluginPanels(P, 'jira', [{ ...notes, defaultZone: 'left' }])
    // The user puts Notes above Sessions.
    const base = published.at(-1)!.layout
    service.set(P, movePanel(base, 'core/sessions', 'left'))
    expect(stored.get(P)!.zones.left.panels.map((p) => p.panelKey)).toEqual([
      'jira/notes',
      'core/sessions'
    ])
    // Window reopened: `layout.get` runs before the plugin declares its panels again.
    service.closeProject(P)
    expect(zoneOf(service.view(P)!.layout, 'jira/notes')).toBeUndefined()
    service.setPluginPanels(P, 'jira', [{ ...notes, defaultZone: 'left' }])
    expect(published.at(-1)!.layout.zones.left.panels.map((p) => p.panelKey)).toEqual([
      'jira/notes',
      'core/sessions'
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
    const moved = movePanel(base, 'core/sessions', 'bottom')
    const view = service.set(P, moved)!
    expect(zoneOf(view.layout, 'core/sessions')).toBe('bottom')
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
    expect(zoneOf(view.layout, 'core/sessions')).toBe('right')
    expect(service.set(P, 'nonsense')!.layout.zones.right.panels).toHaveLength(1)
  })

  it('keeps a hidden panel hidden', () => {
    const { service } = setup()
    const base = service.view(P)!.layout
    const view = service.set(P, hidePanel(base, 'core/sessions'))!
    expect(view.layout.hidden).toEqual(['core/sessions'])
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
    return { stored, service: fresh }
  }

  it('an edit sent before the host declared keeps an enabled plugin\'s panels in place', () => {
    const { stored, service } = withStoredPlugin(['x.p'])
    const before = stored.get(P)!.zones.left.panels.map((p) => p.panelKey)
    expect(before).toEqual(['x.p/a', 'x.p/b'])
    // The page only knows core panels; it moves Sessions to the left zone (appended).
    const view = service.set(P, movePanel(service.view(P)!.layout, 'core/sessions', 'left'))!
    // The reply holds only panels the page can show.
    expect(view.layout.zones.left.panels.map((p) => p.panelKey)).toEqual(['core/sessions'])
    // What is stored keeps the plugin's panels where they were, and the hidden one hidden.
    expect(stored.get(P)!.zones.left.panels.map((p) => p.panelKey)).toEqual(['x.p/a', 'x.p/b', 'core/sessions'])
    expect(stored.get(P)!.hidden).toEqual(['x.p/c'])
    expect(stored.get(P)!.remembered['x.p/c']).toMatchObject({ hidden: true, zone: 'left' })
    // Once the host declares, the view shows them in that order.
    service.setPluginPanels(P, 'x.p', [a, b, c])
    expect(service.view(P)!.layout.zones.left.panels.map((p) => p.panelKey)).toEqual([
      'x.p/a',
      'x.p/b',
      'core/sessions'
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
    const view = service.move(P, 'core/sessions', 'bottom')!
    expect(zoneOf(view.layout, 'core/sessions')).toBe('bottom')
    expect(zoneOf(view.layout, 'jira/notes')).toBe('right')
    expect(stored.get(P)).toEqual(view.layout)
    expect(published.at(-1)).toEqual(view)
  })

  it('does not store or publish when the panel is already in that zone', () => {
    const { service, writes, published } = setup()
    const before = published.length
    service.move(P, 'core/sessions', 'right')
    expect(writes).toHaveLength(0)
    expect(published).toHaveLength(before)
  })

  it('brings a hidden panel back into the chosen zone', () => {
    const { service } = setup()
    service.set(P, hidePanel(service.view(P)!.layout, 'core/sessions'))
    const view = service.move(P, 'core/sessions', 'left')!
    expect(view.layout.hidden).toEqual([])
    expect(zoneOf(view.layout, 'core/sessions')).toBe('left')
  })

  it('refuses a zone or a panel that does not exist, and stores nothing', () => {
    const { service, writes } = setup()
    expect(() => service.move(P, 'core/sessions', 'sideways')).toThrow('unknown zone')
    expect(() => service.move(P, 'jira/notes', 'left')).toThrow('unknown panel')
    expect(() => service.move(P, 'evil/panel', 'left')).toThrow('unknown panel')
    expect(writes).toHaveLength(0)
  })

  it('answers undefined for an unknown project', () => {
    expect(setup().service.move('ffffffffffffffff', 'core/sessions', 'left')).toBeUndefined()
  })
})

describe('plugin panels', () => {
  it('adds a plugin panel to its default zone and publishes', () => {
    const { service, published } = setup()
    service.view(P)
    service.setPluginPanels(P, 'jira', [notes])
    const view = published.at(-1)!
    expect(view.panels.map((p) => p.panelKey)).toEqual(['core/sessions', 'jira/notes'])
    expect(zoneOf(view.layout, 'jira/notes')).toBe('right')
  })

  it('remembers placement while the plugin is off and restores it when it returns', () => {
    const { service, published } = setup()
    service.setPluginPanels(P, 'jira', [notes])
    const placed = movePanel(published.at(-1)!.layout, 'jira/notes', 'bottom')
    service.set(P, placed)
    service.setPluginPanels(P, 'jira', [])
    expect(published.at(-1)!.panels.map((p) => p.panelKey)).toEqual(['core/sessions'])
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
    expect(panels.find((p) => p.panelKey === 'core/sessions')).not.toHaveProperty('src')
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
      service.setStatus(P, 'core/sessions', { badge: { kind: 'count', count: 3 }, error: 'boom' })
    ).toBe(true)
    expect(published.at(-1)!.panels[0]).toMatchObject({
      panelKey: 'core/sessions',
      badge: { kind: 'count', count: 3 },
      error: 'boom'
    })
    service.setStatus(P, 'core/sessions', undefined)
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
    service.setStatus(P, 'core/sessions', { badge: { kind: 'count', count: 2.9 } })
    expect(published.at(-1)!.panels[0]!.badge).toEqual({ kind: 'count', count: 2 })
    service.setStatus(P, 'core/sessions', { badge: { kind: 'count', count: 1e9 } })
    expect(published.at(-1)!.panels[0]!.badge).toEqual({ kind: 'count', count: 99_999 })
    service.setStatus(P, 'core/sessions', { badge: { kind: 'count', count: 0 } })
    expect(published.at(-1)!.panels[0]!.badge).toBeUndefined()
    service.setStatus(P, 'core/sessions', { badge: { kind: 'count', count: NaN } })
    expect(published.at(-1)!.panels[0]!.badge).toBeUndefined()
    service.setStatus(P, 'core/sessions', { badge: { kind: 'dot' } })
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
    expect(service.view(P)!.panels.map((p) => p.panelKey)).toEqual(['core/sessions'])
  })
})
