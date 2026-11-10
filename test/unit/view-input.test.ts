// Input from any view (design-web.md §5.2 "Input from any view", plan Task 16): a browser's keys
// take the desktop's path (router `tabs.input` -> view-input.ts -> TabManager.viewInput ->
// SessionRegistry.userInput), so `typed` and the send gate apply unchanged; TabManager notes which
// view typed last per tab (TabInfo.typedBy, `tabs.typed` only when the view changes).
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IpcRouter, registerTabHandlers, webCaller, type IpcEventLike, type TabHandlerDeps } from '../../src/main/ipc/router'
import { TYPED_ERROR } from '../../src/main/sessions/send-gate'
import { SessionRegistry } from '../../src/main/sessions/session-registry'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { viewInputHandler } from '../../src/main/tabs/view-input'
import type { EventChannel, IpcEventMap } from '../../src/shared/ipc'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const P = 'aaaaaaaaaaaaaaaa'
const ESC = '\x1b'
const CTX = { kind: 'project' as const, windowId: 1, projectId: P }

let root: string
let backend: FakePtyBackend

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-view-input-')))
  backend = new FakePtyBackend()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** main's wiring for `tabs.input`: a router, TabManager and SessionRegistry, as index.ts builds them. */
function setup() {
  const typed: Array<IpcEventMap['tabs.typed']> = []
  const sessions = new SessionRegistry({ projectName: () => 'p', broadcast: () => {}, write: () => {} })
  const tabs = new TabManager({
    backend,
    projectPath: (id) => (id === P ? root : undefined),
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => undefined,
    lifecycle: { started: (t) => sessions.tabStarted(t), closed: (id) => sessions.tabClosed(id) },
    deviceOf: (viewId) => (viewId === 'web:4' ? 'Pixel 8' : viewId === 'web:5' ? '<b>tablet</b>' : 'Desktop'),
    emit: <C extends EventChannel>(_p: string, channel: C, payload: IpcEventMap[C]) => {
      if (channel === 'tabs.typed') typed.push(payload as IpcEventMap['tabs.typed'])
    },
    log: () => undefined
  })
  const listeners = new Map<string, (event: IpcEventLike, ...args: unknown[]) => unknown>()
  const router = new IpcRouter(
    { handle: (channel, listener) => void listeners.set(channel, listener) },
    (id) => (id === 11 ? CTX : undefined),
    () => true,
    () => undefined,
    (windowId, projectId) => windowId === 1 && projectId === P
  )
  // Only `input` is reached by these tests; any other handler answering would be a wiring mistake.
  const unused = new Proxy({} as TabHandlerDeps, {
    get: (_t, name) => () => {
      throw new Error(`unexpected ${String(name)}`)
    }
  })
  registerTabHandlers(router, {
    ...unused,
    input: viewInputHandler({
      viewInput: (projectId, tabId, data, viewId) => tabs.viewInput(projectId, tabId, data, viewId),
      userInput: (projectId, tabId, data) => sessions.userInput(projectId, tabId, data)
    })
  })
  const remote = (viewId: string, tabId: string, data: string): Promise<unknown> =>
    router.dispatch(webCaller(CTX, viewId), 'tabs.input', { tabId, data })
  const desktop = (tabId: string, data: string): unknown =>
    listeners.get('tabs.input')!({ sender: { id: 11 }, senderFrame: { parent: null, url: 'file:///app/index.html' } }, { tabId, data })
  return { tabs, sessions, typed, remote, desktop, router }
}

describe('input from a remote view', () => {
  it("sets typed like the desktop's keys: a queued plugin text is dropped and the next plugin send refused", async () => {
    const { tabs, sessions, remote } = setup()
    const tab = tabs.create(P, { kind: 'claude' })
    const pty = backend.last
    // Starting: a plugin's text waits in the queue.
    expect(sessions.send(tab.id, 'from a plugin', 'plugin').delivered).toBe(false)
    expect(sessions.get(tab.id)?.queue).toHaveLength(1)
    // A browser's focus report (the person clicked into its terminal) is not typing.
    await remote('web:4', tab.id, `${ESC}[I`)
    expect(sessions.get(tab.id)?.typed).toBe(false)
    expect(sessions.get(tab.id)?.queue).toHaveLength(1)
    await remote('web:4', tab.id, 'hi')
    expect(pty.writes.join('')).toBe(`${ESC}[Ihi`)
    expect(sessions.get(tab.id)).toMatchObject({ typed: true, queue: [] })
    expect(() => sessions.send(tab.id, 'again', 'plugin')).toThrow(TYPED_ERROR)
    sessions.dispose()
  })

  it('a view bound to a window that is gone reaches neither the pty nor the registry; an unknown tab is ignored', async () => {
    const { tabs, sessions, typed, remote, router } = setup()
    const tab = tabs.create(P, { kind: 'claude' })
    const gone = webCaller({ kind: 'project', windowId: 2, projectId: P }, 'web:4')
    await expect(router.dispatch(gone, 'tabs.input', { tabId: tab.id, data: 'x' })).rejects.toThrow()
    await remote('web:4', 'no-such-tab', 'x')
    expect(sessions.get(tab.id)?.typed).toBe(false)
    expect(backend.last.writes).toEqual([])
    expect(typed).toEqual([])
    sessions.dispose()
  })
})

describe('the last-typed device per tab', () => {
  it('follows whoever typed, tells the views only when the view changes, and is part of the tab', async () => {
    const { tabs, typed, remote, desktop } = setup()
    const a = tabs.create(P, { kind: 'shell' })
    const b = tabs.create(P, { kind: 'shell' })
    expect(tabs.list(P)[0]!.typedBy).toBeUndefined()
    await desktop(a.id, 'l')
    await desktop(a.id, 's')
    await remote('web:4', a.id, `${ESC}[I`) // a focus report: no change
    await remote('web:4', a.id, 'x')
    await remote('web:4', a.id, 'y')
    await remote('web:5', b.id, 'z')
    await desktop(a.id, '\r')
    expect(typed).toEqual([
      { tabId: a.id, viewId: 'desktop:1', device: 'Desktop' },
      { tabId: a.id, viewId: 'web:4', device: 'Pixel 8' },
      // The device's name is its own text; pages draw it as plain text.
      { tabId: b.id, viewId: 'web:5', device: '<b>tablet</b>' },
      { tabId: a.id, viewId: 'desktop:1', device: 'Desktop' }
    ])
    expect(tabs.list(P).map((t) => t.typedBy)).toEqual([
      { viewId: 'desktop:1', device: 'Desktop' },
      { viewId: 'web:5', device: '<b>tablet</b>' }
    ])
    // A restart keeps it (the same tab); the next key from the same view is still no event.
    backend.last.exit(0)
    tabs.restart(P, b.id)
    await remote('web:5', b.id, 'again')
    expect(tabs.list(P)[1]!.typedBy).toEqual({ viewId: 'web:5', device: '<b>tablet</b>' })
    expect(typed).toHaveLength(4)
  })

  it('a view that is gone is no longer the last typist, and the views are told', async () => {
    const { tabs, typed, remote } = setup()
    const a = tabs.create(P, { kind: 'shell' })
    const b = tabs.create(P, { kind: 'shell' })
    await remote('web:4', a.id, 'x')
    await remote('web:5', b.id, 'y')
    typed.length = 0
    tabs.viewGone('web:4')
    expect(typed).toEqual([{ tabId: a.id, viewId: null, device: null }])
    expect(tabs.list(P).map((t) => t.typedBy)).toEqual([undefined, { viewId: 'web:5', device: '<b>tablet</b>' }])
    tabs.viewGone('web:4')
    expect(typed).toHaveLength(1)
  })

  it('a terminal reply is no typing', () => {
    const { tabs, typed } = setup()
    const tab = tabs.create(P, { kind: 'shell' })
    // Web access off: a cursor report from a view is passed (the desktop answers as before) but is not typing.
    tabs.viewInput(P, tab.id, `${ESC}[3;4R`, 'web:4')
    expect(typed).toEqual([])
  })
})
