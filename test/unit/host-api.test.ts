// Task 27, main side: the sessions / badge / overlay requests of a plugin host, each scoped to the
// project and window main spawned the host for. Real session registry, send gate, tab manager
// (cwd containment, claude argv), layout service and overlay manager, with fake PTYs and views
// and temp dirs; nothing touches the real app data dir.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { getEventListeners } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LayoutService } from '../../src/main/layout/layout-service'
import {
  MAX_OVERLAY_MESSAGE_LENGTH,
  MAX_QUEUED_OVERLAY_MESSAGES,
  OverlayManager,
  type OverlayResult,
  type UrlView
} from '../../src/main/overlays/overlay-manager'
import {
  FILE_OPEN_WINDOW_MS,
  HostApi,
  MAX_FILE_OPENS_PER_WINDOW,
  MAX_OPEN_OVERLAYS,
  MAX_OPENS_PER_WINDOW,
  MAX_OVERLAYS_PER_WINDOW,
  MAX_SENDS_PER_WINDOW,
  RateWindow,
  SESSIONS_EVENT_INTERVAL_MS,
  type HostApiDeps,
  type HostScope
} from '../../src/main/plugins/host-api'
import { MAX_TEXT_CHARS, PASTE_END, PASTE_START } from '../../src/main/sessions/send-gate'
import { SessionRegistry } from '../../src/main/sessions/session-registry'
import { TabManager } from '../../src/main/tabs/tab-manager'
import type { TabInfo } from '../../src/shared/ipc'
import { defaultLayout } from '../../src/shared/layout'
import { FakePtyBackend } from '../fakes/fake-pty-backend'
import { unusedOAuth, unusedSecrets } from '../fakes/unused-host-services'

const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'
const WIN_A = 1
const WIN_B = 2

let root: string
let projA: string
let projB: string
let outside: string
let pluginOne: string
let pluginTwo: string
let tabsBackend: FakePtyBackend
let overlayBackend: FakePtyBackend
let registry: SessionRegistry
let tabs: TabManager
let layouts: LayoutService
let overlays: OverlayManager
/** What the overlay manager sent to each window's renderer. */
let emitted: { windowId: number; channel: string; payload: unknown }[]
/** What main told each window about tabs it did not ask for (`tabs.added`). */
let announced: { projectId: string; tab: TabInfo; windowId: number }[]
let deps: HostApiDeps
let apis: HostApi[]

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-host-api-')))
  projA = join(root, 'a')
  projB = join(root, 'b')
  outside = join(root, 'outside')
  pluginOne = join(root, 'plugins', 'a.one')
  pluginTwo = join(root, 'plugins', 'a.two')
  for (const d of [projA, join(projA, 'sub'), projB, outside, pluginOne, pluginTwo]) mkdirSync(d, { recursive: true })
  writeFileSync(join(outside, 'secret.html'), '<p>secret</p>')
  writeFileSync(join(pluginOne, 'page.html'), '<p>from the plugin</p>')
  mkdirSync(join(pluginOne, 'pages'))
  writeFileSync(join(pluginOne, 'pages', 'big.html'), 'x'.repeat(1024 * 1024 + 1))
  symlinkSync(join(outside, 'secret.html'), join(pluginOne, 'escape.html'))
  symlinkSync(outside, join(projA, 'link-out'))

  tabsBackend = new FakePtyBackend()
  overlayBackend = new FakePtyBackend()
  announced = []
  apis = []
  registry = new SessionRegistry({
    projectName: () => 'p',
    broadcast: () => {},
    write: ({ tabId, projectId }, data) => tabs.input(projectId, tabId, data),
    log: () => {}
  })
  tabs = new TabManager({
    backend: tabsBackend,
    projectPath: (id) => ({ [A]: projA, [B]: projB })[id],
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/sh', HOME: root }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => '/data/app.sock',
    lifecycle: {
      started: (tab) => registry.tabStarted(tab),
      exited: (tabId, code) => registry.tabExited(tabId, code),
      closed: (tabId) => registry.tabClosed(tabId)
    },
    emit: () => {},
    log: () => {}
  })
  const stored = new Map([
    [A, defaultLayout()],
    [B, defaultLayout()]
  ])
  layouts = new LayoutService({ getLayout: (id) => stored.get(id), setLayout: () => {}, publish: () => {} })
  layouts.setPluginPanels(A, 'a.one', [{ id: 'board', title: 'Board', defaultZone: 'left' }])
  layouts.setPluginPanels(A, 'a.two', [{ id: 'inbox', title: 'Inbox', defaultZone: 'left' }])
  layouts.setPluginPanels(B, 'b.one', [{ id: 'board', title: 'Board', defaultZone: 'left' }])
  const view: UrlView = { setBounds: () => {}, setVisible: () => {}, focus: () => {}, destroy: () => {} }
  emitted = []
  overlays = new OverlayManager({
    backend: overlayBackend,
    views: { create: () => view, focusWindow: () => {} },
    isWindowOpen: (id) => id === WIN_A || id === WIN_B,
    env: () => ({ PATH: '/usr/bin' }),
    emit: (windowId, channel, payload) => {
      emitted.push({ windowId, channel, payload })
    },
    commandForChord: () => undefined,
    log: () => {}
  })
  deps = {
    listSessions: (projectId) => registry.listByProject(projectId),
    session: (tabId) => registry.get(tabId),
    send: (tabId, text) => registry.send(tabId, text),
    onSessionsChange: (listener) => registry.onChange(listener),
    openTab: async (projectId, options, windowId) => {
      const tab = tabs.create(projectId, { kind: 'claude', ...options })
      announced.push({ projectId, tab, windowId })
      return tab
    },
    setBadge: (projectId, key, badge) => layouts.setBadge(projectId, key, badge),
    openOverlay: async (windowId, spec, opener, peerGone, channel) => overlays.open(windowId, spec, opener, peerGone, channel),
    postOverlay: (windowId, overlayId, text) => overlays.post(windowId, overlayId, text),
    closeOverlay: (windowId, overlayId) => overlays.close(windowId, overlayId),
    focusOverlay: (windowId, overlayId) => overlays.focus(windowId, overlayId),
    secrets: unusedSecrets,
    oauth: unusedOAuth,
    log: () => {}
  }
})

afterEach(() => {
  for (const api of apis) api.dispose()
  overlays.disposeAll()
  tabs.disposeAll()
  registry.dispose()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

const scopeA = (): HostScope => ({
  projectId: A,
  windowId: WIN_A,
  projectDir: projA,
  plugins: [
    { id: 'a.one', dir: pluginOne, panels: ['board'] },
    { id: 'a.two', dir: pluginTwo, panels: ['inbox'] }
  ]
})

/** A host of project A (window 1); `events` gets what main pushes to it. */
function hostA(events: { event: string; params: unknown }[] = []): (method: string, params?: unknown) => Promise<unknown> {
  return hostFor(scopeA(), events)
}

function hostFor(
  scope: HostScope,
  events: { event: string; params: unknown }[] = []
): (method: string, params?: unknown) => Promise<unknown> {
  const api = new HostApi(deps, scope, (event, params) => events.push({ event, params }))
  apis.push(api)
  const handlers = api.handlers
  // Through a then, like the RPC endpoint does: a synchronous throw becomes a rejection.
  return (method, params) => Promise.resolve().then(() => handlers[method]!(params))
}

/** A Claude tab of `projectId` whose session reached `waiting` (a Stop, nothing queued). */
function waitingTab(projectId: string): string {
  const tab = tabs.create(projectId, { kind: 'claude' })
  registry.applyHook(tab.id, 'SessionStart', { session_id: 's' })
  registry.applyHook(tab.id, 'Stop', {})
  return tab.id
}

/** A Claude tab's fake PTY, found by the tab id main put in its env. */
const ptyOf = (tabId: string) => {
  const pty = tabsBackend.spawned.find((p) => p.options.env.APP_TAB_ID === tabId)
  if (!pty) throw new Error('no pty')
  return pty
}

describe('sessions.list', () => {
  it("lists only this window's Claude tabs, with only the fields a plugin gets", async () => {
    const mine = tabs.create(A, { kind: 'claude', cwd: 'sub' })
    tabs.create(A, { kind: 'shell' })
    tabs.create(B, { kind: 'claude' })
    registry.applyHook(mine.id, 'UserPromptSubmit', { prompt: 'fix it' })
    registry.send(mine.id, 'queued text')
    registry.tabOutput(mine.id, '\x1b]0;✳ Fixing it\x07')
    // The gist is main's (the Sessions panel's), not part of the plugin API; nor are the recent prompts.
    registry.setGist(mine.id, 'a gist')
    const list = (await hostA()('sessions.list', {})) as Record<string, unknown>[]
    expect(list).toEqual([
      { tabId: mine.id, status: 'working', cwd: join(projA, 'sub'), lastPrompt: 'fix it', title: 'Fixing it', notes: [], files: [] }
    ])
    // Nothing of main's bookkeeping: the queue, the project id, the delivering flag.
    expect(Object.keys(list[0]!)).not.toContain('queue')
    expect(Object.keys(list[0]!)).not.toContain('projectId')
  })
})

describe('sessions.send', () => {
  it("refuses another window's tab even when the host names its id", async () => {
    const theirs = waitingTab(B)
    const send = hostA()
    await expect(send('sessions.send', { pluginId: 'a.one', tabId: theirs, text: 'hi' })).rejects.toThrow('unknown tab')
    expect(ptyOf(theirs).writes).toEqual([])
    expect(registry.get(theirs)!.queue).toEqual([])
    // A host of B may (its own tab), proving the refusal above is the scope and not the tab.
    const hostB = hostFor({ projectId: B, windowId: WIN_B, projectDir: projB, plugins: [{ id: 'b.one', dir: pluginTwo, panels: ['board'] }] })
    await expect(hostB('sessions.send', { pluginId: 'b.one', tabId: theirs, text: 'hi' })).resolves.toEqual({ delivered: true })
  })

  it('goes through the gate: queued while the tab is busy, typed at its next Stop', async () => {
    const tab = tabs.create(A, { kind: 'claude' })
    registry.applyHook(tab.id, 'SessionStart', { session_id: 's' })
    registry.applyHook(tab.id, 'UserPromptSubmit', { prompt: 'working on it' })
    const send = hostA()
    const result = (await send('sessions.send', { pluginId: 'a.one', tabId: tab.id, text: 'next step' })) as {
      queued: true
      itemId: string
    }
    expect(result).toEqual({ queued: true, itemId: expect.any(String) })
    expect(ptyOf(tab.id).writes).toEqual([])
    expect(registry.get(tab.id)!.queue.map((q) => q.id)).toEqual([result.itemId])
    registry.applyHook(tab.id, 'Stop', {})
    expect(ptyOf(tab.id).writes).toEqual([`${PASTE_START}next step${PASTE_END}\r`])
  })

  it('types at once into a waiting tab; refuses mode prefixes, unknown plugins and floods', async () => {
    const tab = waitingTab(A)
    const send = hostA()
    await expect(send('sessions.send', { pluginId: 'a.one', tabId: tab, text: 'go' })).resolves.toEqual({ delivered: true })
    await expect(send('sessions.send', { pluginId: 'a.one', tabId: tab, text: '/clear' })).rejects.toThrow('"/", "!", "#" or "&"')
    await expect(send('sessions.send', { pluginId: 'b.one', tabId: tab, text: 'x' })).rejects.toThrow('unknown plugin')
    // The budget is per plugin: a.one used 1 (the refused text cost nothing).
    for (let i = 1; i < MAX_SENDS_PER_WINDOW; i++) {
      await send('sessions.send', { pluginId: 'a.one', tabId: tab, text: `t${i}` })
    }
    await expect(send('sessions.send', { pluginId: 'a.one', tabId: tab, text: 'one more' })).rejects.toThrow(
      `more than ${MAX_SENDS_PER_WINDOW} texts`
    )
    await expect(send('sessions.send', { pluginId: 'a.two', tabId: tab, text: 'other plugin' })).resolves.toEqual({
      queued: true,
      itemId: expect.any(String)
    })
  })

  it('does not spend the budget on a send the gate refuses (an ended session)', async () => {
    const ended = waitingTab(A)
    ptyOf(ended).exit(0)
    const live = waitingTab(A)
    const send = hostA()
    for (let i = 0; i < MAX_SENDS_PER_WINDOW + 5; i++) {
      await expect(send('sessions.send', { pluginId: 'a.one', tabId: ended, text: 'retry' })).rejects.toThrow('has ended')
    }
    // The whole budget is still there for a tab that takes text.
    for (let i = 0; i < MAX_SENDS_PER_WINDOW; i++) {
      await send('sessions.send', { pluginId: 'a.one', tabId: live, text: `t${i}` })
    }
    await expect(send('sessions.send', { pluginId: 'a.one', tabId: live, text: 'one more' })).rejects.toThrow(
      `more than ${MAX_SENDS_PER_WINDOW} texts`
    )
  })
})

describe('sessions.open', () => {
  it('starts a Claude tab in the project with the prompt as one argv element, and tells the window', async () => {
    const open = hostA()
    const { tabId } = (await open('sessions.open', { pluginId: 'a.one', cwd: 'sub', prompt: '-rf --settings x' })) as {
      tabId: string
    }
    const pty = ptyOf(tabId)
    expect(pty.options.cwd).toBe(join(projA, 'sub'))
    // After `--`, with the leading space claude-argv.ts adds: never read as an option.
    expect(pty.argv).toEqual(['claude', '--settings', '/data/hooks.json', '--', ' -rf --settings x'])
    // With the host's own window (main re-checks it after awaiting the login env).
    expect(announced).toEqual([{ projectId: A, tab: expect.objectContaining({ id: tabId, kind: 'claude' }), windowId: WIN_A }])
    expect(tabs.list(B)).toEqual([])
    // No prompt: a bare claude in the project folder.
    const plain = (await open('sessions.open', { pluginId: 'a.one' })) as { tabId: string }
    expect(ptyOf(plain.tabId).argv).toEqual(['claude', '--settings', '/data/hooks.json'])
    expect(ptyOf(plain.tabId).options.cwd).toBe(projA)
  })

  it('refuses a cwd outside the project folder, by path, absolute path or symlink', async () => {
    const open = hostA()
    await expect(open('sessions.open', { pluginId: 'a.one', cwd: '../outside' })).rejects.toThrow('outside the project')
    await expect(open('sessions.open', { pluginId: 'a.one', cwd: outside })).rejects.toThrow('outside the project')
    await expect(open('sessions.open', { pluginId: 'a.one', cwd: projB })).rejects.toThrow('outside the project')
    await expect(open('sessions.open', { pluginId: 'a.one', cwd: 'link-out' })).rejects.toThrow('outside the project')
    await expect(open('sessions.open', { pluginId: 'a.one', cwd: 5 })).rejects.toThrow('cwd must be a string')
    await expect(open('sessions.open', { pluginId: 'a.one', cwd: 'missing' })).rejects.toThrow('cwd does not exist')
    expect(tabsBackend.spawned).toEqual([])
    // None of the refusals above spent the budget.
    for (let i = 0; i < MAX_OPENS_PER_WINDOW; i++) await open('sessions.open', { pluginId: 'a.one', cwd: 'sub' })
    expect(tabsBackend.spawned).toHaveLength(MAX_OPENS_PER_WINDOW)
  })

  it('cleans the prompt like a sent text: control bytes out, a size cap, blank refused, empty is none', async () => {
    const open = hostA()
    const { tabId } = (await open('sessions.open', { pluginId: 'a.one', prompt: 'a\x1b[2Jb\x00c\u009bd' })) as { tabId: string }
    expect(ptyOf(tabId).argv.at(-1)).toBe(' a[2Jbcd')
    await expect(open('sessions.open', { pluginId: 'a.one', prompt: 'x'.repeat(MAX_TEXT_CHARS + 1) })).rejects.toThrow(
      'longer than'
    )
    await expect(open('sessions.open', { pluginId: 'a.one', prompt: ' \n\t ' })).rejects.toThrow('sessions.open: prompt: text is empty')
    await expect(open('sessions.open', { pluginId: 'a.one', prompt: 5 })).rejects.toThrow('text must be a string')
    const plain = (await open('sessions.open', { pluginId: 'a.one', prompt: '' })) as { tabId: string }
    expect(ptyOf(plain.tabId).argv).toEqual(['claude', '--settings', '/data/hooks.json'])
  })

  it('refuses a prompt that is a slash command or bash line, and caps the rate', async () => {
    const open = hostA()
    await expect(open('sessions.open', { pluginId: 'a.one', prompt: '/compact' })).rejects.toThrow('"/", "!", "#" or "&"')
    await expect(open('sessions.open', { pluginId: 'a.one', prompt: '  !rm -rf ~' })).rejects.toThrow('"/", "!", "#" or "&"')
    await expect(open('sessions.open', { pluginId: 'nope' })).rejects.toThrow('unknown plugin')
    expect(tabsBackend.spawned).toEqual([])
    for (let i = 0; i < MAX_OPENS_PER_WINDOW; i++) await open('sessions.open', { pluginId: 'a.one' })
    await expect(open('sessions.open', { pluginId: 'a.one' })).rejects.toThrow(`more than ${MAX_OPENS_PER_WINDOW} tabs`)
    expect(tabsBackend.spawned).toHaveLength(MAX_OPENS_PER_WINDOW)
  })
})

describe('badge', () => {
  const badgeOf = (projectId: string, key: string): unknown => layouts.view(projectId)!.panels.find((p) => p.panelKey === key)?.badge

  it("badges the plugin's own panel only, never another plugin's, a core panel or another window's", async () => {
    const call = hostA()
    await call('badge', { pluginId: 'a.one', panelId: 'board', value: 3 })
    expect(badgeOf(A, 'a.one/board')).toEqual({ kind: 'count', count: 3 })
    await call('badge', { pluginId: 'a.one', panelId: 'board', value: 'dot' })
    expect(badgeOf(A, 'a.one/board')).toEqual({ kind: 'dot' })
    // a.two's panel, by its bare id or its full key; the core panel; B's panel of the same name.
    await expect(call('badge', { pluginId: 'a.one', panelId: 'inbox', value: 1 })).rejects.toThrow('declares no panel')
    await expect(call('badge', { pluginId: 'a.one', panelId: 'a.two/inbox', value: 1 })).rejects.toThrow('declares no panel')
    await expect(call('badge', { pluginId: 'a.one', panelId: 'core/sessions', value: 1 })).rejects.toThrow('declares no panel')
    await expect(call('badge', { pluginId: 'b.one', panelId: 'board', value: 1 })).rejects.toThrow('unknown plugin')
    await expect(call('badge', { pluginId: 'a.one', panelId: 'board', value: 'red' })).rejects.toThrow('must be a non-negative number')
    // Negative is refused by main itself, not left to the layout's clamp; the dot stays.
    await expect(call('badge', { pluginId: 'a.one', panelId: 'board', value: -1 })).rejects.toThrow('must be a non-negative number')
    expect(badgeOf(A, 'a.one/board')).toEqual({ kind: 'dot' })
    expect(badgeOf(A, 'a.two/inbox')).toBeUndefined()
    expect(badgeOf(A, 'core/sessions')).toBeUndefined()
    expect(badgeOf(B, 'b.one/board')).toBeUndefined()
    await call('badge', { pluginId: 'a.one', panelId: 'board', value: null })
    expect(badgeOf(A, 'a.one/board')).toBeUndefined()
  })

  it('clears what the host badged when it goes', async () => {
    const call = hostA()
    await call('badge', { pluginId: 'a.two', panelId: 'inbox', value: 7 })
    layouts.setError(A, 'a.two/inbox', 'job failed')
    apis[0]!.dispose()
    expect(layouts.view(A)!.panels.find((p) => p.panelKey === 'a.two/inbox')).toMatchObject({ error: 'job failed' })
    expect(badgeOf(A, 'a.two/inbox')).toBeUndefined()
    await expect(call('badge', { pluginId: 'a.two', panelId: 'inbox', value: 1 })).rejects.toThrow('stopping')
  })

  it('revoke refuses every request and stops the sessions events, but leaves the badges to dispose', async () => {
    vi.useFakeTimers()
    const events: { event: string; params: unknown }[] = []
    const call = hostA(events)
    const tabId = waitingTab(A)
    await call('badge', { pluginId: 'a.two', panelId: 'inbox', value: 7 })
    await vi.advanceTimersByTimeAsync(1000)
    events.length = 0
    apis[0]!.revoke()
    for (const [method, params] of [
      ['sessions.list', {}],
      ['sessions.send', { pluginId: 'a.one', tabId, text: 'hello' }],
      ['sessions.open', { pluginId: 'a.one' }],
      ['badge', { pluginId: 'a.one', panelId: 'board', value: 1 }],
      ['overlay.open', { pluginId: 'a.one', spec: { kind: 'url', url: 'https://example.com' } }]
    ] as const) {
      await expect(call(method, params), method).rejects.toThrow('the plugin host is stopping')
    }
    expect(ptyOf(tabId).writes).toEqual([])
    registry.applyHook(tabId, 'UserPromptSubmit', { prompt: 'x' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(events).toEqual([])
    expect(badgeOf(A, 'a.two/inbox')).toEqual({ kind: 'count', count: 7 })
    apis[0]!.dispose()
    expect(badgeOf(A, 'a.two/inbox')).toBeUndefined()
  })
})

describe('updatePlugin (reload in place, Task 29)', () => {
  const badgeOf = (projectId: string, key: string): unknown => layouts.view(projectId)!.panels.find((p) => p.panelKey === key)?.badge

  it('takes the new panel list, clears the old copy\'s badges and never adds a plugin', async () => {
    const call = hostA()
    await call('badge', { pluginId: 'a.one', panelId: 'board', value: 4 })
    await call('badge', { pluginId: 'a.two', panelId: 'inbox', value: 2 })
    layouts.setPluginPanels(A, 'a.one', [
      { id: 'board', title: 'Board', defaultZone: 'left' },
      { id: 'extra', title: 'Extra', defaultZone: 'left' }
    ])
    apis[0]!.updatePlugin({ id: 'a.one', dir: pluginOne, panels: ['board', 'extra'] })
    // a.one's badge went with the old copy; a.two's stays.
    expect(badgeOf(A, 'a.one/board')).toBeUndefined()
    expect(badgeOf(A, 'a.two/inbox')).toEqual({ kind: 'count', count: 2 })
    await call('badge', { pluginId: 'a.one', panelId: 'extra', value: 'dot' })
    expect(badgeOf(A, 'a.one/extra')).toEqual({ kind: 'dot' })
    // A plugin the host was not started with cannot be added by a reload.
    apis[0]!.updatePlugin({ id: 'b.one', dir: pluginOne, panels: ['board'] })
    await expect(call('badge', { pluginId: 'b.one', panelId: 'board', value: 1 })).rejects.toThrow('unknown plugin')
  })
})

describe('overlay.open', () => {
  /** Settled results of a pending call, after microtasks and the file reads ran. */
  const track = (p: Promise<unknown>): { results: OverlayResult[]; errors: Error[] } => {
    const out = { results: [] as OverlayResult[], errors: [] as Error[] }
    p.then(
      (r) => out.results.push(r as OverlayResult),
      (e: Error) => out.errors.push(e)
    )
    return out
  }
  const settled = async (t: { results: unknown[]; errors: unknown[] }): Promise<void> => {
    await vi.waitFor(() => expect(t.results.length + t.errors.length).toBeGreaterThan(0))
  }
  const waitOpen = async (windowId: number, n: number): Promise<void> => {
    await vi.waitFor(() => expect(overlays.infos(windowId)).toHaveLength(n))
  }

  it('runs a terminal by argv in the project folder, on its own window, and returns its exit', async () => {
    const call = hostA()
    const t = track(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'terminal', argv: ['tig', '$(id)'] } }))
    await waitOpen(WIN_A, 1)
    expect(overlays.infos(WIN_B)).toEqual([])
    const pty = overlayBackend.last
    expect(pty.argv).toEqual(['tig', '$(id)'])
    expect(pty.options.cwd).toBe(projA)
    pty.exit(3)
    await settled(t)
    expect(t.results).toEqual([{ kind: 'exit', code: 3 }])
    // A relative cwd is relative to the project folder.
    void call('overlay.open', { pluginId: 'a.one', spec: { kind: 'terminal', argv: ['ls'], cwd: 'sub' } })
    await waitOpen(WIN_A, 1)
    expect(overlayBackend.last.options.cwd).toBe(join(projA, 'sub'))
  })

  it("keeps a terminal's cwd inside the project folder: no `..`, absolute path or symlink out", async () => {
    const call = hostA()
    const refuse = (cwd: unknown, message: string): Promise<void> =>
      expect(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'terminal', argv: ['ls'], cwd } })).rejects.toThrow(message)
    await refuse('../outside', 'overlay: cwd is outside the project')
    await refuse(outside, 'overlay: cwd is outside the project')
    await refuse(projB, 'overlay: cwd is outside the project')
    await refuse('link-out', 'overlay: cwd is outside the project')
    await refuse('missing', 'overlay: cwd does not exist')
    await refuse(5, 'overlay: cwd must be a string')
    expect(overlayBackend.spawned).toEqual([])
    // An absolute path inside the project is fine.
    void call('overlay.open', { pluginId: 'a.one', spec: { kind: 'terminal', argv: ['ls'], cwd: join(projA, 'sub') } })
    await waitOpen(WIN_A, 1)
    expect(overlayBackend.last.options.cwd).toBe(join(projA, 'sub'))
  })

  it('leaves no listener on the host signal once an overlay ends, and refunds a refused one', async () => {
    const signals = new Set<AbortSignal>()
    const open = deps.openOverlay
    deps.openOverlay = (windowId, spec, opener, peerGone) => {
      if (peerGone) signals.add(peerGone)
      return open(windowId, spec, opener, peerGone)
    }
    const call = hostA()
    // More than MAX_OVERLAYS_PER_WINDOW in all (two plugins' budgets), each closed before the next.
    for (let i = 0; i < MAX_OVERLAYS_PER_WINDOW + 2; i++) {
      const pluginId = i % 2 === 0 ? 'a.one' : 'a.two'
      const t = track(call('overlay.open', { pluginId, spec: { kind: 'url', url: `https://example.com/${i}` } }))
      await waitOpen(WIN_A, 1)
      overlays.close(WIN_A, overlays.infos(WIN_A)[0]!.id)
      await settled(t)
      expect(t.results).toEqual([{ kind: 'dismissed' }])
      for (const signal of signals) expect(getEventListeners(signal, 'abort')).toEqual([])
    }
    // One signal per plugin copy (a.one, a.two), reused by each of its overlays.
    expect(signals.size).toBe(2)
    // A spec the manager rejects (an empty argv) gives its token back: a.one keeps what it has left.
    for (let i = 0; i < MAX_OVERLAYS_PER_WINDOW; i++) {
      await expect(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'terminal', argv: [] } })).rejects.toThrow('argv')
    }
    // The chain still works: one more overlay is dismissed when the host goes.
    const last = track(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'url', url: 'https://example.com/last' } }))
    await waitOpen(WIN_A, 1)
    expect(getEventListeners([...signals][0]!, 'abort')).toHaveLength(1)
    expect(getEventListeners([...signals][1]!, 'abort')).toEqual([])
    apis[0]!.dispose()
    await settled(last)
    expect(last.results).toEqual([{ kind: 'dismissed' }])
  })

  it('opens http(s) urls only', async () => {
    const call = hostA()
    await expect(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'url', url: 'file:///etc/passwd' } })).rejects.toThrow(
      'only http and https'
    )
    await expect(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'url', url: 'javascript:alert(1)' } })).rejects.toThrow(
      'only http and https'
    )
    const t = track(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'url', url: 'https://example.com/x' } }))
    await waitOpen(WIN_A, 1)
    expect(overlays.infos(WIN_A)[0]).toMatchObject({ kind: 'url', url: 'https://example.com/x' })
    overlays.close(WIN_A, overlays.infos(WIN_A)[0]!.id)
    await settled(t)
    expect(t.results).toEqual([{ kind: 'dismissed' }])
  })

  it("shows one of the plugin's own pages from its cc-plugin:// URL; the page's { result } resolves it", async () => {
    const call = hostA()
    const t = track(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'html', file: 'page.html', title: 'Pick' } }))
    await waitOpen(WIN_A, 1)
    const info = overlays.infos(WIN_A)[0]!
    // Loaded like a panel (the plugin's origin and CSP, the panel SDK), not copied into memory.
    expect(info).toEqual({ id: info.id, kind: 'html', title: 'Pick', src: 'cc-plugin://a.one/page.html', size: 'default' })
    expect(info.kind === 'html' && overlays.pageHtml(info.src)).toBeUndefined()
    // What the renderer relays when the page posts `{ result: { picked: 2 } }` (HtmlOverlay).
    expect(overlays.result(WIN_A, info.id, { picked: 2 })).toBe(true)
    await settled(t)
    expect(t.results).toEqual([{ kind: 'value', value: { picked: 2 } }])
    expect(overlays.infos(WIN_A)).toEqual([])

    // A page in a subfolder: the URL names its realpath inside the folder, each segment encoded.
    const nested = track(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'html', file: './pages/../pages/big.html' } }))
    await waitOpen(WIN_A, 1)
    const nestedInfo = overlays.infos(WIN_A)[0]!
    expect(nestedInfo.kind === 'html' && nestedInfo.src).toBe('cc-plugin://a.one/pages/big.html')
    overlays.close(WIN_A, nestedInfo.id)
    await settled(nested)
    expect(nested.results).toEqual([{ kind: 'dismissed' }])

    const refuse = (file: unknown, message: string): Promise<void> =>
      expect(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'html', file } })).rejects.toThrow(message)
    await refuse('../a.two/page.html', 'cannot read')
    await refuse('../../outside/secret.html', 'outside the plugin folder')
    await refuse('escape.html', 'outside the plugin folder')
    await refuse(join(pluginOne, 'page.html'), 'relative to the plugin folder')
    await refuse('pages', 'not a regular file')
    await refuse('.', 'outside the plugin folder')
    await refuse('missing.html', 'cannot read')
    // a.two's folder holds no page.html: each plugin reads from its own folder only.
    await expect(call('overlay.open', { pluginId: 'a.two', spec: { kind: 'html', file: 'page.html' } })).rejects.toThrow(
      'cannot read'
    )
    expect(overlays.infos(WIN_A)).toEqual([])
  })

  it('caps the overlays a plugin has open, and dismisses them when the host goes', async () => {
    const call = hostA()
    const pending = Array.from({ length: MAX_OPEN_OVERLAYS }, (_, i) =>
      track(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'url', url: `https://example.com/${i}` } }))
    )
    await waitOpen(WIN_A, MAX_OPEN_OVERLAYS)
    await expect(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'url', url: 'https://example.com/more' } })).rejects.toThrow(
      `already has ${MAX_OPEN_OVERLAYS} overlays open`
    )
    // Another plugin of the same host has its own budget.
    const other = track(call('overlay.open', { pluginId: 'a.two', spec: { kind: 'url', url: 'https://example.com/two' } }))
    await waitOpen(WIN_A, MAX_OPEN_OVERLAYS + 1)
    apis[0]!.dispose()
    for (const t of [...pending, other]) {
      await settled(t)
      expect(t.results).toEqual([{ kind: 'dismissed' }])
    }
    expect(overlays.infos(WIN_A)).toEqual([])
  })
})

describe('overlay messages (ctx.overlay.start)', () => {
  const H = '0f6c2c4e-1111-4222-8333-944455556666'
  const messagesTo = (windowId: number): unknown[] =>
    emitted.filter((e) => e.windowId === windowId && e.channel === 'overlays.message').map((e) => e.payload)
  const openHtml = async (
    call: (method: string, params?: unknown) => Promise<unknown>,
    handle = H
  ): Promise<{ result: Promise<unknown>; id: () => string }> => {
    const result = call('overlay.open', { pluginId: 'a.one', spec: { kind: 'html', file: 'page.html' }, handle })
    return { result, id: () => overlays.infos(WIN_A).at(-1)!.id }
  }

  it('queues posts until the overlay exists and its page loaded; page messages reach this host only', async () => {
    const events: { event: string; params: unknown }[] = []
    const call = hostA(events)
    const { result, id } = await openHtml(call)
    // Sent right behind the open, while main still checks the file: held by the handle.
    await expect(call('overlay.post', { pluginId: 'a.one', handle: H, message: { n: 1 } })).resolves.toBe(true)
    await vi.waitFor(() => expect(overlays.infos(WIN_A)).toHaveLength(1))
    await expect(call('overlay.post', { pluginId: 'a.one', handle: H, message: { n: 2 } })).resolves.toBe(true)
    // The page has not loaded: nothing reached the renderer yet.
    expect(messagesTo(WIN_A)).toEqual([])
    overlays.pageReady(WIN_A, id())
    expect(messagesTo(WIN_A)).toEqual([
      { overlayId: id(), message: '{"n":1}' },
      { overlayId: id(), message: '{"n":2}' }
    ])
    await call('overlay.post', { pluginId: 'a.one', handle: H, message: 'after load' })
    expect(messagesTo(WIN_A).at(-1)).toEqual({ overlayId: id(), message: '"after load"' })

    // The page posts without `result`: the overlay stays, the opener's host hears it with the handle.
    expect(overlays.pageMessage(WIN_A, id(), '{"draft":"hi"}')).toBe(true)
    expect(events).toContainEqual({ event: 'overlay.message', params: { pluginId: 'a.one', handle: H, message: { draft: 'hi' } } })
    expect(overlays.infos(WIN_A)).toHaveLength(1)
    // From another window's renderer the id is unknown; junk and oversize text are dropped.
    expect(overlays.pageMessage(WIN_B, id(), '{"x":1}')).toBe(false)
    expect(overlays.pageMessage(WIN_A, id(), 'not json')).toBe(false)
    expect(overlays.pageMessage(WIN_A, id(), JSON.stringify('x'.repeat(MAX_OVERLAY_MESSAGE_LENGTH)))).toBe(false)
    expect(events.filter((e) => e.event === 'overlay.message')).toHaveLength(1)

    // The final answer still closes it and resolves the open.
    const overlayId = id()
    expect(overlays.result(WIN_A, overlayId, { done: true })).toBe(true)
    await expect(result).resolves.toEqual({ kind: 'value', value: { done: true } })
    // Ended: the handle names nothing; post and close answer false (the host makes them no-ops).
    await expect(call('overlay.post', { pluginId: 'a.one', handle: H, message: 1 })).resolves.toBe(false)
    await expect(call('overlay.close', { pluginId: 'a.one', handle: H })).resolves.toBe(false)
    expect(overlays.post(WIN_A, overlayId, '1')).toBe(false)
  })

  it("another plugin, another window's host or a renderer never reach an overlay they did not open", async () => {
    const call = hostA()
    const { result, id } = await openHtml(call)
    await vi.waitFor(() => expect(overlays.infos(WIN_A)).toHaveLength(1))
    overlays.pageReady(WIN_A, id())
    // a.two shares the host but not the handle key.
    await expect(call('overlay.post', { pluginId: 'a.two', handle: H, message: 'x' })).resolves.toBe(false)
    await expect(call('overlay.close', { pluginId: 'a.two', handle: H })).resolves.toBe(false)
    // A plugin this host does not run is refused outright.
    await expect(call('overlay.post', { pluginId: 'b.one', handle: H, message: 'x' })).rejects.toThrow('unknown plugin')
    // The host of another window, even under the same plugin id and handle.
    const other = hostFor({ ...scopeA(), projectId: B, windowId: WIN_B, projectDir: projB })
    await expect(other('overlay.post', { pluginId: 'a.one', handle: H, message: 'x' })).resolves.toBe(false)
    await expect(other('overlay.close', { pluginId: 'a.one', handle: H })).resolves.toBe(false)
    // The manager itself scopes every id to the window asking.
    expect(overlays.post(WIN_B, id(), '"x"')).toBe(false)
    expect(messagesTo(WIN_A)).toEqual([])
    expect(messagesTo(WIN_B)).toEqual([])
    // The owner closes it: dismissed.
    await expect(call('overlay.close', { pluginId: 'a.one', handle: H })).resolves.toBe(true)
    await expect(result).resolves.toEqual({ kind: 'dismissed' })
  })

  it('close before the overlay exists dismisses it once it does; Esc dismisses it like any overlay', async () => {
    const call = hostA()
    const early = await openHtml(call)
    await expect(call('overlay.close', { pluginId: 'a.one', handle: H })).resolves.toBe(true)
    await expect(early.result).resolves.toEqual({ kind: 'dismissed' })
    expect(overlays.infos(WIN_A)).toEqual([])

    const later = await openHtml(call, 'second-handle')
    await vi.waitFor(() => expect(overlays.infos(WIN_A)).toHaveLength(1))
    expect(overlays.pop(WIN_A)).toBe(true)
    await expect(later.result).resolves.toEqual({ kind: 'dismissed' })
  })

  it("focus brings the plugin's own overlay to the top of its window; a no-op answer once it ended", async () => {
    const call = hostA()
    const { result, id } = await openHtml(call)
    // Still being created: it lands on top anyway, nothing to do.
    await expect(call('overlay.focus', { pluginId: 'a.one', handle: H })).resolves.toBe(true)
    await vi.waitFor(() => expect(overlays.infos(WIN_A)).toHaveLength(1))
    const mine = id()
    // Another overlay (a.two's) opens over it.
    void call('overlay.open', { pluginId: 'a.two', spec: { kind: 'url', url: 'https://example.com/two' }, handle: 'two-handle' })
    await vi.waitFor(() => expect(overlays.infos(WIN_A)).toHaveLength(2))
    expect(overlays.infos(WIN_A).at(-1)!.id).not.toBe(mine)
    // Only the opener reaches it: a.two under the same handle, another window's host, an unknown plugin.
    await expect(call('overlay.focus', { pluginId: 'a.two', handle: H })).resolves.toBe(false)
    const other = hostFor({ ...scopeA(), projectId: B, windowId: WIN_B, projectDir: projB })
    await expect(other('overlay.focus', { pluginId: 'a.one', handle: H })).resolves.toBe(false)
    await expect(call('overlay.focus', { pluginId: 'b.one', handle: H })).rejects.toThrow('unknown plugin')
    await expect(call('overlay.focus', { pluginId: 'a.one', handle: 'a/b' })).rejects.toThrow('bad handle')
    expect(overlays.infos(WIN_A).at(-1)!.id).not.toBe(mine)
    // The owner: on top, both still open, the renderer told.
    emitted = []
    await expect(call('overlay.focus', { pluginId: 'a.one', handle: H })).resolves.toBe(true)
    expect(overlays.infos(WIN_A).map((o) => o.id)).toHaveLength(2)
    expect(overlays.infos(WIN_A).at(-1)!.id).toBe(mine)
    expect(emitted.filter((e) => e.channel === 'overlays.updated')).toHaveLength(1)
    // Already on top: true, nothing changes.
    await expect(call('overlay.focus', { pluginId: 'a.one', handle: H })).resolves.toBe(true)
    expect(emitted.filter((e) => e.channel === 'overlays.updated')).toHaveLength(1)
    // Ended: false (the host makes it a no-op).
    await call('overlay.close', { pluginId: 'a.one', handle: H })
    await expect(result).resolves.toEqual({ kind: 'dismissed' })
    await expect(call('overlay.focus', { pluginId: 'a.one', handle: H })).resolves.toBe(false)
  })

  it('refuses focus when main has no focusOverlay', async () => {
    delete deps.focusOverlay
    const call = hostA()
    await openHtml(call)
    await vi.waitFor(() => expect(overlays.infos(WIN_A)).toHaveLength(1))
    await expect(call('overlay.focus', { pluginId: 'a.one', handle: H })).rejects.toThrow('overlay.focus: not available')
  })

  it("a plugin's ctx ending (plugin.disposed) dismisses its overlays only; the next copy's open normally", async () => {
    const call = hostA()
    const api = apis[0]!
    const html = await openHtml(call)
    const term = call('overlay.open', { pluginId: 'a.one', spec: { kind: 'terminal', argv: ['tig'] }, handle: 'term-handle' })
    const two = call('overlay.open', { pluginId: 'a.two', spec: { kind: 'url', url: 'https://example.com/two' }, handle: 'two-handle' })
    await vi.waitFor(() => expect(overlays.infos(WIN_A)).toHaveLength(3))
    const pty = overlayBackend.last
    // An open of the old copy still checking its file when the dispose arrives.
    const late = call('overlay.open', { pluginId: 'a.one', spec: { kind: 'html', file: 'page.html' }, handle: 'late-handle' })
    // The handler starts a microtask later (hostFor); the RPC port runs it before the event behind it.
    await Promise.resolve()
    api.contextDisposed({ pluginId: 'a.one' })
    await expect(html.result).resolves.toEqual({ kind: 'dismissed' })
    await expect(term).resolves.toEqual({ kind: 'dismissed' })
    await expect(late).resolves.toEqual({ kind: 'dismissed' })
    // The terminal's program is ended as on a close; a.two's overlay stays.
    expect(pty.killed).toBeGreaterThan(0)
    expect(overlays.infos(WIN_A)).toHaveLength(1)
    expect(overlays.infos(WIN_A)[0]).toMatchObject({ kind: 'url', url: 'https://example.com/two' })
    // The next copy (same plugin id, same handle even) opens and keeps its overlay.
    const next = await openHtml(call)
    await vi.waitFor(() => expect(overlays.infos(WIN_A)).toHaveLength(2))
    // A second dispose of a.two leaves a.one's new overlay alone; one for an id without overlays is a no-op.
    api.contextDisposed({ pluginId: 'a.two' })
    await expect(two).resolves.toEqual({ kind: 'dismissed' })
    api.contextDisposed({ pluginId: 'a.two' })
    api.contextDisposed({ pluginId: 5 })
    expect(overlays.infos(WIN_A)).toHaveLength(1)
    // The host going still dismisses what is left.
    api.dispose()
    await expect(next.result).resolves.toEqual({ kind: 'dismissed' })
    expect(overlays.infos(WIN_A)).toEqual([])
  })

  it('refuses a bad handle, a reused one, an oversize message and a full queue', async () => {
    const call = hostA()
    const bad = (handle: unknown): Promise<void> =>
      expect(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'html', file: 'page.html' }, handle })).rejects.toThrow('handle')
    await bad('')
    await bad('x'.repeat(65))
    await bad('a/b')
    await bad(5)
    const { result } = await openHtml(call)
    await expect(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'url', url: 'https://example.com' }, handle: H })).rejects.toThrow(
      'already in use'
    )
    await expect(call('overlay.post', { pluginId: 'a.one', handle: H, message: 'x'.repeat(MAX_OVERLAY_MESSAGE_LENGTH) })).rejects.toThrow(
      `exceeds ${MAX_OVERLAY_MESSAGE_LENGTH}`
    )
    await vi.waitFor(() => expect(overlays.infos(WIN_A)).toHaveLength(1))
    // The page never loads: the queue is bounded.
    for (let i = 0; i < MAX_QUEUED_OVERLAY_MESSAGES; i++) await call('overlay.post', { pluginId: 'a.one', handle: H, message: i })
    await expect(call('overlay.post', { pluginId: 'a.one', handle: H, message: 'one more' })).rejects.toThrow('queue is full')
    overlays.closeTop(WIN_A)
    await expect(result).resolves.toEqual({ kind: 'dismissed' })
    // The rate limits are as before: a refused open (bad handle) cost nothing.
    expect(messagesTo(WIN_A)).toEqual([])
  })
})

describe('the sessions event', () => {
  it("pushes this project's list, throttled, and nothing about other projects", async () => {
    vi.useFakeTimers()
    const events: { event: string; params: unknown }[] = []
    hostA(events)
    const theirs = tabs.create(B, { kind: 'claude' })
    registry.applyHook(theirs.id, 'Stop', {})
    await vi.advanceTimersByTimeAsync(SESSIONS_EVENT_INTERVAL_MS * 2)
    expect(events).toEqual([])

    const mine = tabs.create(A, { kind: 'claude' })
    registry.applyHook(mine.id, 'SessionStart', { session_id: 's1' })
    registry.applyHook(mine.id, 'UserPromptSubmit', { prompt: 'p' })
    await vi.advanceTimersByTimeAsync(SESSIONS_EVENT_INTERVAL_MS - 1)
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    // One event for the burst, with the latest state.
    expect(events).toEqual([
      {
        event: 'sessions',
        params: { sessions: [{ tabId: mine.id, status: 'working', cwd: projA, sessionId: 's1', lastPrompt: 'p', notes: [], files: [] }] }
      }
    ])
    // Gone: nothing more.
    apis[0]!.dispose()
    registry.applyHook(mine.id, 'Stop', {})
    await vi.advanceTimersByTimeAsync(SESSIONS_EVENT_INTERVAL_MS * 2)
    expect(events).toHaveLength(1)
  })
})

describe('accounts left core', () => {
  it('no account request exists any more: a plugin brings its own sign-in (design §6)', () => {
    const api = new HostApi(deps, scopeA(), () => {})
    apis.push(api)
    expect(Object.keys(api.handlers).filter((m) => m.startsWith('account'))).toEqual([])
  })
})

describe('files.open (ctx.files.open)', () => {
  /** The route as main wires it (open-file.ts), faked: what it was asked, and its answer. */
  function withRoute(answer: () => Promise<'plugin' | 'builtin'> = async () => 'plugin') {
    const asked: Array<{ caller: unknown; path: string; tabId?: string }> = []
    deps.openFile = (caller, path, tabId) => {
      asked.push({ caller, path, ...(tabId !== undefined ? { tabId } : {}) })
      return answer()
    }
    return asked
  }

  it("hands the route this host's own scope, never one from the request", async () => {
    const asked = withRoute()
    const call = hostA()
    await expect(call('files.open', { pluginId: 'a.one', path: 'src/a.ts', projectId: B, windowId: WIN_B })).resolves.toEqual({
      via: 'plugin'
    })
    await call('files.open', { pluginId: 'a.two', path: 'src/a.ts', tabId: 't1' })
    expect(asked).toEqual([
      { caller: { windowId: WIN_A, projectId: A }, path: 'src/a.ts' },
      { caller: { windowId: WIN_A, projectId: A }, path: 'src/a.ts', tabId: 't1' }
    ])
  })

  it('refuses an unknown plugin and bad shapes before the route, and prefixes the route’s refusal', async () => {
    const asked = withRoute(async () => {
      throw new Error('no such file: x')
    })
    const call = hostA()
    await expect(call('files.open', { pluginId: 'b.one', path: 'a' })).rejects.toThrow('unknown plugin')
    await expect(call('files.open', { pluginId: 'a.one', path: 5 })).rejects.toThrow('path must be a non-empty string')
    await expect(call('files.open', { pluginId: 'a.one', path: 'a', tabId: 5 })).rejects.toThrow('tabId must be a string')
    expect(asked).toEqual([])
    await expect(call('files.open', { pluginId: 'a.one', path: 'x' })).rejects.toThrow('files.open: no such file: x')
    apis[0]!.revoke()
    await expect(call('files.open', { pluginId: 'a.one', path: 'x' })).rejects.toThrow('stopping')
  })

  it('is refused when main wires no route', async () => {
    delete deps.openFile
    await expect(hostA()('files.open', { pluginId: 'a.one', path: 'a' })).rejects.toThrow('not available')
  })

  it(`allows ${MAX_FILE_OPENS_PER_WINDOW} per plugin per ${FILE_OPEN_WINDOW_MS / 1000} s, each plugin its own budget`, async () => {
    vi.useFakeTimers()
    const asked = withRoute()
    const call = hostA()
    for (let i = 0; i < MAX_FILE_OPENS_PER_WINDOW; i++) await call('files.open', { pluginId: 'a.one', path: 'a' })
    await expect(call('files.open', { pluginId: 'a.one', path: 'a' })).rejects.toThrow(`more than ${MAX_FILE_OPENS_PER_WINDOW} files`)
    await expect(call('files.open', { pluginId: 'a.two', path: 'a' })).resolves.toEqual({ via: 'plugin' })
    vi.advanceTimersByTime(FILE_OPEN_WINDOW_MS)
    await expect(call('files.open', { pluginId: 'a.one', path: 'a' })).resolves.toEqual({ via: 'plugin' })
    expect(asked).toHaveLength(MAX_FILE_OPENS_PER_WINDOW + 2)
  })
})

describe('RateWindow', () => {
  it('counts per key in fixed windows', () => {
    const rate = new RateWindow(2, 1000)
    expect([rate.take('a', 0), rate.take('a', 10), rate.take('a', 20), rate.take('b', 20)]).toEqual([true, true, false, true])
    expect(rate.take('a', 1000)).toBe(true)
    rate.refund('a')
    rate.refund('a')
    rate.refund('unknown')
    // Never below zero: two refunds of one token leave the budget at 2, not 3.
    expect([rate.take('a', 1001), rate.take('a', 1002), rate.take('a', 1003)]).toEqual([true, true, false])
  })
})
