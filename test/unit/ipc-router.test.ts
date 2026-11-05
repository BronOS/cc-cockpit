import { describe, expect, it } from 'vitest'
import {
  appPageMatcher,
  IpcRouter,
  registerCoreHandlers,
  registerLayoutHandlers,
  registerOverlayHandlers,
  registerPanelHandlers,
  registerSlotHandlers,
  registerSettingsPageHandlers,
  registerCccCommandHandlers,
  registerUpdateHandlers,
  registerProjectSettingsHandlers,
  registerSessionHandlers,
  registerSettingsHandlers,
  registerServiceHandlers,
  registerTabHandlers,
  webUrlOf,
  type ProjectSettingsHandlerDeps,
  type SettingsHandlerDeps,
  type CoreHandlerDeps,
  type IpcEventLike,
  type IpcMainLike,
  type TabHandlerDeps
} from '../../src/main/ipc/router'
import type { SenderContext } from '../../src/main/windows/window-manager'
import { BUILTIN_THEMES } from '../../src/main/themes/theme-service'
import { ServiceChoices } from '../../src/main/plugins/service-choices'
import type { ServicePlugin, ServicesStatus } from '../../src/shared/services'
import { defaultLayout } from '../../src/shared/layout'
import { DEFAULT_TERMINAL_FONT } from '../../src/shared/terminal-font'
import type { ProjectView } from '../../src/shared/types'

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown

/** The built shell page, as the router is told to expect it. */
const APP_FILE = '/opt/cc-cockpit/out/renderer/index.html'
const APP_PAGE = 'file:///opt/cc-cockpit/out/renderer/index.html'

/** Records handlers like ipcMain and lets a test invoke them as a given sender would. */
class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, Listener>()

  handle(channel: string, listener: Listener): void {
    if (this.handlers.has(channel)) throw new Error(`second handler for ${channel}`)
    this.handlers.set(channel, listener)
  }

  invoke(
    channel: string,
    senderId: number,
    args: unknown[] = [],
    senderFrame: IpcEventLike['senderFrame'] = { parent: null, url: APP_PAGE }
  ): Promise<unknown> {
    const listener = this.handlers.get(channel)
    if (!listener) return Promise.reject(new Error(`no handler for ${channel}`))
    // Like ipcMain.handle: a throwing or rejecting handler rejects the renderer's invoke.
    return Promise.resolve().then(() => listener({ sender: { id: senderId }, senderFrame }, ...args))
  }
}

const PROJECT_A = 'aaaaaaaaaaaaaaaa'
const PROJECT_B = 'bbbbbbbbbbbbbbbb'

/** webContents 11 is project A's window, 12 project B's, 13 the picker. */
const senders = new Map<number, SenderContext>([
  [11, { kind: 'project', windowId: 1, projectId: PROJECT_A }],
  [12, { kind: 'project', windowId: 2, projectId: PROJECT_B }],
  [13, { kind: 'picker', windowId: 3 }]
])

function setup(): { ipc: FakeIpcMain; router: IpcRouter; logs: string[] } {
  const ipc = new FakeIpcMain()
  const logs: string[] = []
  const router = new IpcRouter(
    ipc,
    (id) => senders.get(id),
    appPageMatcher({ kind: 'file', path: APP_FILE }),
    (m) => logs.push(m)
  )
  return { ipc, router, logs }
}

function view(id: string, name: string): ProjectView {
  return {
    schemaVersion: 1,
    id,
    path: `/work/${name}`,
    name,
    enabledPlugins: [],
    pluginSettings: {},
    layout: defaultLayout(),
    tabs: [],
    lastOpenedAt: 1,
    missing: false
  }
}

describe('IpcRouter', () => {
  it('refuses a sender it did not open, without calling the handler', async () => {
    const { ipc, router, logs } = setup()
    let calls = 0
    router.handleWindow('projects.recent', () => {
      calls++
      return []
    })
    router.handleProject('window.info', () => {
      calls++
      return { kind: 'picker', home: '/h' }
    })
    await expect(ipc.invoke('projects.recent', 99)).rejects.toThrow(/refused/)
    await expect(ipc.invoke('window.info', 99)).rejects.toThrow(/refused/)
    expect(calls).toBe(0)
    expect(logs.join('\n')).toMatch(/unknown sender webContents 99/)
  })

  it('refuses a message from a subframe or a destroyed frame', async () => {
    const { ipc, router } = setup()
    let calls = 0
    router.handleWindow('projects.recent', () => {
      calls++
      return []
    })
    await expect(
      ipc.invoke('projects.recent', 11, [], { parent: {}, url: APP_PAGE })
    ).rejects.toThrow(/refused/)
    await expect(ipc.invoke('projects.recent', 11, [], null)).rejects.toThrow(/refused/)
    expect(calls).toBe(0)
  })

  it('refuses a top frame of a known window that is not on the app page', async () => {
    const { ipc, router, logs } = setup()
    let calls = 0
    router.handleWindow('projects.recent', () => {
      calls++
      return []
    })
    for (const url of [
      'https://evil.example/',
      'file:///tmp/other.html',
      'file:///opt/cc-cockpit/out/renderer/index.html.evil',
      'about:blank',
      ''
    ]) {
      await expect(ipc.invoke('projects.recent', 11, [], { parent: null, url })).rejects.toThrow(
        /refused/
      )
    }
    expect(calls).toBe(0)
    expect(logs.join('\n')).toMatch(/not on the app page/)
    // The app page itself, with a hash, passes.
    await expect(
      ipc.invoke('projects.recent', 11, [], { parent: null, url: `${APP_PAGE}#/tab` })
    ).resolves.toEqual([])
  })

  it("passes the sender's project, never one named in the payload", async () => {
    const { ipc, router } = setup()
    const seen: unknown[] = []
    router.handleProject('projects.openRecent', (ctx, payload) => {
      seen.push(ctx, payload)
    })
    // Project A's renderer claims to be project B, in the payload and in an extra argument.
    await ipc.invoke('projects.openRecent', 11, [
      { id: 'x', projectId: PROJECT_B, windowId: 2 },
      { projectId: PROJECT_B }
    ])
    expect(seen[0]).toEqual({ windowId: 1, projectId: PROJECT_A })
    // The payload reaches the handler as data; only the first argument is passed on.
    expect(seen[1]).toEqual({ id: 'x', projectId: PROJECT_B, windowId: 2 })
    expect(seen).toHaveLength(2)
  })

  it('refuses the picker on a project-scoped channel and allows it on a window one', async () => {
    const { ipc, router } = setup()
    router.handleProject('window.info', () => ({ kind: 'picker', home: '/h' }))
    router.handleWindow('projects.recent', (ctx) => {
      expect(ctx).toEqual({ kind: 'picker', windowId: 3 })
      return []
    })
    await expect(ipc.invoke('window.info', 13)).rejects.toThrow(/not a project window/)
    await expect(ipc.invoke('projects.recent', 13)).resolves.toEqual([])
  })
})

describe('appPageMatcher', () => {
  it('matches the built file by decoded path, ignoring query and hash', () => {
    const isApp = appPageMatcher({ kind: 'file', path: '/Apps/cc cockpit/renderer/index.html' })
    expect(isApp('file:///Apps/cc%20cockpit/renderer/index.html')).toBe(true)
    expect(isApp('file:///Apps/cc%20cockpit/renderer/index.html?x=1#y')).toBe(true)
    expect(isApp('file:///Apps/cc%20cockpit/renderer/other.html')).toBe(false)
    expect(isApp('file://host/Apps/cc%20cockpit/renderer/index.html')).toBe(false)
    expect(isApp('http://localhost/Apps/cc%20cockpit/renderer/index.html')).toBe(false)
    expect(isApp('not a url')).toBe(false)
  })

  it('matches the dev server by origin', () => {
    const isApp = appPageMatcher({ kind: 'url', url: 'http://localhost:5173' })
    expect(isApp('http://localhost:5173/')).toBe(true)
    expect(isApp('http://localhost:5173/index.html#x')).toBe(true)
    expect(isApp('http://localhost:5174/')).toBe(false)
    expect(isApp('https://localhost:5173/')).toBe(false)
    expect(isApp('http://localhost.evil:5173/')).toBe(false)
    expect(isApp('file:///index.html')).toBe(false)
  })
})

describe('core handlers', () => {
  function core(overrides: Partial<CoreHandlerDeps> = {}): {
    ipc: FakeIpcMain
    opened: string[]
    dialogs: number[]
    external: string[]
    relinked: string[]
    forgotten: string[]
    ran: string[]
    pickers: { count: number; callers: number[] }
  } {
    const { ipc, router } = setup()
    const ran: string[] = []
    const pickers = { count: 0, callers: [] as number[] }
    const opened: string[] = []
    const dialogs: number[] = []
    const external: string[] = []
    const relinked: string[] = []
    const forgotten: string[] = []
    const projects = new Map([
      [PROJECT_A, view(PROJECT_A, 'alpha')],
      [PROJECT_B, view(PROJECT_B, 'beta')]
    ])
    registerCoreHandlers(router, {
      getProject: (id) => projects.get(id),
      recentProjects: () => [...projects.values()],
      openFolderDialog: async (windowId) => {
        dialogs.push(windowId)
        return true
      },
      openRecent: (id) => {
        opened.push(id)
      },
      showPicker: (callerWindowId) => {
        pickers.count++
        pickers.callers.push(callerWindowId)
      },
      relink: async (windowId, id) => {
        relinked.push(`${windowId}:${id}`)
        return true
      },
      forget: (id) => {
        forgotten.push(id)
      },
      homeDir: () => '/Users/me',
      pickerOpenFolderKey: () => 'meta+o',
      openExternal: (url) => {
        external.push(url)
      },
      currentTheme: () => BUILTIN_THEMES[0]!,
      shellPrefs: () => ({ tabCloseSide: 'left', zoneAutoHide: true, minTerminalWidth: 720, terminalFont: { ...DEFAULT_TERMINAL_FONT, size: 20 }, backgroundOpacity: 70, seeThroughArea: 'main' }),
      commands: (projectId) => ({
        commands: [{ id: projectId, title: 't', source: 'core' }],
        conflicts: []
      }),
      runCommand: async (projectId, id) => {
        ran.push(`${projectId}:${id}`)
      },
      ...overrides
    })
    return { ipc, opened, dialogs, external, relinked, forgotten, ran, pickers }
  }

  it("window.info answers with the sender's own project", async () => {
    const { ipc } = core()
    const info = await ipc.invoke('window.info', 12, [{ projectId: PROJECT_A }])
    expect(info).toEqual({
      kind: 'project',
      project: { id: PROJECT_B, name: 'beta', path: '/work/beta', missing: false }
    })
    await expect(ipc.invoke('window.info', 13)).resolves.toEqual({ kind: 'picker', home: '/Users/me', openFolderKey: 'meta+o' })
  })

  it('window.info and the picker list carry a project colour, and never a damaged one', async () => {
    const colored = new Map([
      [PROJECT_A, { ...view(PROJECT_A, 'alpha'), color: 'teal' as const }],
      // A hand-edited record the registry did not repair (it does; summary checks again).
      [PROJECT_B, { ...view(PROJECT_B, 'beta'), color: 'url(x)' as never }]
    ])
    const { ipc } = core({ getProject: (id) => colored.get(id), recentProjects: () => [...colored.values()] })
    expect(await ipc.invoke('window.info', 11)).toMatchObject({ kind: 'project', project: { id: PROJECT_A, color: 'teal' } })
    expect(((await ipc.invoke('window.info', 12)) as { project: object }).project).not.toHaveProperty('color')
    const recent = (await ipc.invoke('projects.recent', 13)) as Array<{ id: string; color?: string }>
    expect(recent.map((p) => p.color)).toEqual(['teal', undefined])
    expect(recent[1]).not.toHaveProperty('color')
  })

  it('window.info says a project window is transparent only when main made it so, never for the picker', async () => {
    // Window 1 (sender 11) was created transparent, window 2 (sender 12) not; the picker is window 3.
    const asked: number[] = []
    const { ipc } = core({
      isTransparent: (windowId) => {
        asked.push(windowId)
        return windowId === 1 || windowId === 3
      }
    })
    expect(await ipc.invoke('window.info', 11)).toMatchObject({ kind: 'project', transparent: true })
    expect(await ipc.invoke('window.info', 12)).not.toHaveProperty('transparent')
    expect(await ipc.invoke('window.info', 13)).not.toHaveProperty('transparent')
    expect(asked).toEqual([1, 2])
  })

  it("window.reopen reopens the sender's own project window, ignores the payload, and is refused to the picker", async () => {
    const reopened: string[] = []
    const { ipc } = core({ reopenWindow: (projectId) => reopened.push(projectId) })
    // Sender 12 is project B's window; a payload naming project A changes nothing.
    await ipc.invoke('window.reopen', 12, [{ projectId: PROJECT_A }])
    await ipc.invoke('window.reopen', 11)
    expect(reopened).toEqual([PROJECT_B, PROJECT_A])
    await expect(ipc.invoke('window.reopen', 13)).rejects.toThrow(/not a project window/)
    expect(reopened).toEqual([PROJECT_B, PROJECT_A])
  })

  it("window.info for the picker leaves out an unbound Open Folder chord", async () => {
    const { ipc } = core({ pickerOpenFolderKey: () => undefined })
    await expect(ipc.invoke('window.info', 13)).resolves.toEqual({ kind: 'picker', home: '/Users/me' })
  })

  it('window.info fails when the record vanished', async () => {
    const { ipc } = core({ getProject: () => undefined })
    await expect(ipc.invoke('window.info', 11)).rejects.toThrow(/record is gone/)
  })

  it('projects.recent returns summaries only', async () => {
    const { ipc } = core()
    const recent = (await ipc.invoke('projects.recent', 13)) as object[]
    expect(recent).toHaveLength(2)
    expect(Object.keys(recent[0]!).sort()).toEqual(['id', 'missing', 'name', 'path'])
  })

  it('projects.openFolder parents the dialog to the asking window', async () => {
    const { ipc, dialogs } = core()
    await expect(ipc.invoke('projects.openFolder', 13)).resolves.toBe(true)
    expect(dialogs).toEqual([3])
  })

  it('projects.openRecent passes a string id on and refuses anything else', async () => {
    const { ipc, opened } = core()
    await ipc.invoke('projects.openRecent', 13, [{ id: PROJECT_A }])
    expect(opened).toEqual([PROJECT_A])
    await expect(ipc.invoke('projects.openRecent', 13, [{ id: 42 }])).rejects.toThrow(/string/)
    await expect(ipc.invoke('projects.openRecent', 13, [])).rejects.toThrow(/string/)
    expect(opened).toEqual([PROJECT_A])
  })

  it('projects.showPicker shows (or focuses) the picker for a project window, and is refused to the picker', async () => {
    const { ipc, pickers } = core()
    await ipc.invoke('projects.showPicker', 11)
    await ipc.invoke('projects.showPicker', 12, [{ anything: 'ignored' }])
    expect(pickers.count).toBe(2)
    await expect(ipc.invoke('projects.showPicker', 13)).rejects.toThrow(/not a project window/)
    expect(pickers.count).toBe(2)
    // The caller is the sender's window as main resolved it, never anything from the payload.
    // Two senders, two window ids; the payload's `anything` changed nothing.
    expect(pickers.callers).toHaveLength(2)
    expect(pickers.callers.every((id) => typeof id === 'number')).toBe(true)
    expect(new Set(pickers.callers).size).toBe(2)
  })

  it('projects.relink and projects.forget are for the picker only and take a string id', async () => {
    const { ipc, relinked, forgotten } = core()
    await expect(ipc.invoke('projects.relink', 13, [{ id: PROJECT_A }])).resolves.toBe(true)
    await ipc.invoke('projects.forget', 13, [{ id: PROJECT_A }])
    expect(relinked).toEqual([`3:${PROJECT_A}`])
    expect(forgotten).toEqual([PROJECT_A])
    // A project window (11) must not be able to relink or forget projects.
    await expect(ipc.invoke('projects.relink', 11, [{ id: PROJECT_A }])).rejects.toThrow(/picker/)
    await expect(ipc.invoke('projects.forget', 11, [{ id: PROJECT_A }])).rejects.toThrow(/picker/)
    await expect(ipc.invoke('projects.relink', 13, [{ id: 42 }])).rejects.toThrow(/string/)
    await expect(ipc.invoke('projects.forget', 13, [])).rejects.toThrow(/string/)
    expect(relinked).toHaveLength(1)
    expect(forgotten).toHaveLength(1)
  })

  it("commands.list is answered for the sender's own project and refused for the picker", async () => {
    const { ipc } = core()
    const view = (await ipc.invoke('commands.list', 12, [{ projectId: PROJECT_A }])) as {
      commands: { id: string }[]
    }
    // The project id in the payload is ignored; the sender (window 12 -> PROJECT_B) decides.
    expect(view.commands[0]?.id).toBe(PROJECT_B)
    await expect(ipc.invoke('commands.list', 13)).rejects.toThrow(/not a project window/)
  })

  it("commands.run runs a plugin command in the sender's own project only", async () => {
    const { ipc, ran } = core()
    // The project id in the payload is ignored; the sender (window 11 -> PROJECT_A) decides.
    await ipc.invoke('commands.run', 11, [{ id: 'a.one/refresh', projectId: PROJECT_B }])
    expect(ran).toEqual([`${PROJECT_A}:a.one/refresh`])
    // Core commands run in the renderer; anything that is not a plugin command id is refused.
    await expect(ipc.invoke('commands.run', 11, [{ id: 'tab.close' }])).rejects.toThrow(/plugin command/)
    await expect(ipc.invoke('commands.run', 11, [{ id: 7 }])).rejects.toThrow(/plugin command/)
    await expect(ipc.invoke('commands.run', 11, [{ id: `a.one/${'x'.repeat(300)}` }])).rejects.toThrow(/plugin command/)
    await expect(ipc.invoke('commands.run', 13, [{ id: 'a.one/refresh' }])).rejects.toThrow(/not a project window/)
    expect(ran).toHaveLength(1)
  })

  it("commands.run passes the host's refusal back to the renderer", async () => {
    const { ipc } = core({
      runCommand: async (_projectId, id) => {
        throw new Error(`unknown command: ${id}`)
      }
    })
    await expect(ipc.invoke('commands.run', 11, [{ id: 'a.one/nope' }])).rejects.toThrow('unknown command: a.one/nope')
  })

  it('theme.get answers every window kind with the current theme', async () => {
    const { ipc } = core()
    await expect(ipc.invoke('theme.get', 11)).resolves.toBe(BUILTIN_THEMES[0])
    await expect(ipc.invoke('theme.get', 13)).resolves.toBe(BUILTIN_THEMES[0])
  })

  it('prefs.get answers every window kind with the shell prefs', async () => {
    const { ipc } = core()
    const prefs = { tabCloseSide: 'left', zoneAutoHide: true, minTerminalWidth: 720, terminalFont: { ...DEFAULT_TERMINAL_FONT, size: 20 }, backgroundOpacity: 70, seeThroughArea: 'main' }
    await expect(ipc.invoke('prefs.get', 11)).resolves.toEqual(prefs)
    await expect(ipc.invoke('prefs.get', 13)).resolves.toEqual(prefs)
  })

  it('app.openExternal opens http and https links, normalized, from any window', async () => {
    const { ipc, external } = core()
    await ipc.invoke('app.openExternal', 11, [{ url: 'https://example.com/a b?x=1#h' }])
    await ipc.invoke('app.openExternal', 13, [{ url: 'http://localhost:3000' }])
    expect(external).toEqual(['https://example.com/a%20b?x=1#h', 'http://localhost:3000/'])
  })

  it('app.openExternal refuses other schemes and malformed payloads', async () => {
    const { ipc, external } = core()
    const bad: unknown[][] = [
      [{ url: 'file:///etc/passwd' }],
      [{ url: 'javascript:alert(1)' }],
      [{ url: 'ssh://host' }],
      [{ url: 'vscode://file/x' }],
      [{ url: 'not a url' }],
      [{ url: '' }],
      [{ url: 42 }],
      [{ url: 'https://example.com/' + 'a'.repeat(9000) }],
      [{}],
      []
    ]
    for (const args of bad) {
      await expect(ipc.invoke('app.openExternal', 11, args)).rejects.toThrow(/app\.openExternal/)
    }
    expect(external).toEqual([])
  })

  it('every core channel refuses an unknown sender', async () => {
    const { ipc, opened, dialogs, external } = core()
    for (const channel of ipc.handlers.keys()) {
      await expect(
        ipc.invoke(channel, 99, [{ id: PROJECT_A, url: 'https://example.com/' }])
      ).rejects.toThrow(/refused/)
    }
    expect(opened).toEqual([])
    expect(dialogs).toEqual([])
    expect(external).toEqual([])
  })
})

describe('registerTabHandlers', () => {
  /** Records each call with the project the router resolved. */
  function tabsSetup(): { ipc: FakeIpcMain; calls: unknown[][] } {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    const rec =
      (name: string, result?: unknown) =>
      (...args: unknown[]) => {
        calls.push([name, ...args])
        return result
      }
    const info = { id: 't1', kind: 'shell' as const, cwd: '/work/a' }
    registerTabHandlers(router, {
      attach: rec('attach', [info]) as TabHandlerDeps['attach'],
      create: rec('create', info) as TabHandlerDeps['create'],
      commands: rec('commands', { app: [], project: [] }) as TabHandlerDeps['commands'],
      close: rec('close') as TabHandlerDeps['close'],
      reorder: rec('reorder') as TabHandlerDeps['reorder'],
      rename: rec('rename') as TabHandlerDeps['rename'],
      restart: rec('restart', info) as TabHandlerDeps['restart'],
      input: rec('input') as TabHandlerDeps['input'],
      resize: rec('resize') as TabHandlerDeps['resize'],
      ack: rec('ack') as TabHandlerDeps['ack'],
      select: rec('select') as TabHandlerDeps['select']
    })
    return { ipc, calls }
  }

  it("acts on the sender's project, ignoring any project named in the payload; attach, create and restart get the sender's window", async () => {
    const { ipc, calls } = tabsSetup()
    await ipc.invoke('tabs.list', 11)
    await ipc.invoke('tabs.create', 12, [{ kind: 'claude', cwd: 'sub', projectId: PROJECT_A }])
    await ipc.invoke('tabs.close', 11, [{ tabId: 't1', projectId: PROJECT_B }])
    await ipc.invoke('tabs.reorder', 11, [{ tabId: 't1', toIndex: 2 }])
    await ipc.invoke('tabs.rename', 11, [{ tabId: 't1', name: 'Mine' }])
    await ipc.invoke('tabs.rename', 11, [{ tabId: 't1', name: null }])
    await ipc.invoke('tabs.restart', 12, [{ tabId: 't1' }])
    await ipc.invoke('tabs.input', 11, [{ tabId: 't1', data: 'ls\r' }])
    await ipc.invoke('tabs.resize', 11, [{ tabId: 't1', cols: 80, rows: 24 }])
    await ipc.invoke('tabs.ack', 11, [{ tabId: 't1', count: 5 }])
    await ipc.invoke('tabs.selected', 12, [{ tabId: 't1', projectId: PROJECT_A }])
    expect(calls).toEqual([
      ['attach', PROJECT_A, 1],
      ['create', PROJECT_B, { kind: 'claude', cwd: 'sub' }, 2],
      ['close', PROJECT_A, 't1'],
      ['reorder', PROJECT_A, 't1', 2],
      ['rename', PROJECT_A, 't1', 'Mine'],
      ['rename', PROJECT_A, 't1', null],
      ['restart', PROJECT_B, 't1', 2],
      ['input', PROJECT_A, 't1', 'ls\r'],
      ['resize', PROJECT_A, 't1', 80, 24],
      ['ack', PROJECT_A, 't1', 5],
      ['select', PROJECT_B, 't1']
    ])
  })

  it('creates a command tab by level and entry id only: command text in the payload is never read', async () => {
    const { ipc, calls } = tabsSetup()
    await ipc.invoke('tabs.create', 11, [
      { kind: 'command', level: 'project', entryId: 'e1', command: 'rm -rf ~', label: 'evil', cwd: '/', projectId: PROJECT_B }
    ])
    await ipc.invoke('tabs.create', 12, [{ kind: 'command', level: 'app', entryId: 'e2' }])
    expect(calls).toEqual([
      ['create', PROJECT_A, { kind: 'command', level: 'project', entryId: 'e1' }, 1],
      ['create', PROJECT_B, { kind: 'command', level: 'app', entryId: 'e2' }, 2]
    ])
  })

  it('refuses a command tab without a valid level and entry id (raw command text is not a way in)', async () => {
    const { ipc, calls } = tabsSetup()
    const bad: unknown[] = [
      { kind: 'command', command: 'echo hi' },
      { kind: 'command', level: 'app', command: 'echo hi' },
      { kind: 'command', level: 'user', entryId: 'e1' },
      { kind: 'command', level: 'app', entryId: 5 },
      { kind: 'command', level: 'project' }
    ]
    for (const payload of bad) {
      await expect(ipc.invoke('tabs.create', 11, [payload]), JSON.stringify(payload)).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })

  it("lists the sender's new-tab menu entries", async () => {
    const { ipc, calls } = tabsSetup()
    await ipc.invoke('tabs.commands', 12, [{ projectId: PROJECT_A }])
    expect(calls).toEqual([['commands', PROJECT_B]])
  })

  it('never forwards a prompt from the renderer', async () => {
    const { ipc, calls } = tabsSetup()
    await ipc.invoke('tabs.create', 11, [{ kind: 'claude', prompt: '--evil' }])
    expect(calls).toEqual([['create', PROJECT_A, { kind: 'claude' }, 1]])
  })

  it('refuses the picker window and unknown senders', async () => {
    const { ipc, calls } = tabsSetup()
    for (const sender of [13, 99]) {
      await expect(ipc.invoke('tabs.list', sender)).rejects.toThrow()
      await expect(ipc.invoke('tabs.input', sender, [{ tabId: 't1', data: 'x' }])).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })

  it('refuses malformed payloads before calling the manager', async () => {
    const { ipc, calls } = tabsSetup()
    const bad: Array<[string, unknown[]]> = [
      ['tabs.create', []],
      ['tabs.create', [{ kind: 'vim' }]],
      ['tabs.create', [{ kind: 'shell', cwd: 5 }]],
      ['tabs.close', [{ tabId: 7 }]],
      ['tabs.close', [null]],
      ['tabs.reorder', [{ tabId: 't1', toIndex: 'first' }]],
      ['tabs.reorder', [{ tabId: 't1', toIndex: 1.5 }]],
      ['tabs.rename', [{ tabId: 't1', name: 5 }]],
      ['tabs.restart', [{}]],
      ['tabs.input', [{ tabId: 't1', data: 5 }]],
      ['tabs.resize', [{ tabId: 't1', cols: '80', rows: 24 }]],
      ['tabs.ack', [{ tabId: 't1', count: '5' }]],
      ['tabs.selected', [{ tabId: 3 }]],
      ['tabs.selected', []]
    ]
    for (const [channel, args] of bad) {
      await expect(ipc.invoke(channel, 11, args), channel).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })
})

describe('registerSessionHandlers', () => {
  function sessionsSetup(): { ipc: FakeIpcMain; calls: unknown[][] } {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    registerSessionHandlers(router, {
      snapshotFor: (projectId) => {
        calls.push(['snapshotFor', projectId])
        return { own: [] }
      },
      cancelQueued: (projectId, tabId, itemId) => {
        calls.push(['cancelQueued', projectId, tabId, itemId])
        return true
      },
      closeAnswer: (windowId, requestId, closed) => {
        calls.push(['closeAnswer', windowId, requestId, closed])
        return true
      }
    })
    return { ipc, calls }
  }

  it('sessions.closeAnswer passes the sender’s window, never one from the payload', async () => {
    const { ipc, calls } = sessionsSetup()
    await expect(ipc.invoke('sessions.closeAnswer', 12, [{ requestId: 'close-1', closed: true, windowId: 1 }])).resolves.toBe(true)
    expect(calls).toEqual([['closeAnswer', 2, 'close-1', true]])
    await expect(ipc.invoke('sessions.closeAnswer', 12, [{ requestId: 5, closed: true }])).rejects.toThrow()
    await expect(ipc.invoke('sessions.closeAnswer', 12, [{ requestId: 'close-1', closed: 'yes' }])).rejects.toThrow()
    await expect(ipc.invoke('sessions.closeAnswer', 13, [{ requestId: 'close-1', closed: false }])).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('answers and cancels for the sender’s project, ignoring any project in the payload', async () => {
    const { ipc, calls } = sessionsSetup()
    await expect(ipc.invoke('sessions.list', 12, [{ projectId: PROJECT_A }])).resolves.toEqual({ own: [] })
    await expect(
      ipc.invoke('sessions.cancelQueued', 11, [{ tabId: 't1', itemId: 'i1', projectId: PROJECT_B }])
    ).resolves.toBe(true)
    expect(calls).toEqual([
      ['snapshotFor', PROJECT_B],
      ['cancelQueued', PROJECT_A, 't1', 'i1']
    ])
  })

  it('no longer answers the core strip\'s and Sessions panel\'s channels (a plugin asks through ctx.sessions)', async () => {
    const { ipc, calls } = sessionsSetup()
    await expect(ipc.invoke('sessions.focus', 11, [{ tabId: 't1' }])).rejects.toThrow()
    await expect(ipc.invoke('sessions.openFile', 11, [{ tabId: 't1', file: 'a' }])).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('refuses the picker and unknown senders, and malformed payloads', async () => {
    const { ipc, calls } = sessionsSetup()
    for (const sender of [13, 99]) {
      await expect(ipc.invoke('sessions.list', sender)).rejects.toThrow()
      await expect(
        ipc.invoke('sessions.cancelQueued', sender, [{ tabId: 't1', itemId: 'i' }])
      ).rejects.toThrow()
    }
    const bad: Array<[string, unknown[]]> = [
      ['sessions.cancelQueued', [{ tabId: 't1' }]],
      ['sessions.cancelQueued', [{ tabId: 5, itemId: 'i' }]],
      ['sessions.cancelQueued', [{ tabId: 't1', itemId: {} }]],
      ['sessions.cancelQueued', []]
    ]
    for (const [channel, args] of bad) {
      await expect(ipc.invoke(channel, 11, args), channel).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })
})

describe('webUrlOf', () => {
  it('accepts http(s) only and returns the normalized href', () => {
    expect(webUrlOf('HTTPS://Example.com')).toBe('https://example.com/')
    expect(() => webUrlOf('data:text/html,hi')).toThrow(/only http/)
  })
})

describe('registerLayoutHandlers', () => {
  const emptyView = { layout: defaultLayout(), panels: [] }

  it('acts on the project of the sender, never on a payload id', async () => {
    const { ipc, router } = setup()
    const asked: string[] = []
    registerLayoutHandlers(router, {
      view: (projectId) => {
        asked.push(`view ${projectId}`)
        return emptyView
      },
      set: (projectId) => {
        asked.push(`set ${projectId}`)
        return emptyView
      }
    })
    await ipc.invoke('layout.get', 11)
    await ipc.invoke('layout.set', 12, [{ layout: defaultLayout(), projectId: PROJECT_A }])
    expect(asked).toEqual([`view ${PROJECT_A}`, `set ${PROJECT_B}`])
  })

  it('refuses a picker window and a malformed layout', async () => {
    const { ipc, router } = setup()
    registerLayoutHandlers(router, { view: () => emptyView, set: () => emptyView })
    await expect(ipc.invoke('layout.get', 13)).rejects.toThrow('not a project window')
    await expect(ipc.invoke('layout.set', 11)).rejects.toThrow('bad payload')
    await expect(ipc.invoke('layout.set', 11, [{ layout: 'x' }])).rejects.toThrow('must be an object')
    await expect(ipc.invoke('layout.set', 11, [{ layout: null }])).rejects.toThrow('must be an object')
  })

  it('refuses an oversized layout before the service walks it', async () => {
    const { ipc, router } = setup()
    let sets = 0
    registerLayoutHandlers(router, {
      view: () => emptyView,
      set: () => {
        sets += 1
        return emptyView
      }
    })
    const keys = Array.from({ length: 1001 }, (_, i) => `p/${i}`)
    const remembered = Object.fromEntries(
      keys.map((k) => [k, { zone: 'left', open: false, size: 100, hidden: false }])
    )
    const panels = keys.map((panelKey) => ({ panelKey, open: false, size: 100 }))
    const base = defaultLayout()
    for (const layout of [
      { ...base, remembered },
      { ...base, hidden: keys },
      { ...base, zones: { ...base.zones, bottom: { collapsed: false, size: 100, panels } } }
    ]) {
      await expect(ipc.invoke('layout.set', 11, [{ layout }])).rejects.toThrow('too large')
    }
    expect(sets).toBe(0)
    // At the bound it still goes through.
    await ipc.invoke('layout.set', 11, [{ layout: { ...base, hidden: keys.slice(0, 1000) } }])
    expect(sets).toBe(1)
  })

  it('reports a project whose record is gone', async () => {
    const { ipc, router } = setup()
    registerLayoutHandlers(router, { view: () => undefined, set: () => undefined })
    await expect(ipc.invoke('layout.get', 11)).rejects.toThrow('record is gone')
    await expect(ipc.invoke('layout.set', 11, [{ layout: {} }])).rejects.toThrow('record is gone')
  })
})

describe('registerSlotHandlers', () => {
  it("passes the sender's project and window on with the frame id, refusing junk first", async () => {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    registerSlotHandlers(router, {
      connect: (projectId, windowId, frameId, nonce) => {
        calls.push(['connect', projectId, windowId, frameId, nonce])
        return frameId === 's1'
      },
      disconnect: (projectId, frameId) => void calls.push(['disconnect', projectId, frameId]),
      setHeight: (projectId, frameId, height) => {
        calls.push(['height', projectId, frameId, height])
        return true
      }
    })
    await expect(ipc.invoke('slots.connect', 12, [{ frameId: 's1', nonce: 3, projectId: PROJECT_A }])).resolves.toBe(true)
    await expect(ipc.invoke('slots.disconnect', 11, [{ frameId: 's1' }])).resolves.toBeNull()
    await expect(ipc.invoke('slots.height', 11, [{ frameId: 's1', height: 90 }])).resolves.toBe(true)
    expect(calls).toEqual([
      ['connect', PROJECT_B, 2, 's1', 3],
      ['disconnect', PROJECT_A, 's1'],
      ['height', PROJECT_A, 's1', 90]
    ])
    await expect(ipc.invoke('slots.connect', 11, [{ frameId: 'x'.repeat(41), nonce: 1 }])).rejects.toThrow(/short string/)
    await expect(ipc.invoke('slots.disconnect', 11, [{ frameId: 7 }])).rejects.toThrow(/short string/)
    await expect(ipc.invoke('slots.height', 11, [{ frameId: 's1', height: '90' }])).rejects.toThrow(/must be a number/)
    await expect(ipc.invoke('slots.height', 11, ['nope'])).rejects.toThrow(/bad payload/)
    await expect(ipc.invoke('slots.connect', 13, [{ frameId: 's1', nonce: 1 }])).rejects.toThrow(/not a project window/)
    expect(calls).toHaveLength(3)
  })
})

describe('registerSettingsPageHandlers', () => {
  it("passes the sender's project and window on with a checked plugin id and scope, refusing junk first", async () => {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    registerSettingsPageHandlers(router, {
      info: (projectId, pluginId, scope) => {
        calls.push(['info', projectId, pluginId, scope])
        return pluginId === 'a.one' ? { enabled: true, src: 'cc-plugin://a.one/settings/index.html' } : null
      },
      connect: (projectId, windowId, pluginId, scope, nonce) => {
        calls.push(['connect', projectId, windowId, pluginId, scope, nonce])
        return true
      },
      disconnect: (projectId, pluginId) => void calls.push(['disconnect', projectId, pluginId])
    })
    // A projectId in the payload is ignored: the sender's own project is used.
    await expect(ipc.invoke('settingsPage.info', 12, [{ pluginId: 'a.one', scope: 'app', projectId: PROJECT_A }])).resolves.toEqual({
      enabled: true,
      src: 'cc-plugin://a.one/settings/index.html'
    })
    await expect(ipc.invoke('settingsPage.connect', 11, [{ pluginId: 'a.one', scope: 'project', nonce: 4 }])).resolves.toBe(true)
    await expect(ipc.invoke('settingsPage.disconnect', 11, [{ pluginId: 'a.one' }])).resolves.toBeNull()
    expect(calls).toEqual([
      ['info', PROJECT_B, 'a.one', 'app'],
      ['connect', PROJECT_A, 1, 'a.one', 'project', 4],
      ['disconnect', PROJECT_A, 'a.one']
    ])
    await expect(ipc.invoke('settingsPage.info', 11, [{ pluginId: 'A One', scope: 'app' }])).rejects.toThrow(/plugin id/)
    await expect(ipc.invoke('settingsPage.info', 11, [{ pluginId: 'a.one', scope: 'global' }])).rejects.toThrow(/scope/)
    await expect(ipc.invoke('settingsPage.connect', 11, [{ pluginId: 7, scope: 'app', nonce: 1 }])).rejects.toThrow(/plugin id/)
    await expect(ipc.invoke('settingsPage.disconnect', 11, ['nope'])).rejects.toThrow(/bad payload/)
    await expect(ipc.invoke('settingsPage.connect', 13, [{ pluginId: 'a.one', scope: 'app', nonce: 1 }])).rejects.toThrow(/not a project window/)
    expect(calls).toHaveLength(3)
  })
})

describe('registerPanelHandlers', () => {
  it("connects a panel of the sender's own project and window, and restarts that project's host", async () => {
    const { ipc, router } = setup()
    const connects: unknown[][] = []
    const restarts: string[] = []
    registerPanelHandlers(router, {
      connect: (projectId, windowId, panelKey, nonce) => {
        connects.push([projectId, windowId, panelKey, nonce])
        return panelKey === 'a.one/board'
      },
      restartHost: async (projectId) => {
        restarts.push(projectId)
      },
      panelAction: () => false
    })
    await expect(ipc.invoke('panels.connect', 12, [{ panelKey: 'a.one/board', nonce: 3, projectId: PROJECT_A }])).resolves.toBe(true)
    await expect(ipc.invoke('panels.connect', 11, [{ panelKey: 'other/x', nonce: 4 }])).resolves.toBe(false)
    // Window and project are the sender's; key and nonce are passed on for the hub to check.
    expect(connects).toEqual([
      [PROJECT_B, 2, 'a.one/board', 3],
      [PROJECT_A, 1, 'other/x', 4]
    ])
    await expect(ipc.invoke('panels.connect', 11, ['nope'])).rejects.toThrow(/bad payload/)
    await expect(ipc.invoke('panels.connect', 13, [{ panelKey: 'a.one/board', nonce: 1 }])).rejects.toThrow(
      /not a project window/
    )
    await ipc.invoke('plugins.restart', 11, [{ projectId: PROJECT_B }])
    expect(restarts).toEqual([PROJECT_A])
    await expect(ipc.invoke('plugins.restart', 13)).rejects.toThrow(/not a project window/)
  })

  it("hands a header action click to the sender's project, refusing junk before it goes further", async () => {
    const { ipc, router } = setup()
    const clicks: unknown[][] = []
    registerPanelHandlers(router, {
      connect: () => false,
      restartHost: async () => {},
      panelAction: (projectId, panelKey, actionId) => {
        clicks.push([projectId, panelKey, actionId])
        return actionId === 'refresh'
      }
    })
    // The project is the sender's, whatever the payload says.
    await expect(ipc.invoke('panels.action', 11, [{ panelKey: 'a.one/board', actionId: 'refresh', projectId: PROJECT_B }])).resolves.toBe(true)
    await expect(ipc.invoke('panels.action', 12, [{ panelKey: 'a.one/board', actionId: 'other' }])).resolves.toBe(false)
    expect(clicks).toEqual([
      [PROJECT_A, 'a.one/board', 'refresh'],
      [PROJECT_B, 'a.one/board', 'other']
    ])
    await expect(ipc.invoke('panels.action', 11, [{ panelKey: 'a.one/board', actionId: 'x'.repeat(41) }])).rejects.toThrow(/short strings/)
    await expect(ipc.invoke('panels.action', 11, [{ panelKey: 7, actionId: 'refresh' }])).rejects.toThrow(/short strings/)
    await expect(ipc.invoke('panels.action', 11, ['nope'])).rejects.toThrow(/bad payload/)
    await expect(ipc.invoke('panels.action', 13, [{ panelKey: 'a.one/board', actionId: 'refresh' }])).rejects.toThrow(/not a project window/)
    expect(clicks).toHaveLength(2)
  })
})

describe('registerSettingsHandlers', () => {
  /** A deps object that records every call as `name(args)` and answers with harmless values. */
  function settingsSetup(): { ipc: FakeIpcMain; calls: unknown[][] } {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    const rec =
      <R>(name: string, result: R) =>
      (...args: unknown[]): R => {
        calls.push([name, ...args])
        return result
      }
    const deps: SettingsHandlerDeps = {
      projects: rec('projects', []),
      openProject: rec('openProject', undefined),
      relinkProject: async (...args) => rec('relinkProject', true)(...args),
      removeProject: rec('removeProject', undefined),
      plugins: rec('plugins', []),
      installPlugin: async (...args) => rec('installPlugin', {} as never)(...args),
      linkPlugin: async (...args) => rec('linkPlugin', true)(...args),
      updatePlugin: async (...args) => rec('updatePlugin', {} as never)(...args),
      uninstallPlugin: async (...args) => rec('uninstallPlugin', undefined)(...args),
      setBundledOff: async (...args) => rec('setBundledOff', undefined)(...args),
      savePluginSettings: async (...args) => rec('savePluginSettings', { ok: true as const, values: {} })(...args),
      saveProjectDefaults: async (...args) => rec('saveProjectDefaults', { ok: true as const, values: {} })(...args),
      marketplace: rec('marketplace', { indexes: [], entries: [], warnings: [] }),
      installMarketplace: async (...args) => rec('installMarketplace', {} as never)(...args),
      updateMarketplace: async (...args) => rec('updateMarketplace', {} as never)(...args),
      refreshMarketplace: async (...args) => rec('refreshMarketplace', { indexes: [], entries: [], warnings: [] })(...args),
      marketplacePreview: async (...args) => rec('marketplacePreview', null)(...args),
      setMarketplaceUrls: async (...args) => rec('setMarketplaceUrls', { indexes: [], entries: [], warnings: [] })(...args)
    }
    registerSettingsHandlers(router, deps)
    return { ipc, calls }
  }

  it('is for project windows only: the picker is refused on every channel', async () => {
    const { ipc, calls } = settingsSetup()
    const channels = [...ipc.handlers.keys()]
    expect(channels).toHaveLength(18)
    // Accounts left core (design §6): none of their channels is registered any more.
    expect(channels.filter((c) => /account|oauth/i.test(c))).toEqual([])
    for (const channel of channels) {
      await expect(ipc.invoke(channel, 13, [{}])).rejects.toThrow(/not a project window/)
    }
    expect(calls).toEqual([])
  })

  it('passes the sender window to the dialog openers, never one from the payload', async () => {
    const { ipc, calls } = settingsSetup()
    await ipc.invoke('settings.projectRelink', 12, [{ id: 'p1', windowId: 99 }])
    await ipc.invoke('settings.pluginLink', 11, [{ windowId: 99 }])
    expect(calls).toEqual([
      ['relinkProject', 2, 'p1'],
      ['linkPlugin', 1]
    ])
  })

  it('hands renderer fields on as unknown for the service to check, dropping the rest', async () => {
    const { ipc, calls } = settingsSetup()
    await ipc.invoke('settings.pluginInstall', 11, [{ url: 'https://x', tag: 'v1', extra: 1 }])
    await ipc.invoke('settings.pluginUpdate', 11, [{ id: 'a.b', tag: 'v2' }])
    await ipc.invoke('settings.pluginSettingsSave', 11, [{ id: 'a.b', values: { k: 1 } }])
    // A secret field's edit travels beside the values, never inside them.
    await ipc.invoke('settings.pluginSettingsSave', 11, [{ id: 'a.b', values: {}, secrets: { token: 'new', old: null } }])
    // The global values of project fields: an id and the values, never a project (main checks them all).
    await ipc.invoke('settings.pluginProjectDefaultsSave', 11, [{ id: 'a.b', values: { k: 2 }, secrets: { token: null }, projectId: 'other' }])
    await ipc.invoke('settings.pluginUninstall', 11, [{ id: 'a.b', extra: 1 }])
    await ipc.invoke('settings.pluginBundledOff', 11, [{ id: 'cockpit.editor', off: true, projectId: 'other' }])
    // The marketplace calls name a listing only; a repo, tag or commit in the payload is dropped.
    await ipc.invoke('settings.marketplaceInstall', 11, [{ indexUrl: 'https://i/x.json', id: 'a.b', expect: { repo: 'r', commit: 'c' }, tag: 'v9' }])
    await ipc.invoke('settings.marketplaceUpdate', 11, [{ indexUrl: 'https://i/x.json', id: 'a.b', expect: { repo: 'r', commit: 'c' }, tag: 'v9' }])
    await ipc.invoke('settings.marketplaceSetUrls', 11, [{ urls: ['https://i/x.json'], extra: 1 }])
    expect(calls).toEqual([
      ['installPlugin', 'https://x', 'v1'],
      ['updatePlugin', 'a.b', 'v2'],
      ['savePluginSettings', 'a.b', { k: 1 }, undefined],
      ['savePluginSettings', 'a.b', {}, { token: 'new', old: null }],
      ['saveProjectDefaults', 'a.b', { k: 2 }, { token: null }],
      ['uninstallPlugin', 'a.b'],
      ['setBundledOff', 'cockpit.editor', true],
      ['installMarketplace', 'https://i/x.json', 'a.b', { repo: 'r', commit: 'c' }],
      ['updateMarketplace', 'https://i/x.json', 'a.b', { repo: 'r', commit: 'c' }],
      ['setMarketplaceUrls', ['https://i/x.json']]
    ])
  })

  it('rejects a payload that is not an object, and a relink without a string id', async () => {
    const { ipc } = settingsSetup()
    await expect(ipc.invoke('settings.pluginInstall', 11, ['nope'])).rejects.toThrow(/bad payload/)
    await expect(ipc.invoke('settings.pluginSettingsSave', 11, [])).rejects.toThrow(/bad payload/)
    await expect(ipc.invoke('settings.pluginBundledOff', 11, ['cockpit.editor'])).rejects.toThrow(/bad payload/)
    await expect(ipc.invoke('settings.projectRelink', 11, [{ id: 5 }])).rejects.toThrow(/id must be a string/)
    await expect(ipc.invoke('settings.marketplaceInstall', 11, [])).rejects.toThrow(/bad payload/)
    await expect(ipc.invoke('settings.marketplaceInstall', 11, [{ indexUrl: 'u', id: 'a.b' }])).rejects.toThrow(/bad payload/)
  })

  it('answers the marketplace plain queries without a payload', async () => {
    const { ipc, calls } = settingsSetup()
    await ipc.invoke('settings.marketplace', 11)
    await ipc.invoke('settings.marketplaceRefresh', 11)
    expect(calls).toEqual([['marketplace'], ['refreshMarketplace']])
  })

  it('passes a preview request on as given: the service finds the entry and checks the fields', async () => {
    const { ipc, calls } = settingsSetup()
    expect(await ipc.invoke('settings.marketplacePreview', 11, [{ indexUrl: 'https://a.example/index.json', id: 'a.b' }])).toBeNull()
    await expect(ipc.invoke('settings.marketplacePreview', 11, [])).rejects.toThrow(/bad payload/)
    expect(calls).toEqual([['marketplacePreview', 'https://a.example/index.json', 'a.b']])
  })
})

describe('registerServiceHandlers (with ServiceChoices)', () => {
  /** Project A runs two triage providers and a consumer; project B runs its own provider. */
  function servicesSetup(): {
    ipc: FakeIpcMain
    sets: Record<string, ServicePlugin[]>
    picks: Record<string, Record<string, string>>
    restarts: string[]
  } {
    const { ipc, router } = setup()
    const sets: Record<string, ServicePlugin[]> = {
      [PROJECT_A]: [
        { id: 'a.one', services: { provides: { triage: 1 } } },
        { id: 'a.two', services: { provides: { triage: 1 } } },
        { id: 'a.user', services: { uses: { triage: 1, mail: 1 } } }
      ],
      [PROJECT_B]: [{ id: 'b.other', services: { provides: { triage: 1 } } }]
    }
    const picks: Record<string, Record<string, string>> = { [PROJECT_A]: {}, [PROJECT_B]: {} }
    const restarts: string[] = []
    const choices = new ServiceChoices({
      plugins: async (projectId) => sets[projectId] ?? [],
      choices: (projectId) => ({ ...picks[projectId] }),
      setChoice: (projectId, service, pluginId) => {
        const current = picks[projectId]!
        if ((current[service] ?? null) === pluginId) return false
        if (pluginId === null) delete current[service]
        else current[service] = pluginId
        return true
      },
      restart: async (projectId) => void restarts.push(projectId)
    })
    registerServiceHandlers(router, choices)
    return { ipc, sets, picks, restarts }
  }

  it('reports the status of the asking window\'s project; the picker is refused', async () => {
    const { ipc } = servicesSetup()
    const a = (await ipc.invoke('settings.pluginServices', 11, [{ projectId: PROJECT_B }])) as ServicesStatus
    expect(a.services).toEqual([
      { service: 'mail', candidates: [], selected: null, collectedOnly: false },
      { service: 'triage', candidates: ['a.one', 'a.two'], selected: null, collectedOnly: false }
    ])
    const b = (await ipc.invoke('settings.pluginServices', 12)) as ServicesStatus
    expect(b.services).toEqual([{ service: 'triage', candidates: ['b.other'], selected: 'b.other', collectedOnly: false }])
    await expect(ipc.invoke('settings.pluginServices', 13)).rejects.toThrow(/not a project window/)
    await expect(ipc.invoke('settings.pluginServiceProvider', 13, [{ service: 'triage', pluginId: 'a.one' }])).rejects.toThrow(
      /not a project window/
    )
  })

  it('refuses a bad or unknown service, a non-provider and another project\'s plugin', async () => {
    const { ipc, picks, restarts } = servicesSetup()
    const set = (payload: unknown): Promise<unknown> => ipc.invoke('settings.pluginServiceProvider', 11, [payload])
    await expect(set({ service: 'Bad Name', pluginId: 'a.one' })).rejects.toThrow(/bad service name/)
    await expect(set({ service: 5, pluginId: 'a.one' })).rejects.toThrow(/bad service name/)
    await expect(set({ service: 'calendar', pluginId: 'a.one' })).rejects.toThrow(/provides or uses service "calendar"/)
    await expect(set({ service: 'triage', pluginId: 'a.user' })).rejects.toThrow(/a.user does not provide/)
    await expect(set({ service: 'triage', pluginId: 'b.other' })).rejects.toThrow(/b.other does not provide/)
    await expect(set({ service: 'triage', pluginId: 7 })).rejects.toThrow(/string or null/)
    await expect(set({ service: 'triage' })).rejects.toThrow(/string or null/)
    await expect(ipc.invoke('settings.pluginServiceProvider', 11, [])).rejects.toThrow(/bad payload/)
    expect(picks[PROJECT_A]).toEqual({})
    expect(restarts).toEqual([])
  })

  it('saves a pick for the sender\'s project and restarts its host, only on a change; null clears', async () => {
    const { ipc, picks, restarts } = servicesSetup()
    const set = (payload: unknown): Promise<unknown> => ipc.invoke('settings.pluginServiceProvider', 11, [payload])
    // A project id in the payload is ignored: the pick lands in A, the sender's project.
    await set({ service: 'triage', pluginId: 'a.two', projectId: PROJECT_B })
    expect(picks).toEqual({ [PROJECT_A]: { triage: 'a.two' }, [PROJECT_B]: {} })
    expect(restarts).toEqual([PROJECT_A])
    await set({ service: 'triage', pluginId: 'a.two' })
    expect(restarts).toEqual([PROJECT_A])
    const status = (await ipc.invoke('settings.pluginServices', 11)) as ServicesStatus
    expect(status.services.find((s) => s.service === 'triage')?.selected).toBe('a.two')
    await set({ service: 'triage', pluginId: null })
    expect(picks[PROJECT_A]).toEqual({})
    expect(restarts).toEqual([PROJECT_A, PROJECT_A])
    // Clearing what is not set changes nothing.
    await set({ service: 'triage', pluginId: null })
    expect(restarts).toEqual([PROJECT_A, PROJECT_A])
  })

  it('a pick whose plugin left the set (disabled) reads as no choice, not an error', async () => {
    const { ipc, sets, picks } = servicesSetup()
    picks[PROJECT_A] = { triage: 'a.two' }
    sets[PROJECT_A] = sets[PROJECT_A]!.filter((p) => p.id !== 'a.two')
    const status = (await ipc.invoke('settings.pluginServices', 11)) as ServicesStatus
    // One provider left: it answers, the stale pick is simply not used.
    expect(status.services.find((s) => s.service === 'triage')).toEqual({ service: 'triage', candidates: ['a.one'], selected: 'a.one', collectedOnly: false })
    expect(status.plugins.find((p) => p.id === 'a.user')?.problems).toEqual([{ kind: 'missing', service: 'mail' }])
    // With a third provider back, the stale pick still names no one: ambiguous, the page asks again.
    sets[PROJECT_A] = [...sets[PROJECT_A]!, { id: 'a.three', services: { provides: { triage: 1 } } }]
    const again = (await ipc.invoke('settings.pluginServices', 11)) as ServicesStatus
    expect(again.services.find((s) => s.service === 'triage')?.selected).toBeNull()
    expect(picks[PROJECT_A]).toEqual({ triage: 'a.two' })
  })
})

describe('registerProjectSettingsHandlers', () => {
  function projectSettingsSetup(): { ipc: FakeIpcMain; calls: unknown[][] } {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    const rec =
      <R>(name: string, result: R) =>
      (...args: unknown[]): R => {
        calls.push([name, ...args])
        return result
      }
    const deps: ProjectSettingsHandlerDeps = {
      projectView: rec('projectView', { name: 'a', plugins: [], panels: [], tabCommands: [] }),
      setPluginEnabled: async (...args) => rec('setPluginEnabled', undefined)(...args),
      saveProjectPluginSettings: async (...args) =>
        rec('saveProjectPluginSettings', { ok: true as const, values: {} })(...args),
      movePanel: rec('movePanel', undefined),
      setProjectColor: rec('setProjectColor', 'blue'),
      appearance: rec('appearance', { themes: [], selected: null, current: 'light', keys: [], tabExit: 'close-clean' as const, claudeTabOnOpen: true, sessionGist: false, notificationSounds: true, notificationSound: 'builtin:chime', zoneAutoHide: true, minTerminalWidth: 720, confirmTabClose: true, tabCloseSide: 'right' as const, terminalFont: { ...DEFAULT_TERMINAL_FONT }, windowBackground: { transparent: false, opacity: 85, blur: true, area: 'window' as const }, blurSupport: 'vibrancy' as const, tabCommands: [] }),
      setTheme: rec('setTheme', undefined),
      setKey: rec('setKey', undefined),
      setTabExit: rec('setTabExit', undefined),
      setClaudeTabOnOpen: rec('setClaudeTabOnOpen', undefined),
      setSessionGist: rec('setSessionGist', undefined),
      setNotificationSounds: rec('setNotificationSounds', undefined),
      notificationSoundOptions: async (...args) =>
        rec('notificationSoundOptions', [{ label: 'Built-in', sounds: [{ id: 'builtin:chime', name: 'Chime' }] }])(...args),
      setNotificationSound: async (...args) => rec('setNotificationSound', undefined)(...args),
      notificationSoundData: async (...args) =>
        rec('notificationSoundData', { data: new Uint8Array([1, 2]), type: 'audio/wav' })(...args),
      confirmTabClose: rec('confirmTabClose', false),
      setConfirmTabClose: rec('setConfirmTabClose', undefined),
      setTabCloseSide: rec('setTabCloseSide', undefined),
      setZoneAutoHide: rec('setZoneAutoHide', undefined),
      setMinTerminalWidth: rec('setMinTerminalWidth', undefined),
      setTerminalFont: rec('setTerminalFont', undefined),
      setWindowBackground: rec('setWindowBackground', undefined),
      setTabCommands: rec('setTabCommands', [])
    }
    registerProjectSettingsHandlers(router, deps)
    return { ipc, calls }
  }

  it('is for project windows only: the picker is refused on every channel', async () => {
    const { ipc, calls } = projectSettingsSetup()
    const channels = [...ipc.handlers.keys()]
    expect(channels).toHaveLength(23)
    for (const channel of channels) {
      await expect(ipc.invoke(channel, 13, [{}])).rejects.toThrow(/not a project window/)
    }
    expect(calls).toEqual([])
  })

  it("acts on the sender's project, never one named in the payload", async () => {
    const { ipc, calls } = projectSettingsSetup()
    await ipc.invoke('settings.project', 11, [{ projectId: PROJECT_B }])
    await ipc.invoke('settings.projectPluginEnable', 12, [{ pluginId: 'a.b', enabled: true, projectId: PROJECT_A }])
    await ipc.invoke('settings.projectPluginSettingsSave', 12, [{ pluginId: 'a.b', values: { x: 1 }, secrets: { token: null } }])
    await ipc.invoke('settings.projectPanelMove', 11, [{ panelKey: 'core/sessions', zone: 'left' }])
    await ipc.invoke('settings.appearance', 12)
    await ipc.invoke('settings.keySet', 11, [{ commandId: 'tab.close', chord: 'Cmd+Y' }])
    expect(calls).toEqual([
      ['projectView', PROJECT_A],
      ['setPluginEnabled', PROJECT_B, 'a.b', true],
      ['saveProjectPluginSettings', PROJECT_B, 'a.b', { x: 1 }, { token: null }],
      ['movePanel', PROJECT_A, 'core/sessions', 'left'],
      ['appearance', PROJECT_B],
      ['setKey', PROJECT_A, 'tab.close', 'Cmd+Y']
    ])
  })

  it("sets the colour of the sender's own project only, passing the value on as unknown", async () => {
    const { ipc, calls } = projectSettingsSetup()
    expect(await ipc.invoke('settings.projectColorSet', 11, [{ value: 'blue', projectId: PROJECT_B }])).toBe('blue')
    await ipc.invoke('settings.projectColorSet', 12, [{ value: 7, id: PROJECT_A }])
    await ipc.invoke('settings.projectColorSet', 12, [{ value: null }])
    expect(calls).toEqual([
      ['setProjectColor', PROJECT_A, 'blue'],
      ['setProjectColor', PROJECT_B, 7],
      ['setProjectColor', PROJECT_B, null]
    ])
    await expect(ipc.invoke('settings.projectColorSet', 11, ['blue'])).rejects.toThrow(/bad payload/)
  })

  it('passes the tab exit choice on as unknown for the service to check', async () => {
    const { ipc, calls } = projectSettingsSetup()
    await ipc.invoke('settings.tabExitSet', 11, [{ value: 'keep' }])
    await ipc.invoke('settings.tabExitSet', 12, [{ value: 3 }])
    expect(calls).toEqual([
      ['setTabExit', 'keep'],
      ['setTabExit', 3]
    ])
  })

  it('passes the session gist choice on as unknown for the service to check', async () => {
    const { ipc, calls } = projectSettingsSetup()
    await ipc.invoke('settings.sessionGistSet', 11, [{ value: true }])
    await ipc.invoke('settings.sessionGistSet', 12, [{ value: 'yes' }])
    expect(calls).toEqual([
      ['setSessionGist', true],
      ['setSessionGist', 'yes']
    ])
  })

  it('passes the zone auto-hide choice and the minimum terminal width on as unknown for the service to check', async () => {
    const { ipc, calls } = projectSettingsSetup()
    await ipc.invoke('settings.zoneAutoHideSet', 11, [{ value: false }])
    await ipc.invoke('settings.zoneAutoHideSet', 12, [{ value: 'no' }])
    await ipc.invoke('settings.minTerminalWidthSet', 11, [{ value: 800 }])
    await ipc.invoke('settings.minTerminalWidthSet', 12, [{ value: 'wide' }])
    expect(calls).toEqual([
      ['setZoneAutoHide', false],
      ['setZoneAutoHide', 'no'],
      ['setMinTerminalWidth', 800],
      ['setMinTerminalWidth', 'wide']
    ])
  })

  it('passes the Claude-tab-on-open choice on as unknown for the service to check', async () => {
    const { ipc, calls } = projectSettingsSetup()
    await ipc.invoke('settings.claudeTabOnOpenSet', 11, [{ value: false }])
    await ipc.invoke('settings.claudeTabOnOpenSet', 12, [{ value: 'no' }])
    expect(calls).toEqual([
      ['setClaudeTabOnOpen', false],
      ['setClaudeTabOnOpen', 'no']
    ])
  })

  it('passes a notification sounds change on as unknown for the service to check', async () => {
    const { ipc, calls } = projectSettingsSetup()
    await ipc.invoke('settings.notificationSoundsSet', 11, [{ value: false }])
    await ipc.invoke('settings.notificationSoundsSet', 12, [{ value: 'no' }])
    expect(calls).toEqual([
      ['setNotificationSounds', false],
      ['setNotificationSounds', 'no']
    ])
  })

  it('lists the notification sounds, and passes a pick and a bytes request on as unknown for main to check', async () => {
    const { ipc, calls } = projectSettingsSetup()
    expect(await ipc.invoke('settings.notificationSoundOptions', 11)).toEqual([
      { label: 'Built-in', sounds: [{ id: 'builtin:chime', name: 'Chime' }] }
    ])
    await ipc.invoke('settings.notificationSoundSet', 11, [{ value: 'system:0:freedesktop/stereo/bell.oga' }])
    await ipc.invoke('settings.notificationSoundSet', 12, [{ value: 42 }])
    // The id is all the page sends: never a path main would read as is.
    expect(await ipc.invoke('notify.soundData', 11, [{ id: 'system:0:../../etc/passwd' }])).toEqual({
      data: new Uint8Array([1, 2]),
      type: 'audio/wav'
    })
    await expect(ipc.invoke('notify.soundData', 11, [null])).rejects.toThrow(/bad payload/)
    expect(calls).toEqual([
      ['notificationSoundOptions'],
      ['setNotificationSound', 'system:0:freedesktop/stereo/bell.oga'],
      ['setNotificationSound', 42],
      ['notificationSoundData', 'system:0:../../etc/passwd']
    ])
  })

  it('answers the ask-before-close setting and passes a change on as unknown for the service to check', async () => {
    const { ipc, calls } = projectSettingsSetup()
    expect(await ipc.invoke('settings.confirmTabClose', 11)).toBe(false)
    await ipc.invoke('settings.confirmTabCloseSet', 11, [{ value: false }])
    await ipc.invoke('settings.confirmTabCloseSet', 12, [{ value: 'no' }])
    expect(calls).toEqual([
      ['confirmTabClose'],
      ['setConfirmTabClose', false],
      ['setConfirmTabClose', 'no']
    ])
  })

  it('passes the close button side on as unknown for the service to check', async () => {
    const { ipc, calls } = projectSettingsSetup()
    await ipc.invoke('settings.tabCloseSideSet', 11, [{ value: 'left' }])
    await ipc.invoke('settings.tabCloseSideSet', 12, [{ value: 7 }])
    expect(calls).toEqual([
      ['setTabCloseSide', 'left'],
      ['setTabCloseSide', 7]
    ])
  })

  it('passes a terminal font change or a reset on as unknown for the service to check', async () => {
    const { ipc, calls } = projectSettingsSetup()
    await ipc.invoke('settings.terminalFontSet', 11, [{ value: { size: 16 } }])
    await ipc.invoke('settings.terminalFontSet', 12, [{ value: null }])
    await ipc.invoke('settings.terminalFontSet', 12, [{ value: 'x' }])
    expect(calls).toEqual([
      ['setTerminalFont', { size: 16 }],
      ['setTerminalFont', null],
      ['setTerminalFont', 'x']
    ])
  })

  it('passes a window background change on as unknown for the service to check', async () => {
    const { ipc, calls } = projectSettingsSetup()
    await ipc.invoke('settings.windowBackgroundSet', 11, [{ value: { transparent: true } }])
    await ipc.invoke('settings.windowBackgroundSet', 12, [{ value: { opacity: 'x' } }])
    expect(calls).toEqual([
      ['setWindowBackground', { transparent: true }],
      ['setWindowBackground', { opacity: 'x' }]
    ])
  })

  it("passes the new-tab menu entries on as unknown, for the sender's project", async () => {
    const { ipc, calls } = projectSettingsSetup()
    await ipc.invoke('settings.tabCommandsSet', 11, [{ level: 'project', entries: [{ label: 'a', command: 'b' }], projectId: PROJECT_B }])
    await ipc.invoke('settings.tabCommandsSet', 12, [{ level: 'nope', entries: 'x' }])
    expect(calls).toEqual([
      ['setTabCommands', PROJECT_A, 'project', [{ label: 'a', command: 'b' }]],
      ['setTabCommands', PROJECT_B, 'nope', 'x']
    ])
  })

  it('passes the theme pick on as unknown for the service to check', async () => {
    const { ipc, calls } = projectSettingsSetup()
    await ipc.invoke('settings.themeSet', 11, [{ id: null }])
    await ipc.invoke('settings.themeSet', 11, [{ id: 7 }])
    expect(calls).toEqual([
      ['setTheme', null],
      ['setTheme', 7]
    ])
  })

  it('rejects a payload that is not an object', async () => {
    const { ipc } = projectSettingsSetup()
    await expect(ipc.invoke('settings.keySet', 11, ['nope'])).rejects.toThrow(/bad payload/)
    await expect(ipc.invoke('settings.projectPluginEnable', 11, [])).rejects.toThrow(/bad payload/)
  })
})

describe('registerCccCommandHandlers', () => {
  it('is for project windows only and passes no payload on', async () => {
    const { ipc, router } = setup()
    const view = { state: 'missing' as const, linkPath: '/h/.local/bin/ccc', target: '/d/bin/ccc', binDir: '/h/.local/bin', onPath: false, offerAtStart: true }
    const calls: string[] = []
    registerCccCommandHandlers(router, {
      status: () => (calls.push('status'), view),
      install: async () => (calls.push('install'), { ...view, state: 'installed' }),
      setOffer: (v) => void calls.push(`offer ${v}`),
      offer: () => null
    })
    await expect(ipc.invoke('settings.cccInstall', 13, [{}])).rejects.toThrow(/not a project window/)
    expect(calls).toEqual([])
    expect(await ipc.invoke('settings.cccStatus', 11)).toEqual(view)
    expect(await ipc.invoke('settings.cccInstall', 11, [{ path: '/etc/passwd' }])).toMatchObject({ state: 'installed' })
    expect(calls).toEqual(['status', 'install'])
  })
})

describe('registerUpdateHandlers', () => {
  function updateSetup(): { ipc: FakeIpcMain; calls: unknown[][] } {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    registerUpdateHandlers(router, {
      state: () => (calls.push(['state']), { current: '1.0.0', enabled: true, available: null }),
      setEnabled: (value) => void calls.push(['setEnabled', value]),
      dismiss: (...args) => void calls.push(['dismiss', ...args]),
      openRelease: (...args) => void calls.push(['openRelease', ...args])
    })
    return { ipc, calls }
  }

  it('accepts only a boolean for setEnabled, and the picker is refused', async () => {
    const { ipc, calls } = updateSetup()
    await expect(ipc.invoke('updates.setEnabled', 13, [{ value: true }])).rejects.toThrow(/not a project window/)
    for (const bad of [undefined, {}, { value: 'false' }, { value: 0 }, { value: null }]) {
      await expect(ipc.invoke('updates.setEnabled', 11, bad === undefined ? [] : [bad])).rejects.toThrow(/boolean/)
    }
    expect(calls).toEqual([])
    await ipc.invoke('updates.setEnabled', 11, [{ value: false }])
    expect(calls).toEqual([['setEnabled', false]])
  })

  it('dismiss passes on a string version and drops anything else without an error', async () => {
    const { ipc, calls } = updateSetup()
    for (const bad of [[], [null], ['9.9.9'], [{}], [{ version: 9 }], [{ version: null }], [{ version: ['9.9.9'] }], [{ version: { toString: '9.9.9' } }]]) {
      await expect(ipc.invoke('updates.dismiss', 11, bad)).resolves.toBeUndefined()
    }
    expect(calls).toEqual([])
    await ipc.invoke('updates.dismiss', 11, [{ version: '9.9.9' }])
    expect(calls).toEqual([['dismiss', '9.9.9']])
  })

  it('ignores any payload on openRelease', async () => {
    const { ipc, calls } = updateSetup()
    await ipc.invoke('updates.openRelease', 11, [{ url: 'https://evil.example' }])
    expect(calls).toEqual([['openRelease']])
  })
})

describe('registerOverlayHandlers', () => {
  function overlaySetup(): { ipc: FakeIpcMain; calls: unknown[][] } {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    registerOverlayHandlers(router, {
      list: (windowId) => {
        calls.push(['list', windowId])
        return []
      },
      close: (windowId, overlayId) => {
        calls.push(['close', windowId, overlayId])
        return true
      },
      input: (windowId, overlayId, data) => calls.push(['input', windowId, overlayId, data]),
      resize: (windowId, overlayId, cols, rows) =>
        calls.push(['resize', windowId, overlayId, cols, rows]),
      ack: (windowId, overlayId, count) => calls.push(['ack', windowId, overlayId, count]),
      setBounds: (windowId, overlayId, bounds) => calls.push(['bounds', windowId, overlayId, bounds]),
      result: (windowId, overlayId, value) => {
        calls.push(['result', windowId, overlayId, value])
        return true
      },
      message: (windowId, overlayId, text) => {
        calls.push(['message', windowId, overlayId, text])
        return true
      },
      ready: (windowId, overlayId) => {
        calls.push(['ready', windowId, overlayId])
      },
      loaded: (windowId, overlayId) => {
        calls.push(['loaded', windowId, overlayId])
      },
      button: (windowId, overlayId, click) => {
        calls.push(['button', windowId, overlayId, click])
        return true
      },
      discuss: (windowId, overlayId, target, note) => {
        calls.push(['discuss', windowId, overlayId, target, note])
        return Promise.resolve({ ok: true, tabId: 't1', queued: false })
      }
    })
    return { ipc, calls }
  }

  it('acts on the sender’s window, whatever the payload names', async () => {
    const { ipc, calls } = overlaySetup()
    await ipc.invoke('overlays.list', 11, [{ windowId: 2 }])
    await ipc.invoke('overlays.close', 12, [{ overlayId: 'o1', windowId: 1 }])
    await ipc.invoke('overlays.input', 11, [{ overlayId: 'o1', data: 'x' }])
    await ipc.invoke('overlays.resize', 11, [{ overlayId: 'o1', cols: 80, rows: 24 }])
    await ipc.invoke('overlays.ack', 11, [{ overlayId: 'o1', count: 3 }])
    await ipc.invoke('overlays.bounds', 12, [{ overlayId: 'o2', x: 0, y: 30, width: 10, height: 20 }])
    await ipc.invoke('overlays.result', 12, [{ overlayId: 'o2', value: { a: 1 } }])
    await ipc.invoke('overlays.message', 12, [{ overlayId: 'o2', message: '{"n":1}', windowId: 1 }])
    await ipc.invoke('overlays.ready', 11, [{ overlayId: 'o1', windowId: 2 }])
    await ipc.invoke('overlays.loaded', 12, [{ overlayId: 'o2', windowId: 1 }])
    await ipc.invoke('overlays.button', 11, [{ overlayId: 'o1', source: 'opener', buttonId: 'b', pluginId: 'x', windowId: 2 }])
    await ipc.invoke('overlays.button', 12, [{ overlayId: 'o2', source: 'type', pluginId: 'p.one', buttonId: 'edit' }])
    await ipc.invoke('overlays.discuss', 11, [{ overlayId: 'o1', target: { kind: 'tab', tabId: 't1', windowId: 2 }, note: 'hi' }])
    await ipc.invoke('overlays.discuss', 12, [{ overlayId: 'o2', target: { kind: 'new', tabId: 'x' }, note: '' }])
    expect(calls).toEqual([
      ['list', 1],
      ['close', 2, 'o1'],
      ['input', 1, 'o1', 'x'],
      ['resize', 1, 'o1', 80, 24],
      ['ack', 1, 'o1', 3],
      ['bounds', 2, 'o2', { x: 0, y: 30, width: 10, height: 20 }],
      ['result', 2, 'o2', { a: 1 }],
      ['message', 2, 'o2', '{"n":1}'],
      ['ready', 1, 'o1'],
      ['loaded', 2, 'o2'],
      // An opener click carries no plugin id: the opener is the overlay's own.
      ['button', 1, 'o1', { source: 'opener', buttonId: 'b' }],
      ['button', 2, 'o2', { source: 'type', pluginId: 'p.one', buttonId: 'edit' }],
      // A clean target: only the fields of its kind.
      ['discuss', 1, 'o1', { kind: 'tab', tabId: 't1' }, 'hi'],
      ['discuss', 2, 'o2', { kind: 'new' }, '']
    ])
  })

  it('refuses the picker, unknown senders and malformed payloads', async () => {
    const { ipc, calls } = overlaySetup()
    for (const sender of [13, 99]) {
      await expect(ipc.invoke('overlays.list', sender)).rejects.toThrow()
      await expect(ipc.invoke('overlays.close', sender, [{ overlayId: 'o' }])).rejects.toThrow()
    }
    const bad: Array<[string, unknown[]]> = [
      ['overlays.close', []],
      ['overlays.close', [{ overlayId: 5 }]],
      ['overlays.input', [{ overlayId: 'o', data: 5 }]],
      ['overlays.resize', [{ overlayId: 'o', cols: '80', rows: 24 }]],
      ['overlays.ack', [{ overlayId: 'o', count: '3' }]],
      ['overlays.bounds', [{ overlayId: 'o', x: 0, y: 0, width: '1', height: 1 }]],
      ['overlays.result', [{ value: 1 }]],
      ['overlays.message', [{ overlayId: 'o', message: { n: 1 } }]],
      ['overlays.message', [{ message: '{}' }]],
      ['overlays.ready', [{ overlayId: 7 }]],
      ['overlays.loaded', [{ overlayId: 7 }]],
      ['overlays.loaded', []],
      ['overlays.button', [{ overlayId: 'o', source: 'opener', buttonId: 5 }]],
      ['overlays.button', [{ overlayId: 'o', source: 'type', buttonId: 'b' }]],
      ['overlays.button', [{ overlayId: 'o', source: 'page', buttonId: 'b' }]],
      ['overlays.button', [{ source: 'opener', buttonId: 'b' }]],
      ['overlays.discuss', [{ overlayId: 'o', target: { kind: 'new' } }]],
      ['overlays.discuss', [{ overlayId: 'o', target: { kind: 'tab' }, note: '' }]],
      ['overlays.discuss', [{ overlayId: 'o', target: 'new', note: '' }]],
      ['overlays.discuss', [{ target: { kind: 'new' }, note: '' }]]
    ]
    for (const [channel, args] of bad) {
      await expect(ipc.invoke(channel, 11, args), channel).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })
})
