// Task 04 (guests, design-guests §6, §16.5, D-17): what a plugin learns of a viewer. main's hub tags a guest
// view's ports with its role and refuses a hidden plugin, a revoked view or another project; a read guest of a
// plugin that is not guest-aware gets a one-way page end. The host reads the role from main's tag only (never
// the page), hands it to onMessage's `from`, onAction's `from`, the slot and page tab instances, and keeps
// ctx.views from the open lines. No Electron: in-memory port fakes.
import { describe, expect, it } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { slotOpenTag } from '../../src/host/ctx/slots'
import { pageTabOpenTag } from '../../src/host/ctx/tabs'
import { fromMainPort, panelPortTag, type PanelPort } from '../../src/host/ctx/ui'
import { tagAccess } from '../../src/host/ctx/views'
import { PanelPortHub, portViewFields, type PanelPortDeps, type PortViewTag } from '../../src/main/plugins/panel-ports'
import type { GuestAccess } from '../../src/shared/guests'
import type { GuestRole } from '../../src/shared/views'
import type { ViewAccess } from '../../src/sdk/types'
import { channel, FakePort } from '../fakes/fake-main-port'
import { hostSpec } from '../fakes/host-spec'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const GUEST = (role: GuestRole, projectId = 'p1'): GuestAccess => ({ kind: 'guest', id: 'g1', name: 'Bob', role, projectId, scope: 'all' })

function mainHub(access: Record<string, GuestAccess>, port: (pluginId: string, role: GuestRole) => 'none' | 'oneWay' | 'full') {
  const host: { pluginId: string; tag: PortViewTag }[] = []
  const renderer: { viewId: string; payload: unknown }[] = []
  const slots: unknown[] = []
  const tabs: unknown[] = []
  const settings: unknown[] = []
  const deps: PanelPortDeps<FakePort> = {
    createChannel: () => channel(1),
    runningPanels: (projectId, pluginId) => (projectId === 'p1' && (pluginId === 'a.one' || pluginId === 'b.two') ? ['board'] : undefined),
    toHost: (_p, pluginId, _panelId, _port, tag) => (host.push({ pluginId, tag }), true),
    toRenderer: (viewId, payload) => void renderer.push({ viewId, payload }),
    reload: () => {},
    close: (p) => p.close(),
    slotFrame: (projectId, frameId) =>
      projectId === 'p1' && frameId === 's1' ? ({ info: { id: 's1', pluginId: 'a.one', type: 'strip' }, host: { kind: 'panel' } } as never) : undefined,
    slotToHost: (_p, open) => (slots.push(open), true),
    pageTab: (projectId, tabId) =>
      projectId === 'p1' && tabId === '11111111-1111-4111-8111-111111111111' ? { id: tabId, pluginId: 'a.one', type: 'file' } : undefined,
    pageTabToHost: (_p, open) => (tabs.push(open), true),
    settingsPageScopes: () => ['app', 'project'],
    settingsPageToHost: (_p, open) => (settings.push(open), true),
    viewAccess: (viewId) => access[viewId] ?? { kind: 'revoked' },
    guestPort: (_projectId, pluginId, role) => port(pluginId, role),
    log: () => {}
  }
  return { hub: new PanelPortHub(deps), host, renderer, slots, tabs, settings }
}

describe('main: guest views and plugin ports (panel-ports.ts)', () => {
  const access = { 'web:1': { kind: 'owner' } as GuestAccess, 'web:2': GUEST('read'), 'web:3': GUEST('write'), 'web:4': GUEST('read', 'p2') }
  // a.one is shown and not guest-aware (read guests one-way); b.two is hidden.
  const port = (pluginId: string, role: GuestRole) => (pluginId === 'b.two' ? 'none' : role === 'read' ? 'oneWay' : 'full')

  it("tags an owner's view as before and a guest's with its role; a read guest of an unaware plugin gets a one-way page end", () => {
    const m = mainHub(access, port)
    expect(m.hub.connect('p1', 'desktop:1', 'a.one/board', 1)).toBe(true)
    expect(m.hub.connect('p1', 'web:1', 'a.one/board', 2)).toBe(true)
    expect(m.hub.connect('p1', 'web:2', 'a.one/board', 3)).toBe(true)
    expect(m.hub.connect('p1', 'web:3', 'a.one/board', 4)).toBe(true)
    expect(m.host).toEqual([
      { pluginId: 'a.one', tag: { access: 'owner' } },
      { pluginId: 'a.one', tag: { view: 'web:1', access: 'owner' } },
      { pluginId: 'a.one', tag: { view: 'web:2', access: 'read' } },
      { pluginId: 'a.one', tag: { view: 'web:3', access: 'write' } }
    ])
    expect(m.renderer.map((r) => r.payload)).toEqual([
      { panelKey: 'a.one/board', nonce: 1 },
      { panelKey: 'a.one/board', nonce: 2 },
      { panelKey: 'a.one/board', nonce: 3, oneWay: true },
      { panelKey: 'a.one/board', nonce: 4 }
    ])
  })

  it('refuses a hidden plugin, a revoked view and a guest of another project; an owner view of a hidden plugin is unchanged', () => {
    const m = mainHub(access, port)
    expect(m.hub.connect('p1', 'web:2', 'b.two/board', 1)).toBe(false)
    expect(m.hub.connect('p1', 'web:3', 'b.two/board', 1)).toBe(false)
    expect(m.hub.connect('p1', 'web:9', 'a.one/board', 1)).toBe(false)
    expect(m.hub.connect('p1', 'web:4', 'a.one/board', 1)).toBe(false)
    expect(m.host).toEqual([])
    expect(m.hub.connect('p1', 'web:1', 'b.two/board', 1)).toBe(true)
  })

  it('carries the role on slot and page tab tags; never opens a settings page for a guest', () => {
    const m = mainHub(access, port)
    expect(m.hub.connectSlot('p1', 'web:2', 's1', 1)).toBe(true)
    expect(m.hub.connectPageTab('p1', 'web:3', '11111111-1111-4111-8111-111111111111', 2)).toBe(true)
    expect(m.slots).toEqual([expect.objectContaining({ view: 'web:2', access: 'read' })])
    expect(m.tabs).toEqual([expect.objectContaining({ view: 'web:3', access: 'write' })])
    expect(m.renderer.map((r) => r.payload)).toEqual([{ panelKey: '@slot/s1', nonce: 1, oneWay: true }, expect.objectContaining({ nonce: 2 })])
    expect(m.hub.connectSettingsPage('p1', 'web:3', 'a.one', 'app', 3)).toBe(false)
    expect(m.hub.connectSettingsPage('p1', 'web:1', 'a.one', 'app', 4)).toBe(true)
    expect(m.settings).toHaveLength(1)
  })

  it('without guest deps every view is the owner\'s, as before guests', () => {
    const m = mainHub(access, port)
    const bare = new PanelPortHub<FakePort>({
      createChannel: () => channel(1),
      runningPanels: () => ['board'],
      toHost: (_p, pluginId, _id, _port, tag) => (m.host.push({ pluginId, tag }), true),
      toRenderer: () => {},
      reload: () => {},
      close: () => {}
    })
    expect(bare.connect('p1', 'web:2', 'a.one/board', 1)).toBe(true)
    expect(m.host).toEqual([{ pluginId: 'a.one', tag: { view: 'web:2', access: 'owner' } }])
  })

  it('portViewFields always carries the access (the host refuses a tag without one)', () => {
    expect(portViewFields({ access: 'owner' })).toEqual({ access: 'owner' })
    expect(portViewFields({ view: 'web:1', access: 'owner' })).toEqual({ view: 'web:1', access: 'owner' })
    expect(portViewFields({ view: 'web:1', access: 'read' })).toEqual({ view: 'web:1', access: 'read' })
  })
})

describe("host: the role from main's tag (ctx/ui.ts, slots.ts, tabs.ts, views.ts)", () => {
  it('reads a guest role only on a remote view, and refuses a malformed one rather than reading it as the owner', () => {
    expect(tagAccess('owner', undefined)).toBe('owner')
    expect(tagAccess('owner', 'web:1')).toBe('owner')
    expect(tagAccess('read', 'web:1')).toBe('read')
    expect(tagAccess('write', 'web:1')).toBe('write')
    // A tag that lost its access is refused, never read as the owner's.
    expect(tagAccess(undefined, undefined)).toBeNull()
    expect(tagAccess(undefined, 'web:1')).toBeNull()
    expect(tagAccess('read', undefined)).toBeNull()
    expect(tagAccess(1, 'web:1')).toBeNull()
    const tag = (extra: object): string => JSON.stringify({ panelPort: { pluginId: 'a.one', panelId: 'board', ...extra } })
    expect(panelPortTag(tag({ view: 'web:1', access: 'read' }))).toEqual({ pluginId: 'a.one', panelId: 'board', view: 'web:1', access: 'read' })
    expect(panelPortTag(tag({ view: 'web:1', access: 'admin' }))).toBeUndefined()
    expect(panelPortTag(tag({ access: 'write' }))).toBeUndefined()
    expect(panelPortTag(tag({ view: 'web:1' }))).toBeUndefined()
    const slot = { pluginId: 'a.one', id: 's1', type: 'strip', host: { kind: 'app', place: 'top-bar' } }
    expect(slotOpenTag(JSON.stringify({ slotOpen: { ...slot, view: 'web:2', access: 'write' } }))?.access).toBe('write')
    expect(slotOpenTag(JSON.stringify({ slotOpen: { ...slot, view: 'web:2', access: 'admin' } }))).toBeUndefined()
    expect(slotOpenTag(JSON.stringify({ slotOpen: { ...slot, view: 'web:2' } }))).toBeUndefined()
    const tab = { pluginId: 'a.one', id: '11111111-1111-4111-8111-111111111111', type: 'file' }
    expect(pageTabOpenTag(JSON.stringify({ pageTabOpen: { ...tab, view: 'web:2', access: 'read' } }))?.access).toBe('read')
    expect(pageTabOpenTag(JSON.stringify({ pageTabOpen: { ...tab, access: 'read' } }))).toBeUndefined()
    expect(pageTabOpenTag(JSON.stringify({ pageTabOpen: tab }))).toBeUndefined()
  })

  function setup() {
    const contexts = new HostContexts({ log: () => {}, call: async () => null, emit: () => {} })
    const ctx = contexts.create(
      hostSpec({ id: 'a.one', dir: '/p/one', main: 'h.js', panels: ['board'], slotTypes: ['strip'], pageTabTypes: ['file'] })
    )
    const attach = (message: string): FakePort => {
      const ch = channel(1)
      const tag = panelPortTag(message)!
      const port: PanelPort = fromMainPort(ch.host, () => contexts.detachPanelPort(tag.pluginId, tag.panelId, port))
      contexts.attachPanelPort(tag.pluginId, tag.panelId, port, tag.view, tag.access)
      ch.renderer.start()
      return ch.renderer
    }
    return { contexts, ctx, attach }
  }
  const panelTag = (view?: string, access: ViewAccess = 'owner'): string =>
    JSON.stringify({ panelPort: { pluginId: 'a.one', panelId: 'board', ...(view ? { view } : {}), access } })

  it("gives onMessage's from the tagged access, never the page's claim", async () => {
    const { ctx, attach } = setup()
    const heard: unknown[] = []
    ctx.panels.onMessage('board', (m, from) => heard.push({ m, ...from }))
    attach(panelTag()).postMessage('"d"')
    // A crafted page message naming itself the owner changes nothing: the access is the tag's.
    attach(panelTag('web:2', 'read')).postMessage(JSON.stringify({ access: 'owner', view: 'desktop' }))
    await flush()
    expect(heard).toEqual([
      { m: 'd', view: 'desktop', access: 'owner' },
      { m: { access: 'owner', view: 'desktop' }, view: 'web:2', access: 'read' }
    ])
  })

  it('keeps ctx.views from the open lines: known on the first, gone after the last, onChange both ways', async () => {
    const { ctx, attach } = setup()
    const changes: unknown[] = []
    ctx.views.onChange((e) => changes.push(e))
    const page = attach(panelTag('web:3', 'write'))
    expect(ctx.views.access('web:3')).toBe('write')
    expect(ctx.views.access('web:9')).toBeUndefined()
    page.close()
    await flush()
    expect(ctx.views.access('web:3')).toBeUndefined()
    expect(changes).toEqual([
      { view: 'web:3', access: 'write' },
      { view: 'web:3', access: undefined }
    ])
  })

  it('replays the views already open to a new onChange listener, before onChange returns', async () => {
    const { ctx, attach } = setup()
    // The guest's page connected while the plugin was still activating: before anyone listened.
    attach(panelTag('web:4', 'read'))
    attach(panelTag())
    const changes: unknown[] = []
    ctx.views.onChange((e) => changes.push(e))
    expect(changes).toEqual([
      { view: 'web:4', access: 'read' },
      { view: 'desktop', access: 'owner' }
    ])
  })

  it("gives onAction's from the access of the view's open line; an unknown remote view reads as a read guest", async () => {
    const { contexts, ctx, attach } = setup()
    const clicks: unknown[] = []
    ctx.panels.onAction('board', (id, from) => clicks.push({ id, ...from }))
    attach(panelTag('web:3', 'write'))
    contexts.handleEvent('panel.action', { pluginId: 'a.one', panelId: 'board', actionId: 'go', view: 'web:3' })
    contexts.handleEvent('panel.action', { pluginId: 'a.one', panelId: 'board', actionId: 'go', view: 'web:8' })
    contexts.handleEvent('panel.action', { pluginId: 'a.one', panelId: 'board', actionId: 'go' })
    await flush()
    expect(clicks).toEqual([
      { id: 'go', view: 'web:3', access: 'write' },
      { id: 'go', view: 'web:8', access: 'read' },
      { id: 'go', view: 'desktop', access: 'owner' }
    ])
  })

  it('gives slot and page tab instances the tagged access, and counts them in ctx.views', async () => {
    const { contexts, ctx } = setup()
    const got: ViewAccess[] = []
    ctx.slots.onOpen('strip', (slot) => void got.push(slot.access))
    ctx.tabs.onOpen('file', (tab) => void got.push(tab.access))
    const slotTag = slotOpenTag(
      JSON.stringify({ slotOpen: { pluginId: 'a.one', id: 's1', type: 'strip', host: { kind: 'app', place: 'top-bar' }, view: 'web:2', access: 'read' } })
    )!
    const s = channel(1)
    contexts.attachSlotPort(slotTag, fromMainPort(s.host, () => {}))
    const tabTag = pageTabOpenTag(
      JSON.stringify({ pageTabOpen: { pluginId: 'a.one', id: '11111111-1111-4111-8111-111111111111', type: 'file', access: 'owner' } })
    )!
    const t = channel(2)
    contexts.attachPageTabPort(tabTag, fromMainPort(t.host, () => {}))
    expect(got).toEqual(['read', 'owner'])
    expect(ctx.views.access('web:2')).toBe('read')
    expect(ctx.views.access('desktop')).toBe('owner')
    contexts.handleEvent('slot.close', { pluginId: 'a.one', id: 's1', view: 'web:2' })
    await flush()
    expect(ctx.views.access('web:2')).toBeUndefined()
  })
})
