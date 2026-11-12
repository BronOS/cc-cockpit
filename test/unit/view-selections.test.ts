// The selected tab per view and the project's active tab (design-web.md §5.1 "Selected tab", plan
// Task 18): each view selects its own tab, `activeTab` is the selection of the view that acted last
// (selected or typed), and ctx.sessions.focus selects in the view the click came from only.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IpcRouter, registerTabHandlers, webCaller, type IpcEventLike, type TabHandlerDeps } from '../../src/main/ipc/router'
import { SessionRegistry } from '../../src/main/sessions/session-registry'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { viewInputHandler } from '../../src/main/tabs/view-input'
import { focusTabInView, ViewSelections, type FocusTabDeps } from '../../src/main/tabs/view-selections'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const P = 'aaaaaaaaaaaaaaaa'
const Q = 'bbbbbbbbbbbbbbbb'
const CTX = { kind: 'project' as const, windowId: 1, projectId: P }

let root: string
let backend: FakePtyBackend

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-view-sel-')))
  backend = new FakePtyBackend()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** main's wiring for `tabs.selected` and `tabs.input` (index.ts): router, TabManager, registry, selections. */
function setup() {
  const sessions = new SessionRegistry({ projectName: () => 'p', broadcast: () => {}, write: () => {} })
  const tabs = new TabManager({
    backend,
    projectPath: (id) => (id === P || id === Q ? root : undefined),
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => undefined,
    lifecycle: { started: (t) => sessions.tabStarted(t), closed: (id) => sessions.tabClosed(id) },
    emit: () => {},
    log: () => undefined
  })
  const selections = new ViewSelections({
    isTab: (projectId, tabId) => tabs.list(projectId).some((t) => t.id === tabId),
    setActive: (projectId, tabId) => sessions.setActive(projectId, tabId)
  })
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
    select: (projectId, tabId, viewId) => selections.acted(projectId, viewId, tabId),
    viewSelect: () => {},
    input: viewInputHandler({
      viewInput: (projectId, tabId, data, viewId) => tabs.viewInput(projectId, tabId, data, viewId),
      userInput: (projectId, tabId, data) => sessions.userInput(projectId, tabId, data),
      acted: (projectId, tabId, viewId) => selections.acted(projectId, viewId, tabId)
    })
  })
  const desktopFrame = { sender: { id: 11 }, senderFrame: { parent: null, url: 'file:///app/index.html' } }
  return {
    tabs,
    sessions,
    selections,
    remoteSelect: (viewId: string, tabId: string) => router.dispatch(webCaller(CTX, viewId), 'tabs.selected', { tabId }),
    remoteInput: (viewId: string, tabId: string, data: string) => router.dispatch(webCaller(CTX, viewId), 'tabs.input', { tabId, data }),
    desktopSelect: (tabId: string) => listeners.get('tabs.selected')!(desktopFrame, { tabId }),
    desktopInput: (tabId: string, data: string) => listeners.get('tabs.input')!(desktopFrame, { tabId, data })
  }
}

describe('activeTab follows the view that acted last', () => {
  it('a selection in any view makes its tab the active one; each view keeps its own', async () => {
    const { tabs, sessions, selections, remoteSelect, desktopSelect } = setup()
    const a = tabs.create(P, { kind: 'claude' })
    const b = tabs.create(P, { kind: 'claude' })
    await desktopSelect(a.id)
    expect(sessions.activeTab(P)).toBe(a.id)
    await remoteSelect('web:1', b.id)
    expect(sessions.activeTab(P)).toBe(b.id)
    expect(selections.selectionOf('desktop:1')).toBe(a.id)
    expect(selections.selectionOf('web:1')).toBe(b.id)
    await desktopSelect(a.id)
    expect(sessions.activeTab(P)).toBe(a.id)
  })

  it("typing in a view makes its tab the active one; a focus report does not", async () => {
    const { tabs, sessions, remoteSelect, desktopSelect, desktopInput, remoteInput } = setup()
    const a = tabs.create(P, { kind: 'claude' })
    const b = tabs.create(P, { kind: 'claude' })
    await desktopSelect(a.id)
    await remoteSelect('web:1', b.id)
    expect(sessions.activeTab(P)).toBe(b.id)
    // The desktop window regains focus: its terminal sends a focus report, which is not acting.
    await desktopInput(a.id, '\x1b[I')
    expect(sessions.activeTab(P)).toBe(b.id)
    await desktopInput(a.id, 'l')
    expect(sessions.activeTab(P)).toBe(a.id)
    await remoteInput('web:1', b.id, 'x')
    expect(sessions.activeTab(P)).toBe(b.id)
  })

  it('a view that leaves hands the active tab back to the newest remaining view', async () => {
    const { tabs, sessions, selections, remoteSelect, desktopSelect } = setup()
    const a = tabs.create(P, { kind: 'claude' })
    const b = tabs.create(P, { kind: 'claude' })
    const c = tabs.create(P, { kind: 'claude' })
    await desktopSelect(a.id)
    await remoteSelect('web:1', b.id)
    await remoteSelect('web:2', c.id)
    // Not the last to act: nothing moves.
    selections.viewGone('web:1')
    expect(sessions.activeTab(P)).toBe(c.id)
    selections.viewGone('web:2')
    expect(sessions.activeTab(P)).toBe(a.id)
    expect(selections.selectionOf('web:2')).toBeUndefined()
  })

  it("lastActing: of the candidates, the view that acted last (server mode's overlay holder)", async () => {
    const { tabs, selections, remoteSelect, remoteInput, desktopSelect } = setup()
    const a = tabs.create(P, { kind: 'claude' })
    expect(selections.lastActing(['web:1', 'web:2'])).toBeUndefined()
    await remoteSelect('web:1', a.id)
    await remoteSelect('web:2', a.id)
    // The desktop acting last is not a candidate: the newest browser among them wins.
    await desktopSelect(a.id)
    expect(selections.lastActing(['web:1', 'web:2'])).toBe('web:2')
    await remoteInput('web:1', a.id, 'x')
    expect(selections.lastActing(['web:1', 'web:2'])).toBe('web:1')
    expect(selections.lastActing(['web:2'])).toBe('web:2')
    selections.viewGone('web:1')
    expect(selections.lastActing(['web:1', 'web:2'])).toBe('web:2')
    expect(selections.lastActing([])).toBeUndefined()
  })

  it("ignores a tab that is not the project's, and forgets a closed window's views", async () => {
    const { tabs, sessions, selections, remoteSelect, desktopSelect } = setup()
    const a = tabs.create(P, { kind: 'claude' })
    const other = tabs.create(Q, { kind: 'claude' })
    await desktopSelect(a.id)
    await remoteSelect('web:1', other.id)
    await remoteSelect('web:1', 'nope')
    expect(sessions.activeTab(P)).toBe(a.id)
    expect(selections.selectionOf('web:1')).toBeUndefined()
    await remoteSelect('web:1', a.id)
    selections.closeProject(P)
    sessions.setActive(P, undefined)
    // A remote view of the closed window that leaves after it hands nothing back.
    selections.viewGone('desktop:1')
    expect(sessions.activeTab(P)).toBeUndefined()
  })
})

describe('focusTabInView (ctx.sessions.focus)', () => {
  function focusSetup(server = false): {
    deps: FocusTabDeps
    selected: Array<[string, string]>
    raised: string[]
    gone: Array<[string, string, string]>
  } {
    const selected: Array<[string, string]> = []
    const raised: string[] = []
    const gone: Array<[string, string, string]> = []
    const deps: FocusTabDeps = {
      windowOfProject: (projectId) => ({ [P]: 1, [Q]: 2 })[projectId],
      windowOfView: (viewId) => ({ 'web:1': 1, 'web:2': 2, 'desktop:2': 2 })[viewId],
      raise: (projectId) => (raised.push(projectId), true),
      select: (viewId, tabId) => (selected.push([viewId, tabId]), true),
      server,
      goto: (viewId, projectId, tabId) => (gone.push([viewId, projectId, tabId]), true)
    }
    return { deps, selected, raised, gone }
  }

  it('a click in a remote view selects there only, without raising the desktop window', () => {
    const { deps, selected, raised } = focusSetup()
    expect(focusTabInView(deps, P, 't1', 'web:1')).toBe(true)
    expect(selected).toEqual([['web:1', 't1']])
    expect(raised).toEqual([])
  })

  it("a click with no view, or from a view of another window, raises the tab's window and selects on its desktop view", () => {
    const { deps, selected, raised } = focusSetup()
    expect(focusTabInView(deps, P, 't1')).toBe(true)
    // web:2 is a view of project Q's window: the tab in P's window is not its to select.
    expect(focusTabInView(deps, P, 't1', 'web:2')).toBe(true)
    expect(focusTabInView(deps, P, 't1', 'web:99')).toBe(true)
    expect(selected).toEqual([
      ['desktop:1', 't1'],
      ['desktop:1', 't1'],
      ['desktop:1', 't1']
    ])
    expect(raised).toEqual([P, P, P])
  })

  // Server mode: a project window is a hidden page; raising it moves nothing on any screen.
  it("server mode: a browser view of another window is sent to the tab's project, nothing raised", () => {
    const { deps, selected, raised, gone } = focusSetup(true)
    expect(focusTabInView(deps, P, 't1', 'web:2')).toBe(true)
    expect(gone).toEqual([['web:2', P, 't1']])
    expect(selected).toEqual([])
    expect(raised).toEqual([])
  })

  it('server mode: the same window still selects in place; no view, a desktop view or a gone view raises as before', () => {
    const { deps, selected, raised, gone } = focusSetup(true)
    expect(focusTabInView(deps, P, 't1', 'web:1')).toBe(true)
    expect(focusTabInView(deps, P, 't1')).toBe(true)
    // The hidden page's own view (a desktop id) never gets `project.goto`.
    expect(focusTabInView(deps, P, 't1', 'desktop:2')).toBe(true)
    // A browser view that closed meanwhile: no view to send it to.
    expect(focusTabInView(deps, P, 't1', 'web:99')).toBe(true)
    expect(gone).toEqual([])
    expect(selected).toEqual([
      ['web:1', 't1'],
      ['desktop:1', 't1'],
      ['desktop:1', 't1'],
      ['desktop:1', 't1']
    ])
    expect(raised).toEqual([P, P, P])
  })

  it('off server mode a browser view of another window never gets project.goto', () => {
    const { deps, raised, gone } = focusSetup(false)
    expect(focusTabInView(deps, P, 't1', 'web:2')).toBe(true)
    expect(gone).toEqual([])
    expect(raised).toEqual([P])
  })

  it('is false when the tab has no window or it cannot be raised', () => {
    const { deps, selected } = focusSetup()
    expect(focusTabInView(deps, 'cccccccccccccccc', 't1', 'web:1')).toBe(false)
    expect(focusTabInView({ ...deps, raise: () => false }, P, 't1')).toBe(false)
    expect(selected).toEqual([])
  })
})
