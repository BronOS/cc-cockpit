// One tab strip for every view of a window (design-web.md §5.1; found by the plan Task 30 e2e): a
// tab one view creates, restarts, flags, renames, closes or moves is told to the window's other views as the
// `tabs.added` / `tabs.removed` / `tabs.moved` events every page understands, and never echoed to the
// view that acted (it has the change from its own reply).
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IpcRouter, registerTabHandlers, webCaller, type IpcEventLike, type TabHandlerDeps, type TabListEvent } from '../../src/main/ipc/router'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const P = 'aaaaaaaaaaaaaaaa'
const CTX = { kind: 'project' as const, windowId: 1, projectId: P }

let root: string
let backend: FakePtyBackend

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-tab-mirror-')))
  backend = new FakePtyBackend()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** main's wiring of the tab handlers (index.ts) over a real TabManager; `told` records `others`. */
function setup(options: { others?: boolean } = {}) {
  const tabs = new TabManager({
    backend,
    projectPath: (id) => (id === P ? root : undefined),
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => undefined,
    emit: () => {},
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
  const unused = new Proxy({} as TabHandlerDeps, {
    get: (_t, name) => () => {
      throw new Error(`unexpected ${String(name)}`)
    }
  })
  const told: Array<{ windowId: number; except: string; event: TabListEvent }> = []
  registerTabHandlers(router, {
    ...unused,
    list: (projectId) => tabs.list(projectId),
    create: (projectId, request) => {
      if (request.kind === 'command') throw new Error('no command entries here')
      return tabs.create(projectId, { kind: request.kind })
    },
    close: (projectId, tabId) => tabs.close(projectId, tabId),
    reorder: (projectId, tabId, toIndex) => tabs.reorder(projectId, tabId, toIndex),
    restart: (projectId, tabId) => tabs.restart(projectId, tabId),
    flag: (projectId, tabId, patch) => tabs.setFlag(projectId, tabId, patch),
    toggleFlag: (projectId, tabId) => tabs.toggleFlag(projectId, tabId),
    rename: (projectId, tabId, name) => tabs.rename(projectId, tabId, name),
    ...(options.others === false ? { others: undefined } : { others: (windowId, except, event) => void told.push({ windowId, except, event }) })
  })
  const desktopFrame = { sender: { id: 11 }, senderFrame: { parent: null, url: 'file:///app/index.html' } }
  return {
    tabs,
    told,
    // Always a promise, as for the page: a handler that throws at once rejects.
    desktop: async (channel: string, payload?: unknown) => listeners.get(channel)!(desktopFrame, payload),
    remote: (viewId: string, channel: string, payload?: unknown) =>
      router.dispatch(webCaller(CTX, viewId), channel, payload)
  }
}

describe('a tab-list change one view makes reaches the others', () => {
  it('a tab a browser creates is announced to the window, the browser excepted', async () => {
    const { told, remote } = setup()
    const tab = (await remote('web:1', 'tabs.create', { kind: 'shell' })) as { id: string; gen: number }
    expect(told).toEqual([{ windowId: 1, except: 'web:1', event: { channel: 'tabs.added', payload: tab } }])
  })

  it("a tab the desktop closes is removed from the browsers, with the closed process's generation", async () => {
    const { tabs, told, desktop } = setup()
    const tab = tabs.create(P, { kind: 'shell' })
    await desktop('tabs.close', { tabId: tab.id })
    expect(tabs.list(P)).toEqual([])
    expect(told).toEqual([{ windowId: 1, except: 'desktop:1', event: { channel: 'tabs.removed', payload: { tabId: tab.id, gen: tab.gen } } }])
  })

  it('a browser closing a tab tells the desktop; an unknown tab tells nobody', async () => {
    const { tabs, told, remote } = setup()
    const tab = tabs.create(P, { kind: 'shell' })
    await remote('web:2', 'tabs.close', { tabId: tab.id })
    expect(told.map((t) => [t.except, t.event.channel])).toEqual([['web:2', 'tabs.removed']])
    await expect(remote('web:2', 'tabs.close', { tabId: 'nope' })).rejects.toThrow()
    expect(told).toHaveLength(1)
  })

  it('a restart announces the new generation; a refused restart announces nothing', async () => {
    const { tabs, told, remote } = setup()
    const tab = tabs.create(P, { kind: 'shell' })
    await expect(remote('web:1', 'tabs.restart', { tabId: tab.id })).rejects.toThrow(/still running/)
    expect(told).toEqual([])
    backend.last.exit(1)
    const restarted = (await remote('web:1', 'tabs.restart', { tabId: tab.id })) as { gen: number }
    expect(restarted.gen).toBeGreaterThan(tab.gen)
    expect(told).toEqual([{ windowId: 1, except: 'web:1', event: { channel: 'tabs.added', payload: restarted } }])
  })

  it('a flag set or toggled in one view is announced with the tab as stored', async () => {
    const { tabs, told, desktop, remote } = setup()
    const tab = tabs.create(P, { kind: 'shell' })
    await desktop('tabs.flag', { tabId: tab.id, flag: { color: 'red', note: 'later' } })
    expect(told).toHaveLength(1)
    expect(told[0]!.except).toBe('desktop:1')
    expect(told[0]!.event).toEqual({ channel: 'tabs.added', payload: tabs.list(P)[0] })
    expect((told[0]!.event.payload as { flag?: unknown }).flag).toEqual({ color: 'red', note: 'later' })
    await remote('web:1', 'tabs.toggleFlag', { tabId: tab.id })
    expect(told[1]!.except).toBe('web:1')
    expect((told[1]!.event.payload as { flag?: unknown }).flag).toBeUndefined()
    // A bad patch is refused before anything is told.
    await expect(desktop('tabs.flag', { tabId: tab.id, flag: { color: 'nope' } })).rejects.toThrow()
    expect(told).toHaveLength(2)
  })

  it('a rename in one view is announced with the tab as stored; a refused one tells nobody', async () => {
    const { tabs, told, remote } = setup()
    const tab = tabs.create(P, { kind: 'claude' })
    await remote('web:1', 'tabs.rename', { tabId: tab.id, name: 'Review' })
    expect(told).toEqual([{ windowId: 1, except: 'web:1', event: { channel: 'tabs.added', payload: tabs.list(P)[0] } }])
    expect((told[0]!.event.payload as { name?: string }).name).toBe('Review')
    const shell = tabs.create(P, { kind: 'shell' })
    await expect(remote('web:1', 'tabs.rename', { tabId: shell.id, name: 'x' })).rejects.toThrow(/only a Claude tab/)
    expect(told).toHaveLength(1)
  })

  it("a move is told with the index main applied (clamped), not the one asked for", async () => {
    const { tabs, told, desktop, remote } = setup()
    const a = tabs.create(P, { kind: 'shell' })
    const b = tabs.create(P, { kind: 'shell' })
    const c = tabs.create(P, { kind: 'shell' })
    await remote('web:1', 'tabs.reorder', { tabId: a.id, toIndex: 99 })
    expect(tabs.list(P).map((t) => t.id)).toEqual([b.id, c.id, a.id])
    expect(told).toEqual([{ windowId: 1, except: 'web:1', event: { channel: 'tabs.moved', payload: { tabId: a.id, toIndex: 2 } } }])
    await desktop('tabs.reorder', { tabId: c.id, toIndex: -5 })
    expect(told[1]).toEqual({ windowId: 1, except: 'desktop:1', event: { channel: 'tabs.moved', payload: { tabId: c.id, toIndex: 0 } } })
    // A refused move (unknown tab, bad index) tells nobody.
    await expect(desktop('tabs.reorder', { tabId: 'nope', toIndex: 0 })).rejects.toThrow()
    await expect(desktop('tabs.reorder', { tabId: a.id, toIndex: 1.5 })).rejects.toThrow()
    expect(told).toHaveLength(2)
  })

  it('works with nobody to tell (no `others` wired)', async () => {
    const { tabs, desktop } = setup({ others: false })
    const tab = tabs.create(P, { kind: 'shell' })
    await desktop('tabs.close', { tabId: tab.id })
    expect(tabs.list(P)).toEqual([])
  })
})
