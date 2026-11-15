// The D3 exception (design.md §3 "Split groups"): a pane the person ended with their own keys in a
// view (Ctrl+D, `exit`) hands that view's focus to its most recently used remaining pane of the
// group; every other close stays keys-off. Main's wiring as index.ts has it: TabManager (exitClosed),
// TabGroups (departedPanes), ViewSelections (typed, exitFocus) and view-input's handler.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TabGroups } from '../../src/main/tabs/tab-groups'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { viewInputHandler } from '../../src/main/tabs/view-input'
import { EXIT_FOCUS_TYPED_MS, ViewSelections } from '../../src/main/tabs/view-selections'
import type { ViewId } from '../../src/shared/views'
import { FakePtyBackend, type FakePty } from '../fakes/fake-pty-backend'

const P = 'aaaaaaaaaaaaaaaa'
const DESKTOP = 'desktop:1' as ViewId
const WEB = 'web:1' as ViewId

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-exit-focus-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function setup() {
  const backend = new FakePtyBackend()
  const clock = { now: 1_000_000 }
  const sent: Array<{ viewId: ViewId; tabId: string; closed: string }> = []
  const selections = new ViewSelections({
    isTab: (projectId, tabId) => tabs.list(projectId).some((t) => t.id === tabId),
    setActive: () => {},
    now: () => clock.now
  })
  const groups: TabGroups = new TabGroups({
    order: (p) => tabs.list(p).map((t) => t.id),
    setOrder: (p, ids) => tabs.setOrder(p, ids),
    publish: () => {},
    changed: () => {},
    log: () => {}
  })
  const tabs: TabManager = new TabManager({
    backend,
    projectPath: (id) => (id === P ? root : undefined),
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => undefined,
    closeOnCleanExit: () => true,
    shellMinLifeMs: 0,
    lifecycle: { closed: (id) => groups.tabClosed(id) },
    onTabsChanged: (p) => groups.sync(p),
    exitClosed: (projectId, tabId) => {
      const panes = groups.departedPanes(tabId)
      if (!panes) return
      for (const to of selections.exitFocus(projectId, tabId, panes)) sent.push({ ...to, closed: tabId })
    },
    emit: () => {},
    log: () => {}
  })
  const input = viewInputHandler({
    viewInput: (projectId, tabId, data, viewId) => tabs.viewInput(projectId, tabId, data, viewId),
    userInput: () => {},
    acted: (projectId, tabId, viewId) => selections.typed(projectId, viewId, tabId)
  })
  const ptys = new Map<string, FakePty>()
  const shell = (): string => {
    const t = tabs.create(P, { kind: 'shell' })
    ptys.set(t.id, backend.last)
    return t.id
  }
  const select = (viewId: ViewId, tabId: string): void => selections.acted(P, viewId, tabId)
  const type = (viewId: ViewId, tabId: string, data = 'x'): void => input(P, tabId, data, viewId)
  const exit = (tabId: string): void => ptys.get(tabId)!.exit(0)
  return { tabs, groups, selections, clock, sent, shell, select, type, exit }
}

describe('exit focus: the person ended the pane in this view', () => {
  it('Ctrl+D typed in the focused pane moves that view to its most recently used remaining pane', () => {
    const t = setup()
    const [a, b, c] = [t.shell(), t.shell(), t.shell()]
    t.groups.place(P, { tabId: b, at: a, edge: 'right' })
    t.groups.place(P, { tabId: c, at: b, edge: 'right' })
    // Used b, then a, then c: a is the most recent of what stays (not c's neighbour b).
    t.select(DESKTOP, b)
    t.select(DESKTOP, a)
    t.select(DESKTOP, c)
    t.type(DESKTOP, c, '\x04')
    t.clock.now += 50
    t.exit(c)
    expect(t.sent).toEqual([{ viewId: DESKTOP, tabId: a, closed: c }])
  })

  it('falls back to the group’s first pane when the view used none of the others', () => {
    const t = setup()
    const [a, b, c] = [t.shell(), t.shell(), t.shell()]
    t.groups.place(P, { tabId: b, at: a, edge: 'right' })
    t.groups.place(P, { tabId: c, at: b, edge: 'right' })
    t.type(DESKTOP, c, '\x04')
    t.exit(c)
    expect(t.sent).toEqual([{ viewId: DESKTOP, tabId: a, closed: c }])
  })

  it('a group dissolving to one tab: that tab', () => {
    const t = setup()
    const [x, a, b] = [t.shell(), t.shell(), t.shell()]
    t.groups.place(P, { tabId: b, at: a, edge: 'right' })
    t.select(DESKTOP, x)
    t.type(DESKTOP, b, 'exit\r')
    t.exit(b)
    expect(t.groups.groupsOf(P)).toEqual([])
    // x was used more recently, but it is not of the group: the survivor.
    expect(t.sent).toEqual([{ viewId: DESKTOP, tabId: a, closed: b }])
  })

  it('only the view that typed moves; another view showing the pane stays keys-off', () => {
    const t = setup()
    const [a, b] = [t.shell(), t.shell()]
    t.groups.place(P, { tabId: b, at: a, edge: 'right' })
    t.select(WEB, b)
    t.type(DESKTOP, b, '\x04')
    t.exit(b)
    expect(t.sent).toEqual([{ viewId: DESKTOP, tabId: a, closed: b }])
  })
})

describe('exit focus: every other close stays keys-off (D3)', () => {
  it('an exit nobody typed into recently', () => {
    const t = setup()
    const [a, b] = [t.shell(), t.shell()]
    t.groups.place(P, { tabId: b, at: a, edge: 'right' })
    t.type(DESKTOP, b, 'sleep 5; exit\r')
    t.clock.now += EXIT_FOCUS_TYPED_MS + 1
    t.exit(b)
    expect(t.sent).toEqual([])
  })

  it('a terminal report is not the person typing', () => {
    const t = setup()
    const [a, b] = [t.shell(), t.shell()]
    t.groups.place(P, { tabId: b, at: a, edge: 'right' })
    t.select(DESKTOP, b)
    t.type(DESKTOP, b, '\x1b[I')
    t.exit(b)
    expect(t.sent).toEqual([])
  })

  it('an exit while the view had moved to another pane', () => {
    const t = setup()
    const [a, b, c] = [t.shell(), t.shell(), t.shell()]
    t.groups.place(P, { tabId: b, at: a, edge: 'right' })
    t.groups.place(P, { tabId: c, at: b, edge: 'right' })
    t.type(DESKTOP, c, 'exit\r')
    t.select(DESKTOP, a)
    t.exit(c)
    expect(t.sent).toEqual([])
  })

  it('another view typed it: the views that did not type get nothing', () => {
    const t = setup()
    const [a, b] = [t.shell(), t.shell()]
    t.groups.place(P, { tabId: b, at: a, edge: 'right' })
    t.select(DESKTOP, b)
    t.type(WEB, b, '\x04')
    t.exit(b)
    expect(t.sent).toEqual([{ viewId: WEB, tabId: a, closed: b }])
  })

  it('a close that is not an exit (a plugin’s, the person’s): main sends nothing', () => {
    const t = setup()
    const [a, b] = [t.shell(), t.shell()]
    t.groups.place(P, { tabId: b, at: a, edge: 'right' })
    t.type(DESKTOP, b, 'x')
    t.tabs.close(P, b)
    expect(t.sent).toEqual([])
    expect(t.groups.departedPanes(b)).toEqual([a])
  })

  it('a plain tab exiting: nothing (the strip’s rule)', () => {
    const t = setup()
    const [a, b] = [t.shell(), t.shell()]
    t.type(DESKTOP, b, '\x04')
    t.exit(b)
    expect(t.sent).toEqual([])
    expect(t.tabs.list(P).map((x) => x.id)).toEqual([a])
  })
})

describe('ViewSelections.exitFocus', () => {
  it('forgets a view that went away', () => {
    const s = new ViewSelections({ isTab: () => true, setActive: () => {}, now: () => 5 })
    s.typed(P, DESKTOP, 'b')
    expect(s.exitFocus(P, 'b', ['a'])).toEqual([{ viewId: DESKTOP, tabId: 'a' }])
    s.viewGone(DESKTOP)
    expect(s.exitFocus(P, 'b', ['a'])).toEqual([])
    expect(s.exitFocus(P, 'b', [])).toEqual([])
  })
})
