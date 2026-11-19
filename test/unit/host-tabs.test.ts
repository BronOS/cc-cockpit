// Plan Task 4: the plugin API `ctx.tabs` (design-editor.md §1 "Core: page tabs"). Main's side is
// HostApi's `tabs.openPage` / `tabs.list` / `tabs.setTitle` over a real TabManager (only the
// caller's declared types, its own project and window, the open budget); the host's side is
// ctx.tabs and the PageTabInstance a frame's port makes (host/ctx/tabs.ts), opened the way
// host/index.ts does it (pageTabOpenTag + attachPageTabPort), with a recording fake `call`.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostContexts, type ContextDeps, type LogLevel } from '../../src/host/ctx'
import { pageTabOpenTag } from '../../src/host/ctx/tabs'
import type { PanelPort } from '../../src/host/ctx/ui'
import { parsePluginSpecs } from '../../src/host/loader'
import { HostApi, MAX_CLOSES_PER_WINDOW, MAX_PAGE_TAB_OPENS_PER_WINDOW, MAX_PAGE_TAB_TITLES_PER_WINDOW, type HostApiDeps, type HostScope } from '../../src/main/plugins/host-api'
import { TabManager } from '../../src/main/tabs/tab-manager'
import type { PageTabInstance, PluginContext } from '../../src/sdk/types'
import type { TabInfo } from '../../src/shared/ipc'
import { MAX_DISCUSS_TEXT } from '../../src/shared/discuss'
import { FakePtyBackend } from '../fakes/fake-pty-backend'
import { hostSpec } from '../fakes/host-spec'
import { memoryPortPair, type MemoryPort } from '../fakes/memory-port'
import { unusedOAuth, unusedSecrets } from '../fakes/unused-host-services'

const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'
const WIN_A = 1

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('HostApi tabs.* (main)', () => {
  let root: string
  let tabs: TabManager
  let opened: Array<{ projectId: string; tab: TabInfo; windowId: number; focus: boolean; view?: string[] }>
  let emitted: Array<{ projectId: string; channel: string; payload: unknown }>
  let apis: HostApi[]
  let focused: Array<{ projectId: string; tabId: string; windowId: number; view?: string[] }>
  let marked: Array<{ projectId: string; tabId: string }>
  let closing: Array<{ windowId: number; projectId: string; tabId: string }>
  let closeAnswer: boolean

  beforeEach(() => {
    focused = []
    marked = []
    closing = []
    closeAnswer = true
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-host-tabs-')))
    for (const d of ['a', 'b']) mkdirSync(join(root, d))
    opened = []
    emitted = []
    apis = []
    tabs = new TabManager({
      backend: new FakePtyBackend(),
      projectPath: (id) => ({ [A]: join(root, 'a'), [B]: join(root, 'b') })[id],
      loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/sh', HOME: root }),
      hooksPath: '/data/hooks.json',
      binDir: '/data/bin',
      sock: () => '/data/app.sock',
      emit: (projectId, channel, payload) => emitted.push({ projectId, channel, payload }),
      log: () => {}
    })
  })

  afterEach(() => {
    for (const api of apis) api.dispose()
    tabs.disposeAll()
    rmSync(root, { recursive: true, force: true })
  })

  function host(projectId = A): (method: string, params?: unknown, meta?: { view?: string }) => Promise<unknown> {
    const deps = {
      listSessions: () => [],
      session: () => undefined,
      send: () => ({ id: 'x', delivered: false }),
      onSessionsChange: () => () => {},
      openTab: async () => ({ id: 'never' }),
      setBadge: () => true,
      openOverlay: async () => ({ kind: 'dismissed' }),
      secrets: unusedSecrets,
      oauth: unusedOAuth,
      openPageTab: async (pid: string, spec: Parameters<NonNullable<HostApiDeps['openPageTab']>>[1], windowId: number, focus: boolean, ...view: string[]) => {
        const tab = tabs.createPage(pid, spec)
        opened.push({ projectId: pid, tab, windowId, focus, ...(view.length > 0 ? { view } : {}) })
        return tab
      },
      // The views of this host's window are web:1..9; web:77 is another window's.
      viewWindow: (view: string) => (view === 'web:77' ? WIN_A + 1 : WIN_A),
      listTabs: (pid: string) => tabs.list(pid),
      setPageTabTitle: (pid: string, tabId: string, title: string, icon: string | undefined) => tabs.setPageTitle(pid, tabId, title, icon),
      focusPageTab: (pid: string, tabId: string, windowId: number, ...view: string[]) =>
        focused.push({ projectId: pid, tabId, windowId, ...(view.length > 0 ? { view } : {}) }),
      markPageTabUnseen: (pid: string, tabId: string) => (marked.push({ projectId: pid, tabId }), marked.length === 1),
      // The person's close path (close-asks.ts): a dirty tab asks in its views, the answer comes back.
      closeTab: async (windowId: number, pid: string, tabId: string) => (closing.push({ windowId, projectId: pid, tabId }), closeAnswer),
      log: () => {}
    } as unknown as HostApiDeps
    const scope: HostScope = {
      projectId,
      windowId: WIN_A,
      projectDir: join(root, 'a'),
      plugins: [
        { id: 'p.editor', dir: '/p/editor', panels: [], pageTabs: ['file'] },
        { id: 'p.other', dir: '/p/other', panels: [], pageTabs: ['note'] }
      ]
    }
    const api = new HostApi(deps, scope, () => {})
    apis.push(api)
    const handlers = api.handlers
    return (method, params, meta?: { view?: string }) => Promise.resolve().then(() => handlers[method]!(params, meta as never))
  }

  it("opens a page tab of the caller's own declared type in the host's project and window", async () => {
    const call = host()
    const res = (await call('tabs.openPage', { pluginId: 'p.editor', type: 'file', params: { path: 'src/x.ts' }, title: 'x.ts', icon: 'file', focus: true })) as {
      tabId: string
    }
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ projectId: A, windowId: WIN_A, focus: true })
    expect(opened[0]!.tab.id).toBe(res.tabId)
    expect(tabs.list(A).find((t) => t.id === res.tabId)?.page).toEqual({
      plugin: 'p.editor',
      type: 'file',
      params: { path: 'src/x.ts' },
      title: 'x.ts',
      icon: 'file'
    })
  })

  it('hands openPage and focus the view the plugin acted for (03e: a guest\'s click selects in its own view only); none or a foreign window\'s: no view', async () => {
    const call = host()
    const a = (await call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: 'a', focus: true }, { view: 'web:5' })) as { tabId: string }
    await call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: 'b', focus: true })
    await call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: 'c', focus: true }, { view: 'web:77' })
    expect(opened.map((o) => o.view)).toEqual([['web:5'], undefined, undefined])
    await call('tabs.focus', { pluginId: 'p.editor', tabId: a.tabId }, { view: 'web:5' })
    await call('tabs.focus', { pluginId: 'p.editor', tabId: a.tabId })
    expect(focused.map((f) => f.view)).toEqual([['web:5'], undefined])
  })

  it("refuses a foreign type: another plugin's, an undeclared one, an unknown plugin", async () => {
    const call = host()
    await expect(call('tabs.openPage', { pluginId: 'p.editor', type: 'note', title: 'n' })).rejects.toThrow(/not a page tab type of this plugin/)
    await expect(call('tabs.openPage', { pluginId: 'p.editor', type: 'nope', title: 'n' })).rejects.toThrow(/not a page tab type/)
    await expect(call('tabs.openPage', { pluginId: 'p.gone', type: 'file', title: 'n' })).rejects.toThrow(/unknown plugin/)
    await expect(call('tabs.list', { pluginId: 'p.editor', type: 'note' })).rejects.toThrow(/not a page tab type/)
    expect(opened).toEqual([])
  })

  it('checks params and title before the budget, and the budget refuses the next open', async () => {
    const call = host()
    await expect(call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: '   ' })).rejects.toThrow(/title/)
    await expect(call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: 't', params: { big: 'x'.repeat(5000) } })).rejects.toThrow(/4096 bytes/)
    for (let i = 0; i < MAX_PAGE_TAB_OPENS_PER_WINDOW; i++) {
      await call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: `f${i}` })
    }
    await expect(call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: 'one more' })).rejects.toThrow(/more than 20 tabs in 10 s/)
    // The budget is per plugin: another plugin of the host still opens.
    await expect(call('tabs.openPage', { pluginId: 'p.other', type: 'note', title: 'n' })).resolves.toMatchObject({ tabId: expect.any(String) })
    expect(opened).toHaveLength(MAX_PAGE_TAB_OPENS_PER_WINDOW + 1)
  })

  it("lists only the caller's own tabs of the type, field by field", async () => {
    const call = host()
    const one = (await call('tabs.openPage', { pluginId: 'p.editor', type: 'file', params: { path: 'a' }, title: 'a' })) as { tabId: string }
    await call('tabs.openPage', { pluginId: 'p.other', type: 'note', title: 'n' })
    tabs.create(A, { kind: 'shell' })
    tabs.createPage(B, { plugin: 'p.editor', type: 'file', title: 'in B' })
    expect(await call('tabs.list', { pluginId: 'p.editor', type: 'file' })).toEqual([{ id: one.tabId, type: 'file', params: { path: 'a' }, title: 'a' }])
  })

  it("setTitle: only the plugin's own page tab of this project; told to every view", async () => {
    const call = host()
    const mine = (await call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: 'a.ts' })) as { tabId: string }
    const theirs = (await call('tabs.openPage', { pluginId: 'p.other', type: 'note', title: 'n' })) as { tabId: string }
    const otherProject = tabs.createPage(B, { plugin: 'p.editor', type: 'file', title: 'b' })
    emitted.length = 0
    await expect(call('tabs.setTitle', { pluginId: 'p.editor', tabId: mine.tabId, title: 'b.ts', icon: 'file' })).resolves.toBeNull()
    expect(tabs.list(A).find((t) => t.id === mine.tabId)?.page).toMatchObject({ title: 'b.ts', icon: 'file' })
    expect(emitted).toEqual([{ projectId: A, channel: 'tabs.added', payload: expect.objectContaining({ id: mine.tabId }) }])
    await expect(call('tabs.setTitle', { pluginId: 'p.editor', tabId: theirs.tabId, title: 'x' })).rejects.toThrow(/no such page tab/)
    await expect(call('tabs.setTitle', { pluginId: 'p.editor', tabId: otherProject.id, title: 'x' })).rejects.toThrow(/no such page tab/)
    await expect(call('tabs.setTitle', { pluginId: 'p.editor', tabId: mine.tabId, title: 'x', icon: '<svg>' })).rejects.toThrow(/glyph/)
    // Long titles are clamped as at open.
    await call('tabs.setTitle', { pluginId: 'p.editor', tabId: mine.tabId, title: 'y'.repeat(200) })
    expect(tabs.list(A).find((t) => t.id === mine.tabId)?.page?.title).toHaveLength(80)
  })

  it("focus: only the plugin's own page tab of this project, in the host's window; openPage's budget", async () => {
    const call = host()
    const mine = (await call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: 'a.ts' })) as { tabId: string }
    const theirs = (await call('tabs.openPage', { pluginId: 'p.other', type: 'note', title: 'n' })) as { tabId: string }
    const otherProject = tabs.createPage(B, { plugin: 'p.editor', type: 'file', title: 'b' })
    const shell = tabs.create(A, { kind: 'shell' })
    await expect(call('tabs.focus', { pluginId: 'p.editor', tabId: mine.tabId })).resolves.toBeNull()
    expect(focused).toEqual([{ projectId: A, tabId: mine.tabId, windowId: WIN_A }])
    for (const tabId of [theirs.tabId, otherProject.id, shell.id, 'nope']) {
      await expect(call('tabs.focus', { pluginId: 'p.editor', tabId })).rejects.toThrow(/no such page tab/)
    }
    await expect(call('tabs.focus', { pluginId: 'p.editor', tabId: 5 })).rejects.toThrow(/tabId must be a string/)
    // One open (above) and one focus spent: the rest of the shared budget, then a refusal.
    for (let i = 0; i < MAX_PAGE_TAB_OPENS_PER_WINDOW - 2; i++) await call('tabs.focus', { pluginId: 'p.editor', tabId: mine.tabId })
    await expect(call('tabs.focus', { pluginId: 'p.editor', tabId: mine.tabId })).rejects.toThrow(/more than 20 opens in 10 s/)
    await expect(call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: 'x' })).rejects.toThrow(/more than 20 tabs/)
    expect(focused).toHaveLength(MAX_PAGE_TAB_OPENS_PER_WINDOW - 1)
  })

  it("markUnseen: only the plugin's own page tab of this project; main's answer; openPage's budget", async () => {
    const call = host()
    const mine = (await call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: 'a.ts' })) as { tabId: string }
    const theirs = (await call('tabs.openPage', { pluginId: 'p.other', type: 'note', title: 'n' })) as { tabId: string }
    const otherProject = tabs.createPage(B, { plugin: 'p.editor', type: 'file', title: 'b' })
    const shell = tabs.create(A, { kind: 'shell' })
    // The fake marks the first time only (TabManager.markUnseen skips a tab with the dot).
    await expect(call('tabs.markUnseen', { pluginId: 'p.editor', tabId: mine.tabId })).resolves.toEqual({ marked: true })
    await expect(call('tabs.markUnseen', { pluginId: 'p.editor', tabId: mine.tabId })).resolves.toEqual({ marked: false })
    expect(marked).toEqual([
      { projectId: A, tabId: mine.tabId },
      { projectId: A, tabId: mine.tabId }
    ])
    for (const tabId of [theirs.tabId, otherProject.id, shell.id, 'nope']) {
      await expect(call('tabs.markUnseen', { pluginId: 'p.editor', tabId })).rejects.toThrow(/no such page tab/)
    }
    await expect(call('tabs.markUnseen', { pluginId: 'p.editor', tabId: 5 })).rejects.toThrow(/tabId must be a string/)
    // One open and two marks spent: the rest of the shared budget, then a refusal of both.
    for (let i = 0; i < MAX_PAGE_TAB_OPENS_PER_WINDOW - 3; i++) await call('tabs.markUnseen', { pluginId: 'p.editor', tabId: mine.tabId })
    await expect(call('tabs.markUnseen', { pluginId: 'p.editor', tabId: mine.tabId })).rejects.toThrow(/more than 20 opens in 10 s/)
    await expect(call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: 'x' })).rejects.toThrow(/more than 20 tabs/)
    expect(marked).toHaveLength(MAX_PAGE_TAB_OPENS_PER_WINDOW - 1)
  })

  it("close: only the plugin's own page tab of this project, the person's close path; the close budget", async () => {
    const call = host()
    const mine = (await call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: 'a.ts' })) as { tabId: string }
    const theirs = (await call('tabs.openPage', { pluginId: 'p.other', type: 'note', title: 'n' })) as { tabId: string }
    const otherProject = tabs.createPage(B, { plugin: 'p.editor', type: 'file', title: 'b' })
    const shell = tabs.create(A, { kind: 'shell' })
    await expect(call('tabs.close', { pluginId: 'p.editor', tabId: mine.tabId })).resolves.toEqual({ closed: true })
    expect(closing).toEqual([{ windowId: WIN_A, projectId: A, tabId: mine.tabId }])
    // The person kept it (the dirty ask answered Cancel): closed false, nothing forced.
    closeAnswer = false
    await expect(call('tabs.close', { pluginId: 'p.editor', tabId: mine.tabId })).resolves.toEqual({ closed: false })
    for (const tabId of [theirs.tabId, otherProject.id, shell.id, 'nope']) {
      await expect(call('tabs.close', { pluginId: 'p.editor', tabId })).rejects.toThrow(/no such page tab/)
    }
    await expect(call('tabs.close', { pluginId: 'p.editor', tabId: 5 })).rejects.toThrow(/tabId must be a string/)
    expect(closing).toHaveLength(2)
    for (let i = 0; i < MAX_CLOSES_PER_WINDOW - 2; i++) await call('tabs.close', { pluginId: 'p.editor', tabId: mine.tabId })
    await expect(call('tabs.close', { pluginId: 'p.editor', tabId: mine.tabId })).rejects.toThrow(/more than 10 closes in 60 s/)
    expect(closing).toHaveLength(MAX_CLOSES_PER_WINDOW)
  })

  it('setTitle checks the tab and the text before its budget, which refuses the next title per plugin', async () => {
    const call = host()
    const mine = (await call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: 'a.ts' })) as { tabId: string }
    const theirs = (await call('tabs.openPage', { pluginId: 'p.other', type: 'note', title: 'n' })) as { tabId: string }
    // Refused calls take nothing from the budget.
    for (let i = 0; i < MAX_PAGE_TAB_TITLES_PER_WINDOW + 5; i++) {
      await expect(call('tabs.setTitle', { pluginId: 'p.editor', tabId: mine.tabId, title: 'x', icon: '<svg>' })).rejects.toThrow(/glyph/)
      await expect(call('tabs.setTitle', { pluginId: 'p.editor', tabId: theirs.tabId, title: 'x' })).rejects.toThrow(/no such page tab/)
    }
    for (let i = 0; i < MAX_PAGE_TAB_TITLES_PER_WINDOW; i++) {
      await call('tabs.setTitle', { pluginId: 'p.editor', tabId: mine.tabId, title: `t${i}` })
    }
    await expect(call('tabs.setTitle', { pluginId: 'p.editor', tabId: mine.tabId, title: 'one more' })).rejects.toThrow(/more than 60 in 10 s/)
    expect(tabs.list(A).find((t) => t.id === mine.tabId)?.page?.title).toBe(`t${MAX_PAGE_TAB_TITLES_PER_WINDOW - 1}`)
    // Per plugin: another plugin of the host still sets its own.
    await expect(call('tabs.setTitle', { pluginId: 'p.other', tabId: theirs.tabId, title: 'm' })).resolves.toBeNull()
  })

  it('the per-plugin cap from the tab manager refuses and gives the open budget back', async () => {
    for (let i = 0; i < 64; i++) tabs.createPage(A, { plugin: 'p.editor', type: 'file', title: `t${i}` })
    const call = host()
    for (let i = 0; i < MAX_PAGE_TAB_OPENS_PER_WINDOW + 2; i++) {
      await expect(call('tabs.openPage', { pluginId: 'p.editor', type: 'file', title: 'x' })).rejects.toThrow(/at most 64 page tabs/)
    }
  })
})

describe('ctx.tabs (host)', () => {
  interface Call {
    method: string
    params: unknown
  }

  function setup(answer: (c: Call) => unknown = () => null): {
    contexts: HostContexts
    editor: PluginContext
    calls: Call[]
    logs: { pluginId: string; level: LogLevel; text: string }[]
  } {
    const calls: Call[] = []
    const logs: { pluginId: string; level: LogLevel; text: string }[] = []
    const deps: ContextDeps = {
      log: (pluginId, level, text) => logs.push({ pluginId, level, text }),
      call: async (method, params) => {
        const c: Call = { method, params }
        calls.push(c)
        return answer(c)
      }
    }
    const contexts = new HostContexts(deps)
    const editor = contexts.create(hostSpec({ id: 'p.editor', dir: '/p/editor', main: 'h.js', pageTabTypes: ['file'] }))
    return { contexts, editor, calls, logs }
  }

  const TAB = '0b4f6c2e-1d3a-4e5b-8c7d-9e0f1a2b3c4d'

  function openFrame(contexts: HostContexts, tag: Record<string, unknown>): { page: MemoryPort; port: PanelPort & { closed: boolean }; attached: boolean } {
    const [hostEnd, page] = memoryPortPair()
    const port = {
      closed: false,
      postMessage: (m: string) => hostEnd.postMessage(m),
      onMessage: (l: (m: unknown) => void) => hostEnd.onMessage(l),
      close() {
        port.closed = true
      }
    }
    const parsed = pageTabOpenTag(JSON.stringify({ pageTabOpen: { access: 'owner', ...tag } }))
    if (!parsed) throw new Error('bad tag')
    return { page, port, attached: contexts.attachPageTabPort(parsed, port) }
  }

  it('main passes the declared types to the host spec', () => {
    const [spec] = parsePluginSpecs({ plugins: [{ ...hostSpec({ id: 'p.editor', dir: '/p', main: 'h.js' }), pageTabTypes: ['file'] }] })
    expect(spec?.pageTabTypes).toEqual(['file'])
    expect(() => parsePluginSpecs({ plugins: [{ ...hostSpec({ id: 'p.editor', dir: '/p', main: 'h.js' }), pageTabTypes: [3] }] })).toThrow(/pageTabTypes/)
  })

  it('every call throws for an undeclared type; openPage asks main and resolves the id', async () => {
    const { editor, calls } = setup((c) => (c.method === 'tabs.openPage' ? { tabId: TAB } : []))
    expect(() => editor.tabs.onOpen('note', () => {})).toThrow('not declared in plugin.json contributes.tabs')
    await expect(editor.tabs.openPage('note', null, { title: 'n' })).rejects.toThrow('not declared')
    await expect(editor.tabs.list('note')).rejects.toThrow('not declared')
    await expect(editor.tabs.openPage('file', { path: 'a.ts' }, { title: '' })).rejects.toThrow(/title/)
    await expect(editor.tabs.openPage('file', { path: 'a.ts' }, { title: 'a.ts', icon: 'file', focus: true })).resolves.toBe(TAB)
    expect(calls).toEqual([
      { method: 'tabs.openPage', params: { pluginId: 'p.editor', type: 'file', params: { path: 'a.ts' }, title: 'a.ts', icon: 'file', focus: true } }
    ])
    await editor.tabs.list('file')
    expect(calls.at(-1)).toEqual({ method: 'tabs.list', params: { pluginId: 'p.editor', type: 'file' } })
    await editor.tabs.focus(TAB)
    expect(calls.at(-1)).toEqual({ method: 'tabs.focus', params: { pluginId: 'p.editor', tabId: TAB } })
    // Anything but main's `{ marked: true }` reads as not marked.
    await expect(editor.tabs.markUnseen(TAB)).resolves.toEqual({ marked: false })
    expect(calls.at(-1)).toEqual({ method: 'tabs.markUnseen', params: { pluginId: 'p.editor', tabId: TAB } })
    // Anything but main's `{ closed: true }` reads as not closed.
    await expect(editor.tabs.close(TAB)).resolves.toEqual({ closed: false })
    expect(calls.at(-1)).toEqual({ method: 'tabs.close', params: { pluginId: 'p.editor', tabId: TAB } })
    const before = calls.length
    await expect(editor.tabs.focus('not an id')).rejects.toThrow(/page tab id/)
    await expect(editor.tabs.markUnseen('not an id')).rejects.toThrow(/page tab id/)
    await expect(editor.tabs.close('not an id')).rejects.toThrow(/page tab id/)
    expect(calls).toHaveLength(before)
  })

  it("a frame's port makes an instance per view with params, view, messaging and setTitle", async () => {
    const { contexts, editor, calls } = setup()
    const seen: PageTabInstance[] = []
    editor.tabs.onOpen('file', (t) => seen.push(t))
    const desk = openFrame(contexts, { pluginId: 'p.editor', id: TAB, type: 'file', params: { path: 'a.ts' } })
    const web = openFrame(contexts, { pluginId: 'p.editor', id: TAB, type: 'file', params: { path: 'a.ts' }, view: 'web:4' })
    expect(desk.attached && web.attached).toBe(true)
    expect(seen.map((t) => [t.id, t.view, t.params])).toEqual([
      [TAB, undefined, { path: 'a.ts' }],
      [TAB, 'web:4', { path: 'a.ts' }]
    ])
    const got: unknown[] = []
    seen[1]!.onMessage((m) => got.push(m))
    web.page.postMessage(JSON.stringify({ hello: 1 }))
    await flush()
    expect(got).toEqual([{ hello: 1 }])
    seen[0]!.post({ text: 'x' })
    expect(desk.page.sent).toEqual([])
    await flush()
    await seen[0]!.setTitle('b.ts')
    expect(calls).toEqual([{ method: 'tabs.setTitle', params: { pluginId: 'p.editor', tabId: TAB, title: 'b.ts' } }])
    // A bad title is a rejection, never a throw at the call.
    await expect(seen[0]!.setTitle('')).rejects.toThrow(/title/)
    // The plugin stopped: an instance it kept asks main nothing, as every other ctx.tabs member.
    contexts.dispose('p.editor')
    await expect(seen[1]!.setTitle('c.ts')).rejects.toThrow(/deactivated/)
    expect(calls).toHaveLength(1)
  })

  it('a type the plugin does not declare is refused at attach (the port closed)', () => {
    const { contexts } = setup()
    const f = openFrame(contexts, { pluginId: 'p.editor', id: TAB, type: 'note' })
    expect(f.attached).toBe(false)
    expect(f.port.closed).toBe(true)
  })

  it("pageTab.close ends that view's line only and closes its port; an unknown id is ignored; a reconnect replaces", () => {
    const { contexts, editor } = setup()
    const closes: string[] = []
    editor.tabs.onOpen('file', (t) => t.onClose(() => closes.push(t.view ?? 'desktop')))
    const desk = openFrame(contexts, { pluginId: 'p.editor', id: TAB, type: 'file' })
    const web = openFrame(contexts, { pluginId: 'p.editor', id: TAB, type: 'file', view: 'web:4' })
    contexts.handleEvent('pageTab.close', { pluginId: 'p.editor', id: '1b4f6c2e-1d3a-4e5b-8c7d-9e0f1a2b3c4d' })
    contexts.handleEvent('pageTab.close', { pluginId: 'p.editor', id: TAB, view: 'bogus view' })
    expect(closes).toEqual([])
    contexts.handleEvent('pageTab.close', { pluginId: 'p.editor', id: TAB, view: 'web:4' })
    expect(closes).toEqual(['web:4'])
    expect(web.port.closed).toBe(true)
    expect(desk.port.closed).toBe(false)
    // A new line for the desktop's frame (host restart, resync): the old instance ends first.
    const again = openFrame(contexts, { pluginId: 'p.editor', id: TAB, type: 'file' })
    expect(closes).toEqual(['web:4', 'desktop'])
    expect(desk.port.closed).toBe(true)
    expect(again.port.closed).toBe(false)
  })

  it("pageTab.discuss asks the asking view's handlers in order; null passes, a bad shape fails", async () => {
    const { contexts, editor } = setup()
    editor.tabs.onOpen('file', (t) => {
      if (t.view === 'web:4') {
        t.onDiscuss(() => null)
        t.onDiscuss(() => ({ text: `web selection ${'x'.repeat(MAX_DISCUSS_TEXT)}` }))
      } else t.onDiscuss(async () => ({ text: 'desktop selection' }))
    })
    openFrame(contexts, { pluginId: 'p.editor', id: TAB, type: 'file' })
    openFrame(contexts, { pluginId: 'p.editor', id: TAB, type: 'file', view: 'web:4' })
    await expect(contexts.pageTabDiscuss({ pluginId: 'p.editor', id: TAB })).resolves.toEqual({ text: 'desktop selection' })
    const web = (await contexts.pageTabDiscuss({ pluginId: 'p.editor', id: TAB, view: 'web:4' })) as { text: string }
    expect(web.text.startsWith('web selection')).toBe(true)
    expect(web.text).toHaveLength(MAX_DISCUSS_TEXT)
    // No instance in that view: no context, not an error.
    await expect(contexts.pageTabDiscuss({ pluginId: 'p.editor', id: TAB, view: 'web:9' })).resolves.toBeNull()
    const other = setup()
    other.editor.tabs.onOpen('file', (t) => t.onDiscuss(() => 'just text' as unknown as { text: string }))
    openFrame(other.contexts, { pluginId: 'p.editor', id: TAB, type: 'file' })
    await expect(other.contexts.pageTabDiscuss({ pluginId: 'p.editor', id: TAB })).rejects.toThrow(/\{ text \} or null/)
  })

  it('an async onDiscuss that rejects fails the ask once, with no unhandled rejection beside it', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown): void => void unhandled.push(err)
    process.on('unhandledRejection', onUnhandled)
    try {
      const { contexts, editor } = setup()
      editor.tabs.onOpen('file', (t) => t.onDiscuss(async () => Promise.reject(new Error('no selection model'))))
      openFrame(contexts, { pluginId: 'p.editor', id: TAB, type: 'file', view: 'web:4' })
      await expect(contexts.pageTabDiscuss({ pluginId: 'p.editor', id: TAB, view: 'web:4' })).rejects.toThrow(/no selection model/)
      // An unhandled rejection is reported after the microtasks drain, on a later macrotask.
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('a stopping plugin ends its lines and drops its listeners', () => {
    const { contexts, editor } = setup()
    let closed = 0
    editor.tabs.onOpen('file', (t) => t.onClose(() => closed++))
    const f = openFrame(contexts, { pluginId: 'p.editor', id: TAB, type: 'file' })
    contexts.dispose('p.editor')
    expect(closed).toBe(1)
    expect(f.port.closed).toBe(true)
  })

  it('pageTabOpenTag refuses a malformed tag', () => {
    expect(pageTabOpenTag(JSON.stringify({ pageTabOpen: { pluginId: 'p', id: 'not-a-uuid', type: 'file' } }))).toBeUndefined()
    expect(pageTabOpenTag(JSON.stringify({ pageTabOpen: { pluginId: 'p', id: TAB, type: 'File' } }))).toBeUndefined()
    expect(pageTabOpenTag(JSON.stringify({ pageTabOpen: { pluginId: 'p', id: TAB, type: 'file', view: 'nope' } }))).toBeUndefined()
    expect(pageTabOpenTag(JSON.stringify({ slotOpen: {} }))).toBeUndefined()
  })
})
