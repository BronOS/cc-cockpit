// Task 02 of the Terminal panel (docs/design-terminal-panel.md §3, §8, §13): main's side of a docked tab.
// TabManager's `dock`, restore, TabGroups' refusal, the panel's own selection per view, the dock step's order,
// the guests' one visibility rule and the router's `tabs.dock` / `tabs.panelSelected` / `tabs.create` with `dock`.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IpcRouter, registerTabHandlers, webCaller, type IpcEventLike, type TabHandlerDeps } from '../../src/main/ipc/router'
import { buildRestorePlan, tabRecordsOf } from '../../src/main/restore'
import { dockTab, type DockDeps } from '../../src/main/tabs/dock'
import { TabGroups } from '../../src/main/tabs/tab-groups'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { EXIT_FOCUS_TYPED_MS, focusTabInView, ViewSelections } from '../../src/main/tabs/view-selections'
import { pluginOfPanelKey, tabVisible } from '../../src/shared/guest-filter'
import type { TabKind, TabRecord } from '../../src/shared/types'
import type { ViewId } from '../../src/shared/views'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const P = 'aaaaaaaaaaaaaaaa'
let root: string
let backend: FakePtyBackend

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-tpanel-')))
  backend = new FakePtyBackend()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

let clock = 0

function manager(exits: Array<{ tabId: string; closed: unknown }> = []): TabManager {
  return new TabManager({
    now: () => clock,
    backend,
    projectPath: (id) => (id === P ? root : undefined),
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => undefined,
    emit: () => {},
    closeOnCleanExit: () => true,
    exitClosed: (_p, tabId, closed) => void exits.push({ tabId, closed }),
    log: () => undefined
  })
}

describe('TabManager: dock', () => {
  it('opens a shell in the panel, refuses a dock on a Claude tab, and lists the field', () => {
    const tabs = manager()
    const sh = tabs.create(P, { kind: 'shell', dock: 'panel' })
    expect(sh.dock).toBe('panel')
    expect(tabs.dockOf(P, sh.id)).toBe('panel')
    expect(tabs.list(P)[0]!.dock).toBe('panel')
    expect(() => tabs.create(P, { kind: 'claude', dock: 'panel' })).toThrow()
    expect(tabs.list(P)).toHaveLength(1)
    const plain = tabs.create(P, { kind: 'shell' })
    expect('dock' in plain).toBe(false)
  })

  it('setDock moves a shell in and out, clears its flag, refuses other kinds, and is a no-op in place', () => {
    const tabs = manager()
    const sh = tabs.create(P, { kind: 'shell' })
    const cl = tabs.create(P, { kind: 'claude' })
    tabs.setFlag(P, sh.id, { color: 'red' })
    expect(tabs.setDock(P, sh.id, 'panel')).toBe(true)
    expect(tabs.list(P).find((t) => t.id === sh.id)!.flag).toBeUndefined()
    expect(tabs.setDock(P, sh.id, 'panel')).toBe(false)
    // A docked tab has no flag (D4, §13.14).
    expect(() => tabs.setFlag(P, sh.id, { color: 'red' })).toThrow(/no flag/)
    expect(() => tabs.toggleFlag(P, sh.id)).toThrow(/no flag/)
    expect(() => tabs.setDock(P, cl.id, 'panel')).toThrow(/shell or command/)
    expect(tabs.setDock(P, sh.id, undefined)).toBe(true)
    expect(tabs.dockOf(P, sh.id)).toBeUndefined()
    expect(() => tabs.setDock(P, 'nope', 'panel')).toThrow()
  })

  it('a clean exit of a panel tab tells exitClosed where it sat (dock and index)', () => {
    const exits: Array<{ tabId: string; closed: unknown }> = []
    const tabs = manager(exits)
    tabs.create(P, { kind: 'shell' })
    const sh = tabs.create(P, { kind: 'shell', dock: 'panel' })
    // Past the shell's minimum life: a clean exit closes it.
    clock += 10_000
    backend.last.exit(0)
    expect(exits).toEqual([{ tabId: sh.id, closed: { dock: 'panel', index: 1 } }])
  })
})

describe('restore: dock', () => {
  const rec = (partial: Partial<TabRecord> & Pick<TabRecord, 'kind'>, n = 1): TabRecord => ({ id: `tab-${n}`, cwd: root, ...partial })

  it('round trip: a docked shell and command keep their dock, their flag dropped', () => {
    const plan = buildRestorePlan({
      path: root,
      tabs: [rec({ kind: 'shell', dock: 'panel', flag: { color: 'red' } }, 1), rec({ kind: 'command', label: 'Top', command: 'top', dock: 'panel' }, 2), rec({ kind: 'shell' }, 3)]
    })
    expect(plan[0]).toMatchObject({ kind: 'shell', dock: 'panel' })
    expect(plan[0]!.flag).toBeUndefined()
    expect(plan[1]).toMatchObject({ kind: 'command', dock: 'panel' })
    expect('dock' in plan[2]!).toBe(false)
    const tabs = manager()
    const restored = tabs.restoreTab(P, plan[0]!)
    expect(restored.dock).toBe('panel')
    expect(tabRecordsOf(tabs.list(P))[0]!.dock).toBe('panel')
  })

  it('drops a dock on a Claude record (kept, in the main area) and any value that is not panel', () => {
    const plan = buildRestorePlan({
      path: root,
      tabs: [rec({ kind: 'claude', dock: 'panel' } as TabRecord, 1), rec({ kind: 'shell', dock: 'side' } as unknown as TabRecord, 2)]
    })
    expect(plan).toHaveLength(2)
    expect('dock' in plan[0]!).toBe(false)
    expect('dock' in plan[1]!).toBe(false)
    const tabs = manager()
    expect(tabs.restoreTab(P, { kind: 'claude', cwd: root, dock: 'panel' }).dock).toBeUndefined()
  })
})

describe('TabGroups: a docked tab is never a pane (§13.8)', () => {
  function setup(docked: Set<string>) {
    const orders = new Map([['p', ['a', 'b', 'c', 'd']]])
    const groups = new TabGroups({
      order: (p) => [...(orders.get(p) ?? [])],
      setOrder: (p, ids) => void orders.set(p, [...ids]),
      kindOf: (): TabKind => 'shell',
      dockedOf: (_p, t) => docked.has(t),
      publish: () => {},
      changed: () => {},
      groupsChanged: () => {},
      log: () => {}
    })
    return { groups, orders }
  }

  it('refuses a docked tab and a docked anchor with docked', () => {
    const docked = new Set(['d'])
    const { groups } = setup(docked)
    expect(groups.place('p', { tabId: 'd', at: 'a', edge: 'right' })).toEqual({ ok: false, reason: 'docked' })
    expect(groups.place('p', { tabId: 'a', at: 'd', edge: 'right' })).toEqual({ ok: false, reason: 'docked' })
    expect(groups.place('p', { tabId: 'b', at: 'a', edge: 'right' }).ok).toBe(true)
  })

  it('a member that becomes docked leaves panesOf and joinOrder; a block move of a docked tab throws', () => {
    const docked = new Set<string>()
    const { groups } = setup(docked)
    groups.place('p', { tabId: 'b', at: 'a', edge: 'right' })
    groups.place('p', { tabId: 'c', at: 'b', edge: 'right' })
    docked.add('c')
    expect(groups.joinOrder('p', 'a')).toEqual(['a', 'b'])
    expect(() => groups.reorder('p', 'c', 0, true)).toThrow(/no group/)
    // A plain full-order move still works (§13.6).
    expect(() => groups.reorder('p', 'd', 0)).not.toThrow()
  })
})

describe('ViewSelections: the panel has its own selection (§13.5, §13.4)', () => {
  function setup() {
    let clock = 1000
    const docked = new Set<string>()
    const tabsOf = new Set(['m1', 'm2', 'd1', 'd2'])
    let active: string | undefined
    const actives: Array<string | undefined> = []
    const sel = new ViewSelections({
      isTab: (_p, t) => tabsOf.has(t),
      setActive: (_p, t) => {
        active = t
        actives.push(t)
      },
      dockedOf: (_p, t) => docked.has(t),
      activeOf: () => active,
      now: () => clock
    })
    return { sel, docked, tabsOf, actives, active: () => active, tick: (ms: number) => (clock += ms) }
  }
  const D = 'desktop:1' as ViewId
  const W1 = 'web:1' as ViewId

  it('panelSelected takes docked tabs only and never moves the active tab or the main selection', () => {
    const t = setup()
    t.docked.add('d1')
    t.sel.acted(P, D, 'm1')
    expect(t.active()).toBe('m1')
    expect(t.sel.panelSelected(P, D, 'm2')).toBe(false)
    expect(t.sel.panelSelected(P, D, 'nope')).toBe(false)
    expect(t.sel.panelSelected(P, D, 'd1')).toBe(true)
    expect(t.sel.panelSelectionOf(D)).toBe('d1')
    expect(t.sel.selectionOf(D)).toBe('m1')
    expect(t.active()).toBe('m1')
  })

  it('a select or typing that names a docked tab never becomes the main selection or the active tab', () => {
    const t = setup()
    t.docked.add('d1')
    t.sel.acted(P, D, 'm1')
    t.sel.acted(P, D, 'd1')
    t.sel.typed(P, D, 'd1')
    expect(t.sel.selectionOf(D)).toBe('m1')
    expect(t.active()).toBe('m1')
    expect(t.sel.panelSelectionOf(D)).toBe('d1')
  })

  it('docking the active tab hands the active tab back at once (to the newest main selection)', () => {
    const t = setup()
    t.sel.acted(P, D, 'm1')
    t.sel.acted(P, W1, 'm2')
    expect(t.active()).toBe('m2')
    t.docked.add('m2')
    t.sel.docked(P, 'm2')
    expect(t.sel.selectionOf(W1)).toBeUndefined()
    expect(t.active()).toBe('m1')
  })

  it("a panel tab's exit hands the keys to the panel's next tab only when the person typed there just now (D9)", () => {
    const t = setup()
    t.docked.add('d1').add('d2')
    t.sel.panelSelected(P, D, 'd1')
    t.sel.typed(P, D, 'd1')
    t.sel.panelSelected(P, W1, 'd1')
    t.tick(EXIT_FOCUS_TYPED_MS - 1)
    // Only the view that typed: the other view's panel showed it, no keys.
    expect(t.sel.panelExitFocus(P, 'd1', ['d2'])).toEqual([{ viewId: D, tabId: 'd2' }])
    // Never the main area, even with no panel tab left.
    t.sel.panelSelected(P, D, 'd2')
    t.sel.typed(P, D, 'd2')
    expect(t.sel.panelExitFocus(P, 'd2', [])).toEqual([])
    t.sel.panelSelected(P, D, 'd1')
    t.sel.typed(P, D, 'd1')
    t.tick(EXIT_FOCUS_TYPED_MS + 1)
    expect(t.sel.panelExitFocus(P, 'd1', ['d2'])).toEqual([])
  })
})

describe('focusTabInView: ctx.sessions.focus naming a panel tab is ignored (§13.5)', () => {
  it('selects nothing, raises nothing', () => {
    const done: string[] = []
    const deps = {
      windowOfProject: () => 1,
      windowOfView: () => 1,
      raise: () => {
        done.push('raise')
        return true
      },
      select: (v: ViewId, t: string) => {
        done.push(`select:${v}:${t}`)
        return true
      },
      server: false,
      goto: () => true,
      whoOf: () => 'owner' as const,
      docked: (_p: string, t: string) => t === 'd1'
    }
    expect(focusTabInView(deps, P, 'd1', 'web:1' as ViewId)).toBe(false)
    expect(focusTabInView(deps, P, 'd1')).toBe(false)
    expect(done).toEqual([])
    expect(focusTabInView(deps, P, 'm1', 'web:1' as ViewId)).toBe(true)
    expect(done).toEqual(['select:web:1:m1'])
  })
})

describe('dockTab: the order of one move (main/tabs/dock.ts)', () => {
  function deps(kind: TabKind = 'shell', dock: 'panel' | undefined = undefined) {
    const steps: string[] = []
    let current = dock
    const d: DockDeps = {
      kindOf: () => kind,
      dockOf: () => current,
      ungroup: () => void steps.push('ungroup'),
      setDock: (_p, _t, next) => {
        steps.push(`setDock:${next ?? 'main'}`)
        current = next
        return true
      },
      docked: () => void steps.push('docked'),
      undocked: () => void steps.push('undocked'),
      announce: (_p, payload) => void steps.push(`announce:${payload.dock}`),
      guestsSeeing: () => {
        steps.push(`seeing:${current ?? 'main'}`)
        return new Set(['g1'])
      },
      guestsChanged: (_p, _t, saw) => void steps.push(`guests:${[...saw].join()}`),
      selectIn: (v, t) => void steps.push(`select:${v}:${t}`)
    }
    return { d, steps }
  }

  it('docks: who saw it read first, out of its group, saved, selections, announce, guests; no select', () => {
    const { d, steps } = deps()
    dockTab(d, P, 't1', 'panel', 'web:1' as ViewId)
    expect(steps).toEqual(['seeing:main', 'ungroup', 'setDock:panel', 'docked', 'announce:panel', 'guests:g1'])
  })

  it('moves back: no ungroup, then the tab is selected in the view that asked (§13.11)', () => {
    const { d, steps } = deps('command', 'panel')
    dockTab(d, P, 't1', 'main', 'web:1' as ViewId)
    expect(steps).toEqual(['seeing:panel', 'setDock:main', 'undocked', 'announce:main', 'guests:g1', 'select:web:1:t1'])
  })

  it('refuses an unknown tab and other kinds; a move to where it is does nothing', () => {
    const unknown = deps()
    unknown.d.kindOf = () => undefined
    expect(() => dockTab(unknown.d, P, 'x', 'panel', 'web:1' as ViewId)).toThrow(/unknown tab/)
    const claude = deps('claude')
    expect(() => dockTab(claude.d, P, 't', 'panel', 'web:1' as ViewId)).toThrow(/shell or command/)
    expect(claude.steps).toEqual([])
    const same = deps('shell', 'panel')
    dockTab(same.d, P, 't', 'panel', 'web:1' as ViewId)
    expect(same.steps).toEqual([])
  })

  it('a guest store that throws leaves the move standing and logs it', () => {
    const { d, steps } = deps()
    const logs: string[] = []
    d.guestsChanged = () => {
      throw new Error('boom')
    }
    d.log = (m) => void logs.push(m)
    dockTab(d, P, 't1', 'panel', 'web:1' as ViewId)
    expect(steps.at(-1)).toBe('announce:panel')
    expect(logs[0]).toMatch(/boom/)
  })
})

describe('guest-filter: the panel is the owner\'s (§13.2, §13.9)', () => {
  const guest = { kind: 'guest' as const, id: 'g', name: 'Bob', role: 'write' as const, projectId: P, scope: 'all' as const }
  it('tabVisible hides a docked tab from every guest, whatever the scope; the owner sees it', () => {
    expect(tabVisible(guest, { id: 't', dock: 'panel' }, [], () => true)).toBe(false)
    expect(tabVisible(guest, { id: 't', dock: 'anything' }, ['t'], () => true)).toBe(false)
    expect(tabVisible(guest, { id: 't' }, [], () => true)).toBe(true)
    expect(tabVisible({ kind: 'owner' }, { id: 't', dock: 'panel' }, [], () => true)).toBe(true)
  })

  it('pluginOfPanelKey: a core key is no plugin\'s', () => {
    expect(pluginOfPanelKey('core/terminal')).toBeUndefined()
    expect(pluginOfPanelKey('jira/notes')).toBe('jira')
  })
})

describe('router: tabs.dock, tabs.panelSelected, tabs.create with dock', () => {
  const CTX = { kind: 'project' as const, windowId: 1, projectId: P }
  function setup() {
    const calls: unknown[][] = []
    const listeners = new Map<string, (event: IpcEventLike, ...args: unknown[]) => unknown>()
    const router = new IpcRouter(
      { handle: (channel, listener) => void listeners.set(channel, listener) },
      (id) => (id === 11 ? CTX : undefined),
      () => true,
      () => undefined,
      (windowId, projectId) => windowId === 1 && projectId === P
    )
    const unused = new Proxy({} as TabHandlerDeps, {
      get: (_t, name) => () => {
        throw new Error(`unexpected ${String(name)}`)
      }
    })
    registerTabHandlers(router, {
      ...unused,
      dock: (...a) => void calls.push(['dock', ...a]),
      panelSelect: (projectId, tabId, viewId) => {
        calls.push(['panelSelect', projectId, tabId, viewId])
        return tabId === 'd1'
      },
      viewPanelSelect: (...a) => void calls.push(['viewPanelSelect', ...a]),
      viewSelect: (...a) => void calls.push(['viewSelect', ...a]),
      create: async (projectId, options) => {
        calls.push(['create', projectId, options])
        return null
      }
    })
    const desktopFrame = { sender: { id: 11 }, senderFrame: { parent: null, url: 'file:///app/index.html' } }
    return {
      calls,
      owner: (channel: string, payload: unknown) => router.dispatch(webCaller(CTX, 'web:1' as ViewId, 'owner'), channel as never, payload as never),
      guest: (channel: string, payload: unknown) => router.dispatch(webCaller(CTX, 'web:2' as ViewId, { guest: 'g' }), channel as never, payload as never),
      desktop: (channel: string, payload: unknown) => listeners.get(channel)!(desktopFrame, payload)
    }
  }

  it("tabs.dock: the owner's, with panel or main; anything else refused", async () => {
    const t = setup()
    await t.owner('tabs.dock', { tabId: 't1', dock: 'panel' })
    await t.desktop('tabs.dock', { tabId: 't1', dock: 'main' })
    expect(t.calls).toEqual([
      ['dock', P, 't1', 'panel', 'web:1'],
      ['dock', P, 't1', 'main', expect.stringMatching(/^desktop:/)]
    ])
    await expect(t.owner('tabs.dock', { tabId: 't1', dock: 'side' })).rejects.toThrow()
    await expect(t.guest('tabs.dock', { tabId: 't1', dock: 'panel' })).rejects.toThrow()
    expect(t.calls).toHaveLength(2)
  })

  it("tabs.panelSelected: a browser's accepted panel tab joins its stream; the main selection path is never used", async () => {
    const t = setup()
    await t.owner('tabs.panelSelected', { tabId: 'd1' })
    await t.owner('tabs.panelSelected', { tabId: 'm1' })
    await t.desktop('tabs.panelSelected', { tabId: 'd1' })
    expect(t.calls.filter((c) => c[0] === 'viewPanelSelect')).toEqual([['viewPanelSelect', 'web:1', 'd1']])
    expect(t.calls.some((c) => c[0] === 'viewSelect')).toBe(false)
    await expect(t.guest('tabs.panelSelected', { tabId: 'd1' })).rejects.toThrow()
  })

  it('tabs.create: dock on a shell or command passes on; on Claude, with beside, or not panel is refused; never a guest', async () => {
    const t = setup()
    await t.owner('tabs.create', { kind: 'shell', dock: 'panel' })
    await t.owner('tabs.create', { kind: 'command', level: 'app', entryId: 'e', dock: 'panel' })
    expect(t.calls).toEqual([
      ['create', P, { kind: 'shell', dock: 'panel' }],
      ['create', P, { kind: 'command', level: 'app', entryId: 'e', dock: 'panel' }]
    ])
    await expect(t.owner('tabs.create', { kind: 'claude', dock: 'panel' })).rejects.toThrow()
    await expect(t.owner('tabs.create', { kind: 'shell', dock: 'panel', beside: { tabId: 'x', edge: 'right' } })).rejects.toThrow()
    await expect(t.owner('tabs.create', { kind: 'shell', dock: 'main' })).rejects.toThrow()
    await expect(t.guest('tabs.create', { kind: 'shell', dock: 'panel' })).rejects.toThrow()
    expect(t.calls).toHaveLength(2)
  })
})
