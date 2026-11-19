import { describe, expect, it } from 'vitest'
import {
  askVisible,
  guestByOverlay,
  guestByPanel,
  guestCommands,
  guestExitFocus,
  guestGroups,
  guestLayout,
  guestLinkNotice,
  guestOverlays,
  guestPanelsReload,
  guestPresence,
  guestProject,
  guestSessions,
  guestTab,
  guestTabIds,
  guestTabs,
  guestTabsMoved,
  guestTyped,
  guestWindowInfo,
  pluginOfPanelKey,
  tabVisible,
  type GuestFilterContext
} from '../../src/shared/guest-filter'
import type { GuestAccess, GuestOnlyAccess, PresenceSnapshot } from '../../src/shared/guests'
import type { LayoutView, OverlayInfo, SessionDetail, TabInfo } from '../../src/shared/ipc'
import { defaultLayout } from '../../src/shared/layout'
import type { GroupsSnapshot } from '../../src/shared/tab-groups'

// design-guests §5, shared/design.md §16.8 (spec-review 3): the pure filters every outbound route uses.

const MARKER = 'SECRET-MARKER-7f3a'
const guest = (role: 'read' | 'write' = 'read', scope: GuestOnlyAccess['scope'] = ['t1', 't2']): GuestOnlyAccess => ({
  kind: 'guest',
  id: 'g1',
  name: 'Bob',
  role,
  projectId: 'p1',
  scope
})

/** A guest that sees tabs t1, t2 (and t5 it opened), plugins a.files and bronos.team, overlays o1. */
function ctx(over: Partial<GuestFilterContext> = {}): GuestFilterContext {
  const tabs = new Set(['t1', 't2', 't5'])
  const plugins = new Set(['a.files', 'bronos.team'])
  return {
    viewId: 'web:9',
    access: guest(),
    tabVisible: (t) => tabs.has(t),
    pluginVisible: (p) => plugins.has(p),
    overlayVisible: (o) => o === 'o1',
    personOf: (v) => (v === 'web:9' ? 'Bob' : v === 'desktop:1' || v === 'web:2' ? 'Host' : undefined),
    tabOrder: () => ['t1', 'secret', 't2', 't5'],
    ...over
  }
}

const tab = (id: string, extra: Partial<TabInfo> = {}): TabInfo => ({ id, kind: 'claude', cwd: '/Users/host/project', gen: 1, ...extra })

describe('tabVisible', () => {
  const visible = (p: string): boolean => p === 'shown.plugin'
  it('the owner sees every tab, a revoked guest none', () => {
    expect(tabVisible({ kind: 'owner' }, { id: 'x', openedBy: 'hidden.plugin' }, [], visible)).toBe(true)
    expect(tabVisible({ kind: 'revoked' }, { id: 'x' }, ['x'], visible)).toBe(false)
  })

  it('a guest sees its scope and the tabs it opened', () => {
    expect(tabVisible(guest('read', 'all'), { id: 'any' }, [], visible)).toBe(true)
    expect(tabVisible(guest('read', ['a']), { id: 'a' }, [], visible)).toBe(true)
    expect(tabVisible(guest('read', ['a']), { id: 'b' }, [], visible)).toBe(false)
    expect(tabVisible(guest('write', ['a']), { id: 'b' }, ['b'], visible)).toBe(true)
  })

  it('never a tab a hidden plugin opened or draws, whatever the scope', () => {
    const all = guest('write', 'all')
    expect(tabVisible(all, { id: 'c', openedBy: 'hidden.plugin' }, [], visible)).toBe(false)
    expect(tabVisible(all, { id: 'c', page: { plugin: 'hidden.plugin' } }, ['c'], visible)).toBe(false)
    expect(tabVisible(guest('read', ['c']), { id: 'c', page: { plugin: 'hidden.plugin' } }, [], visible)).toBe(false)
    expect(tabVisible(all, { id: 'c', page: { plugin: 'shown.plugin' } }, [], visible)).toBe(true)
  })
})

describe('tabs (T, S)', () => {
  it('keeps visible tabs and strips env, room, sharing, flag note, paths, commands and device names', () => {
    const tabs = [
      tab('t1', {
        env: { TOKEN: MARKER },
        room: { id: 'r', name: MARKER, coordinator: false, mark: false } as never,
        sharedWith: ['g2'],
        flag: { color: 'red', note: MARKER },
        typedBy: { viewId: 'desktop:1', device: `${MARKER} MacBook` },
        command: `deploy --token ${MARKER}`,
        argv: ['x', MARKER]
      }),
      tab('secret', { name: MARKER })
    ]
    const out = guestTabs(tabs, ctx())
    expect(out.map((t) => t.id)).toEqual(['t1'])
    expect(JSON.stringify(out)).not.toContain(MARKER)
    expect(JSON.stringify(out)).not.toContain('/Users/host')
    expect(out[0]!.flag).toEqual({ color: 'red' })
    expect(out[0]!.typedBy).toEqual({ viewId: '', device: 'Host' })
    expect(out[0]!.sharedWith).toBeUndefined()
    // The input is not changed.
    expect(tabs[0]!.env).toEqual({ TOKEN: MARKER })
  })

  it('keeps the guest its own view id', () => {
    expect(guestTab(tab('t1', { typedBy: { viewId: 'web:9', device: 'phone' } }), ctx())!.typedBy).toEqual({ viewId: 'web:9', device: 'Bob' })
    expect(guestTab(tab('secret'), ctx())).toBeUndefined()
  })

  it('tabs.typed, moved, exitFocus and unsaved', () => {
    expect(guestTyped({ tabId: 'secret', viewId: 'web:2', device: 'x' }, ctx())).toBeUndefined()
    expect(guestTyped({ tabId: 't1', viewId: 'web:2', device: MARKER }, ctx())).toEqual({ tabId: 't1', viewId: '', device: 'Host' })
    expect(guestTyped({ tabId: 't1', viewId: null, device: null }, ctx())).toEqual({ tabId: 't1', viewId: null, device: null })
    expect(guestTabsMoved({ tabId: 't2', toIndex: 2 }, ctx())).toEqual({ tabId: 't2', toIndex: 1 })
    expect(guestTabsMoved({ tabId: 'secret', toIndex: 1 }, ctx())).toBeUndefined()
    expect(guestExitFocus({ tabId: 't1', closed: 'secret' }, ctx())).toBeUndefined()
    expect(guestExitFocus({ tabId: 't1', closed: 't2' }, ctx())).toEqual({ tabId: 't1', closed: 't2' })
    expect(guestTabIds(['t1', 'secret', 't5'], ctx())).toEqual(['t1', 't5'])
  })

  it('sessions: shared tabs only, no room or held count', () => {
    const d = (tabId: string): SessionDetail =>
      ({ tabId, status: 'idle', notes: [], files: [], queue: [], room: { title: MARKER, name: 'n', coordinator: true }, held: 3 }) as SessionDetail
    const out = guestSessions({ own: [d('t1'), d('secret')] }, ctx())
    expect(out.own.map((s) => s.tabId)).toEqual(['t1'])
    expect(JSON.stringify(out)).not.toContain(MARKER)
    expect(out.own[0]!.held).toBeUndefined()
  })
})

describe('plugins (P)', () => {
  it('layout: visible plugins only, no settings target, slot frames of visible providers, reveal of a hidden one dropped', () => {
    const layout = defaultLayout()
    layout.zones.left.panels = [
      { panelKey: 'a.files/tree', open: true, size: 1 },
      { panelKey: 'bronos.gmail/inbox', open: true, size: 1 }
    ]
    layout.hidden = ['bronos.gmail/other', 'bronos.team/team']
    layout.remembered = { 'bronos.gmail/x': { zone: 'left', open: true, size: 1, hidden: false } }
    const v: LayoutView = {
      layout,
      panels: [
        {
          panelKey: 'a.files/tree',
          title: 'Files',
          settings: { pluginId: 'a.files' } as never,
          slots: [
            { id: 's1', type: 't', pluginId: 'bronos.gmail', src: MARKER, position: 'top', height: 30, minHeight: 24 },
            { id: 's2', type: 't', pluginId: 'bronos.team', src: 'ok', position: 'top', height: 30, minHeight: 24 }
          ]
        },
        { panelKey: 'bronos.gmail/inbox', title: MARKER, badge: { count: 3 } as never }
      ],
      reveal: 'bronos.gmail/inbox',
      appSlots: [{ id: 'a1', type: 'sessions-strip', pluginId: 'cockpit.sessions', src: MARKER, position: 'top-bar', height: 30, minHeight: 24 }],
      seq: 4
    }
    const out = guestLayout(v, ctx())
    expect(JSON.stringify(out)).not.toContain(MARKER)
    expect(JSON.stringify(out)).not.toContain('bronos.gmail')
    expect(out.panels.map((p) => p.panelKey)).toEqual(['a.files/tree'])
    expect(out.panels[0]!.settings).toBeUndefined()
    expect(out.panels[0]!.slots!.map((s) => s.id)).toEqual(['s2'])
    expect(out.layout.hidden).toEqual(['bronos.team/team'])
    expect(out.reveal).toBeUndefined()
    expect(out.appSlots).toEqual([])
    expect(out.seq).toBe(4)
  })

  it('commands: core and visible plugins, never the owner menu entries, no conflicts', () => {
    const out = guestCommands(
      {
        commands: [
          { id: 'tab.newClaude', title: 'New', source: 'core' },
          { id: 'a.files/reveal', title: 'Reveal', source: 'plugin' },
          { id: 'bronos.gmail/compose', title: MARKER, source: 'plugin' },
          { id: 'tab-command:app:x', title: MARKER, source: 'tabCommand' }
        ],
        conflicts: [{ chord: 'cmd+k', commands: ['bronos.gmail/compose', 'x'] }]
      },
      ctx()
    )
    expect(out.commands.map((c) => c.id)).toEqual(['tab.newClaude', 'a.files/reveal'])
    expect(out.conflicts).toEqual([])
  })

  it('panels.reload and webview events follow the plugin', () => {
    expect(guestPanelsReload({ pluginIds: ['bronos.gmail', 'a.files'] }, ctx())).toEqual({ pluginIds: ['a.files'] })
    expect(guestPanelsReload({ pluginIds: ['bronos.gmail'] }, ctx())).toBeUndefined()
    expect(guestByPanel({ panelKey: 'bronos.gmail/web', cursor: 'x' }, ctx())).toBeUndefined()
    expect(guestByPanel({ panelKey: 'a.files/web', cursor: 'x' }, ctx())).toEqual({ panelKey: 'a.files/web', cursor: 'x' })
    expect(pluginOfPanelKey('a.b/c')).toBe('a.b')
    expect(pluginOfPanelKey('/c')).toBeUndefined()
    expect(pluginOfPanelKey('nokey')).toBeUndefined()
  })
})

describe('overlays', () => {
  const overlay = (id: string, extra: Partial<OverlayInfo> = {}): OverlayInfo =>
    ({ id, kind: 'terminal', title: 't', size: 'default', ...extra }) as OverlayInfo
  it('visible overlays only; type buttons of visible plugins; Discuss for write guests into visible tabs; holder as a person', () => {
    const list = [
      overlay('o1', {
        typeButtons: [
          { id: 'b1', label: 'x', pluginId: 'bronos.gmail', pluginTitle: MARKER },
          { id: 'b2', label: 'y', pluginId: 'a.files', pluginTitle: 'Files' }
        ],
        discuss: { tabId: 't1' },
        heldBy: { viewId: 'web:2', device: MARKER }
      }),
      overlay('o2', { title: MARKER })
    ]
    const read = guestOverlays(list, ctx())
    expect(read.map((o) => o.id)).toEqual(['o1'])
    expect(JSON.stringify(read)).not.toContain(MARKER)
    expect(read[0]!.typeButtons!.map((b) => b.id)).toEqual(['b2'])
    expect(read[0]!.discuss).toBeUndefined()
    expect(read[0]!.heldBy).toEqual({ viewId: '', device: 'Host' })
    const write = guestOverlays(list, ctx({ access: guest('write') }))
    expect(write[0]!.discuss).toEqual({ tabId: 't1' })
    const hiddenTarget = guestOverlays([overlay('o1', { discuss: { tabId: 'secret' } })], ctx({ access: guest('write') }))
    expect(hiddenTarget[0]!.discuss).toBeUndefined()
    expect(guestByOverlay({ overlayId: 'o2', data: MARKER }, ctx())).toBeUndefined()
    expect(guestByOverlay({ overlayId: 'o1', data: 'x' }, ctx())).toEqual({ overlayId: 'o1', data: 'x' })
  })
})

describe('the project (D-33)', () => {
  it('id, name and colour; never the host path', () => {
    expect(guestProject({ id: 'p1', name: 'proj', path: '/Users/host/proj', missing: true, color: 'blue' })).toEqual({
      id: 'p1',
      name: 'proj',
      path: '',
      missing: false,
      color: 'blue'
    })
    const w = guestWindowInfo({ kind: 'project', project: { id: 'p1', name: 'proj', path: '/Users/host/proj', missing: false }, fullScreen: true })
    expect(JSON.stringify(w)).not.toContain('/Users/host')
    expect(w).toEqual({ kind: 'project', project: { id: 'p1', name: 'proj', path: '', missing: false }, fullScreen: true })
  })
})

describe('notices and asks', () => {
  it('a link notice only when main stamped it for this view, never a sign-in', () => {
    expect(guestLinkNotice({ url: 'https://x', to: 'web:9' }, ctx())).toEqual({ url: 'https://x', to: 'web:9' })
    expect(guestLinkNotice({ url: 'https://x', to: 'web:2' }, ctx())).toBeUndefined()
    expect(guestLinkNotice({ url: 'https://x' }, ctx())).toBeUndefined()
    expect(guestLinkNotice({ url: 'https://x', to: 'web:9', signIn: 's' }, ctx())).toBeUndefined()
  })

  it('askVisible: the owner all, read guests none, write guests trash of a visible plugin and downloads from a visible tab', () => {
    const c = ctx()
    const owner: GuestAccess = { kind: 'owner' }
    for (const kind of ['link', 'trash', 'download', 'close', 'roomRemove', 'guestClose'] as const) {
      expect(askVisible(kind, {}, owner, c), kind).toBe(true)
      expect(askVisible(kind, { pluginId: 'a.files', originTab: 't1' }, guest('read'), c), kind).toBe(false)
      expect(askVisible(kind, { pluginId: 'a.files', originTab: 't1' }, { kind: 'revoked' }, c), kind).toBe(false)
    }
    const w = guest('write')
    expect(askVisible('trash', { pluginId: 'a.files' }, w, c)).toBe(true)
    expect(askVisible('trash', { pluginId: 'bronos.gmail' }, w, c)).toBe(false)
    expect(askVisible('trash', {}, w, c)).toBe(false)
    expect(askVisible('download', { originTab: 't1' }, w, c)).toBe(true)
    expect(askVisible('download', { originTab: 'secret' }, w, c)).toBe(false)
    expect(askVisible('download', {}, w, c)).toBe(false)
    for (const kind of ['link', 'close', 'roomRemove', 'guestClose'] as const) {
      expect(askVisible(kind, { pluginId: 'a.files', originTab: 't1' }, w, c), kind).toBe(false)
    }
  })

  it('presence: a person on a hidden tab is elsewhere; last typed only on visible tabs', () => {
    const s: PresenceSnapshot = {
      seq: 3,
      people: [
        { id: 'owner', name: 'Host', role: 'owner', color: 0, state: 'live', tabId: 'secret', typing: true },
        { id: 'g1', name: 'Bob', role: 'read', color: 1, state: 'live', tabId: 't1', typing: false }
      ],
      lastTyped: { secret: 'owner', t1: 'g1' }
    }
    const out = guestPresence(s, ctx())
    expect(out.people[0]).toEqual({ id: 'owner', name: 'Host', role: 'owner', color: 0, state: 'live', tabId: null, elsewhere: true, typing: true })
    expect(out.people[1]!.tabId).toBe('t1')
    expect(out.lastTyped).toEqual({ t1: 'g1' })
    expect(JSON.stringify(out)).not.toContain('secret')
  })
})

describe('split groups (G, D-16)', () => {
  const snapshot: GroupsSnapshot = {
    seq: 7,
    order: ['t1', 'secret', 't2', 'plain'],
    groups: [
      {
        id: 'g1',
        name: MARKER,
        root: { id: 's1', dir: 'row', children: [{ tab: 't1' }, { tab: 'secret' }, { tab: 't2' }], sizes: [0.5, 0.25, 0.25] }
      }
    ]
  }

  it('removes a hidden member, renormalises the shares and hides the name', () => {
    const out = guestGroups(snapshot, ctx({ tabVisible: (t) => t !== 'secret' }))
    expect(out.seq).toBe(7)
    expect(out.order).toEqual(['t1', 't2', 'plain'])
    expect(JSON.stringify(out)).not.toContain('secret')
    expect(JSON.stringify(out)).not.toContain(MARKER)
    const g = out.groups[0]!
    expect(g.id).toBe('g1')
    expect(g.name).toBeUndefined()
    expect('tab' in g.root ? [] : g.root.children).toEqual([{ tab: 't1' }, { tab: 't2' }])
    const sizes = g.root.sizes
    expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    // canon rounds shares (GROUP_CAPS), so the ratio holds to about 1e-5.
    expect(sizes[0]! / sizes[1]!).toBeCloseTo(2, 4)
  })

  it('dissolves a group left with one pane, and changes nothing when all are visible', () => {
    const one = guestGroups(snapshot, ctx({ tabVisible: (t) => t === 't1' || t === 'plain' }))
    expect(one.groups).toEqual([])
    expect(one.order).toEqual(['t1', 'plain'])
    const all = guestGroups(snapshot, ctx({ tabVisible: () => true }))
    expect(all).toEqual(snapshot)
  })
})
