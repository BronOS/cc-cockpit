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
  type OverlayChannel,
  type OverlayResult,
  type UrlView
} from '../../src/main/overlays/overlay-manager'
import {
  CLOSE_WINDOW_MS,
  EXTERNAL_OPEN_WINDOW_MS,
  FILE_OPEN_WINDOW_MS,
  FOCUS_WINDOW_MS,
  HostApi,
  MAX_CLOSES_PER_WINDOW,
  MAX_RENAMES_PER_WINDOW,
  RENAME_WINDOW_MS,
  MAX_FOCUSES_PER_WINDOW,
  MAX_SESSION_FILES_PER_WINDOW,
  SESSION_FILE_WINDOW_MS,
  MAX_EXTERNAL_OPENS_PER_WINDOW,
  MAX_FILE_OPENS_PER_WINDOW,
  MAX_OPEN_OVERLAYS,
  MAX_OPENS_PER_WINDOW,
  OPEN_WINDOW_MS,
  MAX_OVERLAYS_PER_WINDOW,
  MAX_SENDS_PER_WINDOW,
  RateWindow,
  SESSIONS_EVENT_INTERVAL_MS,
  type HostApiDeps,
  type HostScope,
  sessionInfoOf
} from '../../src/main/plugins/host-api'
import { newEntry } from '../../src/main/sessions/status-reducer'
import { RATE_LIMITS_EVENT_INTERVAL_MS, RateLimitsStore } from '../../src/main/sessions/rate-limits-store'
import { MAX_TEXT_CHARS, PASTE_END, PASTE_START } from '../../src/main/sessions/send-gate'
import { SessionRegistry } from '../../src/main/sessions/session-registry'
import { TabManager } from '../../src/main/tabs/tab-manager'
import type { TabInfo } from '../../src/shared/ipc'
import { defaultLayout } from '../../src/shared/layout'
import { FakePtyBackend } from '../fakes/fake-pty-backend'
import { unusedOAuth, unusedSecrets } from '../fakes/unused-host-services'
import type { RpcMeta } from '../../src/host/rpc'

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
let announced: { projectId: string; tab: TabInfo; windowId: number; focus?: boolean }[]
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
      closed: (tabId) => registry.tabClosed(tabId),
      renamed: (tabId, name) => void registry.setName(tabId, name),
      flagged: (tabId, flag) => void registry.setFlag(tabId, flag)
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
    activeTab: (projectId) => registry.activeTab(projectId),
    send: (tabId, text, origin) => registry.send(tabId, text, origin),
    onSessionsChange: (listener) => registry.onChange(listener),
    openTab: async (projectId, options, windowId, focus) => {
      const tab = tabs.create(projectId, { kind: 'claude', ...options })
      announced.push({ projectId, tab, windowId, ...(focus ? { focus } : {}) })
      return tab
    },
    openShellTab: async (projectId, options, windowId, focus) => {
      const tab = tabs.create(projectId, { kind: 'shell', ...options })
      announced.push({ projectId, tab, windowId, ...(focus ? { focus } : {}) })
      return tab
    },
    openCommandTab: async (projectId, options, windowId, focus) => {
      const tab = tabs.createPluginCommand(projectId, { ...options, openedByName: `name of ${options.openedBy}` })
      announced.push({ projectId, tab, windowId, ...(focus ? { focus } : {}) })
      return tab
    },
    setBadge: (projectId, key, badge) => layouts.setBadge(projectId, key, badge),
    setPanelHeader: (projectId, key, header) => layouts.setHeader(projectId, key, header),
    openOverlay: async (windowId, spec, opener, peerGone, channel, pluginId) =>
      overlays.open(windowId, spec, opener, peerGone, channel, pluginId),
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
    registry.send(mine.id, 'queued text', 'plugin')
    registry.tabOutput(mine.id, '\x1b]0;✳ Fixing it\x07')
    // The gist reaches plugins (design-next §4.1: the cockpit.sessions cards show it); the recent prompts do not.
    registry.setGist(mine.id, 'a gist')
    const list = (await hostA()('sessions.list', {})) as Record<string, unknown>[]
    expect(list).toEqual([
      { tabId: mine.id, status: 'working', cwd: join(projA, 'sub'), lastPrompt: 'fix it', title: 'Fixing it', gist: 'a gist', notes: [], files: [], typed: false }
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

  it('refuses a tab the person typed in, without spending the budget; before that it delivers as always', async () => {
    const tab = waitingTab(A)
    const live = waitingTab(A)
    const send = hostA()
    // Before the person types: the plugin's text goes in as before.
    await expect(send('sessions.send', { pluginId: 'a.one', tabId: tab, text: 'first' })).resolves.toEqual({ delivered: true })
    registry.applyHook(tab, 'UserPromptSubmit', { prompt: 'first' })
    registry.applyHook(tab, 'Stop', {})
    registry.userInput(A, tab, 'h')
    const before = ptyOf(tab).writes.length
    for (let i = 0; i < MAX_SENDS_PER_WINDOW + 5; i++) {
      await expect(send('sessions.send', { pluginId: 'a.one', tabId: tab, text: 'more' })).rejects.toThrow(
        'the person is typing in this tab'
      )
    }
    expect(ptyOf(tab).writes).toHaveLength(before)
    expect(registry.get(tab)!.queue).toEqual([])
    // Refunded each time: the whole budget minus the one delivered text is still there.
    for (let i = 1; i < MAX_SENDS_PER_WINDOW; i++) {
      await send('sessions.send', { pluginId: 'a.one', tabId: live, text: `t${i}` })
    }
    await expect(send('sessions.send', { pluginId: 'a.one', tabId: live, text: 'one more' })).rejects.toThrow(
      `more than ${MAX_SENDS_PER_WINDOW} texts`
    )
  })

  it("drops a plugin's queued text when the person types, so the next Stop types nothing", async () => {
    const tab = tabs.create(A, { kind: 'claude' })
    registry.applyHook(tab.id, 'SessionStart', { session_id: 's' })
    registry.applyHook(tab.id, 'UserPromptSubmit', { prompt: 'working on it' })
    const send = hostA()
    await expect(send('sessions.send', { pluginId: 'a.one', tabId: tab.id, text: 'next step' })).resolves.toMatchObject({ queued: true })
    registry.userInput(A, tab.id, 'x')
    expect(registry.get(tab.id)!.queue).toEqual([])
    registry.applyHook(tab.id, 'Stop', {})
    expect(ptyOf(tab.id).writes).toEqual([])
  })
})

describe('sessions.open', () => {
  it('passes model and effort to the tab as --model / --effort, and rejects anything else naming the field', async () => {
    const open = hostA()
    const both = (await open('sessions.open', { pluginId: 'a.one', prompt: 'go', model: 'haiku', effort: 'xhigh' })) as { tabId: string }
    expect(ptyOf(both.tabId).argv).toEqual([
      'claude', '--settings', '/data/hooks.json', '--model', 'haiku', '--effort', 'xhigh', '--', ' go'
    ])
    // A fresh host per value: each has its own 5-a-minute open budget.
    for (const model of ['haiku', 'sonnet', 'opus', 'fable']) {
      const t = (await hostA()('sessions.open', { pluginId: 'a.one', model })) as { tabId: string }
      expect(ptyOf(t.tabId).argv.slice(-2)).toEqual(['--model', model])
    }
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const t = (await hostA()('sessions.open', { pluginId: 'a.one', effort })) as { tabId: string }
      expect(ptyOf(t.tabId).argv.slice(-2)).toEqual(['--effort', effort])
    }
    await expect(open('sessions.open', { pluginId: 'a.one', model: 'gpt' })).rejects.toThrow('sessions.open: model must be one of')
    await expect(open('sessions.open', { pluginId: 'a.one', model: 5 })).rejects.toThrow('model must be one of')
    await expect(open('sessions.open', { pluginId: 'a.one', effort: 'extreme' })).rejects.toThrow('sessions.open: effort must be one of')
    await expect(open('sessions.open', { pluginId: 'a.one', effort: ['low'] })).rejects.toThrow('effort must be one of')
  })

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

  it('selects the new tab only with focus: true, in the host\'s own window', async () => {
    // Discuss in a new session opened a tab the person then had to find (real-work feedback 10).
    const open = hostA()
    const plain = (await open('sessions.open', { pluginId: 'a.one', prompt: 'x' })) as { tabId: string }
    const shown = (await open('sessions.open', { pluginId: 'a.one', prompt: 'y', focus: true })) as { tabId: string }
    const off = (await open('sessions.open', { pluginId: 'a.one', focus: false })) as { tabId: string }
    expect(announced.map((a) => [a.tab.id, a.windowId, a.focus])).toEqual([
      [plain.tabId, WIN_A, undefined],
      [shown.tabId, WIN_A, true],
      [off.tabId, WIN_A, undefined]
    ])
    // A wrong type is refused before a tab starts or the budget is spent.
    await expect(open('sessions.open', { pluginId: 'a.one', focus: 'yes' })).rejects.toThrow('focus must be a boolean')
    expect(tabsBackend.spawned).toHaveLength(3)
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

describe('sessions.openShell', () => {
  it("starts the person's login shell with nothing from the plugin: no command, argv, env or typing", async () => {
    const open = hostA()
    const { tabId } = (await open('sessions.openShell', {
      pluginId: 'a.one',
      // Riding along, never read: only cwd and focus are.
      command: 'rm -rf ~',
      argv: ['/bin/rm', '-rf', '/'],
      env: { EVIL: '1', PATH: '/tmp/evil' },
      prompt: 'hi'
    })) as { tabId: string }
    const pty = ptyOf(tabId)
    // shellArgv: the same `$SHELL -l` as the person's "+" > shell.
    expect(pty.argv).toEqual(['/bin/sh', '-l'])
    expect(pty.options.cwd).toBe(projA)
    expect(pty.options.env.EVIL).toBeUndefined()
    expect(pty.options.env.PATH).not.toContain('/tmp/evil')
    expect(pty.writes).toEqual([])
    expect(tabs.list(A).find((t) => t.id === tabId)?.kind).toBe('shell')
    // Told to the host's own window, never another project's.
    expect(announced).toEqual([{ projectId: A, tab: expect.objectContaining({ id: tabId, kind: 'shell' }), windowId: WIN_A }])
    expect(tabs.list(B)).toEqual([])
    // Not a Claude tab: no session in the registry for plugins to see.
    expect(registry.listByProject(A)).toEqual([])
  })

  it('starts in a folder inside the project, and refuses one outside by path, absolute path or symlink', async () => {
    const open = hostA()
    const { tabId } = (await open('sessions.openShell', { pluginId: 'a.one', cwd: 'sub' })) as { tabId: string }
    expect(ptyOf(tabId).options.cwd).toBe(join(projA, 'sub'))
    const abs = (await open('sessions.openShell', { pluginId: 'a.one', cwd: join(projA, 'sub') })) as { tabId: string }
    expect(ptyOf(abs.tabId).options.cwd).toBe(join(projA, 'sub'))
    await expect(open('sessions.openShell', { pluginId: 'a.one', cwd: '../outside' })).rejects.toThrow('sessions.openShell: cwd is outside the project')
    await expect(open('sessions.openShell', { pluginId: 'a.one', cwd: outside })).rejects.toThrow('outside the project')
    await expect(open('sessions.openShell', { pluginId: 'a.one', cwd: projB })).rejects.toThrow('outside the project')
    await expect(open('sessions.openShell', { pluginId: 'a.one', cwd: 'link-out' })).rejects.toThrow('outside the project')
    await expect(open('sessions.openShell', { pluginId: 'a.one', cwd: 5 })).rejects.toThrow('cwd must be a string')
    await expect(open('sessions.openShell', { pluginId: 'a.one', cwd: 'missing' })).rejects.toThrow('cwd does not exist')
    await expect(open('sessions.openShell', { pluginId: 'nope' })).rejects.toThrow('unknown plugin')
    expect(tabsBackend.spawned).toHaveLength(2)
    // None of the refusals spent the budget: three more fit.
    for (let i = 0; i < MAX_OPENS_PER_WINDOW - 2; i++) await open('sessions.openShell', { pluginId: 'a.one' })
    expect(tabsBackend.spawned).toHaveLength(MAX_OPENS_PER_WINDOW)
  })

  it('selects the tab only with focus: true, in the host\'s own window', async () => {
    const open = hostA()
    const plain = (await open('sessions.openShell', { pluginId: 'a.one' })) as { tabId: string }
    const shown = (await open('sessions.openShell', { pluginId: 'a.one', focus: true })) as { tabId: string }
    const off = (await open('sessions.openShell', { pluginId: 'a.one', focus: false })) as { tabId: string }
    expect(announced.map((a) => [a.tab.id, a.windowId, a.focus])).toEqual([
      [plain.tabId, WIN_A, undefined],
      [shown.tabId, WIN_A, true],
      [off.tabId, WIN_A, undefined]
    ])
    await expect(open('sessions.openShell', { pluginId: 'a.one', focus: 'yes' })).rejects.toThrow('focus must be a boolean')
    expect(tabsBackend.spawned).toHaveLength(3)
  })

  it("shares sessions.open's budget of 5 a minute per plugin", async () => {
    vi.useFakeTimers()
    const open = hostA()
    for (let i = 0; i < 3; i++) await open('sessions.open', { pluginId: 'a.one' })
    for (let i = 0; i < MAX_OPENS_PER_WINDOW - 3; i++) await open('sessions.openShell', { pluginId: 'a.one' })
    await expect(open('sessions.openShell', { pluginId: 'a.one' })).rejects.toThrow(
      `sessions.openShell: more than ${MAX_OPENS_PER_WINDOW} tabs in ${OPEN_WINDOW_MS / 1000} s`
    )
    await expect(open('sessions.open', { pluginId: 'a.one' })).rejects.toThrow(`more than ${MAX_OPENS_PER_WINDOW} tabs`)
    expect(tabsBackend.spawned).toHaveLength(MAX_OPENS_PER_WINDOW)
    // Per plugin: another plugin of the host has its own.
    await open('sessions.openShell', { pluginId: 'a.two' })
    // And a minute later the first one may open again.
    vi.advanceTimersByTime(OPEN_WINDOW_MS + 1)
    await open('sessions.openShell', { pluginId: 'a.one' })
    expect(tabsBackend.spawned).toHaveLength(MAX_OPENS_PER_WINDOW + 2)
  })

  it('is refused when main has no shell tabs to give', async () => {
    delete deps.openShellTab
    await expect(hostA()('sessions.openShell', { pluginId: 'a.one' })).rejects.toThrow('sessions.openShell: shell tabs are not available')
    expect(tabsBackend.spawned).toEqual([])
  })
})

describe('sessions.openCommand', () => {
  const ARGV = ['sh', '-c', 'echo "hello-$1"', 'sh', '$(id) x y']

  it('runs the argv with no shell in this project, marked with the asking plugin; extra keys are never read', async () => {
    const open = hostA()
    const { tabId } = (await open('sessions.openCommand', {
      pluginId: 'a.one',
      argv: ARGV,
      title: 'Hello',
      // Riding along, never read: no project, window, env or command line from the request.
      projectId: B,
      windowId: WIN_B,
      openedBy: 'a.two',
      command: 'rm -rf ~',
      env: { EVIL: '1', PATH: '/tmp/evil' }
    })) as { tabId: string }
    const pty = ptyOf(tabId)
    expect(pty.argv).toEqual(ARGV)
    expect(pty.options.cwd).toBe(projA)
    expect(pty.options.env.EVIL).toBeUndefined()
    expect(pty.options.env.PATH).not.toContain('/tmp/evil')
    expect(pty.writes).toEqual([])
    expect(tabs.list(A).find((t) => t.id === tabId)).toMatchObject({
      kind: 'command',
      label: 'Hello',
      argv: ARGV,
      openedBy: 'a.one',
      openedByName: 'name of a.one'
    })
    expect(announced).toEqual([{ projectId: A, tab: expect.objectContaining({ id: tabId, kind: 'command' }), windowId: WIN_A }])
    expect(tabs.list(B)).toEqual([])
    // Not a Claude tab: no session for plugins to see.
    expect(registry.listByProject(A)).toEqual([])
  })

  it('titles the tab after argv[0] when no title is given, and selects it only with focus: true', async () => {
    const open = hostA()
    const plain = (await open('sessions.openCommand', { pluginId: 'a.one', argv: ['/usr/local/bin/glow', 'README.md'] })) as { tabId: string }
    const shown = (await open('sessions.openCommand', { pluginId: 'a.one', argv: ['less'], focus: true })) as { tabId: string }
    expect(tabs.list(A).map((t) => t.label)).toEqual(['glow', 'less'])
    expect(announced.map((a) => [a.tab.id, a.windowId, a.focus])).toEqual([
      [plain.tabId, WIN_A, undefined],
      [shown.tabId, WIN_A, true]
    ])
  })

  it('starts in a folder inside the project, and refuses one outside by path, absolute path or symlink', async () => {
    const open = hostA()
    const { tabId } = (await open('sessions.openCommand', { pluginId: 'a.one', argv: ['ls'], cwd: 'sub' })) as { tabId: string }
    expect(ptyOf(tabId).options.cwd).toBe(join(projA, 'sub'))
    for (const cwd of ['../outside', outside, projB, 'link-out']) {
      await expect(open('sessions.openCommand', { pluginId: 'a.one', argv: ['ls'], cwd })).rejects.toThrow('sessions.openCommand: cwd is outside the project')
    }
    await expect(open('sessions.openCommand', { pluginId: 'a.one', argv: ['ls'], cwd: 'missing' })).rejects.toThrow('cwd does not exist')
    expect(tabsBackend.spawned).toHaveLength(1)
  })

  it('refuses each bad param before spending the budget or spawning anything', async () => {
    const open = hostA()
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ pluginId: 'nope', argv: ['ls'] }, 'unknown plugin'],
      [{ pluginId: 'a.one' }, 'argv must be an array of 1-64 strings'],
      [{ pluginId: 'a.one', argv: 'ls -la' }, 'argv must be an array'],
      [{ pluginId: 'a.one', argv: [] }, 'argv must be an array'],
      [{ pluginId: 'a.one', argv: Array(65).fill('x') }, 'argv must be an array of 1-64 strings'],
      [{ pluginId: 'a.one', argv: ['ls', 5] }, 'argv must hold strings only'],
      [{ pluginId: 'a.one', argv: ['ls', ''] }, 'each argv element must be 1-4096 characters'],
      [{ pluginId: 'a.one', argv: ['x'.repeat(4097)] }, 'each argv element must be 1-4096 characters'],
      [{ pluginId: 'a.one', argv: ['ls', 'a\0b'] }, 'argv may not contain a NUL character'],
      [{ pluginId: 'a.one', argv: ['ls'], cwd: 5 }, 'cwd must be a string'],
      [{ pluginId: 'a.one', argv: ['ls'], focus: 'yes' }, 'focus must be a boolean'],
      [{ pluginId: 'a.one', argv: ['ls'], title: '' }, 'title must be 1-60 characters on one line'],
      [{ pluginId: 'a.one', argv: ['ls'], title: 'x'.repeat(61) }, 'title must be 1-60'],
      [{ pluginId: 'a.one', argv: ['ls'], title: 'two\nlines' }, 'title must be 1-60 characters on one line'],
      [{ pluginId: 'a.one', argv: ['ls'], title: 7 }, 'title must be']
    ]
    for (const [params, message] of refusals) {
      await expect(open('sessions.openCommand', params), JSON.stringify(params).slice(0, 80)).rejects.toThrow(message)
    }
    expect(tabsBackend.spawned).toEqual([])
    // None of them spent the budget: the full five still fit.
    for (let i = 0; i < MAX_OPENS_PER_WINDOW; i++) await open('sessions.openCommand', { pluginId: 'a.one', argv: ['ls'] })
    expect(tabsBackend.spawned).toHaveLength(MAX_OPENS_PER_WINDOW)
  })

  it("shares the 5 a minute of sessions.open and sessions.openShell, per plugin", async () => {
    vi.useFakeTimers()
    const open = hostA()
    await open('sessions.open', { pluginId: 'a.one' })
    await open('sessions.openShell', { pluginId: 'a.one' })
    for (let i = 0; i < MAX_OPENS_PER_WINDOW - 2; i++) await open('sessions.openCommand', { pluginId: 'a.one', argv: ['ls'] })
    await expect(open('sessions.openCommand', { pluginId: 'a.one', argv: ['ls'] })).rejects.toThrow(
      `sessions.openCommand: more than ${MAX_OPENS_PER_WINDOW} tabs in ${OPEN_WINDOW_MS / 1000} s`
    )
    await expect(open('sessions.openShell', { pluginId: 'a.one' })).rejects.toThrow(`more than ${MAX_OPENS_PER_WINDOW} tabs`)
    await expect(open('sessions.open', { pluginId: 'a.one' })).rejects.toThrow(`more than ${MAX_OPENS_PER_WINDOW} tabs`)
    expect(tabsBackend.spawned).toHaveLength(MAX_OPENS_PER_WINDOW)
    await open('sessions.openCommand', { pluginId: 'a.two', argv: ['ls'] })
    vi.advanceTimersByTime(OPEN_WINDOW_MS + 1)
    await open('sessions.openCommand', { pluginId: 'a.one', argv: ['ls'] })
    expect(tabsBackend.spawned).toHaveLength(MAX_OPENS_PER_WINDOW + 2)
  })

  it("a host of project B opens in B: the project is the host's, never a param", async () => {
    const openB = hostFor({ projectId: B, windowId: WIN_B, projectDir: projB, plugins: [{ id: 'b.one', dir: pluginOne, panels: ['board'] }] })
    const { tabId } = (await openB('sessions.openCommand', { pluginId: 'b.one', argv: ['ls'], projectId: A })) as { tabId: string }
    expect(tabs.list(B).map((t) => t.id)).toEqual([tabId])
    expect(tabs.list(A)).toEqual([])
    expect(announced).toEqual([{ projectId: B, tab: expect.objectContaining({ id: tabId, openedBy: 'b.one' }), windowId: WIN_B }])
    // A plugin of the other host is unknown here.
    await expect(openB('sessions.openCommand', { pluginId: 'a.one', argv: ['ls'] })).rejects.toThrow('unknown plugin')
  })

  it('is refused when main has no command tabs to give', async () => {
    delete deps.openCommandTab
    await expect(hostA()('sessions.openCommand', { pluginId: 'a.one', argv: ['ls'] })).rejects.toThrow(
      'sessions.openCommand: command tabs are not available'
    )
    expect(tabsBackend.spawned).toEqual([])
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
      ['sessions.openShell', { pluginId: 'a.one' }],
      ['sessions.openCommand', { pluginId: 'a.one', argv: ['ls'] }],
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

describe('panels.header / panelAction', () => {
  const headerOf = (projectId: string, key: string): unknown =>
    layouts.view(projectId)!.panels.find((p) => p.panelKey === key)?.header
  const refresh = { id: 'refresh', icon: 'refresh', title: 'Refresh' }

  it("sets the header of the plugin's own panel only, a plugin .svg as its cc-plugin:// url", async () => {
    const call = hostA()
    await call('panels.header', {
      pluginId: 'a.one',
      panelId: 'board',
      header: { meta: '3 open', actions: [{ ...refresh, busy: true }, { id: 'star', icon: 'icons/my star.svg', title: 'Star', disabled: true }] }
    })
    expect(headerOf(A, 'a.one/board')).toEqual({
      meta: '3 open',
      actions: [
        { id: 'refresh', title: 'Refresh', icon: 'refresh', busy: true },
        { id: 'star', title: 'Star', iconSrc: 'cc-plugin://a.one/icons/my%20star.svg', disabled: true }
      ]
    })
    // Never another plugin's panel, a core panel, or a plugin this host does not run.
    for (const panelId of ['inbox', 'a.two/inbox', 'core/sessions', '../board']) {
      await expect(call('panels.header', { pluginId: 'a.one', panelId, header: { meta: 'x' } }), panelId).rejects.toThrow(
        'declares no panel'
      )
    }
    await expect(call('panels.header', { pluginId: 'b.one', panelId: 'board', header: { meta: 'x' } })).rejects.toThrow(
      'unknown plugin'
    )
    expect(headerOf(A, 'a.two/inbox')).toBeUndefined()
    expect(headerOf(A, 'core/sessions')).toBeUndefined()
    expect(headerOf(B, 'b.one/board')).toBeUndefined()
    await call('panels.header', { pluginId: 'a.one', panelId: 'board', header: null })
    expect(headerOf(A, 'a.one/board')).toBeUndefined()
  })

  it('checks the header again, whatever the host sent: limits, ids, icons, plain strings', async () => {
    const call = hostA()
    const action = (over: Record<string, unknown>) => ({ ...refresh, ...over })
    for (const [header, message] of [
      [{ actions: [action({ id: 'a' }), action({ id: 'b' }), action({ id: 'c' }), action({ id: 'd' })] }, 'at most 3 actions'],
      [{ actions: [action({ id: 'no spaces' })] }, 'must be 1 to 40 letters'],
      [{ actions: [action({ id: '<b>' })] }, 'must be 1 to 40 letters'],
      [{ actions: [action({}), action({})] }, 'used twice'],
      [{ actions: [action({ title: 'x'.repeat(81) })] }, 'title is longer than 80'],
      [{ actions: [action({ title: { html: '<b>' } })] }, 'title must be a non-empty string'],
      [{ actions: [action({ icon: '../../outside.svg' })] }, 'must not contain ".." segments'],
      [{ actions: [action({ icon: 'javascript:alert(1)' })] }, 'icon must be one of'],
      [{ meta: 'x'.repeat(121) }, 'meta is longer than 120'],
      [{ meta: ['x'] }, 'meta must be a string'],
      ['<b>x</b>', 'must be an object or null']
    ] as const) {
      await expect(call('panels.header', { pluginId: 'a.one', panelId: 'board', header }), JSON.stringify(header)).rejects.toThrow(message)
    }
    expect(headerOf(A, 'a.one/board')).toBeUndefined()
  })

  it('delivers a click only on an action the current header has, not busy or disabled', async () => {
    const events: { event: string; params: unknown }[] = []
    const call = hostA(events)
    const api = apis[0]!
    const clicks = (): unknown[] => events.filter((e) => e.event === 'panel.action').map((e) => e.params)
    // Nothing set yet: nothing to click.
    expect(api.panelAction('a.one/board', 'refresh')).toBe(false)
    await call('panels.header', {
      pluginId: 'a.one',
      panelId: 'board',
      header: { actions: [refresh, { id: 'add', icon: 'add', title: 'Add', disabled: true }] }
    })
    expect(api.panelAction('a.one/board', 'refresh')).toBe(true)
    expect(clicks()).toEqual([{ pluginId: 'a.one', panelId: 'board', actionId: 'refresh' }])
    // A remote view's click (the router's caller) names that view: the host runs the listeners in it.
    expect(api.panelAction('a.one/board', 'refresh', 'web:3')).toBe(true)
    expect(clicks().at(-1)).toEqual({ pluginId: 'a.one', panelId: 'board', actionId: 'refresh', view: 'web:3' })
    // An unknown or disabled action, another panel, a key no header of this host is on.
    expect(api.panelAction('a.one/board', 'nope')).toBe(false)
    expect(api.panelAction('a.one/board', 'add')).toBe(false)
    expect(api.panelAction('a.two/inbox', 'refresh')).toBe(false)
    expect(api.panelAction('core/sessions', 'refresh')).toBe(false)
    // Busy: the click that raced the header making it busy is dropped.
    await call('panels.header', { pluginId: 'a.one', panelId: 'board', header: { actions: [{ ...refresh, busy: true }] } })
    expect(api.panelAction('a.one/board', 'refresh')).toBe(false)
    // Cleared: the action is gone.
    await call('panels.header', { pluginId: 'a.one', panelId: 'board', header: { actions: [refresh] } })
    await call('panels.header', { pluginId: 'a.one', panelId: 'board', header: null })
    expect(api.panelAction('a.one/board', 'refresh')).toBe(false)
    expect(clicks()).toHaveLength(2)
    // A stopping host takes no clicks.
    await call('panels.header', { pluginId: 'a.one', panelId: 'board', header: { actions: [refresh] } })
    api.revoke()
    expect(api.panelAction('a.one/board', 'refresh')).toBe(false)
    expect(clicks()).toHaveLength(2)
  })

  it("clears the headers when the host goes, the plugin's ctx ends or it reloads; a newer host's stay", async () => {
    const call = hostA()
    const api = apis[0]!
    await call('panels.header', { pluginId: 'a.one', panelId: 'board', header: { meta: 'one' } })
    await call('panels.header', { pluginId: 'a.two', panelId: 'inbox', header: { meta: 'two', actions: [refresh] } })
    layouts.setBadge(A, 'a.two/inbox', { kind: 'dot' })
    // a.one's ctx ended (an unload for bad settings, a failed activate): only its header goes.
    api.contextDisposed({ pluginId: 'a.one' })
    expect(headerOf(A, 'a.one/board')).toBeUndefined()
    expect(headerOf(A, 'a.two/inbox')).toEqual({ meta: 'two', actions: [{ id: 'refresh', title: 'Refresh', icon: 'refresh' }] })
    // A reload in place: the old copy's header goes, the badge is the layout's to keep.
    apis[0]!.updatePlugin({ id: 'a.two', dir: pluginTwo, panels: ['inbox'] })
    expect(headerOf(A, 'a.two/inbox')).toBeUndefined()
    expect(api.panelAction('a.two/inbox', 'refresh')).toBe(false)
    // The host goes: what it set is cleared, except where a newer host of the project set one.
    await call('panels.header', { pluginId: 'a.one', panelId: 'board', header: { meta: 'again' } })
    await call('panels.header', { pluginId: 'a.two', panelId: 'inbox', header: { meta: 'again' } })
    const newer = hostA()
    await newer('panels.header', { pluginId: 'a.two', panelId: 'inbox', header: { meta: 'newer' } })
    api.dispose(undefined, (key) => apis[1]!.hasHeader(key))
    expect(headerOf(A, 'a.one/board')).toBeUndefined()
    expect(headerOf(A, 'a.two/inbox')).toEqual({ meta: 'newer' })
    await expect(call('panels.header', { pluginId: 'a.one', panelId: 'board', header: null })).rejects.toThrow('stopping')
  })
})

describe('slots.available (design-next §2)', () => {
  it('asks the provider lookup of this host\'s own project, and is false without one', async () => {
    const asked: { projectId: string; type: string }[] = []
    deps.slotAvailable = (projectId, type) => {
      asked.push({ projectId, type })
      return type === 'agenda'
    }
    const call = hostA()
    await expect(call('slots.available', { pluginId: 'a.one', type: 'agenda' })).resolves.toBe(true)
    await expect(call('slots.available', { pluginId: 'a.one', type: 'weather' })).resolves.toBe(false)
    expect(asked).toEqual([
      { projectId: A, type: 'agenda' },
      { projectId: A, type: 'weather' }
    ])
    await expect(call('slots.available', { pluginId: 'b.one', type: 'agenda' })).rejects.toThrow('unknown plugin')
    await expect(call('slots.available', { pluginId: 'a.one', type: 'Bad Type' })).rejects.toThrow('not a slot type')
    deps.slotAvailable = undefined
    await expect(call('slots.available', { pluginId: 'a.one', type: 'agenda' })).resolves.toBe(false)
  })
})

describe('panels.slots (design-next §2)', () => {
  /** What the layout service was told, per panel key (the last call). */
  let placed: Map<string, unknown>
  const scope = (): HostScope => ({
    ...scopeA(),
    plugins: [
      { id: 'a.one', dir: pluginOne, panels: ['board'], panelSlots: { board: ['agenda', 'weather'] } },
      { id: 'a.two', dir: pluginTwo, panels: ['inbox'], panelSlots: { inbox: ['agenda'] } }
    ]
  })
  const agenda = { type: 'agenda', position: 'top', height: 80 }
  beforeEach(() => {
    placed = new Map()
    deps.setPanelSlots = (projectId, key, placements) => {
      placed.set(`${projectId}:${key}`, placements)
      return layouts.setSlots(projectId, key, placements)
    }
  })

  it("places slots on the plugin's own panel only, with types its manifest lists", async () => {
    const call = hostFor(scope())
    await call('panels.slots', { pluginId: 'a.one', panelId: 'board', placements: [agenda, { type: 'weather', position: 'bottom', height: 40, params: { city: 'x' } }] })
    expect(placed.get(`${A}:a.one/board`)).toEqual([agenda, { type: 'weather', position: 'bottom', height: 40, params: { city: 'x' } }])
    // Never another plugin's panel, a core panel, or a plugin this host does not run.
    for (const panelId of ['inbox', 'a.two/inbox', 'core/sessions', '../board']) {
      await expect(call('panels.slots', { pluginId: 'a.one', panelId, placements: [agenda] }), panelId).rejects.toThrow('declares no panel')
    }
    await expect(call('panels.slots', { pluginId: 'b.one', panelId: 'board', placements: [agenda] })).rejects.toThrow('unknown plugin')
    // A type the panel does not list (another panel of the same host lists it, or nobody does), an app type.
    await expect(call('panels.slots', { pluginId: 'a.two', panelId: 'inbox', placements: [{ ...agenda, type: 'weather' }] })).rejects.toThrow(
      'does not list slot "weather"'
    )
    await expect(call('panels.slots', { pluginId: 'a.one', panelId: 'board', placements: [{ ...agenda, type: 'sessions-strip' }] })).rejects.toThrow(
      'placed by the app'
    )
    // A plugin whose manifest lists no slots at all.
    const bare = hostA()
    await expect(bare('panels.slots', { pluginId: 'a.one', panelId: 'board', placements: [agenda] })).rejects.toThrow('does not list slot')
    expect(placed.has(`${A}:a.two/inbox`)).toBe(false)
    await call('panels.slots', { pluginId: 'a.one', panelId: 'board', placements: null })
    expect(placed.get(`${A}:a.one/board`)).toBeNull()
  })

  it('budgets the calls per plugin: a changed params is a new frame, so a loop is refused', async () => {
    const call = hostFor(scope())
    for (let i = 0; i < 60; i++) {
      await call('panels.slots', { pluginId: 'a.one', panelId: 'board', placements: [{ ...agenda, params: { n: i } }] })
    }
    await expect(call('panels.slots', { pluginId: 'a.one', panelId: 'board', placements: [agenda] })).rejects.toThrow('more than 60 calls')
  })

  it('checks the placements again, whatever the host sent: caps, positions, the height clamp, plain JSON params', async () => {
    const call = hostFor(scope())
    const at = (over: Record<string, unknown>) => ({ pluginId: 'a.one', panelId: 'board', placements: [{ ...agenda, ...over }] })
    for (const [params, message] of [
      [{ pluginId: 'a.one', panelId: 'board', placements: [agenda, agenda, agenda, agenda, agenda] }, 'at most 4 placements'],
      [{ pluginId: 'a.one', panelId: 'board', placements: agenda }, 'must be an array or null'],
      [{ pluginId: 'a.one', panelId: 'board', placements: ['agenda'] }, 'must be an object'],
      [at({ type: 'Agenda' }), 'type must match'],
      [at({ position: 'inline' }), 'position must be "top" or "bottom"'],
      [at({ height: '80' }), 'height must be a number'],
      [at({ height: Number.POSITIVE_INFINITY }), 'height must be a number'],
      [at({ params: () => 1 }), 'params must be plain JSON'],
      [at({ params: 10n }), 'params must be plain JSON'],
      [at({ params: { text: 'é'.repeat(2100) } }), 'params are larger than 4096 bytes']
    ] as const) {
      await expect(call('panels.slots', params), JSON.stringify(params, (_k, v) => (typeof v === 'bigint' ? 'big' : v))).rejects.toThrow(message)
    }
    expect(placed.size).toBe(0)
    // Heights are clamped to 24-600 and rounded; params become a clean JSON copy.
    await call('panels.slots', {
      pluginId: 'a.one',
      panelId: 'board',
      placements: [
        { ...agenda, height: 3 },
        { ...agenda, height: 9000 },
        { ...agenda, height: 99.6, params: { when: new Date(0), skip: undefined, list: [1, 'two'] } }
      ]
    })
    expect(placed.get(`${A}:a.one/board`)).toEqual([
      { ...agenda, height: 24 },
      { ...agenda, height: 600 },
      { ...agenda, height: 100, params: { when: '1970-01-01T00:00:00.000Z', list: [1, 'two'] } }
    ])
  })

  it("clears the placements when the plugin's ctx ends, it reloads or the host goes; a newer host's stay", async () => {
    const call = hostFor(scope())
    const api = apis[0]!
    await call('panels.slots', { pluginId: 'a.one', panelId: 'board', placements: [agenda] })
    await call('panels.slots', { pluginId: 'a.two', panelId: 'inbox', placements: [agenda] })
    expect(api.hasSlots('a.one/board')).toBe(true)
    api.contextDisposed({ pluginId: 'a.one' })
    expect(placed.get(`${A}:a.one/board`)).toBeNull()
    expect(api.hasSlots('a.one/board')).toBe(false)
    expect(placed.get(`${A}:a.two/inbox`)).toEqual([agenda])
    api.updatePlugin({ id: 'a.two', dir: pluginTwo, panels: ['inbox'], panelSlots: { inbox: ['agenda'] } })
    expect(placed.get(`${A}:a.two/inbox`)).toBeNull()
    // The host goes: what it placed is cleared, except where a newer host of the project placed.
    await call('panels.slots', { pluginId: 'a.one', panelId: 'board', placements: [agenda] })
    await call('panels.slots', { pluginId: 'a.two', panelId: 'inbox', placements: [agenda] })
    const newer = hostFor(scope())
    await newer('panels.slots', { pluginId: 'a.two', panelId: 'inbox', placements: [{ ...agenda, height: 90 }] })
    api.dispose(undefined, undefined, (key) => apis[1]!.hasSlots(key))
    expect(placed.get(`${A}:a.one/board`)).toBeNull()
    expect(placed.get(`${A}:a.two/inbox`)).toEqual([{ ...agenda, height: 90 }])
    await expect(call('panels.slots', { pluginId: 'a.one', panelId: 'board', placements: null })).rejects.toThrow('stopping')
  })

  it('is refused without the layout service', async () => {
    delete deps.setPanelSlots
    await expect(hostFor(scope())('panels.slots', { pluginId: 'a.one', panelId: 'board', placements: [agenda] })).rejects.toThrow(
      'slots are not available'
    )
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

  it("resolves the opener's .svg button icons in that plugin's own folder", async () => {
    const call = hostA()
    void call('overlay.open', {
      pluginId: 'a.one',
      spec: { kind: 'html', file: 'page.html', buttons: [{ id: 'star', label: 'Star', icon: 'star.svg' }, { id: 'ok', label: 'OK', icon: 'check' }] }
    })
    await waitOpen(WIN_A, 1)
    expect(overlays.infos(WIN_A)[0]!.buttons).toEqual([
      { id: 'star', label: 'Star', iconSrc: 'cc-plugin://a.one/star.svg' },
      { id: 'ok', label: 'OK', icon: 'check' }
    ])
    overlays.close(WIN_A, overlays.infos(WIN_A)[0]!.id)
  })

  it("shows one of the plugin's own pages from its cc-plugin:// URL; the page's { result } resolves it", async () => {
    const call = hostA()
    const t = track(call('overlay.open', { pluginId: 'a.one', spec: { kind: 'html', file: 'page.html', title: 'Pick' } }))
    await waitOpen(WIN_A, 1)
    const info = overlays.infos(WIN_A)[0]!
    // Loaded like a panel (the plugin's origin and CSP, the panel SDK), not copied into memory.
    expect(info).toEqual({ id: info.id, kind: 'html', title: 'Pick', src: 'cc-plugin://a.one/page.html', size: 'default', loading: true })
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
        params: { sessions: [{ tabId: mine.id, status: 'working', cwd: projA, sessionId: 's1', lastPrompt: 'p', notes: [], files: [], typed: false }] }
      }
    ])
    // Gone: nothing more.
    apis[0]!.dispose()
    registry.applyHook(mine.id, 'Stop', {})
    await vi.advanceTimersByTimeAsync(SESSIONS_EVENT_INTERVAL_MS * 2)
    expect(events).toHaveLength(1)
  })

  it('marks the tab the window shows as active, in the list and in an event for a selection change', async () => {
    vi.useFakeTimers()
    const events: { event: string; params: unknown }[] = []
    const call = hostA(events)
    const one = tabs.create(A, { kind: 'claude' })
    const two = tabs.create(A, { kind: 'claude' })
    const theirs = tabs.create(B, { kind: 'claude' })
    await vi.advanceTimersByTimeAsync(SESSIONS_EVENT_INTERVAL_MS)
    events.length = 0
    registry.setActive(A, two.id)
    registry.setActive(B, theirs.id)
    const listed = (await call('sessions.list', {})) as { tabId: string; active?: boolean }[]
    expect(listed.map((s) => [s.tabId, s.active])).toEqual([
      [one.id, undefined],
      [two.id, true]
    ])
    // Absent, not false, on the others.
    expect('active' in listed[0]!).toBe(false)
    await vi.advanceTimersByTimeAsync(SESSIONS_EVENT_INTERVAL_MS)
    expect(events).toHaveLength(1)
    const pushed = (events[0]!.params as { sessions: { tabId: string; active?: boolean }[] }).sessions
    expect(pushed.filter((s) => s.active).map((s) => s.tabId)).toEqual([two.id])
  })

  it('carries typed (false until the person types), and its flip reaches the sessions event', async () => {
    vi.useFakeTimers()
    const events: { event: string; params: unknown }[] = []
    const call = hostA(events)
    const tab = waitingTab(A)
    // A plugin's send is delivered through the gate's write (tabs.input), never userInput: still false.
    await call('sessions.send', { pluginId: 'a.one', tabId: tab, text: 'hello' })
    await vi.advanceTimersByTimeAsync(SESSIONS_EVENT_INTERVAL_MS)
    const typedOf = async () => ((await call('sessions.list', {})) as { typed: boolean }[]).map((s) => s.typed)
    expect(await typedOf()).toEqual([false])
    events.length = 0
    // A focus report (switching to the tab) is not typing; a key is.
    registry.userInput(A, tab, '\x1b[I')
    await vi.advanceTimersByTimeAsync(SESSIONS_EVENT_INTERVAL_MS)
    expect(events).toEqual([])
    registry.userInput(A, tab, 'x')
    await vi.advanceTimersByTimeAsync(SESSIONS_EVENT_INTERVAL_MS)
    expect(events).toHaveLength(1)
    expect((events[0]!.params as { sessions: { typed: boolean }[] }).sessions.map((s) => s.typed)).toEqual([true])
    expect(await typedOf()).toEqual([true])
  })
})

describe('plan usage (ctx.sessions.rateLimits / onRateLimits) and the status line fields', () => {
  const five = { usedPercent: 40, resetsAt: 1_762_600_000_000 }

  it('answers null before the first report, then the latest, to any plugin of the host and no other id', async () => {
    const store = new RateLimitsStore({ log: () => {} })
    deps.rateLimits = () => store.get()
    deps.onRateLimitsChange = (listener) => store.onChange(listener)
    const call = hostA()
    expect(await call('sessions.rateLimits', { pluginId: 'a.one' })).toBeNull()
    store.report({ fiveHour: five })
    expect(await call('sessions.rateLimits', { pluginId: 'a.two' })).toEqual({ fiveHour: five, updatedAt: expect.any(Number) })
    await expect(call('sessions.rateLimits', { pluginId: 'b.one' })).rejects.toThrow('sessions.rateLimits: unknown plugin')
    await expect(call('sessions.rateLimits', {})).rejects.toThrow('unknown plugin')
    store.dispose()
  })

  it('is null without the dep (an app wired without the store)', async () => {
    expect(await hostA()('sessions.rateLimits', { pluginId: 'a.one' })).toBeNull()
  })

  it('pushes a change to every host, throttled by the store, and nothing once revoked', async () => {
    vi.useFakeTimers()
    const store = new RateLimitsStore({ log: () => {} })
    deps.rateLimits = () => store.get()
    deps.onRateLimitsChange = (listener) => store.onChange(listener)
    const eventsA: { event: string; params: unknown }[] = []
    const eventsB: { event: string; params: unknown }[] = []
    hostA(eventsA)
    hostFor({ projectId: B, windowId: WIN_B, projectDir: projB, plugins: [{ id: 'b.one', dir: pluginOne, panels: ['board'] }] }, eventsB)
    store.report({ fiveHour: five })
    store.report({ fiveHour: { ...five, usedPercent: 41 } })
    expect(eventsA).toEqual([{ event: 'sessions.rateLimits', params: { rateLimits: { fiveHour: five, updatedAt: expect.any(Number) } } }])
    expect(eventsB).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(RATE_LIMITS_EVENT_INTERVAL_MS)
    expect(eventsA.map((e) => (e.params as { rateLimits: { fiveHour: { usedPercent: number } } }).rateLimits.fiveHour.usedPercent)).toEqual([40, 41])
    apis[0]!.revoke()
    store.report({ fiveHour: { ...five, usedPercent: 50 } })
    await vi.advanceTimersByTimeAsync(RATE_LIMITS_EVENT_INTERVAL_MS)
    expect(eventsA).toHaveLength(2)
    expect(eventsB).toHaveLength(3)
    await expect(hostA()('sessions.rateLimits', { pluginId: 'a.one' })).resolves.toMatchObject({ fiveHour: { usedPercent: 50 } })
    store.dispose()
  })

  it("carries a tab's costUsd and contextPercent in SessionInfo, gone once its process exits", async () => {
    const call = hostA()
    const tab = tabs.create(A, { kind: 'claude' })
    registry.setUsage(tab.id, { costUsd: 0.75, contextPercent: 33 })
    expect(await call('sessions.list', {})).toEqual([expect.objectContaining({ tabId: tab.id, costUsd: 0.75, contextPercent: 33 })])
    registry.tabExited(tab.id, 0)
    const [info] = (await call('sessions.list', {})) as Record<string, unknown>[]
    expect(info).not.toHaveProperty('costUsd')
    expect(info).not.toHaveProperty('contextPercent')
  })
})

describe('tab flags (read-only for plugins)', () => {
  it('sessionInfoOf copies the flag field by field: colour and note, nothing shared with the entry', () => {
    const entry = { ...newEntry({ tabId: 't1', projectId: A, kind: 'claude', cwd: '/p' }), flag: { color: 'red' as const, note: 'n' } }
    const info = sessionInfoOf(entry)
    expect(info.flag).toEqual({ color: 'red', note: 'n' })
    expect(info.flag).not.toBe(entry.flag)
    expect(sessionInfoOf({ ...entry, flag: { color: 'blue' } }).flag).toEqual({ color: 'blue' })
    expect('flag' in sessionInfoOf(newEntry({ tabId: 't2', projectId: A, kind: 'claude', cwd: '/p' }))).toBe(false)
  })

  it('carries the person\'s flag in sessions.list, its change reaches the sessions event, and a clear removes it', async () => {
    vi.useFakeTimers()
    const events: { event: string; params: unknown }[] = []
    const call = hostA(events)
    const tab = tabs.create(A, { kind: 'claude' })
    const flagOf = async () => ((await call('sessions.list', {})) as { flag?: unknown }[]).map((s) => s.flag)
    expect(await flagOf()).toEqual([undefined])
    events.length = 0
    tabs.setFlag(A, tab.id, { color: 'red', note: 'come back' })
    await vi.advanceTimersByTimeAsync(SESSIONS_EVENT_INTERVAL_MS)
    expect(events).toHaveLength(1)
    expect((events[0]!.params as { sessions: { flag?: unknown }[] }).sessions.map((s) => s.flag)).toEqual([{ color: 'red', note: 'come back' }])
    tabs.setFlag(A, tab.id, null)
    expect(await flagOf()).toEqual([undefined])
  })

  it('has no way for a plugin to set or clear a flag: no host method, and a sent flag field changes nothing', async () => {
    const api = new HostApi(deps, scopeA(), () => {})
    apis.push(api)
    expect(Object.keys(api.handlers).filter((m) => /flag/i.test(m))).toEqual([])
    const call = hostA()
    const tab = tabs.create(A, { kind: 'claude' })
    // The nearest a plugin gets: rename with a flag riding along, and mutating its own copy.
    await call('sessions.rename', { pluginId: 'a.one', tabId: tab.id, name: 'x', flag: { color: 'red' } }).catch(() => undefined)
    const [listed] = (await call('sessions.list', {})) as { flag?: { color: string } }[]
    expect(listed!.flag).toBeUndefined()
    expect(tabs.list(A)[0]!.flag).toBeUndefined()
    tabs.setFlag(A, tab.id, { color: 'blue' })
    const [mine] = (await call('sessions.list', {})) as { flag: { color: string } }[]
    mine!.flag.color = 'red'
    expect(tabs.list(A)[0]!.flag).toEqual({ color: 'blue' })
    expect(registry.get(tab.id)!.flag).toEqual({ color: 'blue' })
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

describe('openExternal (ctx.openExternal)', () => {
  /** The openExternal adapter as main wires it, faked: the URLs it was handed. */
  function withBrowser(fail?: Error, targets: unknown[] = []): string[] {
    const opened: string[] = []
    deps.openExternal = async (url, target) => {
      opened.push(url)
      targets.push(target)
      if (fail) throw fail
    }
    return opened
  }

  it('hands the normalized http(s) href to the openExternal adapter, for this host\'s window', async () => {
    const targets: unknown[] = []
    const opened = withBrowser(undefined, targets)
    const call = hostA()
    await expect(call('openExternal', { pluginId: 'a.one', url: 'HTTPS://Example.com/a b?x=1#h' })).resolves.toBeNull()
    await call('openExternal', { pluginId: 'a.two', url: 'http://localhost:3000', windowId: WIN_B })
    expect(opened).toEqual(['https://example.com/a%20b?x=1#h', 'http://localhost:3000/'])
    // The host's own window, never one the plugin named; no view asked.
    expect(targets).toEqual([
      { windowId: WIN_A, viewId: undefined },
      { windowId: WIN_A, viewId: undefined }
    ])
  })

  it('refuses other schemes, userinfo, long or malformed URLs and unknown plugins, before the browser', async () => {
    const opened = withBrowser()
    const call = hostA()
    const refused: Array<[unknown, RegExp]> = [
      ['file:///etc/passwd', /only http and https/],
      ['javascript:alert(1)', /only http and https/],
      ['vscode://file/etc/passwd', /only http and https/],
      ['data:text/html,hi', /only http and https/],
      ['ftp://example.com/x', /only http and https/],
      ['https://user:pass@example.com/', /user name or password/],
      ['https://bank.example@evil.example/', /user name or password/],
      ['https://:pw@example.com/', /user name or password/],
      [`https://example.com/${'a'.repeat(2048)}`, /over 2048 characters/],
      // Within the limit as asked, over it once percent-encoded: what is opened counts.
      [`https://example.com/${' '.repeat(1000)}x`, /over 2048 characters/],
      ['not a url', /not a valid URL/],
      ['', /non-empty string/],
      [5, /non-empty string/],
      [undefined, /non-empty string/]
    ]
    for (const [url, why] of refused) {
      await expect(call('openExternal', { pluginId: 'a.one', url }), String(url)).rejects.toThrow(why)
    }
    await expect(call('openExternal', { pluginId: 'b.one', url: 'https://example.com' })).rejects.toThrow('unknown plugin')
    expect(opened).toEqual([])
    // Refusals spent no budget: the plugin still has all of it.
    for (let i = 0; i < MAX_EXTERNAL_OPENS_PER_WINDOW; i++) await call('openExternal', { pluginId: 'a.one', url: 'https://example.com' })
    expect(opened).toHaveLength(MAX_EXTERNAL_OPENS_PER_WINDOW)
  })

  it(`allows ${MAX_EXTERNAL_OPENS_PER_WINDOW} per plugin per ${EXTERNAL_OPEN_WINDOW_MS / 1000} s, each plugin its own budget`, async () => {
    vi.useFakeTimers()
    const opened = withBrowser()
    const call = hostA()
    for (let i = 0; i < MAX_EXTERNAL_OPENS_PER_WINDOW; i++) await call('openExternal', { pluginId: 'a.one', url: `https://example.com/${i}` })
    await expect(call('openExternal', { pluginId: 'a.one', url: 'https://example.com/x' })).rejects.toThrow(
      `more than ${MAX_EXTERNAL_OPENS_PER_WINDOW} links in ${EXTERNAL_OPEN_WINDOW_MS / 1000} s`
    )
    await expect(call('openExternal', { pluginId: 'a.two', url: 'https://example.com/y' })).resolves.toBeNull()
    vi.advanceTimersByTime(EXTERNAL_OPEN_WINDOW_MS)
    await expect(call('openExternal', { pluginId: 'a.one', url: 'https://example.com/z' })).resolves.toBeNull()
    expect(opened).toHaveLength(MAX_EXTERNAL_OPENS_PER_WINDOW + 2)
  })

  it('prefixes the browser\'s failure, and is refused without a lambda or once the host is stopping', async () => {
    withBrowser(new Error('no handler'))
    const call = hostA()
    await expect(call('openExternal', { pluginId: 'a.one', url: 'https://example.com' })).rejects.toThrow('openExternal: no handler')
    apis[0]!.revoke()
    await expect(call('openExternal', { pluginId: 'a.one', url: 'https://example.com' })).rejects.toThrow('stopping')
    delete deps.openExternal
    await expect(hostA()('openExternal', { pluginId: 'a.one', url: 'https://example.com' })).rejects.toThrow('not available')
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

describe('overlay toolbar (design-next §3.3, §3.6)', () => {
  const H = '1f6c2c4e-1111-4222-8333-944455556666'
  interface HostCall {
    method: string
    params: Record<string, unknown>
    timeoutMs?: number
  }

  /** A host of project A whose requests to the host process are `answer`ed and recorded. */
  function toolbarHost(answer: (c: HostCall) => unknown = () => null): {
    api: HostApi
    call: (method: string, params?: unknown) => Promise<unknown>
    hostCalls: HostCall[]
    events: { event: string; params: unknown }[]
  } {
    const hostCalls: HostCall[] = []
    const events: { event: string; params: unknown }[] = []
    deps.setOverlayButtons = (windowId, overlayId, buttons) => overlays.setButtons(windowId, overlayId, buttons)
    const api = new HostApi(
      deps,
      scopeA(),
      (event, params) => events.push({ event, params }),
      async (method, params, options) => {
        const c: HostCall = { method, params: params as Record<string, unknown>, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }
        hostCalls.push(c)
        return answer(c)
      }
    )
    apis.push(api)
    const handlers = api.handlers
    return { api, call: (method, params) => Promise.resolve().then(() => handlers[method]!(params)), hostCalls, events }
  }

  const query = { type: { name: 'file', data: { path: 'a.ts' } }, title: 'a.ts', opener: 'a.one' }

  it("setButtons reaches only the opening plugin's overlay of that handle, checked again; one sent early waits", async () => {
    const { call } = toolbarHost()
    const result = call('overlay.open', {
      pluginId: 'a.one',
      spec: { kind: 'url', url: 'https://example.com/', buttons: [{ id: 'star', label: 'Star' }] },
      handle: H
    })
    // Before the overlay exists: held by the handle, the last one applied.
    await expect(call('overlay.setButtons', { pluginId: 'a.one', handle: H, buttons: [{ id: 'early', label: 'Early' }] })).resolves.toBe(true)
    await vi.waitFor(() => expect(overlays.infos(WIN_A)).toHaveLength(1))
    expect(overlays.infos(WIN_A)[0]!.buttons).toEqual([{ id: 'early', label: 'Early' }])
    await expect(call('overlay.setButtons', { pluginId: 'a.one', handle: H, buttons: [{ id: 'read', label: 'Mark read' }] })).resolves.toBe(true)
    expect(overlays.infos(WIN_A)[0]!.buttons).toEqual([{ id: 'read', label: 'Mark read' }])
    // Another plugin of the host, a plugin it does not run, a bad list.
    await expect(call('overlay.setButtons', { pluginId: 'a.two', handle: H, buttons: [] })).resolves.toBe(false)
    await expect(call('overlay.setButtons', { pluginId: 'b.one', handle: H, buttons: [] })).rejects.toThrow('unknown plugin')
    await expect(call('overlay.setButtons', { pluginId: 'a.one', handle: H, buttons: [{ id: 'x', label: '' }] })).rejects.toThrow(/label/)
    expect(overlays.infos(WIN_A)[0]!.buttons).toEqual([{ id: 'read', label: 'Mark read' }])
    overlays.close(WIN_A, overlays.infos(WIN_A)[0]!.id)
    await result
    await expect(call('overlay.setButtons', { pluginId: 'a.one', handle: H, buttons: [] })).resolves.toBe(false)
  })

  it("an opener click goes to this host for that plugin and handle, with the 30 s bound", async () => {
    const { call, hostCalls } = toolbarHost()
    void call('overlay.open', {
      pluginId: 'a.one',
      spec: { kind: 'html', file: 'page.html', buttons: [{ id: 'star', label: 'Star' }] },
      handle: H
    })
    await vi.waitFor(() => expect(overlays.infos(WIN_A)).toHaveLength(1))
    expect(overlays.buttonClick(WIN_A, overlays.infos(WIN_A)[0]!.id, { source: 'opener', buttonId: 'star' })).toBe(true)
    expect(hostCalls).toEqual([
      { method: 'overlay.buttonClick', params: { source: 'opener', pluginId: 'a.one', handle: H, buttonId: 'star' }, timeoutMs: 30_000 }
    ])
  })

  it("the providers' opener is the plugin main checked the open for, never a name in the opener's payload", async () => {
    // A source gates its inbox-item buttons on `opener` (a plugin opening an overlay that names a
    // Gmail thread must not get Gmail's Mark read): main fills it from the plugin it accepted the
    // request for, so a spec, its type data or the request naming another plugin changes nothing.
    const { api, call, hostCalls } = toolbarHost((c) => (c.method === 'overlay.buttons' ? [] : null))
    const view: UrlView = { setBounds: () => {}, setVisible: () => {}, focus: () => {}, destroy: () => {} }
    const typed = new OverlayManager({
      backend: overlayBackend,
      views: { create: () => view, focusWindow: () => {} },
      isWindowOpen: (id) => id === WIN_A,
      env: () => ({ PATH: '/usr/bin' }),
      emit: () => {},
      commandForChord: () => undefined,
      typeButtons: (windowId) => (windowId === WIN_A ? api.overlayButtons : undefined),
      log: () => {}
    })
    deps.openOverlay = async (windowId, spec, opener, peerGone, channel, pluginId) =>
      typed.open(windowId, spec, opener, peerGone, channel, pluginId)
    const forged = { opener: 'a.one', openedBy: 'a.one', pluginId: 'a.one' }
    const type = { name: 'inbox-item', data: { source: 'a.one', id: 't1', ...forged } }
    void call('overlay.open', {
      pluginId: 'a.two',
      ...{ opener: 'a.one', openedBy: 'a.one' },
      spec: { kind: 'url', url: 'https://example.com/', title: 'Thread', type, ...forged }
    })
    await vi.waitFor(() => expect(hostCalls.filter((c) => c.method === 'overlay.buttons')).toHaveLength(1))
    expect(hostCalls[0]!.params.info).toEqual({ type, title: 'Thread', opener: 'a.two' })
    typed.disposeAll()
  })

  it('type buttons: only plugins of this host, each plugin checked with the opener rule; a click names it', async () => {
    const { api, hostCalls, events } = toolbarHost((c) => {
      if (c.method === 'overlay.buttons') {
        return [
          { pluginId: 'a.two', id: 'edit', label: 'Edit' },
          { pluginId: 'b.one', id: 'steal', label: 'Steal' },
          { id: 'anon', label: 'No plugin' },
          // a.one's group is broken (an id twice): all of it is refused, a.two's still shows.
          { pluginId: 'a.one', id: 'x', label: 'X' },
          { pluginId: 'a.one', id: 'x', label: 'Y' }
        ]
      }
      return { close: true, extra: 1 }
    })
    const buttons = api.overlayButtons
    await expect(buttons.list('key-1', query)).resolves.toEqual([{ pluginId: 'a.two', id: 'edit', label: 'Edit' }])
    expect(hostCalls[0]).toEqual({ method: 'overlay.buttons', params: { key: 'key-1', info: query }, timeoutMs: 2_000 })
    await expect(buttons.click('key-1', 'a.two', 'edit', query)).resolves.toEqual({ close: true })
    expect(hostCalls[1]).toEqual({
      method: 'overlay.buttonClick',
      params: { source: 'type', key: 'key-1', pluginId: 'a.two', buttonId: 'edit', info: query },
      timeoutMs: 30_000
    })
    await expect(buttons.click('key-1', 'b.one', 'steal', query)).rejects.toThrow('unknown plugin')
    expect(hostCalls).toHaveLength(2)
    buttons.ended('key-1')
    expect(events).toContainEqual({ event: 'overlay.ended', params: { key: 'key-1' } })
    // A stopping host is asked nothing more.
    api.revoke()
    await expect(buttons.list('key-2', query)).rejects.toThrow(/not available/)
    buttons.ended('key-2')
    expect(events.filter((e) => e.event === 'overlay.ended')).toHaveLength(1)
  })

  it('a host answer that is not a list is refused; a plugin ctx ending asks the toolbars again', async () => {
    const refreshed: number[] = []
    deps.refreshOverlayButtons = (windowId) => refreshed.push(windowId)
    const { api } = toolbarHost(() => ({ not: 'a list' }))
    await expect(api.overlayButtons.list('k', query)).rejects.toThrow(/did not answer a list/)
    api.contextDisposed({ pluginId: 'a.one' })
    expect(refreshed).toEqual([WIN_A])
  })

  it('without a host call (an older wiring) clicks and asks are refused, not hung', async () => {
    const api = new HostApi(deps, scopeA(), () => {})
    apis.push(api)
    await expect(api.overlayButtons.list('k', query)).rejects.toThrow(/not available/)
  })

  it("setDiscussPrimary reaches only the opener's overlay, held until it exists; on must be a boolean", async () => {
    deps.setOverlayDiscussPrimary = (windowId, overlayId, on) => overlays.setDiscussPrimary(windowId, overlayId, on)
    const { call } = toolbarHost(() => null)
    void call('overlay.open', { pluginId: 'a.one', spec: { kind: 'url', url: 'https://example.com/', type: { name: 'file', data: {} } }, handle: H }).catch(() => {})
    await expect(call('overlay.discussPrimary', { pluginId: 'a.one', handle: H, on: true })).resolves.toBe(true)
    await vi.waitFor(() => expect(overlays.infos(WIN_A)).toHaveLength(1))
    expect(overlays.infos(WIN_A)[0]!.discuss).toEqual({ primary: true })
    await expect(call('overlay.discussPrimary', { pluginId: 'a.two', handle: H, on: false })).resolves.toBe(false)
    await expect(call('overlay.discussPrimary', { pluginId: 'a.one', handle: H, on: 1 })).rejects.toThrow(/boolean/)
    await expect(call('overlay.discussPrimary', { pluginId: 'a.one', handle: H, on: false })).resolves.toBe(true)
    expect(overlays.infos(WIN_A)[0]!.discuss).toEqual({})
  })

  it("onDiscuss: discussable reaches only the opener's overlay (held until it exists); the ask goes to that handle, 5 s", async () => {
    deps.setOverlayDiscuss = (windowId, overlayId, on) => overlays.setDiscussHandler(windowId, overlayId, on)
    const { call, hostCalls } = toolbarHost((c) => (c.method === 'overlay.discuss' ? { text: 'ctx' } : null))
    const result = call('overlay.open', { pluginId: 'a.one', spec: { kind: 'url', url: 'https://example.com/' }, handle: H })
    // Sent before the overlay exists: held by the handle.
    await expect(call('overlay.discussable', { pluginId: 'a.one', handle: H, on: true })).resolves.toBe(true)
    await vi.waitFor(() => expect(overlays.infos(WIN_A)).toHaveLength(1))
    expect(overlays.infos(WIN_A)[0]!.discuss).toEqual({})
    // Another plugin of the host, a plugin it does not run, a bad flag.
    await expect(call('overlay.discussable', { pluginId: 'a.two', handle: H, on: false })).resolves.toBe(false)
    await expect(call('overlay.discussable', { pluginId: 'b.one', handle: H, on: false })).rejects.toThrow('unknown plugin')
    await expect(call('overlay.discussable', { pluginId: 'a.one', handle: H, on: 'yes' })).rejects.toThrow(/boolean/)
    expect(overlays.infos(WIN_A)[0]!.discuss).toEqual({})
    // This manager has no sessions wired: Send is refused before the opener is asked.
    const answer = await overlays.discuss(WIN_A, overlays.infos(WIN_A)[0]!.id, { kind: 'new' })
    expect(answer.ok).toBe(false)
    await expect(call('overlay.discussable', { pluginId: 'a.one', handle: H, on: false })).resolves.toBe(true)
    expect(overlays.infos(WIN_A)[0]).not.toHaveProperty('discuss')
    overlays.close(WIN_A, overlays.infos(WIN_A)[0]!.id)
    await result
    expect(hostCalls.filter((c) => c.method === 'overlay.discuss')).toEqual([])
  })

  it('the opener channel asks its own host for the Discuss context with the 5 s bound', async () => {
    deps.setOverlayDiscuss = (windowId, overlayId, on) => overlays.setDiscussHandler(windowId, overlayId, on)
    let channel: OverlayChannel | undefined
    deps.openOverlay = (windowId, spec, opener, peerGone, ch, pluginId) => {
      channel = ch
      return overlays.open(windowId, spec, opener, peerGone, ch, pluginId)
    }
    const { call, hostCalls } = toolbarHost((c) => (c.method === 'overlay.discuss' ? { text: 'ctx' } : null))
    void call('overlay.open', { pluginId: 'a.one', spec: { kind: 'url', url: 'https://example.com/' }, handle: H })
    await vi.waitFor(() => expect(channel).toBeDefined())
    await expect(channel!.onDiscuss!()).resolves.toEqual({ text: 'ctx' })
    expect(hostCalls).toEqual([{ method: 'overlay.discuss', params: { pluginId: 'a.one', handle: H }, timeoutMs: 5_000 }])
  })
})

// design-next §4.1: scope 'all' with the manifest's declaration, focus any window's tab, close and
// openFile only this window's, each with its own budget per plugin.
describe('sessions scope all, focus, close, openFile', () => {
  const declared = (): HostScope => ({
    ...scopeA(),
    plugins: [
      { id: 'a.one', dir: pluginOne, panels: ['board'], sessionsAll: true },
      { id: 'a.two', dir: pluginTwo, panels: ['inbox'] }
    ]
  })

  it('refuses scope all without the declaration, and answers summaries with it', async () => {
    deps.summaries = (projectId) => registry.summariesFor(projectId)
    const mine = tabs.create(A, { kind: 'claude' })
    const theirs = tabs.create(B, { kind: 'claude' })
    registry.applyHook(theirs.id, 'UserPromptSubmit', { prompt: 'their private prompt' })
    registry.setGist(theirs.id, 'their gist')
    // The flag's colour travels to other windows, its note (the person's words) never.
    tabs.setFlag(B, theirs.id, { color: 'green', note: 'their private note' })
    const plain = hostA()
    await expect(plain('sessions.list', { pluginId: 'a.one', scope: 'all' })).rejects.toThrow(
      `needs "access": { "sessions": "all-windows" } in a.one's plugin.json`
    )
    const host = hostFor(declared())
    await expect(host('sessions.list', { pluginId: 'a.two', scope: 'all' })).rejects.toThrow('needs "access"')
    await expect(host('sessions.list', { pluginId: 'a.one', scope: 'everything' })).rejects.toThrow('scope must be')
    await expect(host('sessions.list', { pluginId: 'nobody', scope: 'all' })).rejects.toThrow('unknown plugin')
    const all = (await host('sessions.list', { pluginId: 'a.one', scope: 'all' })) as Record<string, unknown>[]
    expect(all).toEqual([
      { tabId: mine.id, own: true, project: { name: 'p' }, status: 'starting' },
      { tabId: theirs.id, own: false, project: { name: 'p' }, status: 'working', flag: { color: 'green' } }
    ])
    expect(JSON.stringify(all)).not.toMatch(/private|gist|cwd|files|notes|note/)
    // Scope window (or none) is the call as it always was, for any plugin.
    await expect(host('sessions.list', { pluginId: 'a.two', scope: 'window' })).resolves.toHaveLength(1)
    await expect(host('sessions.list', {})).resolves.toHaveLength(1)
  })

  it('a reload that drops the declaration stops sessions.all and refuses scope all; one that adds it grants it', async () => {
    vi.useFakeTimers()
    deps.summaries = (projectId) => registry.summariesFor(projectId)
    const events: { event: string; params: unknown }[] = []
    const host = hostFor(declared(), events)
    const mine = { id: 'a.one', dir: pluginOne, panels: ['board'] }
    await expect(host('sessions.list', { pluginId: 'a.one', scope: 'all' })).resolves.toBeDefined()
    // The new manifest has no `access`: main must forget the old copy's grant.
    apis.at(-1)!.updatePlugin(mine)
    await expect(host('sessions.list', { pluginId: 'a.one', scope: 'all' })).rejects.toThrow('needs "access"')
    tabs.create(B, { kind: 'claude' })
    vi.advanceTimersByTime(SESSIONS_EVENT_INTERVAL_MS)
    expect(events.filter((e) => e.event === 'sessions.all')).toEqual([])
    // Another plugin of the host gets it by a reload that adds the declaration.
    apis.at(-1)!.updatePlugin({ id: 'a.two', dir: pluginTwo, panels: ['inbox'], sessionsAll: true })
    await expect(host('sessions.list', { pluginId: 'a.two', scope: 'all' })).resolves.toBeDefined()
    tabs.create(B, { kind: 'claude' })
    vi.advanceTimersByTime(SESSIONS_EVENT_INTERVAL_MS)
    expect(events.some((e) => e.event === 'sessions.all')).toBe(true)
  })

  it('sends sessions.all on any window’s change only to a host running a declaring plugin', async () => {
    vi.useFakeTimers()
    deps.summaries = (projectId) => registry.summariesFor(projectId)
    const withDecl: { event: string; params: unknown }[] = []
    const without: { event: string; params: unknown }[] = []
    hostFor(declared(), withDecl)
    hostA(without)
    const theirs = tabs.create(B, { kind: 'claude' })
    vi.advanceTimersByTime(SESSIONS_EVENT_INTERVAL_MS)
    expect(withDecl.map((e) => e.event)).toEqual(['sessions.all'])
    expect(withDecl[0]!.params).toEqual({ sessions: [{ tabId: theirs.id, own: false, project: { name: 'p' }, status: 'starting' }] })
    // The other host hears nothing of project B at all.
    expect(without).toEqual([])
  })

  it('focus reaches a tab of any window, false for no Claude tab, at most 10 in 10 s', async () => {
    const focused: string[] = []
    deps.focusTab = (tabId) => {
      focused.push(tabId)
      return true
    }
    const theirs = tabs.create(B, { kind: 'claude' })
    const shell = tabs.create(A, { kind: 'shell' })
    const host = hostA()
    await expect(host('sessions.focus', { pluginId: 'a.one', tabId: theirs.id })).resolves.toBe(true)
    expect(focused).toEqual([theirs.id])
    // A shell tab or an unknown id is no Claude tab: false, nothing moved, nothing spent.
    for (let i = 0; i < 20; i++) {
      await expect(host('sessions.focus', { pluginId: 'a.one', tabId: shell.id })).resolves.toBe(false)
      await expect(host('sessions.focus', { pluginId: 'a.one', tabId: 'nope' })).resolves.toBe(false)
    }
    expect(focused).toEqual([theirs.id])
    for (let i = 1; i < MAX_FOCUSES_PER_WINDOW; i++) await host('sessions.focus', { pluginId: 'a.one', tabId: theirs.id })
    await expect(host('sessions.focus', { pluginId: 'a.one', tabId: theirs.id })).rejects.toThrow(
      `more than ${MAX_FOCUSES_PER_WINDOW} focuses in ${FOCUS_WINDOW_MS / 1000} s`
    )
    // Per plugin.
    await expect(host('sessions.focus', { pluginId: 'a.two', tabId: theirs.id })).resolves.toBe(true)
    await expect(host('sessions.focus', { pluginId: 'a.one', tabId: 5 })).rejects.toThrow('tabId must be a string')
  })

  it("close goes to the host's own window for its own tabs only, relays closed, at most 10 a minute", async () => {
    const asked: unknown[][] = []
    let answer = true
    deps.closeTab = async (windowId, projectId, tabId) => {
      asked.push([windowId, projectId, tabId])
      return answer
    }
    const mine = tabs.create(A, { kind: 'claude' })
    const theirs = tabs.create(B, { kind: 'claude' })
    const host = hostA()
    await expect(host('sessions.close', { pluginId: 'a.one', tabId: theirs.id })).rejects.toThrow('sessions.close: unknown tab')
    await expect(host('sessions.close', { pluginId: 'a.one', tabId: 'nope' })).rejects.toThrow('unknown tab')
    expect(asked).toEqual([])
    await expect(host('sessions.close', { pluginId: 'a.one', tabId: mine.id })).resolves.toEqual({ closed: true })
    answer = false
    await expect(host('sessions.close', { pluginId: 'a.one', tabId: mine.id })).resolves.toEqual({ closed: false })
    expect(asked).toEqual([
      [WIN_A, A, mine.id],
      [WIN_A, A, mine.id]
    ])
    for (let i = 2; i < MAX_CLOSES_PER_WINDOW; i++) await host('sessions.close', { pluginId: 'a.one', tabId: mine.id })
    await expect(host('sessions.close', { pluginId: 'a.one', tabId: mine.id })).rejects.toThrow(
      `more than ${MAX_CLOSES_PER_WINDOW} closes in ${CLOSE_WINDOW_MS / 1000} s`
    )
  })

  it('rename: own tabs only, the name checked, shown in list, null clears, at most 30 a minute', async () => {
    deps.renameTab = (projectId, tabId, name) => tabs.rename(projectId, tabId, name)
    const mine = tabs.create(A, { kind: 'claude' })
    const theirs = tabs.create(B, { kind: 'claude' })
    const host = hostA()
    const nameOf = async (): Promise<string | undefined> =>
      ((await host('sessions.list', {})) as Array<{ tabId: string; name?: string }>).find((s) => s.tabId === mine.id)?.name
    await expect(host('sessions.rename', { pluginId: 'a.one', tabId: theirs.id, name: 'x' })).rejects.toThrow('sessions.rename: unknown tab')
    await expect(host('sessions.rename', { pluginId: 'a.one', tabId: 'nope', name: 'x' })).rejects.toThrow('unknown tab')
    for (const bad of ['', '   ', 'a'.repeat(61), 'tab\u001b[31m', 'a\nb', 5]) {
      await expect(host('sessions.rename', { pluginId: 'a.one', tabId: mine.id, name: bad })).rejects.toThrow('sessions.rename:')
    }
    expect(await nameOf()).toBeUndefined()
    await host('sessions.rename', { pluginId: 'a.one', tabId: mine.id, name: '  Release prep  ' })
    expect(await nameOf()).toBe('Release prep')
    await host('sessions.rename', { pluginId: 'a.one', tabId: mine.id, name: 'a'.repeat(60) })
    await host('sessions.rename', { pluginId: 'a.one', tabId: mine.id, name: null })
    expect(await nameOf()).toBeUndefined()
    // The refusals above spent nothing: 3 renames so far.
    for (let i = 3; i < MAX_RENAMES_PER_WINDOW; i++) await host('sessions.rename', { pluginId: 'a.one', tabId: mine.id, name: `n${i}` })
    await expect(host('sessions.rename', { pluginId: 'a.one', tabId: mine.id, name: 'more' })).rejects.toThrow(
      `more than ${MAX_RENAMES_PER_WINDOW} renames in ${RENAME_WINDOW_MS / 1000} s`
    )
    // Per plugin.
    await expect(host('sessions.rename', { pluginId: 'a.two', tabId: mine.id, name: 'ok' })).resolves.toBeNull()
  })

  it('openFile: own tabs only, an unrecorded file refused without spending, at most 20 in 10 s', async () => {
    const opened: unknown[][] = []
    deps.openSessionFile = async (caller, tabId, file) => {
      opened.push([caller, tabId, file])
      return registry.get(tabId)?.files.includes(file) === true
    }
    const mine = tabs.create(A, { kind: 'claude' })
    registry.applyHook(mine.id, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: join(projA, 'a.ts') } })
    const theirs = tabs.create(B, { kind: 'claude' })
    registry.applyHook(theirs.id, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: join(projB, 'b.ts') } })
    const host = hostA()
    await expect(host('sessions.openFile', { pluginId: 'a.one', tabId: theirs.id, path: join(projB, 'b.ts') })).rejects.toThrow(
      'sessions.openFile: unknown tab'
    )
    expect(opened).toEqual([])
    for (let i = 0; i < MAX_SESSION_FILES_PER_WINDOW + 5; i++) {
      await expect(host('sessions.openFile', { pluginId: 'a.one', tabId: mine.id, path: '/etc/passwd' })).rejects.toThrow(
        'not a file of that tab'
      )
    }
    await expect(host('sessions.openFile', { pluginId: 'a.one', tabId: mine.id, path: '' })).rejects.toThrow('non-empty string')
    for (let i = 0; i < MAX_SESSION_FILES_PER_WINDOW; i++) {
      await expect(host('sessions.openFile', { pluginId: 'a.one', tabId: mine.id, path: join(projA, 'a.ts') })).resolves.toBeNull()
    }
    expect(opened.at(-1)).toEqual([{ windowId: WIN_A, projectId: A }, mine.id, join(projA, 'a.ts')])
    await expect(host('sessions.openFile', { pluginId: 'a.one', tabId: mine.id, path: join(projA, 'a.ts') })).rejects.toThrow(
      `more than ${MAX_SESSION_FILES_PER_WINDOW} files in ${SESSION_FILE_WINDOW_MS / 1000} s`
    )
  })

  it('refuses all four once the host is revoked', async () => {
    deps.summaries = (projectId) => registry.summariesFor(projectId)
    deps.focusTab = () => true
    deps.closeTab = async () => true
    deps.openSessionFile = async () => true
    const mine = tabs.create(A, { kind: 'claude' })
    const api = new HostApi(deps, declared(), () => {})
    apis.push(api)
    api.revoke()
    const h = api.handlers
    const call = (m: string, p: unknown): Promise<unknown> => Promise.resolve().then(() => h[m]!(p))
    await expect(call('sessions.list', { pluginId: 'a.one', scope: 'all' })).rejects.toThrow('stopping')
    await expect(call('sessions.focus', { pluginId: 'a.one', tabId: mine.id })).rejects.toThrow('stopping')
    await expect(call('sessions.close', { pluginId: 'a.one', tabId: mine.id })).rejects.toThrow('stopping')
    await expect(call('sessions.openFile', { pluginId: 'a.one', tabId: mine.id, path: 'x' })).rejects.toThrow('stopping')
  })
})

describe('the origin view (design-web.md §5.3 "Where an action came from")', () => {
  /** HostApi's handlers called as the RPC endpoint does, with the request's meta. */
  function hostWithMeta(): (method: string, params: unknown, meta: RpcMeta) => Promise<unknown> {
    const api = new HostApi(deps, scopeA(), () => {})
    apis.push(api)
    const handlers = api.handlers
    return (method, params, meta) => Promise.resolve().then(() => handlers[method]!(params, meta))
  }

  /** web:1 is a view of host A's window, web:2 of another window; anything else main does not know. */
  const viewWindows: Record<string, number> = { 'web:1': WIN_A, 'web:2': WIN_A + 100 }

  it("focus and panels.show act in a view of the host's own window, and ignore any other view", async () => {
    const focused: unknown[][] = []
    const shown: unknown[][] = []
    deps.focusTab = (...args) => {
      focused.push(args)
      return true
    }
    deps.showPanel = (...args) => {
      shown.push(args)
      return true
    }
    deps.viewWindow = (viewId) => viewWindows[viewId]
    const tab = tabs.create(A, { kind: 'claude' })
    const host = hostWithMeta()
    await host('sessions.focus', { pluginId: 'a.one', tabId: tab.id }, { view: 'web:1' })
    await host('panels.show', { pluginId: 'a.one', panelId: 'board' }, { view: 'web:1' })
    // Another window's view, one main never had (or that closed), and no view: as without a view.
    for (const meta of [{ view: 'web:2' }, { view: 'web:99' }, {}]) {
      await host('sessions.focus', { pluginId: 'a.one', tabId: tab.id }, meta)
      await host('panels.show', { pluginId: 'a.one', panelId: 'board' }, meta)
    }
    expect(focused).toEqual([[tab.id, 'web:1'], [tab.id], [tab.id], [tab.id]])
    expect(shown).toEqual([[A, 'a.one/board', 'web:1'], [A, 'a.one/board'], [A, 'a.one/board'], [A, 'a.one/board']])
  })

  it("files.open and sessions.openFile hand the route a view of the host's own window, and no other", async () => {
    const files: unknown[] = []
    const sessionFiles: unknown[] = []
    deps.openFile = async (_caller, _path, _tabId, view) => {
      files.push(view)
      return 'plugin'
    }
    deps.openSessionFile = async (_caller, _tabId, _file, view) => {
      sessionFiles.push(view)
      return true
    }
    deps.viewWindow = (viewId) => viewWindows[viewId]
    const tab = tabs.create(A, { kind: 'claude' })
    const host = hostWithMeta()
    for (const meta of [{ view: 'web:1' }, { view: 'web:2' }, { view: 'web:99' }, {}]) {
      await host('files.open', { pluginId: 'a.one', path: 'src/a.ts' }, meta)
      await host('sessions.openFile', { pluginId: 'a.one', tabId: tab.id, path: '/p/a.ts' }, meta)
    }
    // A view named in the payload is not the call's.
    await host('files.open', { pluginId: 'a.one', path: 'src/a.ts', view: 'web:1' }, {})
    expect(files).toEqual(['web:1', undefined, undefined, undefined, undefined])
    expect(sessionFiles).toEqual(['web:1', undefined, undefined, undefined])
  })

  it("overlay.open opens in a view of the host's own window, and ignores any other view", async () => {
    const views: unknown[] = []
    deps.openOverlay = (_windowId, _spec, _opener, _peerGone, _channel, _pluginId, view) => {
      views.push(view)
      return Promise.resolve({ kind: 'dismissed' })
    }
    deps.viewWindow = (viewId) => viewWindows[viewId]
    const host = hostWithMeta()
    const spec = { kind: 'terminal', argv: ['true'] }
    for (const meta of [{ view: 'web:1' }, { view: 'web:2' }, { view: 'web:99' }, {}]) {
      await host('overlay.open', { pluginId: 'a.one', spec }, meta)
    }
    expect(views).toEqual(['web:1', undefined, undefined, undefined])
  })

  // Desktop-only features (design-web.md §6.1, plan Task 25): the caller type is main's (originOf), never a payload field.
  it('openExternal names the remote view the plugin acted for (a notice there, external/open-external.ts); another window\'s, an unknown or no view names none', async () => {
    const calls: unknown[][] = []
    deps.openExternal = async (url, target) => {
      calls.push([url, target])
    }
    deps.viewWindow = (viewId) => viewWindows[viewId]
    const host = hostWithMeta()
    const params = { pluginId: 'a.one', url: 'https://example.com/a' }
    await host('openExternal', params, { view: 'web:1' })
    expect(calls).toEqual([['https://example.com/a', { windowId: WIN_A, viewId: 'web:1' }]])
    // A view of another window, one main never had, no view, and a forged field in the payload.
    for (const meta of [{ view: 'web:2' }, { view: 'web:99' }, {}]) await host('openExternal', { ...params, pluginId: 'a.two' }, meta)
    await host('openExternal', { ...params, view: 'web:1', remote: true }, {})
    expect(calls.slice(1)).toEqual(Array.from({ length: 4 }, () => ['https://example.com/a', { windowId: WIN_A, viewId: undefined }]))
    // The URL is still checked before the adapter is asked.
    await expect(host('openExternal', { pluginId: 'a.one', url: 'file:///etc/passwd' }, { view: 'web:1' })).rejects.toThrow()
    expect(calls).toHaveLength(5)
  })

  it('files.reveal and files.openWithSystem are refused for a remote view and run for the desktop', async () => {
    const calls: string[] = []
    deps.systemFiles = {
      reveal: async (_c, path) => void calls.push(`reveal ${String(path)}`),
      openWithSystem: async (_c, path) => void calls.push(`open ${String(path)}`),
      trash: async () => true
    }
    deps.viewWindow = (viewId) => viewWindows[viewId]
    const host = hostWithMeta()
    const params = { pluginId: 'a.one', path: 'src/a.ts' }
    await expect(host('files.reveal', params, { view: 'web:1' })).rejects.toThrow(/do it on the desktop/)
    await expect(host('files.openWithSystem', params, { view: 'web:1' })).rejects.toThrow(/do it on the desktop/)
    expect(calls).toEqual([])
    await host('files.reveal', params, {})
    await host('files.openWithSystem', params, { view: 'web:99' })
    await host('files.reveal', { ...params, view: 'web:1' }, {})
    expect(calls).toEqual(['reveal src/a.ts', 'open src/a.ts', 'reveal src/a.ts'])
  })

  // design-web.md §9.9: the origin view is a hint that lapses (10 s) and is absent for a timer or a
  // plugin command, so in server mode main's own flag refuses both calls whatever the origin.
  it('files.reveal and files.openWithSystem are refused in server mode from a view, a timer and a plugin command', async () => {
    const calls: string[] = []
    deps.systemFiles = {
      reveal: async (_c, path) => void calls.push(`reveal ${String(path)}`),
      openWithSystem: async (_c, path) => void calls.push(`open ${String(path)}`),
      trash: async () => true
    }
    deps.viewWindow = (viewId) => viewWindows[viewId]
    deps.server = true
    const api = new HostApi(deps, scopeA(), () => {})
    apis.push(api)
    const params = { pluginId: 'a.one', path: 'src/a.ts' }
    // A browser view's click (a live view of this window), a call whose hint lapsed or that never had
    // one (a timer, a `ccc` plugin command: no meta at all), and a desktop-looking payload field.
    const origins: Array<RpcMeta | undefined> = [{ view: 'web:1' }, {}, undefined]
    for (const method of ['files.reveal', 'files.openWithSystem']) {
      for (const meta of origins) {
        await expect(Promise.resolve().then(() => api.handlers[method]!(params, meta))).rejects.toThrow(/not available in server mode/)
      }
      await expect(Promise.resolve().then(() => api.handlers[method]!({ ...params, view: 'desktop' }, undefined))).rejects.toThrow(
        /not available in server mode/
      )
    }
    expect(calls).toEqual([])
    // Refused before the budget (3 per 10 s): the same host, flag off (the desktop), still has all of it.
    deps.server = false
    for (let i = 0; i < 3; i++) await api.handlers['files.reveal']!(params, {})
    await api.handlers['files.openWithSystem']!(params, undefined)
    expect(calls).toEqual(['reveal src/a.ts', 'reveal src/a.ts', 'reveal src/a.ts', 'open src/a.ts'])
  })

  it('files.trash stays the same for a remote view (the confirm is in the window)', async () => {
    const trashed: string[] = []
    deps.systemFiles = {
      reveal: async () => undefined,
      openWithSystem: async () => undefined,
      trash: async (_c, path) => {
        trashed.push(String(path))
        return true
      }
    }
    deps.viewWindow = (viewId) => viewWindows[viewId]
    await expect(hostWithMeta()('files.trash', { pluginId: 'a.one', path: 'x.txt' }, { view: 'web:1' })).resolves.toEqual({ trashed: true })
    expect(trashed).toEqual(['x.txt'])
  })

  it('oauth.authorize says to sign in on the desktop for a remote view, before any browser opens', async () => {
    let authorizes = 0
    deps.oauth = { ...unusedOAuth, authorize: async () => (authorizes++, { accessToken: 't' } as never) }
    deps.viewWindow = (viewId) => viewWindows[viewId]
    const spec = { authorizeUrl: 'https://idp.example/auth', tokenUrl: 'https://idp.example/token', clientId: 'c', scopes: ['s'] }
    await expect(hostWithMeta()('oauth.authorize', { pluginId: 'a.one', spec }, { view: 'web:1' })).rejects.toThrow(/sign in on the desktop/)
    expect(authorizes).toBe(0)
  })

  // design-web.md §9.9: in server mode every sign-in is a browser's (a link notice with the paste box),
  // so a browser origin goes through to PluginOAuth, with that view as the notice's target.
  it('oauth.authorize from a browser view runs in server mode, for this host’s window and that view', async () => {
    const targets: unknown[] = []
    deps.oauth = { ...unusedOAuth, authorize: async (_spec, _signal, target) => (targets.push(target), { accessToken: 't' } as never) }
    deps.viewWindow = (viewId) => viewWindows[viewId]
    deps.server = true
    const spec = { authUrl: 'https://idp.example/auth', tokenUrl: 'https://idp.example/token', clientId: 'c', scopes: ['s'] }
    await expect(hostWithMeta()('oauth.authorize', { pluginId: 'a.one', spec }, { view: 'web:1' })).resolves.toEqual({ accessToken: 't' })
    // A view of another window is no origin of this host's (the hint is dropped): the window's browsers.
    await expect(hostWithMeta()('oauth.authorize', { pluginId: 'a.one', spec }, { view: 'web:2' })).resolves.toEqual({ accessToken: 't' })
    expect(targets).toEqual([
      { windowId: WIN_A, viewId: 'web:1' },
      { windowId: WIN_A, viewId: undefined }
    ])
  })

  it('ignores every view hint when main cannot check views', async () => {
    const focused: unknown[][] = []
    deps.focusTab = (...args) => {
      focused.push(args)
      return true
    }
    delete deps.viewWindow
    const tab = tabs.create(A, { kind: 'claude' })
    await hostWithMeta()('sessions.focus', { pluginId: 'a.one', tabId: tab.id }, { view: 'web:1' })
    expect(focused).toEqual([[tab.id]])
  })
})
