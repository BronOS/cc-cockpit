import { describe, expect, it } from 'vitest'
import {
  appPageMatcher,
  IpcRouter,
  registerCoreHandlers,
  registerLayoutHandlers,
  registerOverlayHandlers,
  registerPanelHandlers,
  registerSlotHandlers,
  registerPageTabHandlers,
  registerSettingsPageHandlers,
  registerCccCommandHandlers,
  registerClaudeCodeHandlers,
  registerWebAccessHandlers,
  registerRemoteServerHandlers,
  registerNoticeHandlers,
  registerOAuthPasteHandlers,
  registerUpdateHandlers,
  registerProjectSettingsHandlers,
  registerSessionHandlers,
  registerSettingsHandlers,
  registerServiceHandlers,
  registerTabHandlers,
  registerGroupHandlers,
  type GroupHandlerDeps,
  registerWebviewHandlers,
  webUrlOf,
  type ProjectSettingsHandlerDeps,
  type SettingsHandlerDeps,
  type CoreHandlerDeps,
  type IpcEventLike,
  type IpcMainLike,
  type TabHandlerDeps,
  type WebAccessHandlerOptions,
  type RemoteServerHandlerDeps,
  webCaller
} from '../../src/main/ipc/router'
import { registerRoomStripHandlers } from '../../src/main/ipc/room-handlers'
import type { SenderContext } from '../../src/main/windows/window-manager'
import type { OpenTarget } from '../../src/main/external/open-external'
import { BUILTIN_THEMES } from '../../src/main/themes/theme-service'
import { ServiceChoices } from '../../src/main/plugins/service-choices'
import type { ServicePlugin, ServicesStatus } from '../../src/shared/services'
import { defaultLayout } from '../../src/shared/layout'
import { DEFAULT_TERMINAL_FONT } from '../../src/shared/terminal-font'
import { REMOTE_SECRETS_UNAVAILABLE_TEXT, type WebAccessIndicator, type WebAccessView } from '../../src/shared/web-access'
import type { ProjectView } from '../../src/shared/types'
import { OAUTH_PASTE_REFUSED } from '../../src/shared/oauth-paste'
import { REMOTE_CLASS, type ClaudeCodeView, type InvokeChannel, type TabInfo } from '../../src/shared/ipc'
import { OverlayManager, type OverlayChannel } from '../../src/main/overlays/overlay-manager'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

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

function setup(): { ipc: FakeIpcMain; router: IpcRouter; logs: string[]; open: Map<number, string> } {
  const ipc = new FakeIpcMain()
  const logs: string[] = []
  // Which project each open project window holds; a test deletes or rebinds an entry to close a window.
  const open = new Map<number, string>([
    [1, PROJECT_A],
    [2, PROJECT_B]
  ])
  const router = new IpcRouter(
    ipc,
    (id) => senders.get(id),
    appPageMatcher({ kind: 'file', path: APP_FILE }),
    (m) => logs.push(m),
    (windowId, projectId) => open.get(windowId) === projectId
  )
  return { ipc, router, logs, open }
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

describe('IpcRouter callers and views', () => {
  const A_CTX = { kind: 'project', windowId: 1, projectId: PROJECT_A } as const

  it('gives a desktop caller its window\'s desktop view, unchanged checks otherwise', async () => {
    const { ipc, router } = setup()
    const seen: unknown[] = []
    router.handleProject('tabs.list', (ctx, _payload, view) => {
      seen.push(ctx, view)
      return []
    })
    await ipc.invoke('tabs.list', 11)
    expect(seen).toEqual([
      { windowId: 1, projectId: PROJECT_A },
      { viewId: 'desktop:1', who: 'owner', remote: false }
    ])
    // A `no`-class channel stays open to the desktop: the class only limits remote views.
    router.handleWindow('projects.openFolder', () => true)
    await expect(ipc.invoke('projects.openFolder', 11)).resolves.toBe(true)
  })

  it('resolves a web caller to its bound window and view', async () => {
    const { router } = setup()
    const seen: unknown[] = []
    router.handleProject('tabs.list', (ctx, _payload, view) => {
      seen.push(ctx, view)
      return []
    })
    router.handleWindow('window.info', (ctx, _payload, view) => {
      seen.push(ctx, view)
      return { kind: 'picker', home: '/h' }
    })
    const caller = webCaller(A_CTX, 'web:7', 'owner')
    await expect(router.dispatch(caller, 'tabs.list', undefined)).resolves.toEqual([])
    await router.dispatch(caller, 'window.info', undefined)
    const view = { viewId: 'web:7', who: 'owner', remote: true }
    expect(seen).toEqual([{ windowId: 1, projectId: PROJECT_A }, view, A_CTX, view])
  })

  it('ignores a window, project or view named in a web payload', async () => {
    const { router } = setup()
    const seen: unknown[] = []
    router.handleProject('tabs.list', (ctx, payload, view) => {
      seen.push(ctx, payload, view)
      return []
    })
    const forged = { windowId: 2, projectId: PROJECT_B, viewId: 'web:99', kind: 'electron', who: 'x' }
    await router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'tabs.list', forged)
    expect(seen[0]).toEqual({ windowId: 1, projectId: PROJECT_A })
    expect(seen[1]).toEqual(forged)
    expect(seen[2]).toEqual({ viewId: 'web:1', who: 'owner', remote: true })
  })

  it('refuses a no-class channel from a web caller before the handler', async () => {
    const { router, logs } = setup()
    let calls = 0
    router.handleWindow('projects.openFolder', () => {
      calls++
      return true
    })
    router.handleProject('window.reopen', () => {
      calls++
    })
    const caller = webCaller(A_CTX, 'web:1', 'owner')
    await expect(router.dispatch(caller, 'projects.openFolder', undefined)).rejects.toThrow(/refused/)
    await expect(router.dispatch(caller, 'window.reopen', undefined)).rejects.toThrow(/refused/)
    expect(calls).toBe(0)
    expect(logs.join('\n')).toMatch(/remote views may not call \(view web:1\)/)
  })

  it('refuses unknown and inherited channel names from a web caller', async () => {
    const { router } = setup()
    const caller = webCaller(A_CTX, 'web:1', 'owner')
    for (const channel of ['nope', '__proto__', 'toString', 'constructor', '']) {
      await expect(router.dispatch(caller, channel, undefined)).rejects.toThrow(/refused/)
    }
    // A `yes` channel with no handler registered is an error, not a crash.
    await expect(router.dispatch(caller, 'tabs.list', undefined)).rejects.toThrow(/no handler/)
  })

  it('refuses a web caller whose window closed or now holds another project', async () => {
    const { router, logs, open } = setup()
    let calls = 0
    router.handleProject('tabs.list', () => {
      calls++
      return []
    })
    router.handleWindow('window.info', () => {
      calls++
      return { kind: 'picker', home: '/h' }
    })
    const caller = webCaller(A_CTX, 'web:1', 'owner')
    await expect(router.dispatch(caller, 'tabs.list', undefined)).resolves.toEqual([])
    expect(calls).toBe(1)
    // The socket outlived its window: every later frame is refused, not run with the stale binding.
    open.delete(1)
    await expect(router.dispatch(caller, 'tabs.list', undefined)).rejects.toThrow(/refused/)
    await expect(router.dispatch(caller, 'window.info', undefined)).rejects.toThrow(/refused/)
    // The same window id now holding another project does not revive the binding.
    open.set(1, PROJECT_B)
    await expect(router.dispatch(caller, 'tabs.list', undefined)).rejects.toThrow(/refused/)
    expect(calls).toBe(1)
    expect(logs.join('\n')).toMatch(/window 1 of remote view web:1 is closed/)
  })

  it('refuses every web call when no window check was given', async () => {
    const isApp = appPageMatcher({ kind: 'file', path: APP_FILE })
    const router = new IpcRouter(new FakeIpcMain(), (id) => senders.get(id), isApp, () => {})
    router.handleProject('tabs.list', () => [])
    await expect(router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'tabs.list', undefined)).rejects.toThrow(/refused/)
  })

  it('rejects a throwing handler as a promise, as ipcMain does', async () => {
    const { router } = setup()
    router.handleProject('tabs.list', () => {
      throw new Error('boom')
    })
    await expect(router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'tabs.list', undefined)).rejects.toThrow('boom')
  })

  it('refuses a second handler for one channel', () => {
    const { router } = setup()
    router.handleProject('tabs.list', () => [])
    expect(() => router.handleProject('tabs.list', () => [])).toThrow(/second handler/)
  })

  it('builds only frozen web callers bound to a project window and a remote view id', () => {
    expect(() => webCaller(A_CTX, 'desktop:1', 'owner')).toThrow(/remote view id/)
    expect(() => webCaller(A_CTX, 'web:0', 'owner')).toThrow(/remote view id/)
    expect(() =>
      webCaller({ kind: 'picker', windowId: 3 } as unknown as typeof A_CTX, 'web:1', 'owner')
    ).toThrow(/project window/)
    const caller = webCaller(A_CTX, 'web:2', 'owner')
    expect(caller).toEqual({ kind: 'web', context: A_CTX, viewId: 'web:2', who: 'owner' })
    expect(Object.isFrozen(caller)).toBe(true)
    expect(Object.isFrozen(caller.context)).toBe(true)
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
    router: IpcRouter
    targets: OpenTarget[]
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
    const targets: OpenTarget[] = []
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
      openExternal: (url, target) => {
        external.push(url)
        targets.push(target)
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
    return { ipc, router, targets, opened, dialogs, external, relinked, forgotten, ran, pickers }
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

  // docs/design-overlay-views.md §5: server mode's desktop page is the hidden page and loads no perView copy.
  it('window.info marks the hidden page in server mode only, from the view main bound, never a browser view', async () => {
    const server = core({ server: true })
    expect(await server.ipc.invoke('window.info', 12, [{ projectId: PROJECT_A }])).toMatchObject({ kind: 'project', hiddenPage: true })
    const web = await server.router.dispatch(webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:3', 'owner'), 'window.info', undefined)
    expect(web).not.toHaveProperty('hiddenPage')
    expect(await core().ipc.invoke('window.info', 12, [{ projectId: PROJECT_A }])).not.toHaveProperty('hiddenPage')
    expect(await server.ipc.invoke('window.info', 13)).not.toHaveProperty('hiddenPage')
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

  it("commands.run names a remote caller's view to the host, none for the desktop's", async () => {
    const seen: unknown[][] = []
    const { ipc, router } = core({
      runCommand: async (projectId, id, view) => {
        seen.push([projectId, id, view])
      }
    })
    await ipc.invoke('commands.run', 11, [{ id: 'a.one/refresh', view: 'web:9' }])
    await router.dispatch(webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:4', 'owner'), 'commands.run', {
      id: 'a.one/refresh',
      view: 'web:9'
    })
    expect(seen).toEqual([
      [PROJECT_A, 'a.one/refresh', undefined],
      [PROJECT_A, 'a.one/refresh', 'web:4']
    ])
  })

  it("commands.run passes the host's refusal back to the renderer", async () => {
    const { ipc } = core({
      runCommand: async (_projectId, id) => {
        throw new Error(`unknown command: ${id}`)
      }
    })
    await expect(ipc.invoke('commands.run', 11, [{ id: 'a.one/nope' }])).rejects.toThrow('unknown command: a.one/nope')
  })

  it('theme.get answers every window kind, for the calling view (design-web.md §5.7)', async () => {
    const asked: string[] = []
    const { ipc, router } = core({
      currentTheme: (viewId) => {
        asked.push(viewId)
        return viewId.startsWith('web:') ? BUILTIN_THEMES[1]! : BUILTIN_THEMES[0]!
      }
    })
    await expect(ipc.invoke('theme.get', 11)).resolves.toBe(BUILTIN_THEMES[0])
    await expect(ipc.invoke('theme.get', 13)).resolves.toBe(BUILTIN_THEMES[0])
    // A browser view of window 1: answered by main's binding, never a view named in the payload.
    const caller = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:5', 'owner')
    await expect(router.dispatch(caller, 'theme.get', { viewId: 'desktop:1' })).resolves.toBe(BUILTIN_THEMES[1])
    expect(asked).toEqual(['desktop:1', 'desktop:3', 'web:5'])
  })

  it('theme.scheme is taken from a remote view only, and only as a boolean', async () => {
    const schemes: Array<[string, boolean]> = []
    const { ipc, router } = core({ setViewScheme: (viewId, dark) => schemes.push([viewId, dark]) })
    const caller = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:5', 'owner')
    await router.dispatch(caller, 'theme.scheme', { dark: true, viewId: 'web:9' })
    // The desktop page follows nativeTheme: its report is ignored, not an error.
    await expect(ipc.invoke('theme.scheme', 11, [{ dark: true }])).resolves.toBeUndefined()
    await expect(router.dispatch(caller, 'theme.scheme', { dark: 'yes' })).rejects.toThrow(/dark must be a boolean/)
    await expect(router.dispatch(caller, 'theme.scheme', undefined)).rejects.toThrow(/bad payload/)
    expect(schemes).toEqual([['web:5', true]])
  })

  it('prefs.get answers every window kind with the shell prefs', async () => {
    const { ipc } = core()
    const prefs = { tabCloseSide: 'left', zoneAutoHide: true, minTerminalWidth: 720, terminalFont: { ...DEFAULT_TERMINAL_FONT, size: 20 }, backgroundOpacity: 70, seeThroughArea: 'main' }
    await expect(ipc.invoke('prefs.get', 11)).resolves.toEqual(prefs)
    await expect(ipc.invoke('prefs.get', 13)).resolves.toEqual(prefs)
  })

  it('app.openExternal hands http and https links, normalized, from any window to the adapter for the caller\'s view', async () => {
    const { ipc, external, targets } = core()
    await ipc.invoke('app.openExternal', 11, [{ url: 'https://example.com/a b?x=1#h' }])
    await ipc.invoke('app.openExternal', 13, [{ url: 'http://localhost:3000' }])
    expect(external).toEqual(['https://example.com/a%20b?x=1#h', 'http://localhost:3000/'])
    expect(targets).toEqual([
      { windowId: 1, viewId: 'desktop:1' },
      { windowId: 3, viewId: 'desktop:3' }
    ])
  })

  it('app.openExternal from a remote view names that view and its window, as the router bound them', async () => {
    const { router, external, targets } = core()
    await router.dispatch(webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:3', 'owner'), 'app.openExternal', { url: 'https://example.com/x', viewId: 'web:9', windowId: 2 })
    expect(external).toEqual(['https://example.com/x'])
    // The payload's window and view are ignored: the adapter decides by what the router bound.
    expect(targets).toEqual([{ windowId: 1, viewId: 'web:3' }])
    // The same checks as the desktop's: a bad scheme is refused before the adapter is asked.
    await expect(router.dispatch(webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:3', 'owner'), 'app.openExternal', { url: 'file:///etc/passwd' })).rejects.toThrow(/app\.openExternal/)
    expect(targets).toHaveLength(1)
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

  // design-web.md §9.8: a server's browser view closes the window main bound it to, for every device.
  describe('projects.close', () => {
    function closing(server: boolean | undefined): { ipc: FakeIpcMain; router: IpcRouter; closed: string[] } {
      const closed: string[] = []
      const { ipc, router } = core({
        ...(server === undefined ? {} : { server }),
        closeProjectWindow: (windowId, viewId) => {
          closed.push(`${windowId}:${viewId}`)
        }
      })
      return { ipc, router, closed }
    }
    const webA = (viewId: `web:${number}` = 'web:3') => webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, viewId, 'owner')

    it('in server mode closes the window the remote view is bound to', async () => {
      const { router, closed } = closing(true)
      await router.dispatch(webA(), 'projects.close', undefined)
      expect(closed).toEqual(['1:web:3'])
    })

    it('ignores a payload that names another project or window: only the caller\'s window closes', async () => {
      const { router, closed } = closing(true)
      await router.dispatch(webA('web:5'), 'projects.close', { projectId: PROJECT_B, windowId: 2, id: PROJECT_B })
      expect(closed).toEqual(['1:web:5'])
    })

    it('refuses a remote view on the desktop (no server flag, or server false)', async () => {
      for (const server of [undefined, false]) {
        const { router, closed } = closing(server)
        await expect(router.dispatch(webA(), 'projects.close', undefined)).rejects.toThrow(/projects\.close/)
        expect(closed).toEqual([])
      }
    })

    it('refuses the desktop page, server mode or not (it is no browser view)', async () => {
      for (const server of [true, false]) {
        const { ipc, closed } = closing(server)
        await expect(ipc.invoke('projects.close', 11)).rejects.toThrow(/projects\.close/)
        expect(closed).toEqual([])
      }
    })

    it('refuses the picker and a remote view whose window is gone', async () => {
      const { ipc, router, closed } = closing(true)
      await expect(ipc.invoke('projects.close', 13)).rejects.toThrow(/not a project window/)
      // A view bound to a window that now holds another project: the router refuses before the handler.
      await expect(router.dispatch(webCaller({ kind: 'project', windowId: 2, projectId: PROJECT_A }, 'web:4', 'owner'), 'projects.close', undefined)).rejects.toThrow(/refused/)
      expect(closed).toEqual([])
    })

    it('refuses in server mode when main gave no way to close', async () => {
      const { router } = core({ server: true })
      await expect(router.dispatch(webA(), 'projects.close', undefined)).rejects.toThrow(/projects\.close/)
    })
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
  function tabsSetup(): { ipc: FakeIpcMain; router: IpcRouter; calls: unknown[][] } {
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
      flag: rec('flag', { color: 'red' }) as TabHandlerDeps['flag'],
      toggleFlag: rec('toggleFlag', null) as TabHandlerDeps['toggleFlag'],
      restart: rec('restart', info) as TabHandlerDeps['restart'],
      input: rec('input') as TabHandlerDeps['input'],
      resize: rec('resize') as TabHandlerDeps['resize'],
      fit: rec('fit', true) as TabHandlerDeps['fit'],
      visible: rec('visible') as TabHandlerDeps['visible'],
      ack: rec('ack') as TabHandlerDeps['ack'],
      screen: rec('screen') as TabHandlerDeps['screen'],
      select: rec('select') as TabHandlerDeps['select'],
      list: rec('list', [info]) as TabHandlerDeps['list'],
      viewAck: rec('viewAck') as TabHandlerDeps['viewAck'],
      viewSelect: rec('viewSelect') as TabHandlerDeps['viewSelect']
    })
    return { ipc, router, calls }
  }

  it('answers a remote view with the plain list, its own ack and a terminal join; the desktop as before', async () => {
    const { ipc, router, calls } = tabsSetup()
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:3', 'owner')
    // Never the desktop's re-attach (it resets or resyncs the desktop's terminals and runs the restore).
    await expect(router.dispatch(web, 'tabs.list', undefined)).resolves.toEqual([{ id: 't1', kind: 'shell', cwd: '/work/a' }])
    await router.dispatch(web, 'tabs.ack', { tabId: 't1', count: 7 })
    await router.dispatch(web, 'tabs.selected', { tabId: 't1' })
    await ipc.invoke('tabs.ack', 11, [{ tabId: 't1', count: 5 }])
    await ipc.invoke('tabs.selected', 11, [{ tabId: 't1' }])
    expect(calls).toEqual([
      ['list', PROJECT_A],
      // The remote ack never reaches TabManager (the pty's or the desktop's flow).
      ['viewAck', 'web:3', 't1', 7],
      ['select', PROJECT_A, 't1', 'web:3'],
      ['viewSelect', 'web:3', 't1'],
      ['ack', PROJECT_A, 't1', 5],
      ['select', PROJECT_A, 't1', 'desktop:1']
    ])
    await expect(router.dispatch(web, 'tabs.ack', { tabId: 't1', count: 'x' })).rejects.toThrow(/count/)
  })

  it('tabs.screen: the desktop page\'s answer, shape-checked, on its own project; a remote view is refused', async () => {
    const { ipc, router, calls } = tabsSetup()
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:3', 'owner')
    await expect(router.dispatch(web, 'tabs.screen', { tabId: 't1', id: 1, screen: { cols: 80, rows: 24, data: 'x' } })).rejects.toThrow(/refused/)
    await ipc.invoke('tabs.screen', 11, [{ tabId: 't1', id: 1, screen: { cols: 80, rows: 24, data: 'x', extra: 1 }, other: 2 }])
    await ipc.invoke('tabs.screen', 11, [{ tabId: 't1', id: 2, busy: true }])
    await ipc.invoke('tabs.screen', 11, [{ tabId: 't1', id: 3 }])
    await expect(ipc.invoke('tabs.screen', 11, [{ tabId: 't1', id: 'x' }])).rejects.toThrow(/id/)
    await expect(ipc.invoke('tabs.screen', 11, [{ tabId: 't1', id: 4, screen: { cols: 80, rows: 24, data: 5 } }])).rejects.toThrow(/bad screen/)
    await expect(ipc.invoke('tabs.screen', 11, [{ tabId: 't1', id: 4, screen: 'x' }])).rejects.toThrow(/bad screen/)
    expect(calls).toEqual([
      ['screen', PROJECT_A, 't1', { id: 1, screen: { cols: 80, rows: 24, data: 'x' } }],
      ['screen', PROJECT_A, 't1', { id: 2, busy: true }],
      ['screen', PROJECT_A, 't1', { id: 3 }]
    ])
  })

  it("keys terminal sizes, fits, visibility and input by the caller's own view, never one from the payload", async () => {
    const { ipc, router, calls } = tabsSetup()
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:3', 'owner')
    await router.dispatch(web, 'tabs.resize', { tabId: 't1', cols: 40, rows: 20, viewId: 'desktop:1' })
    await router.dispatch(web, 'tabs.input', { tabId: 't1', data: 'x', viewId: 'desktop:1' })
    await expect(router.dispatch(web, 'tabs.fit', { tabId: 't1', viewId: 'desktop:1' })).resolves.toBe(true)
    await router.dispatch(web, 'tabs.visibility', { visible: false, viewId: 'desktop:1' })
    await expect(ipc.invoke('tabs.fit', 12, [{ tabId: 't1', viewId: 'web:3' }])).resolves.toBe(true)
    await ipc.invoke('tabs.visibility', 11, [{ visible: true }])
    expect(calls).toEqual([
      ['resize', PROJECT_A, 't1', 40, 20, 'web:3'],
      ['input', PROJECT_A, 't1', 'x', 'web:3'],
      ['fit', PROJECT_A, 't1', 'web:3'],
      ['visible', 'web:3', false],
      ['fit', PROJECT_B, 't1', 'desktop:2'],
      ['visible', 'desktop:1', true]
    ])
  })

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
      // The tabs before the attach: the ones it restores are announced to the other views.
      ['list', PROJECT_A],
      ['attach', PROJECT_A, 1],
      ['create', PROJECT_B, { kind: 'claude', cwd: 'sub' }, 2],
      // The closing tab's generation, for the window's other views (TabHandlerDeps.others).
      ['list', PROJECT_A],
      ['close', PROJECT_A, 't1'],
      ['reorder', PROJECT_A, 't1', 2, false],
      // The index main applied, for the other views (`tabs.moved`).
      ['list', PROJECT_A],
      // Each followed by the tab as stored, announced to the window's other views.
      ['rename', PROJECT_A, 't1', 'Mine'],
      ['list', PROJECT_A],
      ['rename', PROJECT_A, 't1', null],
      ['list', PROJECT_A],
      ['restart', PROJECT_B, 't1', 2],
      ['input', PROJECT_A, 't1', 'ls\r', 'desktop:1'],
      ['resize', PROJECT_A, 't1', 80, 24, 'desktop:1'],
      ['ack', PROJECT_A, 't1', 5],
      ['select', PROJECT_B, 't1', 'desktop:2']
    ])
  })

  it("flags only the sender's project's tab: the payload's project is ignored, the patch goes to main's check as sent", async () => {
    const { ipc, calls } = tabsSetup()
    await expect(ipc.invoke('tabs.flag', 12, [{ tabId: 't1', flag: { color: 'red', note: 'n' }, projectId: PROJECT_A }])).resolves.toEqual({ color: 'red' })
    await ipc.invoke('tabs.flag', 11, [{ tabId: 't1', flag: null }])
    await expect(ipc.invoke('tabs.toggleFlag', 11, [{ tabId: 't1', projectId: PROJECT_B }])).resolves.toBeNull()
    expect(calls).toEqual([
      // Each followed by the tab as stored, announced to the window's other views.
      ['flag', PROJECT_B, 't1', { color: 'red', note: 'n' }],
      ['list', PROJECT_B],
      ['flag', PROJECT_A, 't1', null],
      ['list', PROJECT_A],
      ['toggleFlag', PROJECT_A, 't1'],
      ['list', PROJECT_A]
    ])
  })

  it('takes a flag from the shell page\'s top frame only: a plugin panel (a subframe) never reaches the manager', async () => {
    const { ipc, calls } = tabsSetup()
    await expect(ipc.invoke('tabs.flag', 11, [{ tabId: 't1', flag: { color: 'red' } }], { parent: {}, url: APP_PAGE })).rejects.toThrow(/refused/)
    await expect(ipc.invoke('tabs.toggleFlag', 11, [{ tabId: 't1' }], { parent: {}, url: APP_PAGE })).rejects.toThrow(/refused/)
    await expect(ipc.invoke('tabs.flag', 11, [{ tabId: 't1', flag: { color: 'red' } }], { parent: null, url: 'cc-plugin://example.plugin/panel.html' })).rejects.toThrow()
    await expect(ipc.invoke('tabs.flag', 13, [{ tabId: 't1', flag: { color: 'red' } }])).rejects.toThrow()
    expect(calls).toEqual([])
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

  it('passes a checked beside (split right / down) and the reorder block flag, nothing else', async () => {
    const { ipc, router, calls } = tabsSetup()
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:3', 'owner')
    await ipc.invoke('tabs.create', 11, [{ kind: 'shell', beside: { tabId: 't0', edge: 'down', extra: 1 } }])
    await router.dispatch(web, 'tabs.create', { kind: 'command', level: 'app', entryId: 'e1', beside: { tabId: 't0', edge: 'right' } })
    await ipc.invoke('tabs.reorder', 12, [{ tabId: 't1', toIndex: 0, block: true }])
    expect(calls).toEqual([
      ['create', PROJECT_A, { kind: 'shell', beside: { tabId: 't0', edge: 'down' } }, 1],
      ['create', PROJECT_A, { kind: 'command', level: 'app', entryId: 'e1', beside: { tabId: 't0', edge: 'right' } }, 1],
      ['reorder', PROJECT_B, 't1', 0, true],
      ['list', PROJECT_B]
    ])
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
      ['tabs.close', [{ tabId: 't1', discard: 'yes' }]],
      ['tabs.reorder', [{ tabId: 't1', toIndex: 'first' }]],
      ['tabs.reorder', [{ tabId: 't1', toIndex: 1.5 }]],
      ['tabs.reorder', [{ tabId: 't1', toIndex: 1, block: 'yes' }]],
      ['tabs.create', [{ kind: 'shell', beside: 't1' }]],
      ['tabs.create', [{ kind: 'shell', beside: { tabId: 5, edge: 'right' } }]],
      ['tabs.create', [{ kind: 'shell', beside: { tabId: 't1', edge: 'diagonal' } }]],
      ['tabs.create', [{ kind: 'command', level: 'app', entryId: 'e', beside: { tabId: 't1' } }]],
      ['tabs.rename', [{ tabId: 't1', name: 5 }]],
      ['tabs.flag', [{ tabId: 't1' }]],
      ['tabs.flag', [{ flag: null }]],
      ['tabs.toggleFlag', [{ tabId: 5 }]],
      ['tabs.restart', [{}]],
      ['tabs.input', [{ tabId: 't1', data: 5 }]],
      ['tabs.resize', [{ tabId: 't1', cols: '80', rows: 24 }]],
      ['tabs.ack', [{ tabId: 't1', count: '5' }]],
      ['tabs.selected', [{ tabId: 3 }]],
      ['tabs.selected', []],
      ['tabs.fit', [{}]],
      ['tabs.fit', [{ tabId: 5 }]],
      ['tabs.visibility', [{ visible: 'no' }]],
      ['tabs.visibility', []]
    ]
    for (const [channel, args] of bad) {
      await expect(ipc.invoke(channel, 11, args), channel).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })

  it("leaves a page tab some view reported dirty open unless the close says the person chose to discard", async () => {
    // tabsSetup has no pageUnsaved (as other handlers' tests): a router of its own here.
    const { ipc, calls } = tabsSetup()
    const fresh = setup()
    const closes: string[] = []
    const unsaved = new Set(['dirty'])
    registerTabHandlers(fresh.router, {
      attach: () => [],
      list: () => [],
      create: () => null,
      commands: () => ({ app: [], project: [] }),
      close: (_projectId, tabId) => {
        closes.push(tabId)
      },
      pageUnsaved: (_projectId, tabId) => unsaved.has(tabId),
      reorder: () => {},
      rename: () => {},
      flag: () => null,
      toggleFlag: () => null,
      restart: () => ({ id: 't1', kind: 'shell', cwd: '/work/a', gen: 1 }),
      input: () => {},
      resize: () => {},
      fit: () => true,
      visible: () => {},
      ack: () => {},
      select: () => {},
      viewAck: () => {},
      viewSelect: () => {}
    })
    // The view's copy of the tab was still clean (its report not back yet): main answers unsaved.
    await expect(fresh.ipc.invoke('tabs.close', 11, [{ tabId: 'dirty' }])).resolves.toEqual({ unsaved: true })
    await expect(fresh.ipc.invoke('tabs.close', 11, [{ tabId: 'dirty', discard: false }])).resolves.toEqual({ unsaved: true })
    expect(closes).toEqual([])
    // Asked, and the person chose Close.
    await expect(fresh.ipc.invoke('tabs.close', 11, [{ tabId: 'dirty', discard: true }])).resolves.toBeUndefined()
    await fresh.ipc.invoke('tabs.close', 11, [{ tabId: 'clean' }])
    expect(closes).toEqual(['dirty', 'clean'])
    // Without the dependency (other handlers' tests) a close is as before.
    await ipc.invoke('tabs.close', 11, [{ tabId: 't1' }])
    expect(calls.filter((c) => c[0] === 'close')).toEqual([['close', PROJECT_A, 't1']])
  })
})

describe('registerSessionHandlers', () => {
  function sessionsSetup(): { ipc: FakeIpcMain; router: IpcRouter; calls: unknown[][] } {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    registerSessionHandlers(router, {
      linkAnswer: (windowId, requestId, allow, remote) => {
        calls.push(['linkAnswer', windowId, requestId, allow, remote])
        return true
      },
      trashAnswer: (windowId, requestId, move) => {
        calls.push(['trashAnswer', windowId, requestId, move])
        return true
      },
      snapshotFor: (projectId) => {
        calls.push(['snapshotFor', projectId])
        return { own: [] }
      },
      cancelQueued: (projectId, tabId, itemId) => {
        calls.push(['cancelQueued', projectId, tabId, itemId])
        return true
      },
      closeAnswer: (windowId, viewId, requestId, answer) => {
        calls.push(['closeAnswer', windowId, viewId, requestId, answer])
        return true
      },
      downloadAccept: async (windowId, viewId, requestId, all) => {
        calls.push(['downloadAccept', windowId, viewId, requestId, all])
        return true
      },
      downloadDecline: (windowId, requestId) => {
        calls.push(['downloadDecline', windowId, requestId])
        return true
      }
    })
    return { ipc, router, calls }
  }

  it('sessions.closeAnswer passes the sender’s window and view, never ones from the payload', async () => {
    const { ipc, calls } = sessionsSetup()
    await expect(
      ipc.invoke('sessions.closeAnswer', 12, [{ requestId: 'close-1', closed: true, windowId: 1, viewId: 'web:9' }])
    ).resolves.toBe(true)
    await expect(ipc.invoke('sessions.closeAnswer', 12, [{ requestId: 'close-2', closed: false, declined: true }])).resolves.toBe(true)
    await expect(ipc.invoke('sessions.closeAnswer', 12, [{ requestId: 'close-3', closed: true, discard: true }])).resolves.toBe(true)
    expect(calls).toEqual([
      ['closeAnswer', 2, 'desktop:2', 'close-1', { closed: true, declined: false, discard: false }],
      ['closeAnswer', 2, 'desktop:2', 'close-2', { closed: false, declined: true, discard: false }],
      ['closeAnswer', 2, 'desktop:2', 'close-3', { closed: true, declined: false, discard: true }]
    ])
    await expect(ipc.invoke('sessions.closeAnswer', 12, [{ requestId: 5, closed: true }])).rejects.toThrow()
    await expect(ipc.invoke('sessions.closeAnswer', 12, [{ requestId: 'close-1', closed: 'yes' }])).rejects.toThrow()
    await expect(ipc.invoke('sessions.closeAnswer', 12, [{ requestId: 'close-1', closed: false, declined: 'yes' }])).rejects.toThrow()
    await expect(ipc.invoke('sessions.closeAnswer', 12, [{ requestId: 'close-1', closed: true, discard: 'yes' }])).rejects.toThrow()
    await expect(ipc.invoke('sessions.closeAnswer', 13, [{ requestId: 'close-1', closed: false }])).rejects.toThrow()
    expect(calls).toHaveLength(3)
  })

  it('links.answer passes the sender’s window, never one from the payload, and checks the shape', async () => {
    const { ipc, calls } = sessionsSetup()
    await expect(ipc.invoke('links.answer', 12, [{ requestId: 'link-1', allow: true, windowId: 1, remote: true }])).resolves.toBe(true)
    expect(calls).toEqual([['linkAnswer', 2, 'link-1', true, false]])
    await expect(ipc.invoke('links.answer', 12, [{ requestId: 'link-1', allow: 'yes' }])).rejects.toThrow()
    await expect(ipc.invoke('links.answer', 12, [{ requestId: 7, allow: true }])).rejects.toThrow()
    await expect(ipc.invoke('links.answer', 13, [{ requestId: 'link-1', allow: true }])).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('links.answer tells main a remote view answered from the view it bound, never from the payload', async () => {
    const { router, calls } = sessionsSetup()
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:4', 'owner')
    await router.dispatch(web, 'links.answer', { requestId: 'link-1', allow: true, remote: false, viewId: 'desktop:1' })
    await router.dispatch(web, 'links.answer', { requestId: 'link-1', allow: false })
    expect(calls).toEqual([
      ['linkAnswer', 1, 'link-1', true, true],
      ['linkAnswer', 1, 'link-1', false, true]
    ])
  })

  it('trash.answer passes the sender’s window, never one from the payload, from any view, and checks the shape', async () => {
    const { ipc, router, calls } = sessionsSetup()
    await expect(ipc.invoke('trash.answer', 12, [{ requestId: 'trash-1', move: true, windowId: 1 }])).resolves.toBe(true)
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:4', 'owner')
    await router.dispatch(web, 'trash.answer', { requestId: 'trash-2', move: false, windowId: 2 })
    expect(calls).toEqual([
      ['trashAnswer', 2, 'trash-1', true],
      ['trashAnswer', 1, 'trash-2', false]
    ])
    await expect(ipc.invoke('trash.answer', 12, [{ requestId: 'trash-1', move: 'yes' }])).rejects.toThrow()
    await expect(ipc.invoke('trash.answer', 12, [{ requestId: 3, move: true }])).rejects.toThrow()
    await expect(ipc.invoke('trash.answer', 13, [{ requestId: 'trash-1', move: true }])).rejects.toThrow()
    expect(calls).toHaveLength(2)
  })

  // design-download.md §6: Download (`adapted`) only from a remote view, with the sender's window and
  // view; the desktop page (where the file already is) answers false without reaching main.
  it('downloads.accept is taken only from a remote view, with its own window and view, and checks the shape', async () => {
    const { ipc, router, calls } = sessionsSetup()
    await expect(ipc.invoke('downloads.accept', 12, [{ requestId: 'offer-1', all: false }])).resolves.toBe(false)
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:4', 'owner')
    await expect(router.dispatch(web, 'downloads.accept', { requestId: 'offer-1', all: true, windowId: 2, viewId: 'web:9' })).resolves.toBe(true)
    expect(calls).toEqual([['downloadAccept', 1, 'web:4', 'offer-1', true]])
    await expect(router.dispatch(web, 'downloads.accept', { requestId: 'offer-1', all: 'yes' })).rejects.toThrow()
    await expect(router.dispatch(web, 'downloads.accept', { requestId: 1, all: true })).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('downloads.answer declines for the sender’s window from any view, never one from the payload', async () => {
    const { ipc, router, calls } = sessionsSetup()
    await expect(ipc.invoke('downloads.answer', 12, [{ requestId: 'offer-1', windowId: 1 }])).resolves.toBe(true)
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:4', 'owner')
    await router.dispatch(web, 'downloads.answer', { requestId: 'offer-2', windowId: 2 })
    expect(calls).toEqual([
      ['downloadDecline', 2, 'offer-1'],
      ['downloadDecline', 1, 'offer-2']
    ])
    await expect(router.dispatch(web, 'downloads.answer', { requestId: 3 })).rejects.toThrow()
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

  it('a remote view\'s layout.set keeps the stored geometry (sizes are per view); the desktop\'s does not', async () => {
    const { ipc, router } = setup()
    const opts: Array<{ keepGeometry?: boolean } | undefined> = []
    registerLayoutHandlers(router, {
      view: () => emptyView,
      set: (_projectId, _layout, o) => {
        opts.push(o)
        return emptyView
      }
    })
    await ipc.invoke('layout.set', 11, [{ layout: defaultLayout() }])
    await router.dispatch(webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:3', 'owner'), 'layout.set', { layout: defaultLayout() })
    expect(opts).toEqual([undefined, { keepGeometry: true }])
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
  it("passes the sender's project and view on with the frame id, refusing junk first", async () => {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    registerSlotHandlers(router, {
      connect: (projectId, viewId, frameId, nonce) => {
        calls.push(['connect', projectId, viewId, frameId, nonce])
        return frameId === 's1'
      },
      disconnect: (projectId, viewId, frameId) => void calls.push(['disconnect', projectId, viewId, frameId]),
      setHeight: (projectId, frameId, height) => {
        calls.push(['height', projectId, frameId, height])
        return true
      }
    })
    await expect(ipc.invoke('slots.connect', 12, [{ frameId: 's1', nonce: 3, projectId: PROJECT_A }])).resolves.toBe(true)
    await expect(ipc.invoke('slots.disconnect', 11, [{ frameId: 's1' }])).resolves.toBeNull()
    await expect(ipc.invoke('slots.height', 11, [{ frameId: 's1', height: 90 }])).resolves.toBe(true)
    expect(calls).toEqual([
      ['connect', PROJECT_B, 'desktop:2', 's1', 3],
      ['disconnect', PROJECT_A, 'desktop:1', 's1'],
      ['height', PROJECT_A, 's1', 90]
    ])
    await expect(ipc.invoke('slots.connect', 11, [{ frameId: 'x'.repeat(41), nonce: 1 }])).rejects.toThrow(/short string/)
    await expect(ipc.invoke('slots.disconnect', 11, [{ frameId: 7 }])).rejects.toThrow(/short string/)
    await expect(ipc.invoke('slots.height', 11, [{ frameId: 's1', height: '90' }])).rejects.toThrow(/must be a number/)
    await expect(ipc.invoke('slots.height', 11, ['nope'])).rejects.toThrow(/bad payload/)
    await expect(ipc.invoke('slots.connect', 13, [{ frameId: 's1', nonce: 1 }])).rejects.toThrow(/not a project window/)
    expect(calls).toHaveLength(3)
    // A remote view's frame is its own instance: main's view id from the caller, a payload's ignored.
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:4', 'owner')
    await router.dispatch(web, 'slots.connect', { frameId: 's1', nonce: 5, viewId: 'desktop:1' })
    await router.dispatch(web, 'slots.disconnect', { frameId: 's1', viewId: 'desktop:1' })
    expect(calls.slice(3)).toEqual([
      ['connect', PROJECT_A, 'web:4', 's1', 5],
      ['disconnect', PROJECT_A, 'web:4', 's1']
    ])
  })
})

describe('registerPageTabHandlers', () => {
  const TAB = '0b4f6c2e-1d3a-4e5b-8c7d-9e0f1a2b3c4d'
  function pageTabs(server: boolean) {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    registerPageTabHandlers(router, {
      src: (projectId, tabId) => {
        calls.push(['src', projectId, tabId])
        return tabId === TAB ? 'cc-plugin://a.one/tab.html' : undefined
      },
      connect: (projectId, viewId, tabId, nonce) => {
        calls.push(['connect', projectId, viewId, tabId, nonce])
        return true
      },
      disconnect: (projectId, viewId, tabId) => void calls.push(['disconnect', projectId, viewId, tabId]),
      dirty: (projectId, viewId, tabId, dirty) => void calls.push(['dirty', projectId, viewId, tabId, dirty]),
      unsaved: (projectId) => {
        calls.push(['unsaved', projectId])
        return ['a.ts']
      },
      discuss: (caller, tabId, question, target) => {
        calls.push(['discuss', caller, tabId, question, target])
        return Promise.resolve({ ok: true as const, tabId: 'claude-1', queued: false })
      },
      server
    })
    return { ipc, router, calls }
  }

  it("discuss: the sender's window, project and view; the hidden page is refused", async () => {
    const { ipc, router, calls } = pageTabs(true)
    await expect(ipc.invoke('pageTabs.discuss', 11, [{ tabId: TAB, question: 'why?', target: { kind: 'new' } }])).resolves.toEqual({
      ok: false,
      error: 'Ask Claude is not available here'
    })
    expect(calls).toEqual([])
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:4', 'owner')
    await router.dispatch(web, 'pageTabs.discuss', { tabId: TAB, question: 'why?', target: { kind: 'tab', tabId: 'c1' }, viewId: 'desktop:1' })
    expect(calls).toEqual([['discuss', { windowId: 1, projectId: PROJECT_A, viewId: 'web:4' }, TAB, 'why?', { kind: 'tab', tabId: 'c1' }]])
  })

  it('dirty: per sender view, a boolean only; unsaved: the sender project', async () => {
    const { ipc, router, calls } = pageTabs(false)
    await expect(ipc.invoke('pageTabs.dirty', 11, [{ tabId: TAB, dirty: true, viewId: 'web:9', projectId: PROJECT_B }])).resolves.toBeNull()
    await expect(ipc.invoke('pageTabs.dirty', 11, [{ tabId: TAB, dirty: 'yes' }])).rejects.toThrow(/boolean/)
    await expect(ipc.invoke('pageTabs.unsaved', 12, [])).resolves.toEqual(['a.ts'])
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:4', 'owner')
    await router.dispatch(web, 'pageTabs.dirty', { tabId: TAB, dirty: false })
    expect(calls).toEqual([
      ['dirty', PROJECT_A, 'desktop:1', TAB, true],
      ['unsaved', PROJECT_B],
      ['dirty', PROJECT_A, 'web:4', TAB, false]
    ])
  })

  it("server mode: the hidden page's dirty report is ignored, a browser's counts", async () => {
    const { ipc, router, calls } = pageTabs(true)
    await expect(ipc.invoke('pageTabs.dirty', 11, [{ tabId: TAB, dirty: true }])).resolves.toBeNull()
    expect(calls).toEqual([])
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:4', 'owner')
    await router.dispatch(web, 'pageTabs.dirty', { tabId: TAB, dirty: true })
    expect(calls).toEqual([['dirty', PROJECT_A, 'web:4', TAB, true]])
  })

  it("passes the sender's project and view on with the tab id, refusing junk first", async () => {
    const { ipc, router, calls } = pageTabs(false)
    await expect(ipc.invoke('pageTabs.src', 11, [{ tabId: TAB }])).resolves.toBe('cc-plugin://a.one/tab.html')
    await expect(ipc.invoke('pageTabs.src', 11, [{ tabId: 'other' }])).resolves.toBeNull()
    await expect(ipc.invoke('pageTabs.connect', 12, [{ tabId: TAB, nonce: 3, projectId: PROJECT_A }])).resolves.toBe(true)
    await expect(ipc.invoke('pageTabs.disconnect', 11, [{ tabId: TAB }])).resolves.toBeNull()
    expect(calls).toEqual([
      ['src', PROJECT_A, TAB],
      ['src', PROJECT_A, 'other'],
      ['connect', PROJECT_B, 'desktop:2', TAB, 3],
      ['disconnect', PROJECT_A, 'desktop:1', TAB]
    ])
    await expect(ipc.invoke('pageTabs.connect', 11, [{ tabId: 'x'.repeat(65), nonce: 1 }])).rejects.toThrow(/short string/)
    await expect(ipc.invoke('pageTabs.src', 11, [{ tabId: 7 }])).rejects.toThrow(/must be a string/)
    await expect(ipc.invoke('pageTabs.connect', 13, [{ tabId: TAB, nonce: 1 }])).rejects.toThrow(/not a project window/)
    expect(calls).toHaveLength(4)
    // A remote view's frame is its own instance: main's view id from the caller.
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:4', 'owner')
    await router.dispatch(web, 'pageTabs.connect', { tabId: TAB, nonce: 5, viewId: 'desktop:1' })
    expect(calls.at(-1)).toEqual(['connect', PROJECT_A, 'web:4', TAB, 5])
  })

  it("server mode: the hidden page (the desktop view) gets no page and no port; a browser view does", async () => {
    const { ipc, router, calls } = pageTabs(true)
    await expect(ipc.invoke('pageTabs.src', 11, [{ tabId: TAB }])).resolves.toBeNull()
    await expect(ipc.invoke('pageTabs.connect', 11, [{ tabId: TAB, nonce: 1 }])).resolves.toBe(false)
    expect(calls).toEqual([])
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:4', 'owner')
    await expect(router.dispatch(web, 'pageTabs.src', { tabId: TAB })).resolves.toBe('cc-plugin://a.one/tab.html')
    await expect(router.dispatch(web, 'pageTabs.connect', { tabId: TAB, nonce: 2 })).resolves.toBe(true)
  })
})

describe('registerSettingsPageHandlers', () => {
  it("passes the sender's project and view on with a checked plugin id and scope, refusing junk first", async () => {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    registerSettingsPageHandlers(router, {
      info: (projectId, pluginId, scope) => {
        calls.push(['info', projectId, pluginId, scope])
        return pluginId === 'a.one' ? { enabled: true, src: 'cc-plugin://a.one/settings/index.html' } : null
      },
      connect: (projectId, viewId, pluginId, scope, nonce) => {
        calls.push(['connect', projectId, viewId, pluginId, scope, nonce])
        return true
      },
      disconnect: (projectId, viewId, pluginId) => void calls.push(['disconnect', projectId, viewId, pluginId])
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
      ['connect', PROJECT_A, 'desktop:1', 'a.one', 'project', 4],
      ['disconnect', PROJECT_A, 'desktop:1', 'a.one']
    ])
    await expect(ipc.invoke('settingsPage.info', 11, [{ pluginId: 'A One', scope: 'app' }])).rejects.toThrow(/plugin id/)
    await expect(ipc.invoke('settingsPage.info', 11, [{ pluginId: 'a.one', scope: 'global' }])).rejects.toThrow(/scope/)
    await expect(ipc.invoke('settingsPage.connect', 11, [{ pluginId: 7, scope: 'app', nonce: 1 }])).rejects.toThrow(/plugin id/)
    await expect(ipc.invoke('settingsPage.disconnect', 11, ['nope'])).rejects.toThrow(/bad payload/)
    await expect(ipc.invoke('settingsPage.connect', 13, [{ pluginId: 'a.one', scope: 'app', nonce: 1 }])).rejects.toThrow(/not a project window/)
    expect(calls).toHaveLength(3)
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:4', 'owner')
    await router.dispatch(web, 'settingsPage.connect', { pluginId: 'a.one', scope: 'app', nonce: 6, viewId: 'desktop:1' })
    await router.dispatch(web, 'settingsPage.disconnect', { pluginId: 'a.one', viewId: 'desktop:1' })
    expect(calls.slice(3)).toEqual([
      ['connect', PROJECT_A, 'web:4', 'a.one', 'app', 6],
      ['disconnect', PROJECT_A, 'web:4', 'a.one']
    ])
  })
})

describe('registerPanelHandlers', () => {
  it("connects a panel of the sender's own project and view, and restarts that project's host", async () => {
    const { ipc, router } = setup()
    const connects: unknown[][] = []
    const restarts: string[] = []
    registerPanelHandlers(router, {
      connect: (projectId, viewId, panelKey, nonce) => {
        connects.push([projectId, viewId, panelKey, nonce])
        return panelKey === 'a.one/board'
      },
      restartHost: async (projectId) => {
        restarts.push(projectId)
      },
      panelAction: () => false
    })
    await expect(ipc.invoke('panels.connect', 12, [{ panelKey: 'a.one/board', nonce: 3, projectId: PROJECT_A }])).resolves.toBe(true)
    await expect(ipc.invoke('panels.connect', 11, [{ panelKey: 'other/x', nonce: 4 }])).resolves.toBe(false)
    // View and project are the sender's; key and nonce are passed on for the hub to check.
    expect(connects).toEqual([
      [PROJECT_B, 'desktop:2', 'a.one/board', 3],
      [PROJECT_A, 'desktop:1', 'other/x', 4]
    ])
    // A remote view's connect carries its own view id (the page end goes back to it), never a payload's.
    await router.dispatch(webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:9', 'owner'), 'panels.connect', {
      panelKey: 'a.one/board',
      nonce: 5,
      viewId: 'desktop:1'
    })
    expect(connects.at(-1)).toEqual([PROJECT_A, 'web:9', 'a.one/board', 5])
    connects.pop()
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
      panelAction: (projectId, panelKey, actionId, view) => {
        clicks.push([projectId, panelKey, actionId, view])
        return actionId === 'refresh'
      }
    })
    // The project is the sender's, whatever the payload says.
    await expect(ipc.invoke('panels.action', 11, [{ panelKey: 'a.one/board', actionId: 'refresh', projectId: PROJECT_B }])).resolves.toBe(true)
    await expect(ipc.invoke('panels.action', 12, [{ panelKey: 'a.one/board', actionId: 'other' }])).resolves.toBe(false)
    // A remote view's click names that view (the caller main bound), none for the desktop's.
    await router.dispatch(webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:5', 'owner'), 'panels.action', {
      panelKey: 'a.one/board',
      actionId: 'refresh',
      view: 'web:9'
    })
    expect(clicks).toEqual([
      [PROJECT_A, 'a.one/board', 'refresh', undefined],
      [PROJECT_B, 'a.one/board', 'other', undefined],
      [PROJECT_A, 'a.one/board', 'refresh', 'web:5']
    ])
    await expect(ipc.invoke('panels.action', 11, [{ panelKey: 'a.one/board', actionId: 'x'.repeat(41) }])).rejects.toThrow(/short strings/)
    await expect(ipc.invoke('panels.action', 11, [{ panelKey: 7, actionId: 'refresh' }])).rejects.toThrow(/short strings/)
    await expect(ipc.invoke('panels.action', 11, ['nope'])).rejects.toThrow(/bad payload/)
    await expect(ipc.invoke('panels.action', 13, [{ panelKey: 'a.one/board', actionId: 'refresh' }])).rejects.toThrow(/not a project window/)
    expect(clicks).toHaveLength(3)
  })
})

describe('registerSettingsHandlers', () => {
  /** A deps object that records every call as `name(args)` and answers with harmless values. */
  function settingsSetup(options: { server?: boolean } = {}): { ipc: FakeIpcMain; calls: unknown[][]; router: IpcRouter } {
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
      updateAllMarketplace: async (...args) => rec('updateAllMarketplace', { updated: [], failed: [] })(...args),
      refreshMarketplace: async (...args) => rec('refreshMarketplace', { indexes: [], entries: [], warnings: [] })(...args),
      marketplacePreview: async (...args) => rec('marketplacePreview', null)(...args),
      setMarketplaceUrls: async (...args) => rec('setMarketplaceUrls', { indexes: [], entries: [], warnings: [] })(...args),
      pluginLimits: rec('pluginLimits', { id: 'a.one', limits: [] }),
      setPluginLimits: rec('setPluginLimits', { id: 'a.one', limits: [] }),
      globalPluginLimits: rec('globalPluginLimits', { global: true as const, limits: [] }),
      setGlobalPluginLimits: rec('setGlobalPluginLimits', { global: true as const, limits: [] })
    }
    registerSettingsHandlers(router, deps, options)
    return { ipc, calls, router }
  }

  // settings.projectOpen is `adapted`: it makes a window on the host's screen, which a browser view of
  // a desktop may not do; a server's browser may (its window is the hidden page). Decided by main's
  // bound view and its own flag, never the payload.
  it('projectOpen: the desktop and a server\'s browser open; a desktop\'s browser is refused', async () => {
    const desktop = settingsSetup()
    await desktop.ipc.invoke('settings.projectOpen', 11, [{ id: 'p1' }])
    const browser = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:5', 'owner')
    await expect(desktop.router.dispatch(browser, 'settings.projectOpen', { id: 'p2', remote: false })).rejects.toThrow(/outside server mode/)
    expect(desktop.calls).toEqual([['openProject', 'p1']])
    const server = settingsSetup({ server: true })
    await server.router.dispatch(browser, 'settings.projectOpen', { id: 'p3' })
    expect(server.calls).toEqual([['openProject', 'p3']])
  })

  // plugins.limits.set is `adapted` (design-rooms.md §6): raising a cap widens what a plugin may do on the host, so a
  // desktop's browser is refused and a server's browser (the only screen there) may; the read is any view's.
  it('plugin limits: any view reads; the write from the desktop and a server\'s browser, never a desktop\'s browser', async () => {
    const desktop = settingsSetup()
    const browser = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:5', 'owner')
    await desktop.ipc.invoke('plugins.limits.get', 11, [{ id: 'a.one' }])
    await desktop.router.dispatch(browser, 'plugins.limits.get', { id: 'a.two' })
    await desktop.ipc.invoke('plugins.limits.set', 11, [{ id: 'a.one', set: [['opensPerMinute', 10]], reset: ['sendsPerMinute'] }])
    await expect(desktop.router.dispatch(browser, 'plugins.limits.set', { id: 'a.one', set: [['opensPerMinute', 60]] })).rejects.toThrow(
      /outside server mode/
    )
    expect(desktop.calls).toEqual([
      ['pluginLimits', 'a.one'],
      ['pluginLimits', 'a.two'],
      ['setPluginLimits', 'a.one', [['opensPerMinute', 10]], ['sendsPerMinute']]
    ])
    const server = settingsSetup({ server: true })
    await server.router.dispatch(browser, 'plugins.limits.set', { id: 'a.one', set: [['opensPerMinute', 60]] })
    expect(server.calls).toEqual([['setPluginLimits', 'a.one', [['opensPerMinute', 60]], undefined]])
  })

  // The global values (Settings › General) follow the same rule: a global raise widens every plugin without an
  // override, so a desktop's browser is refused the write before the service is reached; any view reads.
  it('global plugin limits: any view reads; the write from the desktop and a server\'s browser, never a desktop\'s browser', async () => {
    const desktop = settingsSetup()
    const browser = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:5', 'owner')
    await desktop.ipc.invoke('plugins.globalLimits.get', 11, [])
    await desktop.router.dispatch(browser, 'plugins.globalLimits.get', undefined)
    await desktop.ipc.invoke('plugins.globalLimits.set', 11, [{ set: [['sendsPerMinute', 90]], reset: ['opensPerMinute'], id: 'ignored' }])
    for (const payload of [{ set: [['opensPerMinute', 60]] }, { reset: ['opensPerMinute'] }]) {
      await expect(desktop.router.dispatch(browser, 'plugins.globalLimits.set', payload)).rejects.toThrow(/outside server mode/)
    }
    expect(desktop.calls).toEqual([
      ['globalPluginLimits'],
      ['globalPluginLimits'],
      // Only `set` and `reset` go on: a payload's `id` is not a way to reach a plugin's overrides.
      ['setGlobalPluginLimits', [['sendsPerMinute', 90]], ['opensPerMinute']]
    ])
    const server = settingsSetup({ server: true })
    await server.router.dispatch(browser, 'plugins.globalLimits.set', { set: [['opensPerMinute', 60]] })
    expect(server.calls).toEqual([['setGlobalPluginLimits', [['opensPerMinute', 60]], undefined]])
  })

  it('is for project windows only: the picker is refused on every channel', async () => {
    const { ipc, calls } = settingsSetup()
    const channels = [...ipc.handlers.keys()]
    expect(channels).toHaveLength(23)
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
    // "Update all" hands its list on whole: the service checks each item's shape itself.
    await ipc.invoke('settings.marketplaceUpdateAll', 11, [{ items: [{ indexUrl: 'https://i/x.json', id: 'a.b', expect: { repo: 'r', commit: 'c' } }], tag: 'v9' }])
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
      ['updateAllMarketplace', [{ indexUrl: 'https://i/x.json', id: 'a.b', expect: { repo: 'r', commit: 'c' } }]],
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
  function projectSettingsSetup(options: { server?: boolean } = {}): { ipc: FakeIpcMain; router: IpcRouter; calls: unknown[][] } {
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
      setDiscussPrompt: rec('setDiscussPrompt', undefined),
      setProjectDiscussPrompt: rec('setProjectDiscussPrompt', undefined),
      appearance: rec('appearance', { themes: [], selected: null, current: 'light', keys: [], tabExit: 'close-clean' as const, claudeTabOnOpen: true, sessionGist: false, statusLineUsage: true, keepAwake: true, discussPrompt: '', notificationSounds: true, notificationSound: 'builtin:chime', zoneAutoHide: true, minTerminalWidth: 720, confirmTabClose: true, tabCloseSide: 'right' as const, terminalFont: { ...DEFAULT_TERMINAL_FONT }, windowBackground: { transparent: false, opacity: 85, blur: true, area: 'window' as const }, blurSupport: 'vibrancy' as const, tabCommands: [] }),
      setTheme: rec('setTheme', undefined),
      setKey: rec('setKey', undefined),
      setTabExit: rec('setTabExit', undefined),
      setClaudeTabOnOpen: rec('setClaudeTabOnOpen', undefined),
      setSessionGist: rec('setSessionGist', undefined),
      setStatusLineUsage: rec('setStatusLineUsage', undefined),
      setKeepAwake: rec('setKeepAwake', undefined),
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
    registerProjectSettingsHandlers(router, deps, options)
    return { ipc, router, calls }
  }

  it('is for project windows only: the picker is refused on every channel', async () => {
    const { ipc, calls } = projectSettingsSetup()
    const channels = [...ipc.handlers.keys()]
    expect(channels).toHaveLength(27)
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
      // The calling view: "Showing ..." names that view's theme (design-web.md §5.7).
      ['appearance', PROJECT_B, 'desktop:2'],
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

  it('passes the status line usage choice on as unknown for the service to check', async () => {
    const { ipc, calls } = projectSettingsSetup()
    await ipc.invoke('settings.statusLineUsageSet', 11, [{ value: false }])
    await ipc.invoke('settings.statusLineUsageSet', 12, [{ value: 'no' }])
    expect(calls).toEqual([
      ['setStatusLineUsage', false],
      ['setStatusLineUsage', 'no']
    ])
  })

  // `adapted` (REMOTE_CLASS): whether the host may idle-sleep is the person's at that computer. A desktop's browser is
  // refused before the service is reached; the desktop page and a server's browser pass the value on as unknown.
  it("keep awake: the desktop and a server's browser pass it on, never a desktop's browser", async () => {
    const desktop = projectSettingsSetup()
    const browser = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:5', 'owner')
    await desktop.ipc.invoke('settings.keepAwakeSet', 11, [{ value: false }])
    await desktop.ipc.invoke('settings.keepAwakeSet', 12, [{ value: 'no' }])
    await expect(desktop.router.dispatch(browser, 'settings.keepAwakeSet', { value: true })).rejects.toThrow(/outside server mode/)
    expect(desktop.calls).toEqual([
      ['setKeepAwake', false],
      ['setKeepAwake', 'no']
    ])
    const server = projectSettingsSetup({ server: true })
    await server.router.dispatch(browser, 'settings.keepAwakeSet', { value: true })
    expect(server.calls).toEqual([['setKeepAwake', true]])
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
      offer: (viewId) => (calls.push(`ccc offer ${viewId}`), null)
    })
    await expect(ipc.invoke('settings.cccInstall', 13, [{}])).rejects.toThrow(/not a project window/)
    expect(calls).toEqual([])
    expect(await ipc.invoke('settings.cccStatus', 11)).toEqual(view)
    expect(await ipc.invoke('settings.cccInstall', 11, [{ path: '/etc/passwd' }])).toMatchObject({ state: 'installed' })
    expect(calls).toEqual(['status', 'install'])
    // The asking view, for the hold while the Claude Code question is up in another window.
    await ipc.invoke('ccc.offer', 11)
    expect(calls).toEqual(['status', 'install', 'ccc offer desktop:1'])
  })
})

// Claude Code (main/hooks/claude-offer.ts): the start-up question, "Don't ask again" and the installer tab are `adapted`.
// The desktop page on the desktop; in server mode the owner's browser, never the hidden page; never a guest. main
// decides from the view it bound and its own flag; the install reads nothing of the payload.
describe('registerClaudeCodeHandlers', () => {
  const A_CTX = { kind: 'project', windowId: 1, projectId: PROJECT_A } as const
  const view: ClaudeCodeView = {
    state: 'missing',
    launcher: '/h/.local/bin/claude',
    binDir: '/h/.local/bin',
    command: 'curl -fsSL https://claude.ai/install.sh | bash',
    docsUrl: 'https://code.claude.com/docs/en/setup',
    others: [],
    installInTab: true,
    offerAtStart: true
  }
  function claudeSetup(server: boolean): { ipc: FakeIpcMain; router: IpcRouter; calls: unknown[][] } {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    registerClaudeCodeHandlers(router, {
      server,
      status: () => view,
      setOffer: (value) => void calls.push(['setOffer', value]),
      // Records who asked; answers like a claim that says yes to anyone it is handed.
      offer: (caller, viewId) => (calls.push(['offer', caller, viewId]), view),
      install: async (projectId, windowId, viewId) => {
        calls.push(['install', projectId, windowId, viewId])
        return { id: 't1', kind: 'command', cwd: '/w', gen: 1 } satisfies TabInfo
      }
    })
    return { ipc, router, calls }
  }

  it('desktop: its own page sets, asks and installs; the payload names nothing', async () => {
    const { ipc, calls } = claudeSetup(false)
    expect(await ipc.invoke('settings.claudeStatus', 11)).toEqual(view)
    await ipc.invoke('settings.claudeOfferSet', 11, [{ value: false }])
    await expect(ipc.invoke('settings.claudeOfferSet', 11, [{ value: 'no' }])).rejects.toThrow(/must be a boolean/)
    expect(await ipc.invoke('claude.offer', 11)).toEqual(view)
    await ipc.invoke('claude.install', 11, [{ command: 'rm -rf ~', projectId: PROJECT_B }])
    expect(calls).toEqual([
      ['setOffer', false],
      ['offer', { remote: false, owner: true }, 'desktop:1'],
      ['install', PROJECT_A, 1, 'desktop:1']
    ])
    await expect(ipc.invoke('claude.install', 13)).rejects.toThrow(/not a project window/)
  })

  it("desktop: a browser view of the owner is refused the set and the install, and asks as a browser (main's claim says no)", async () => {
    const { router, calls } = claudeSetup(false)
    const browser = webCaller(A_CTX, 'web:5', 'owner')
    await expect(router.dispatch(browser, 'settings.claudeOfferSet', { value: false })).rejects.toThrow(/refused for this view/)
    await expect(router.dispatch(browser, 'claude.install', undefined)).rejects.toThrow(/refused for this view/)
    await router.dispatch(browser, 'claude.offer', undefined)
    expect(calls).toEqual([['offer', { remote: true, owner: true }, 'web:5']])
  })

  it("server: the owner's browser sets and installs on the server; the hidden page may not install", async () => {
    const { ipc, router, calls } = claudeSetup(true)
    const browser = webCaller(A_CTX, 'web:5', 'owner')
    await router.dispatch(browser, 'settings.claudeOfferSet', { value: false })
    await router.dispatch(browser, 'claude.install', undefined)
    await expect(ipc.invoke('claude.install', 11)).rejects.toThrow(/refused for this view/)
    await expect(ipc.invoke('settings.claudeOfferSet', 11, [{ value: true }])).rejects.toThrow(/refused for this view/)
    expect(calls).toEqual([
      ['setOffer', false],
      ['install', PROJECT_A, 1, 'web:5']
    ])
  })

  it('a guest is refused every channel before the handler, in either mode', async () => {
    for (const server of [false, true]) {
      const { router, calls } = claudeSetup(server)
      const guest = webCaller(A_CTX, 'web:7', { guest: 'g1' })
      for (const channel of ['settings.claudeStatus', 'settings.claudeOfferSet', 'claude.offer', 'claude.install']) {
        await expect(router.dispatch(guest, channel, { value: false }), channel).rejects.toThrow(/refused/)
      }
      expect(calls).toEqual([])
    }
  })
})

describe('registerWebAccessHandlers', () => {
  const WEB_CHANNELS = [
    'settings.webAccess',
    'settings.webAccessSet',
    'settings.webAccessLink',
    'settings.webAccessRegenerate',
    'settings.webAccessAddDevice',
    'settings.webDeviceDisconnect',
    'settings.webDeviceRevoke',
    'settings.webDevicesRevokeAll',
    'settings.webAccessSetPassword',
    'webAccess.state',
    'webAccess.confirmAnswer'
  ] as const

  function webAccessSetup(options: WebAccessHandlerOptions = {}): { ipc: FakeIpcMain; router: IpcRouter; calls: unknown[][] } {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    const view = {
      form: { enabled: false, bind: '127.0.0.1', port: 7330, externalOrigin: '', hosts: [], mode: 'link' as const, certPath: '', keyPath: '' },
      network: false,
      gateway: { state: 'off' as const },
      devices: [],
      risks: [],
      passwordSet: false,
      passwordMinLength: 8,
      passwordShort: false,
      credentials: { accessLink: 'unset' as const, password: 'unset' as const }
    }
    registerWebAccessHandlers(router, {
      view: () => (calls.push(['view']), view),
      set: async (patch) => (calls.push(['set', patch]), view),
      link: async () => (calls.push(['link']), { ok: true, link: 'http://127.0.0.1:7330/#t=x' }),
      regenerate: async () => (calls.push(['regenerate']), { ok: false, reason: 'no' }),
      addDevice: () => (calls.push(['addDevice']), { ok: false, reason: 'no' }),
      disconnect: (...args) => (calls.push(['disconnect', ...args]), true),
      revoke: (...args) => (calls.push(['revoke', ...args]), true),
      revokeAll: (...args) => (calls.push(['revokeAll', ...args]), 2),
      indicator: () => (calls.push(['indicator']), { connected: 1, warning: 'risky', confirm: { id: 'c1', name: 'a stranger', expiresAt: 1 } }),
      setPassword: async (password) => (calls.push(['setPassword', password]), { ok: true }),
      answerConfirm: (payload) => (calls.push(['answerConfirm', payload]), { ok: false, reason: 'no' })
    }, options)
    return { ipc, router, calls }
  }

  it('is for project windows only and hands the handler the payload fields', async () => {
    const { ipc, calls } = webAccessSetup()
    await expect(ipc.invoke('settings.webAccess', 13)).rejects.toThrow(/not a project window/)
    expect(calls).toEqual([])
    await ipc.invoke('settings.webAccessSet', 11, [{ value: { port: 8000 } }])
    await ipc.invoke('settings.webDeviceRevoke', 11, [{ id: 'abc' }])
    await ipc.invoke('settings.webDeviceDisconnect', 11, [{ id: 7 }])
    expect(await ipc.invoke('settings.webDevicesRevokeAll', 11)).toBe(2)
    // The desktop page gets the indicator whole, a confirm request included (only it may answer).
    expect(await ipc.invoke('webAccess.state', 11)).toEqual({ connected: 1, warning: 'risky', confirm: { id: 'c1', name: 'a stranger', expiresAt: 1 } })
    await ipc.invoke('settings.webAccessSetPassword', 11, [{ password: 'correct horse' }])
    await ipc.invoke('webAccess.confirmAnswer', 11, [{ id: 'a', allow: true, code: '123456' }])
    expect(calls).toEqual([
      ['set', { port: 8000 }],
      ['revoke', 'abc'],
      ['disconnect', 7],
      ['revokeAll'],
      ['indicator'],
      ['setPassword', 'correct horse'],
      ['answerConfirm', { id: 'a', allow: true, code: '123456' }]
    ])
  })

  // Design-web §4.1: a remote view cannot widen its own access. On the desktop every web access
  // channel is refused to a browser: the `no` ones by class before any handler runs, the `adapted`
  // ones by their handler, which reads main's flag (absent or false here), never the payload.
  it.each(WEB_CHANNELS)('refuses %s from a web caller on the desktop, before the service is called', async (channel) => {
    for (const options of [{}, { server: false }]) {
      const { router, calls } = webAccessSetup({ ...options, actorOf: () => ({ device: 'd1', name: 'Phone' }) })
      const ctx = { kind: 'project', windowId: 1, projectId: PROJECT_A } as const
      await expect(router.dispatch(webCaller(ctx, 'web:1', 'owner'), channel, { id: 'abc', server: true })).rejects.toThrow(/refused/)
      expect(calls).toEqual([])
    }
  })

  // Design-web §9.6: minting (link, add-device, password, mode, bind) stays on the server shell in
  // server mode too: refused by class before the handler, whatever the flag.
  const MINTING = [
    'settings.webAccessSet',
    'settings.webAccessLink',
    'settings.webAccessRegenerate',
    'settings.webAccessAddDevice',
    'settings.webAccessSetPassword',
    'webAccess.confirmAnswer'
  ] as const
  it.each(MINTING)('refuses %s from a web caller in server mode too', async (channel) => {
    const { router, calls } = webAccessSetup({ server: true, actorOf: () => ({ device: 'd1', name: 'Phone' }) })
    const ctx = { kind: 'project', windowId: 1, projectId: PROJECT_A } as const
    await expect(router.dispatch(webCaller(ctx, 'web:1', 'owner'), channel, { value: { mode: 'none' }, password: 'x'.repeat(12) })).rejects.toThrow(/refused/)
    expect(calls).toEqual([])
  })

  describe('server mode: the card and the narrowing calls from a browser', () => {
    const ctx = { kind: 'project', windowId: 1, projectId: PROJECT_A } as const
    const phone = { device: 'dev-phone', name: 'Phone' }
    const serverSetup = (): ReturnType<typeof webAccessSetup> & { asked: string[] } => {
      const asked: string[] = []
      const out = webAccessSetup({
        server: true,
        actorOf: (viewId) => {
          asked.push(viewId)
          return viewId === 'web:4' ? phone : undefined
        },
        secrets: async () => ({ store: 'keyfile', unavailable: null, otherMode: 2, replaced: 0 })
      })
      return { ...out, asked }
    }

    it('reads the card, with the secret store, and the indicator without a confirm request', async () => {
      const { router, calls } = serverSetup()
      const view = (await router.dispatch(webCaller(ctx, 'web:4', 'owner'), 'settings.webAccess', undefined)) as WebAccessView
      expect(view.secrets).toEqual({ store: 'keyfile', unavailable: null, otherMode: 2, replaced: 0 })
      expect(view.credentials).toEqual({ accessLink: 'unset', password: 'unset' })
      expect(await router.dispatch(webCaller(ctx, 'web:4', 'owner'), 'webAccess.state', undefined)).toEqual({ connected: 1, warning: 'risky' })
      expect(calls).toEqual([['view'], ['indicator']])
    })

    it('hides the TLS paths and the key file path from a browser view, not from the desktop', async () => {
      const { ipc, router } = setup()
      const view = {
        form: { enabled: true, bind: '127.0.0.1', port: 7330, externalOrigin: '', hosts: [], mode: 'link' as const, certPath: '/home/x/c.pem', keyPath: '/home/x/k.pem' },
        network: false,
        gateway: { state: 'off' as const },
        devices: [],
        risks: [],
        passwordSet: false,
        credentials: { accessLink: 'unset' as const, password: 'unset' as const }
      }
      const unavailable = 'the key file /home/x/secret.key cannot be opened'
      registerWebAccessHandlers(router, { view: () => view } as unknown as Parameters<typeof registerWebAccessHandlers>[1], {
        server: true,
        actorOf: () => phone,
        secrets: async () => ({ store: 'keyfile', unavailable, otherMode: 0, replaced: 0 })
      })
      const remote = (await router.dispatch(webCaller(ctx, 'web:4', 'owner'), 'settings.webAccess', undefined)) as WebAccessView
      expect(JSON.stringify(remote)).not.toContain('/home/x')
      expect(remote.form.certPath).not.toBe('')
      expect(remote.secrets?.unavailable).toBe(REMOTE_SECRETS_UNAVAILABLE_TEXT)
      const local = (await ipc.invoke('settings.webAccess', 11)) as WebAccessView
      expect(local.form.certPath).toBe('/home/x/c.pem')
      expect(local.secrets?.unavailable).toBe(unavailable)
    })

    it('revokes and disconnects with the acting device main bound, never one from the payload', async () => {
      const { router, calls, asked } = serverSetup()
      const forged = { id: 'dev-laptop', by: { device: 'dev-forged', name: 'Forged' }, viewId: 'web:9' }
      expect(await router.dispatch(webCaller(ctx, 'web:4', 'owner'), 'settings.webDeviceRevoke', forged)).toBe(true)
      expect(await router.dispatch(webCaller(ctx, 'web:4', 'owner'), 'settings.webDeviceDisconnect', forged)).toBe(true)
      expect(await router.dispatch(webCaller(ctx, 'web:4', 'owner'), 'settings.webDevicesRevokeAll', forged)).toBe(2)
      expect(calls).toEqual([
        ['revoke', 'dev-laptop', { by: phone }],
        ['disconnect', 'dev-laptop', phone],
        ['revokeAll', { by: phone }]
      ])
      expect(asked).toEqual(['web:4', 'web:4', 'web:4'])
    })

    it('refuses a narrowing call from a view that is already gone (no device to name in the log)', async () => {
      const { router, calls } = serverSetup()
      for (const channel of ['settings.webDeviceRevoke', 'settings.webDeviceDisconnect', 'settings.webDevicesRevokeAll'] as const) {
        await expect(router.dispatch(webCaller(ctx, 'web:5', 'owner'), channel, { id: 'dev-laptop' })).rejects.toThrow(/refused/)
      }
      expect(calls).toEqual([])
    })

    it('leaves the desktop page as it was: no acting device, the whole indicator', async () => {
      const { ipc, calls, asked } = serverSetup()
      await ipc.invoke('settings.webDeviceRevoke', 11, [{ id: 'abc' }])
      await ipc.invoke('settings.webDeviceDisconnect', 11, [{ id: 'abc' }])
      await ipc.invoke('settings.webDevicesRevokeAll', 11)
      expect((await ipc.invoke('webAccess.state', 11)) as WebAccessIndicator).toHaveProperty('confirm')
      expect(calls).toEqual([['revoke', 'abc'], ['disconnect', 'abc'], ['revokeAll'], ['indicator']])
      expect(asked).toEqual([])
    })
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

  it('openRelease from a remote view names that view and its window (the adapter shows a notice there)', async () => {
    const { router } = setup()
    const calls: unknown[][] = []
    registerUpdateHandlers(router, {
      state: () => ({ current: '1.0.0', enabled: true, available: null }),
      setEnabled: () => undefined,
      dismiss: () => undefined,
      openRelease: (...args) => void calls.push(args)
    })
    await router.dispatch(webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:4', 'owner'), 'updates.openRelease', { url: 'https://evil.example' })
    expect(calls).toEqual([[{ windowId: 1, viewId: 'web:4' }]])
  })

  it('ignores any payload on openRelease', async () => {
    const { ipc, calls } = updateSetup()
    await ipc.invoke('updates.openRelease', 11, [{ url: 'https://evil.example' }])
    expect(calls).toEqual([['openRelease', { windowId: 1, viewId: 'desktop:1' }]])
  })
})

describe('registerOverlayHandlers', () => {
  function overlaySetup(): { ipc: FakeIpcMain; router: IpcRouter; calls: unknown[][] } {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    registerOverlayHandlers(router, {
      list: (windowId, viewId) => {
        calls.push(['list', windowId, viewId])
        return []
      },
      close: (windowId, overlayId) => {
        calls.push(['close', windowId, overlayId])
        return true
      },
      input: (windowId, overlayId, data, viewId) => calls.push(['input', windowId, overlayId, data, viewId]),
      resize: (windowId, overlayId, cols, rows, viewId) =>
        calls.push(['resize', windowId, overlayId, cols, rows, viewId]),
      ack: (windowId, overlayId, count) => calls.push(['ack', windowId, overlayId, count]),
      setBounds: (windowId, overlayId, bounds) => calls.push(['bounds', windowId, overlayId, bounds]),
      result: (windowId, overlayId, value, viewId) => {
        calls.push(['result', windowId, overlayId, value, viewId])
        return true
      },
      message: (windowId, overlayId, text, viewId) => {
        calls.push(['message', windowId, overlayId, text, viewId])
        return true
      },
      ready: (windowId, overlayId, viewId) => {
        calls.push(['ready', windowId, overlayId, viewId])
      },
      loaded: (windowId, overlayId, viewId) => {
        calls.push(['loaded', windowId, overlayId, viewId])
      },
      take: (windowId, viewId, overlayId) => {
        calls.push(['take', windowId, viewId, overlayId])
        return true
      },
      button: (windowId, overlayId, click, viewId) => {
        calls.push(['button', windowId, overlayId, click, viewId])
        return true
      },
      discuss: (windowId, overlayId, target, _guest, viewId) => {
        calls.push(['discuss', windowId, overlayId, target, viewId])
        return Promise.resolve({ ok: true, tabId: 't1', queued: false })
      }
    })
    return { ipc, router, calls }
  }

  it("an owner browser's Discuss names its own view (the caller main bound), not the desktop", async () => {
    const { router, calls } = overlaySetup()
    await router.dispatch(webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:3', 'owner'), 'overlays.discuss', {
      overlayId: 'o1',
      target: { kind: 'new' },
      viewId: 'web:9'
    })
    expect(calls).toEqual([['discuss', 1, 'o1', { kind: 'new' }, 'web:3']])
  })

  it("a remote view's terminal overlay input and size are its own; its acks never reach the PTY's flow", async () => {
    const { router, calls } = overlaySetup()
    const web = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:3', 'owner')
    await router.dispatch(web, 'overlays.input', { overlayId: 'o1', data: 'j', viewId: 'desktop:1' })
    await router.dispatch(web, 'overlays.resize', { overlayId: 'o1', cols: 50, rows: 30 })
    await router.dispatch(web, 'overlays.ack', { overlayId: 'o1', count: 9 })
    expect(calls).toEqual([
      ['input', 1, 'o1', 'j', 'web:3'],
      ['resize', 1, 'o1', 50, 30, 'web:3']
    ])
  })

  it("a remote view's toolbar click names that view (the caller main bound), never one in the payload", async () => {
    const { router, calls } = overlaySetup()
    await router.dispatch(webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:3', 'owner'), 'overlays.button', {
      overlayId: 'o1',
      source: 'opener',
      buttonId: 'b',
      viewId: 'web:9'
    })
    expect(calls).toEqual([['button', 1, 'o1', { source: 'opener', buttonId: 'b' }, 'web:3']])
  })

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
    // The taking view is the sender's own, never one the payload names.
    await ipc.invoke('overlays.take', 12, [{ overlayId: 'o2', viewId: 'web:1', windowId: 1 }])
    await ipc.invoke('overlays.button', 11, [{ overlayId: 'o1', source: 'opener', buttonId: 'b', pluginId: 'x', windowId: 2 }])
    await ipc.invoke('overlays.button', 12, [{ overlayId: 'o2', source: 'type', pluginId: 'p.one', buttonId: 'edit' }])
    await ipc.invoke('overlays.discuss', 11, [{ overlayId: 'o1', target: { kind: 'tab', tabId: 't1', windowId: 2 } }])
    await ipc.invoke('overlays.discuss', 12, [{ overlayId: 'o2', target: { kind: 'new', tabId: 'x' } }])
    expect(calls).toEqual([
      ['list', 1, 'desktop:1'],
      ['close', 2, 'o1'],
      ['input', 1, 'o1', 'x', 'desktop:1'],
      ['resize', 1, 'o1', 80, 24, 'desktop:1'],
      ['ack', 1, 'o1', 3],
      ['bounds', 2, 'o2', { x: 0, y: 30, width: 10, height: 20 }],
      ['result', 2, 'o2', { a: 1 }, 'desktop:2'],
      ['message', 2, 'o2', '{"n":1}', 'desktop:2'],
      ['ready', 1, 'o1', 'desktop:1'],
      ['loaded', 2, 'o2', 'desktop:2'],
      ['take', 2, 'desktop:2', 'o2'],
      // An opener click carries no plugin id: the opener is the overlay's own.
      ['button', 1, 'o1', { source: 'opener', buttonId: 'b' }, 'desktop:1'],
      ['button', 2, 'o2', { source: 'type', pluginId: 'p.one', buttonId: 'edit' }, 'desktop:2'],
      // A clean target: only the fields of its kind; the caller's view always goes with it.
      ['discuss', 1, 'o1', { kind: 'tab', tabId: 't1' }, 'desktop:1'],
      ['discuss', 2, 'o2', { kind: 'new' }, 'desktop:2']
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
      ['overlays.take', [{ overlayId: 7 }]],
      ['overlays.button', [{ overlayId: 'o', source: 'opener', buttonId: 5 }]],
      ['overlays.button', [{ overlayId: 'o', source: 'type', buttonId: 'b' }]],
      ['overlays.button', [{ overlayId: 'o', source: 'page', buttonId: 'b' }]],
      ['overlays.button', [{ source: 'opener', buttonId: 'b' }]],
      ['overlays.discuss', [{ overlayId: 'o', target: { kind: 'tab' } }]],
      ['overlays.discuss', [{ overlayId: 'o', target: 'new' }]],
      ['overlays.discuss', [{ target: { kind: 'new' } }]]
    ]
    for (const [channel, args] of bad) {
      await expect(ipc.invoke(channel, 11, args), channel).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })
})

// docs/design-overlay-views.md §5: a perView overlay's page calls go through the router to the real manager's copies.
describe('overlays: per-view copies through the router', () => {
  const A_WIN = { kind: 'project', windowId: 1, projectId: PROJECT_A } as const
  function copiesSetup() {
    const { ipc, router } = setup()
    const heard: unknown[][] = []
    const legacy: string[] = []
    const m = new OverlayManager({
      ownerView: () => true,
      backend: new FakePtyBackend(),
      views: {
        create: () => {
          throw new Error('no url overlays here')
        },
        focusWindow: () => {}
      },
      isWindowOpen: () => true,
      env: () => ({}),
      emit: () => {},
      emitToView: () => true,
      isViewLive: (viewId, windowId) => windowId === 1 && (viewId === 'web:3' || viewId === 'web:4'),
      commandForChord: () => undefined,
      log: () => {}
    })
    const channel: OverlayChannel = {
      onMessage: (message, view, copy) => heard.push(['message', message, view, copy]),
      onConnect: (copy, view) => heard.push(['connect', copy, view]),
      onDisconnect: (copy, view) => heard.push(['disconnect', copy, view])
    }
    registerOverlayHandlers(router, {
      list: (w, v) => m.list(w, v),
      close: (w, o) => m.close(w, o),
      input: () => {},
      resize: () => {},
      ack: () => {},
      setBounds: () => {},
      result: (w, o, value, v) => {
        legacy.push('result')
        return m.result(w, o, value, v)
      },
      message: (w, o, text, v) => {
        legacy.push('message')
        return m.pageMessage(w, o, text, v)
      },
      ready: (w, o, v) => {
        legacy.push('ready')
        m.pageReady(w, o, v)
      },
      loaded: (w, o, v) => {
        legacy.push('loaded')
        m.pageLoaded(w, o, v)
      },
      take: (w, v, o) => m.take(w, v, o),
      button: (w, o, click, v) => m.buttonClick(w, o, click, v),
      discuss: (w, o, t, g, v) => m.discuss(w, o, t, g, v),
      perView: (w, o) => m.isPerView(w, o),
      connectCopy: (w, o, v) => m.connectReady(w, o, v),
      copyLoaded: (w, o, v, c) => m.copyLoaded(w, o, v, c),
      copyMessage: (w, o, v, c, text) => m.copyMessage(w, o, v, c, text),
      copyResult: (w, o, v, c, value) => m.copyResult(w, o, v, c, value),
      releaseCopy: (w, o, v, c) => m.releaseCopy(w, o, v, c)
    })
    const result = m.open(1, { kind: 'html', html: '<p>x</p>' }, 'plugin a.one', undefined, channel, 'a.one', undefined, undefined, { perView: true })
    const pv = m.infos(1).at(-1)!.id
    void m.open(1, { kind: 'html', html: '<p>y</p>' }, 'plugin a.one', undefined, channel, 'a.one')
    const plain = m.infos(1).at(-1)!.id
    const desktop = (channel: InvokeChannel, payload: unknown): Promise<unknown> => ipc.invoke(channel, 11, [payload])
    const browser = (viewId: string) => (channel: InvokeChannel, payload: unknown): Promise<unknown> =>
      Promise.resolve().then(() => router.dispatch(webCaller(A_WIN, viewId, 'owner'), channel, payload))
    return { m, heard, legacy, pv, plain, result, desktop, web3: browser('web:3'), web4: browser('web:4'), router }
  }

  it("ready answers each view's own copy; loaded, message and result must name it and count from that view only", async () => {
    const { m, heard, legacy, pv, result, desktop, web3 } = copiesSetup()
    const a = (await desktop('overlays.ready', { overlayId: pv })) as { copy: string }
    const b = (await web3('overlays.ready', { overlayId: pv })) as { copy: string }
    expect(a.copy).toMatch(/^[0-9a-f]{32}$/)
    expect(b.copy).not.toBe(a.copy)
    expect(m.copies(1, pv).map((c) => [c.view, c.ready])).toEqual([['desktop:1', true], ['web:3', true]])
    await expect(web3('overlays.message', { overlayId: pv, message: '{"n":1}', copy: b.copy })).resolves.toBe(true)
    expect(heard.at(-1)).toEqual(['message', { n: 1 }, 'web:3', b.copy])
    // Another view's copy named from this view: dropped, never heard as that view's.
    await expect(web3('overlays.message', { overlayId: pv, message: '"forged"', copy: a.copy })).resolves.toBe(false)
    await expect(web3('overlays.result', { overlayId: pv, value: 1, copy: a.copy })).resolves.toBe(false)
    // A perView page call without its copy is refused outright.
    await expect(web3('overlays.message', { overlayId: pv, message: '"x"' })).rejects.toThrow(/copy is required/)
    await expect(desktop('overlays.loaded', { overlayId: pv })).rejects.toThrow(/copy is required/)
    await expect(desktop('overlays.result', { overlayId: pv, value: 1 })).rejects.toThrow(/copy is required/)
    await expect(desktop('overlays.message', { overlayId: pv, message: '"x"', copy: 7 })).rejects.toThrow(/copy must be a string/)
    await desktop('overlays.loaded', { overlayId: pv, copy: a.copy })
    expect(heard.filter((h) => h[0] === 'message')).toHaveLength(1)
    // The holder's calls are never reached for a perView overlay.
    expect(legacy).toEqual([])
    await expect(desktop('overlays.result', { overlayId: pv, value: { ok: 1 }, copy: a.copy })).resolves.toBe(true)
    await expect(result).resolves.toEqual({ kind: 'value', value: { ok: 1 } })
  })

  it("overlays.release lets go of the caller's own copy only; another view's is refused", async () => {
    const { m, heard, pv, desktop, web3, web4 } = copiesSetup()
    const a = (await desktop('overlays.ready', { overlayId: pv })) as { copy: string }
    const b = (await web3('overlays.ready', { overlayId: pv })) as { copy: string }
    await expect(web4('overlays.release', { overlayId: pv, copy: b.copy })).resolves.toBe(false)
    await expect(desktop('overlays.release', { overlayId: pv, copy: b.copy, viewId: 'web:3' })).resolves.toBe(false)
    expect(m.copies(1, pv).map((c) => c.copy)).toEqual([a.copy, b.copy])
    // An owner's browser releases its own (the channel is `adapted`: decided by the view main bound).
    await expect(web3('overlays.release', { overlayId: pv, copy: b.copy })).resolves.toBe(true)
    await expect(desktop('overlays.release', { overlayId: pv, copy: a.copy })).resolves.toBe(true)
    expect(heard.filter((h) => h[0] === 'disconnect')).toEqual([
      ['disconnect', b.copy, 'web:3'],
      ['disconnect', a.copy, 'desktop:1']
    ])
    await expect(desktop('overlays.release', { overlayId: pv })).rejects.toThrow(/copy is required/)
  })

  // Task 5 review: hide is a read guest's (guest-overlays.test.ts); the owner closes, so a hide from it is refused.
  it("overlays.release { hide: true } from an owner's view is refused, and its copy stays", async () => {
    const { m, pv, desktop, web3 } = copiesSetup()
    const a = (await desktop('overlays.ready', { overlayId: pv })) as { copy: string }
    const b = (await web3('overlays.ready', { overlayId: pv })) as { copy: string }
    await expect(desktop('overlays.release', { overlayId: pv, copy: a.copy, hide: true })).rejects.toThrow(/hide is a read guest's/)
    await expect(web3('overlays.release', { overlayId: pv, hide: true })).rejects.toThrow(/hide is a read guest's/)
    expect(m.copies(1, pv).map((c) => c.copy)).toEqual([a.copy, b.copy])
  })

  // The guest rows themselves (read, own copy, perView only) are guest-overlays.test.ts's, with guest deps wired.
  it('a guest cannot release a copy while no guest deps are wired (fail closed)', async () => {
    const { router, pv } = copiesSetup()
    await expect(
      Promise.resolve().then(() => router.dispatch(webCaller(A_WIN, 'web:4', { guest: 'g1' }), 'overlays.release', { overlayId: pv, copy: 'c' }))
    ).rejects.toThrow()
  })

  it('a non-perView overlay keeps the holder calls exactly; a copy there names nothing', async () => {
    const { m, heard, legacy, plain, desktop } = copiesSetup()
    await expect(desktop('overlays.ready', { overlayId: plain })).resolves.toBeUndefined()
    await expect(desktop('overlays.message', { overlayId: plain, message: '"held"' })).resolves.toBe(true)
    expect(heard.at(-1)).toEqual(['message', 'held', undefined, undefined])
    await expect(desktop('overlays.message', { overlayId: plain, message: '"x"', copy: 'c' })).resolves.toBe(false)
    await expect(desktop('overlays.result', { overlayId: plain, value: 1, copy: 'c' })).resolves.toBe(false)
    await desktop('overlays.loaded', { overlayId: plain, copy: 'c' })
    await desktop('overlays.loaded', { overlayId: plain })
    await expect(desktop('overlays.release', { overlayId: plain, copy: 'c' })).resolves.toBe(false)
    expect(legacy).toEqual(['ready', 'message', 'loaded'])
    expect(m.copies(1, plain)).toEqual([])
  })
})

// design-web.md §9.9: a server's in-page notices are clicked and dismissed from a browser view, for a
// notice of the window main bound the view to; the payload names only the notice.
describe('notices.click / notices.dismiss', () => {
  function notices(server: boolean) {
    const { ipc, router } = setup()
    const calls: string[] = []
    registerNoticeHandlers(router, {
      server,
      click: (windowId, requestId) => {
        calls.push(`click ${windowId} ${requestId}`)
        return requestId === 'n1'
      },
      dismiss: (windowId, requestId) => {
        calls.push(`dismiss ${windowId} ${requestId}`)
        return requestId === 'n1'
      }
    })
    return { ipc, router, calls }
  }
  const webA = (viewId: `web:${number}` = 'web:3') => webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, viewId, 'owner')

  it('in server mode a browser view settles a notice of its own window, whatever window the payload names', async () => {
    const { router, calls } = notices(true)
    await expect(router.dispatch(webA(), 'notices.click', { requestId: 'n1', windowId: 2 })).resolves.toBe(true)
    await expect(router.dispatch(webA('web:4'), 'notices.dismiss', { requestId: 'n1', projectId: PROJECT_B })).resolves.toBe(true)
    // An unknown id (or another window's, which the backend refuses by the bound window) is false.
    await expect(router.dispatch(webA(), 'notices.click', { requestId: 'other' })).resolves.toBe(false)
    expect(calls).toEqual(['click 1 n1', 'dismiss 1 n1', 'click 1 other'])
  })

  it('refuses a remote view on the desktop, and the desktop page (the hidden page) in both modes', async () => {
    for (const channel of ['notices.click', 'notices.dismiss']) {
      const desktop = notices(false)
      await expect(desktop.router.dispatch(webA(), channel, { requestId: 'n1' })).rejects.toThrow(/browser view of a server/)
      for (const server of [true, false]) {
        const { ipc, calls } = notices(server)
        await expect(ipc.invoke(channel, 11, [{ requestId: 'n1' }])).rejects.toThrow(/browser view of a server/)
        expect(calls).toEqual([])
      }
      expect(desktop.calls).toEqual([])
    }
  })

  it('refuses a malformed payload and the picker', async () => {
    const { ipc, router, calls } = notices(true)
    for (const payload of [undefined, {}, { requestId: 5 }, 'n1']) {
      await expect(router.dispatch(webA(), 'notices.click', payload)).rejects.toThrow(/notices\.click/)
    }
    await expect(ipc.invoke('notices.click', 13, [{ requestId: 'n1' }])).rejects.toThrow(/not a project window/)
    expect(calls).toEqual([])
  })
})

// design-web.md §9.9: a plugin's OAuth sign-in in server mode is settled by the failed redirect's
// address pasted in a browser view, for a sign-in of the window main bound the view to.
describe('oauth.paste', () => {
  function paste(server: boolean, settles = true) {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    registerOAuthPasteHandlers(router, {
      server,
      paste: (windowId, signIn, url) => {
        calls.push([windowId, signIn, url])
        return settles
      }
    })
    return { ipc, router, calls }
  }
  const webA = (viewId: `web:${number}` = 'web:3') => webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, viewId, 'owner')
  const PASTE = { signIn: 'S'.repeat(22), url: 'http://127.0.0.1:4100/callback?state=s&code=c' }
  const REFUSED = { ok: false, error: OAUTH_PASTE_REFUSED }

  it('in server mode a browser view pastes for its own window, whatever window the payload names', async () => {
    const { router, calls } = paste(true)
    await expect(router.dispatch(webA(), 'oauth.paste', { ...PASTE, windowId: 2, projectId: PROJECT_B })).resolves.toEqual({ ok: true })
    expect(calls).toEqual([[1, PASTE.signIn, PASTE.url]])
    // PluginOAuth's refusal (unknown or another window's id, a wrong address) is the one text.
    const refusing = paste(true, false)
    await expect(refusing.router.dispatch(webA(), 'oauth.paste', PASTE)).resolves.toEqual(REFUSED)
  })

  it('answers a remote view on the desktop and the desktop page in both modes with the same refusal, reaching nothing', async () => {
    const desktop = paste(false)
    await expect(desktop.router.dispatch(webA(), 'oauth.paste', PASTE)).resolves.toEqual(REFUSED)
    expect(desktop.calls).toEqual([])
    for (const server of [true, false]) {
      const { ipc, calls } = paste(server)
      await expect(ipc.invoke('oauth.paste', 11, [PASTE])).resolves.toEqual(REFUSED)
      expect(calls).toEqual([])
    }
  })

  it('passes a malformed payload on unread (PluginOAuth refuses it) and never echoes the address', async () => {
    const { router, calls } = paste(true, false)
    for (const payload of [undefined, 'x', [PASTE], { signIn: 5, url: PASTE.url }]) {
      const answer = await router.dispatch(webA(), 'oauth.paste', payload)
      expect(answer).toEqual(REFUSED)
      expect(JSON.stringify(answer)).not.toContain('127.0.0.1')
    }
    expect(calls.map((c) => c[0])).toEqual([1, 1, 1, 1])
    expect(calls[0]).toEqual([1, undefined, undefined])
  })

  it('refuses the picker', async () => {
    const { ipc, calls } = paste(true)
    await expect(ipc.invoke('oauth.paste', 13, [PASTE])).rejects.toThrow(/not a project window/)
    expect(calls).toEqual([])
  })
})

// design-web-browser.md §3.2 (plan 20261111-streamed-webviews.md Task 4): a server's browser views
// report their webview panels and ask "Fit to this screen". `adapted`: only from a remote view, only
// in server mode, the panel resolved in the caller's own project, the window and view main's.
describe('registerWebviewHandlers: webviews.place and webviews.fit', () => {
  const A_CTX = { kind: 'project', windowId: 1, projectId: PROJECT_A } as const
  const B_CTX = { kind: 'project', windowId: 2, projectId: PROJECT_B } as const
  const place = { panelKey: 'a.one/view', width: 800, height: 600, visible: true, hidden: false }

  function webviewSetup(options: { server?: boolean; viewers?: boolean } = {}): {
    ipc: FakeIpcMain
    router: IpcRouter
    calls: unknown[][]
    open: Map<number, string>
  } {
    const { ipc, router, open } = setup()
    const calls: unknown[][] = []
    registerWebviewHandlers(router, {
      // Project A has the webview panel a.one/view; project B has none.
      panel: (projectId, panelKey) => (projectId === PROJECT_A && panelKey === 'a.one/view' ? { pluginId: 'a.one', panelId: 'view' } : undefined),
      views: {
        setPlacement: (...args) => void calls.push(['placement', ...args]),
        back: () => {},
        forward: () => {},
        reload: () => {},
        current: () => ({ url: '', title: '' })
      },
      server: options.server ?? true,
      ...(options.viewers === false
        ? {}
        : {
            viewers: {
              report: (panel, viewId, report) => void calls.push(['report', panel, viewId, report]),
              claimOwner: (panel, viewId) => void calls.push(['claim', panel, viewId]),
              leave: (windowId, viewId, panelKey) => void calls.push(['leave', windowId, viewId, panelKey])
            }
          })
    })
    return { ipc, router, calls, open }
  }

  it('are adapted', () => {
    expect(REMOTE_CLASS['webviews.place']).toBe('adapted')
    expect(REMOTE_CLASS['webviews.fit']).toBe('adapted')
    // The desktop's own placement stays the host's.
    expect(REMOTE_CLASS['webviews.placement']).toBe('no')
  })

  it("passes a server browser's report on with main's window, panel and view, never the payload's", async () => {
    const { router, calls } = webviewSetup()
    const forged = { ...place, windowId: 2, viewId: 'web:99', pluginId: 'x', panelId: 'y', projectId: PROJECT_B }
    await router.dispatch(webCaller(A_CTX, 'web:3', 'owner'), 'webviews.place', forged)
    // Sizes go on as sent: the viewers clamp them (webview-viewers.ts).
    await router.dispatch(webCaller(A_CTX, 'web:3', 'owner'), 'webviews.place', { ...place, width: 0, height: 1e9, hidden: true })
    await router.dispatch(webCaller(A_CTX, 'web:3', 'owner'), 'webviews.fit', { panelKey: 'a.one/view', viewId: 'web:4' })
    const panel = { windowId: 1, pluginId: 'a.one', panelId: 'view' }
    expect(calls).toEqual([
      ['report', panel, 'web:3', { width: 800, height: 600, visible: true, hidden: false }],
      ['report', panel, 'web:3', { width: 0, height: 1e9, visible: true, hidden: true }],
      ['claim', panel, 'web:3']
    ])
  })

  it('refuses the desktop page and the hidden page, and a browser outside server mode', async () => {
    const server = webviewSetup()
    // webContents 11 is window 1's own page: the desktop's, or in server mode the hidden page.
    await expect(server.ipc.invoke('webviews.place', 11, [place])).rejects.toThrow(/only a browser view of a server/)
    await expect(server.ipc.invoke('webviews.fit', 11, [{ panelKey: 'a.one/view' }])).rejects.toThrow(/only a browser view of a server/)
    expect(server.calls).toEqual([])

    const desktop = webviewSetup({ server: false })
    await expect(desktop.router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.place', place)).rejects.toThrow(/only a browser view of a server/)
    await expect(desktop.router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.fit', { panelKey: 'a.one/view' })).rejects.toThrow(
      /only a browser view of a server/
    )
    await expect(desktop.ipc.invoke('webviews.place', 11, [place])).rejects.toThrow(/only a browser view of a server/)
    expect(desktop.calls).toEqual([])

    // Wired without viewers: refused too (fail closed).
    const none = webviewSetup({ viewers: false })
    await expect(none.router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.place', place)).rejects.toThrow(/only a browser view of a server/)
  })

  it('checks the payload: finite numbers and booleans', async () => {
    const { router, calls } = webviewSetup()
    const caller = webCaller(A_CTX, 'web:1', 'owner')
    for (const bad of [
      { ...place, width: Number.NaN },
      { ...place, height: Infinity },
      { ...place, width: -Infinity },
      { ...place, width: '800' },
      { ...place, height: undefined }
    ]) {
      await expect(router.dispatch(caller, 'webviews.place', bad)).rejects.toThrow(/finite numbers/)
    }
    await expect(router.dispatch(caller, 'webviews.place', { ...place, visible: 'yes' })).rejects.toThrow(/booleans/)
    await expect(router.dispatch(caller, 'webviews.place', { ...place, hidden: 1 })).rejects.toThrow(/booleans/)
    await expect(router.dispatch(caller, 'webviews.place', 'nope')).rejects.toThrow(/bad payload/)
    await expect(router.dispatch(caller, 'webviews.fit', null)).rejects.toThrow(/bad payload/)
    expect(calls).toEqual([])
  })

  // design-web-browser.md §3.5 (Task 6): the toolbar is `adapted` the same way, the desktop page unchanged.
  it('the toolbar: step and current from a server browser, through its own window; refused from a desktop browser', async () => {
    const { ipc, router } = setup()
    const steps: unknown[][] = []
    const deps = (server: boolean): Parameters<typeof registerWebviewHandlers>[1] => ({
      panel: (projectId, panelKey) => (projectId === PROJECT_A && panelKey === 'a.one/view' ? { pluginId: 'a.one', panelId: 'view' } : undefined),
      views: {
        setPlacement: () => {},
        back: (o) => void steps.push(['back', o]),
        forward: (o) => void steps.push(['forward', o]),
        reload: (o) => void steps.push(['reload', o]),
        current: (o) => ({ url: `https://w${o.windowId}.test/`, title: '' })
      },
      server
    })
    registerWebviewHandlers(router, deps(true))
    expect(REMOTE_CLASS['webviews.step']).toBe('adapted')
    expect(REMOTE_CLASS['webviews.current']).toBe('adapted')
    expect(REMOTE_CLASS['webviews.navigated']).toBe('adapted')
    const forged = { panelKey: 'a.one/view', step: 'back', windowId: 2, projectId: PROJECT_B }
    await router.dispatch(webCaller(A_CTX, 'web:3', 'owner'), 'webviews.step', forged)
    await expect(router.dispatch(webCaller(A_CTX, 'web:3', 'owner'), 'webviews.current', { panelKey: 'a.one/view', windowId: 2 })).resolves.toEqual({
      url: 'https://w1.test/',
      title: ''
    })
    expect(steps).toEqual([['back', { windowId: 1, projectId: PROJECT_A, pluginId: 'a.one', panelId: 'view' }]])
    // Another window's browser naming this project's key: not a panel of its project.
    await expect(router.dispatch(webCaller(B_CTX, 'web:5', 'owner'), 'webviews.step', { panelKey: 'a.one/view', step: 'reload' })).rejects.toThrow(
      /not a webview panel/
    )
    // The desktop page (here the hidden page) keeps its toolbar.
    await ipc.invoke('webviews.step', 11, [{ panelKey: 'a.one/view', step: 'forward' }])
    expect(steps).toHaveLength(2)

    const desktop = setup()
    registerWebviewHandlers(desktop.router, deps(false))
    await expect(desktop.router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.step', { panelKey: 'a.one/view', step: 'reload' })).rejects.toThrow(
      /only a browser view of a server/
    )
    await expect(desktop.router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.current', { panelKey: 'a.one/view' })).rejects.toThrow(
      /only a browser view of a server/
    )
    await desktop.ipc.invoke('webviews.step', 11, [{ panelKey: 'a.one/view', step: 'reload' }])
    expect(steps).toHaveLength(3)
  })

  it("a view of another window naming the key reaches only its own window: refused, and only its own entry may leave", async () => {
    const { router, calls } = webviewSetup()
    // Project B has no such panel: refused; the unmount path touches B's window and this view only.
    await expect(router.dispatch(webCaller(B_CTX, 'web:5', 'owner'), 'webviews.place', place)).rejects.toThrow(/not a webview panel of this project/)
    await expect(router.dispatch(webCaller(B_CTX, 'web:5', 'owner'), 'webviews.fit', { panelKey: 'a.one/view' })).rejects.toThrow(
      /not a webview panel of this project/
    )
    // A key that is not a webview panel of the caller's own project (a core panel, a made-up one).
    await expect(router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.place', { ...place, panelKey: 'core/sessions' })).rejects.toThrow(
      /not a webview panel/
    )
    await expect(router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.place', { ...place, panelKey: 42 })).rejects.toThrow(/not a webview panel/)
    expect(calls).toEqual([
      ['leave', 2, 'web:5', 'a.one/view'],
      ['leave', 1, 'web:1', 'core/sessions']
    ])
  })

  it('refuses a browser whose window closed', async () => {
    const { router, calls, open } = webviewSetup()
    await router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.place', place)
    open.delete(1)
    await expect(router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.place', place)).rejects.toThrow(/refused/)
    await expect(router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.fit', { panelKey: 'a.one/view' })).rejects.toThrow(/refused/)
    expect(calls).toHaveLength(1)
  })

  // Task 7 (design-web-browser.md §4.1): input into the streamed page, the same gate.
  describe('webviews.input', () => {
    const events = [{ kind: 'pointer', type: 'move', x: 1, y: 1 }]
    function inputSetup(options: { server?: boolean; input?: boolean } = {}) {
      const { ipc, router } = setup()
      const accepted: unknown[][] = []
      registerWebviewHandlers(router, {
        panel: (projectId, panelKey) => (projectId === PROJECT_A && panelKey === 'a.one/view' ? { pluginId: 'a.one', panelId: 'view' } : undefined),
        views: { setPlacement: () => {}, back: () => {}, forward: () => {}, reload: () => {}, current: () => ({ url: '', title: '' }) },
        server: options.server ?? true,
        ...(options.input === false ? {} : {
              input: {
                accept: (panel, viewId, raw) => {
                  accepted.push([panel, viewId, raw])
                  return 0
                },
                acceptText: (panel, viewId, raw) => {
                  accepted.push(['text', panel, viewId, raw])
                  return true
                },
                acceptChoice: (panel, viewId, id, index) => {
                  accepted.push(['choose', panel, viewId, id, index])
                  return true
                }
              }
            })
      })
      return { ipc, router, accepted }
    }

    it('is adapted, and passes main\'s window, panel and view with the raw events', async () => {
      expect(REMOTE_CLASS['webviews.input']).toBe('adapted')
      expect(REMOTE_CLASS['webviews.cursor']).toBe('adapted')
      const { router, accepted } = inputSetup()
      await router.dispatch(webCaller(A_CTX, 'web:3', 'owner'), 'webviews.input', { panelKey: 'a.one/view', events, windowId: 2, viewId: 'web:9' })
      expect(accepted).toEqual([[{ windowId: 1, pluginId: 'a.one', panelId: 'view' }, 'web:3', events]])
    })

    it('refuses the desktop page, the hidden page, a browser outside server mode, and no gate', async () => {
      const server = inputSetup()
      await expect(server.ipc.invoke('webviews.input', 11, [{ panelKey: 'a.one/view', events }])).rejects.toThrow(/only a browser view of a server/)
      const desktop = inputSetup({ server: false })
      await expect(desktop.router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.input', { panelKey: 'a.one/view', events })).rejects.toThrow(
        /only a browser view of a server/
      )
      const none = inputSetup({ input: false })
      await expect(none.router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.input', { panelKey: 'a.one/view', events })).rejects.toThrow(
        /only a browser view of a server/
      )
      expect([...server.accepted, ...desktop.accepted, ...none.accepted]).toEqual([])
    })

    it("refuses a key that is no webview panel of the caller's own project (another window's view naming it)", async () => {
      const { router, accepted } = inputSetup()
      await expect(router.dispatch(webCaller(B_CTX, 'web:5', 'owner'), 'webviews.input', { panelKey: 'a.one/view', events })).rejects.toThrow(
        /not a webview panel of this project/
      )
      await expect(router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.input', { panelKey: 'core/sessions', events })).rejects.toThrow(
        /not a webview panel/
      )
      await expect(router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.input', null)).rejects.toThrow(/bad payload/)
      expect(accepted).toEqual([])
    })

    // Task 8 (§4.2): text into the streamed page, by the same gate.
    it('webviews.insertText: adapted, the same gate, main\'s window, panel and view with the raw text', async () => {
      expect(REMOTE_CLASS['webviews.insertText']).toBe('adapted')
      expect(REMOTE_CLASS['webviews.selection']).toBe('adapted')
      const { router, ipc, accepted } = inputSetup()
      await router.dispatch(webCaller(A_CTX, 'web:3', 'owner'), 'webviews.insertText', { panelKey: 'a.one/view', text: 'héllo', windowId: 2, viewId: 'web:9' })
      expect(accepted).toEqual([['text', { windowId: 1, pluginId: 'a.one', panelId: 'view' }, 'web:3', 'héllo']])
      accepted.length = 0
      await expect(ipc.invoke('webviews.insertText', 11, [{ panelKey: 'a.one/view', text: 'x' }])).rejects.toThrow(/only a browser view of a server/)
      const desktop = inputSetup({ server: false })
      await expect(desktop.router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.insertText', { panelKey: 'a.one/view', text: 'x' })).rejects.toThrow(
        /only a browser view of a server/
      )
      const none = inputSetup({ input: false })
      await expect(none.router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.insertText', { panelKey: 'a.one/view', text: 'x' })).rejects.toThrow(
        /only a browser view of a server/
      )
      await expect(router.dispatch(webCaller(B_CTX, 'web:5', 'owner'), 'webviews.insertText', { panelKey: 'a.one/view', text: 'x' })).rejects.toThrow(
        /not a webview panel of this project/
      )
      expect([...accepted, ...desktop.accepted, ...none.accepted]).toEqual([])
    })

    // Task 9 (§4.4): a select popup's answer, by the same gate; the id and index go to the gate raw.
    it('webviews.selectChoose: adapted, the same gate, main\'s window, panel and view', async () => {
      expect(REMOTE_CLASS['webviews.selectChoose']).toBe('adapted')
      expect(REMOTE_CLASS['webviews.select']).toBe('adapted')
      const { router, ipc, accepted } = inputSetup()
      await router.dispatch(webCaller(A_CTX, 'web:3', 'owner'), 'webviews.selectChoose', { panelKey: 'a.one/view', id: 'x', index: 2, viewId: 'web:9' })
      expect(accepted).toEqual([['choose', { windowId: 1, pluginId: 'a.one', panelId: 'view' }, 'web:3', 'x', 2]])
      accepted.length = 0
      const choose = { panelKey: 'a.one/view', id: 'x', index: null }
      await expect(ipc.invoke('webviews.selectChoose', 11, [choose])).rejects.toThrow(/only a browser view of a server/)
      const desktop = inputSetup({ server: false })
      await expect(desktop.router.dispatch(webCaller(A_CTX, 'web:1', 'owner'), 'webviews.selectChoose', choose)).rejects.toThrow(/only a browser view of a server/)
      await expect(router.dispatch(webCaller(B_CTX, 'web:5', 'owner'), 'webviews.selectChoose', choose)).rejects.toThrow(/not a webview panel of this project/)
      expect([...accepted, ...desktop.accepted]).toEqual([])
    })
  })
})

// Remote desktop (design-remote-desktop.md §3): the picker's `remote.*` calls dial out over SSH and
// keep device cookies, so only the desktop picker page reaches them; payloads are checked by hand.
describe('remote server handlers', () => {
  const PICKER = 13
  function remoteSetup(withService = true): { ipc: FakeIpcMain; router: IpcRouter; calls: unknown[][] } {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    const deps: RemoteServerHandlerDeps = {
      list: async () => {
        calls.push(['list'])
        return []
      },
      connect: async (request) => {
        calls.push(['connect', request])
        return { ok: true, serverId: 's1' }
      },
      open: async (serverId, projectId, answers) => {
        calls.push(answers === undefined ? ['open', serverId, projectId] : ['open', serverId, projectId, answers])
        return { ok: true, serverId }
      },
      edit: async (request) => {
        calls.push(['edit', request])
        return { ok: true, serverId: request.serverId }
      },
      pickKey: async (windowId) => {
        calls.push(['pickKey', windowId])
        return '/home/me/.ssh/id_work'
      },
      rename: (serverId, name) => {
        calls.push(['rename', serverId, name])
        return { ok: true }
      },
      forget: async (serverId) => {
        calls.push(['forget', serverId])
      }
    }
    registerRemoteServerHandlers(router, withService ? deps : undefined)
    return { ipc, router, calls }
  }

  it('answers the picker page', async () => {
    const { ipc, calls } = remoteSetup()
    await expect(ipc.invoke('remote.list', PICKER)).resolves.toEqual([])
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'ssh', host: 'devbox', ccc: '/opt/ccc', name: 'Dev' }])).resolves.toEqual({ ok: true, serverId: 's1' })
    await ipc.invoke('remote.connect', PICKER, [{ kind: 'direct', link: 'https://box/#t=x' }])
    await ipc.invoke('remote.open', PICKER, [{ serverId: 's1', projectId: 'p1' }])
    await ipc.invoke('remote.open', PICKER, [{ serverId: 's1' }])
    await ipc.invoke('remote.rename', PICKER, [{ serverId: 's1', name: 'Home' }])
    await ipc.invoke('remote.forget', PICKER, [{ serverId: 's1' }])
    await ipc.invoke('remote.connect', PICKER, [
      { kind: 'ssh', host: 'devbox', user: 'me', port: 2222, auth: { kind: 'key', path: '~/.ssh/k' }, answers: { hostKey: 'SHA256:x', passphrase: 'p', remember: true } }
    ])
    await ipc.invoke('remote.connect', PICKER, [{ kind: 'tunnel', localPort: 7331, remotePort: 7330, sshHost: 'devbox', link: 'http://127.0.0.1:7330/#t=t' }])
    await ipc.invoke('remote.open', PICKER, [{ serverId: 's1', answers: { password: 'pw' } }])
    await expect(ipc.invoke('remote.edit', PICKER, [{ serverId: 's1', kind: 'ssh', host: 'devbox', auth: { kind: 'password' } }])).resolves.toEqual({ ok: true, serverId: 's1' })
    await ipc.invoke('remote.edit', PICKER, [{ serverId: 's1', kind: 'ssh', host: 'devbox', forgetHostKey: true }])
    await expect(ipc.invoke('remote.pickKey', PICKER)).resolves.toBe('/home/me/.ssh/id_work')
    expect(calls).toEqual([
      ['list'],
      ['connect', { kind: 'ssh', host: 'devbox', ccc: '/opt/ccc', name: 'Dev' }],
      ['connect', { kind: 'direct', link: 'https://box/#t=x' }],
      ['open', 's1', 'p1'],
      ['open', 's1', undefined],
      ['rename', 's1', 'Home'],
      ['forget', 's1'],
      ['connect', { kind: 'ssh', host: 'devbox', user: 'me', port: 2222, auth: { kind: 'key', path: '~/.ssh/k' }, answers: { hostKey: 'SHA256:x', passphrase: 'p', remember: true } }],
      ['connect', { kind: 'tunnel', localPort: 7331, remotePort: 7330, sshHost: 'devbox', link: 'http://127.0.0.1:7330/#t=t' }],
      ['open', 's1', undefined, { password: 'pw' }],
      ['edit', { kind: 'ssh', host: 'devbox', auth: { kind: 'password' }, serverId: 's1' }],
      ['edit', { kind: 'ssh', host: 'devbox', serverId: 's1', forgetHostKey: true }],
      // The dialog is a sheet on the window main resolved for the sender (13 is window 3), never one from the payload.
      ['pickKey', 3]
    ])
  })

  it("passes a Direct connect's certificate answer through (D-29: main checks it), bounded; a tunnel's answers are ignored", async () => {
    const { ipc, calls } = remoteSetup()
    const shown = '01:23:45:67:89:AB:CD:EF:'.repeat(4).slice(0, -1)
    await ipc.invoke('remote.connect', PICKER, [{ kind: 'direct', link: 'https://box/#i=x&c=y', answers: { certificate: shown } }])
    await ipc.invoke('remote.connect', PICKER, [{ kind: 'tunnel', localPort: 7331, remotePort: 7330, answers: { certificate: shown } }])
    expect(calls).toEqual([
      ['connect', { kind: 'direct', link: 'https://box/#i=x&c=y', answers: { certificate: shown } }],
      ['connect', { kind: 'tunnel', localPort: 7331, remotePort: 7330 }]
    ])
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'direct', link: 'https://box', answers: { certificate: 'a'.repeat(129) } }])).rejects.toThrow(/certificate must be a string/)
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'direct', link: 'https://box', answers: { certificate: 5 } }])).rejects.toThrow(/certificate must be a string/)
  })

  it.each(['remote.list', 'remote.connect', 'remote.open', 'remote.edit', 'remote.pickKey', 'remote.rename', 'remote.forget'])(
    '%s is refused to a project window and to a browser view, before the service runs',
    async (channel) => {
      const { ipc, router, calls } = remoteSetup()
      const payload = { kind: 'ssh', host: 'devbox', serverId: 's1', name: 'x' }
      await expect(ipc.invoke(channel, 11, [payload])).rejects.toThrow(/only the project picker/)
      await expect(router.dispatch(webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:1', 'owner'), channel, payload)).rejects.toThrow(/refused/)
      // A subframe of the picker page (the isolation already broke) is refused too.
      await expect(ipc.invoke(channel, PICKER, [payload], { parent: {}, url: APP_PAGE })).rejects.toThrow(/refused/)
      expect(calls).toEqual([])
    }
  )

  it('refuses every call in server mode (no service), even from the picker', async () => {
    const { ipc } = remoteSetup(false)
    await expect(ipc.invoke('remote.list', PICKER)).rejects.toThrow(/not available in server mode/)
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'ssh', host: 'devbox' }])).rejects.toThrow(/not available in server mode/)
  })

  it('checks payload shapes by hand', async () => {
    const { ipc, calls } = remoteSetup()
    await expect(ipc.invoke('remote.connect', PICKER, [])).rejects.toThrow(/bad payload/)
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'telnet', host: 'x' }])).rejects.toThrow(/kind must be/)
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'ssh', host: 'h', port: '22' }])).rejects.toThrow(/port must be a whole number/)
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'ssh', host: 'h', auth: { kind: 'cert' } }])).rejects.toThrow(/auth.kind must be/)
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'ssh', host: 'h', auth: { kind: 'key' } }])).rejects.toThrow(/path must be a string/)
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'ssh', host: 'h', answers: { password: 7 } }])).rejects.toThrow(/password must be a string/)
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'ssh', host: 'h', answers: { password: 'x'.repeat(1025) } }])).rejects.toThrow(/password must be a string/)
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'ssh', host: 'h', answers: { remember: 'yes' } }])).rejects.toThrow(/remember must be a boolean/)
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'tunnel', localPort: 1.5, remotePort: 7330 }])).rejects.toThrow(/localPort must be a whole number/)
    await expect(ipc.invoke('remote.open', PICKER, [{ serverId: 's', answers: 'pw' }])).rejects.toThrow(/bad payload/)
    await expect(ipc.invoke('remote.edit', PICKER, [{ kind: 'direct', link: 'https://box' }])).rejects.toThrow(/serverId must be a string/)
    await expect(ipc.invoke('remote.edit', PICKER, [{ serverId: 's', kind: 'ssh', host: 'h', forgetHostKey: 'yes' }])).rejects.toThrow(/forgetHostKey must be a boolean/)
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'ssh', host: 7 }])).rejects.toThrow(/host must be a string/)
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'ssh', host: 'h', ccc: 1 }])).rejects.toThrow(/ccc must be a string/)
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'direct', link: 'x'.repeat(5000) }])).rejects.toThrow(/link must be a string/)
    await expect(ipc.invoke('remote.connect', PICKER, [{ kind: 'direct', link: 'https://box', name: null }])).rejects.toThrow(/name must be a string/)
    await expect(ipc.invoke('remote.open', PICKER, [{ serverId: 1 }])).rejects.toThrow(/serverId must be a string/)
    await expect(ipc.invoke('remote.open', PICKER, [{ serverId: 's', projectId: {} }])).rejects.toThrow(/projectId must be a string/)
    await expect(ipc.invoke('remote.rename', PICKER, [{ serverId: 's' }])).rejects.toThrow(/name must be a string/)
    await expect(ipc.invoke('remote.forget', PICKER, ['s1'])).rejects.toThrow(/bad payload/)
    // Only the fields named are passed on: an extra field never reaches the service.
    await ipc.invoke('remote.connect', PICKER, [{ kind: 'direct', link: 'https://box', origin: 'http://evil' }])
    // Answers ride on an SSH connect (a Direct one carries only a certificate); extra answer fields are dropped too.
    await ipc.invoke('remote.connect', PICKER, [{ kind: 'direct', link: 'https://box', answers: { password: 'x' } }])
    await ipc.invoke('remote.connect', PICKER, [{ kind: 'ssh', host: 'h', answers: { password: 'x', cookie: 'c' } }])
    expect(calls).toEqual([
      ['connect', { kind: 'direct', link: 'https://box' }],
      ['connect', { kind: 'direct', link: 'https://box' }],
      ['connect', { kind: 'ssh', host: 'h', answers: { password: 'x' } }]
    ])
  })

  it('every remote channel is no-class', () => {
    for (const channel of ['remote.list', 'remote.connect', 'remote.open', 'remote.edit', 'remote.pickKey', 'remote.rename', 'remote.forget', 'remote.changed'] as const) {
      expect(REMOTE_CLASS[channel]).toBe('no')
    }
  })
})

describe('registerGroupHandlers', () => {
  function groupsSetup(): { ipc: FakeIpcMain; router: IpcRouter; calls: unknown[][] } {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    const ok = { ok: true as const, seq: 7 }
    const rec =
      (name: string, result: unknown = ok) =>
      (...args: unknown[]) => {
        calls.push([name, ...args])
        return result
      }
    registerGroupHandlers(router, {
      get: rec('get', { seq: 1, order: [], groups: [] }) as GroupHandlerDeps['get'],
      place: rec('place') as GroupHandlerDeps['place'],
      remove: rec('remove') as GroupHandlerDeps['remove'],
      dissolve: rec('dissolve') as GroupHandlerDeps['dissolve'],
      resize: rec('resize') as GroupHandlerDeps['resize'],
      rename: rec('rename') as GroupHandlerDeps['rename']
    })
    return { ipc, router, calls }
  }

  it("acts on the sender's own project, for the desktop and a browser view alike (all `yes`, D12)", async () => {
    const { ipc, router, calls } = groupsSetup()
    const web = webCaller({ kind: 'project', windowId: 2, projectId: PROJECT_B }, 'web:4', 'owner')
    await expect(ipc.invoke('groups.get', 11, [{ projectId: PROJECT_B }])).resolves.toEqual({ seq: 1, order: [], groups: [] })
    await expect(ipc.invoke('groups.place', 11, [{ tabId: 'a', at: 'b', edge: 'left', projectId: PROJECT_B }])).resolves.toEqual({ ok: true, seq: 7 })
    await router.dispatch(web, 'groups.remove', { tabId: 'a' })
    await router.dispatch(web, 'groups.dissolve', { groupId: 'g1' })
    await router.dispatch(web, 'groups.resize', { groupId: 'g1', splitId: 's1', sizes: [0.3, 0.7] })
    await ipc.invoke('groups.rename', 12, [{ groupId: 'g1', name: null }])
    await ipc.invoke('groups.rename', 12, [{ groupId: 'g1', name: 'dev' }])
    expect(calls).toEqual([
      ['get', PROJECT_A],
      ['place', PROJECT_A, { tabId: 'a', at: 'b', edge: 'left' }],
      ['remove', PROJECT_B, 'a'],
      ['dissolve', PROJECT_B, 'g1'],
      ['resize', PROJECT_B, 'g1', 's1', [0.3, 0.7]],
      ['rename', PROJECT_B, 'g1', null],
      ['rename', PROJECT_B, 'g1', 'dev']
    ])
    for (const ch of ['groups.get', 'groups.place', 'groups.remove', 'groups.dissolve', 'groups.resize', 'groups.rename', 'groups.changed']) {
      expect(REMOTE_CLASS[ch as keyof typeof REMOTE_CLASS]).toBe('yes')
    }
  })

  it('refuses malformed payloads, the picker and unknown senders before calling the service', async () => {
    const { ipc, calls } = groupsSetup()
    const bad: Array<[string, unknown[]]> = [
      ['groups.place', [{ tabId: 'a', at: 'b' }]],
      ['groups.place', [{ tabId: 'a', at: 5, edge: 'left' }]],
      ['groups.place', [{ tabId: 'a', at: 'b', edge: 'middle' }]],
      ['groups.place', [null]],
      ['groups.remove', [{ tabId: 1 }]],
      ['groups.dissolve', [{}]],
      ['groups.resize', [{ groupId: 'g', splitId: 's', sizes: 'half' }]],
      ['groups.resize', [{ groupId: 'g', splitId: 's', sizes: [0.5, '0.5'] }]],
      ['groups.resize', [{ groupId: 'g', sizes: [0.5, 0.5] }]],
      ['groups.resize', [{ groupId: 'g', splitId: 's', sizes: new Array(100).fill(0.01) }]],
      ['groups.rename', [{ groupId: 'g', name: 5 }]],
      ['groups.rename', [{ name: 'x' }]]
    ]
    for (const [channel, args] of bad) {
      await expect(ipc.invoke(channel, 11, args), `${channel} ${JSON.stringify(args)}`).rejects.toThrow()
    }
    for (const sender of [13, 99]) await expect(ipc.invoke('groups.get', sender)).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe('room strip handlers (tabs.roomMark, rooms.deliverHeld)', () => {
  // The membership the strip showed when the person clicked (TabRoomRef).
  const ROOM = { id: '11111111-1111-4111-8111-111111111111', name: 'bob' }
  function roomSetup(options: { server?: boolean } = {}): {
    ipc: FakeIpcMain
    router: IpcRouter
    calls: unknown[][]
    members: Map<string, { id: string; name: string; mark: boolean }>
  } {
    const { ipc, router } = setup()
    const calls: unknown[][] = []
    // The memberships main would hold, all in ROOM as bob: t1 starts off, `marked` starts on.
    const members = new Map<string, { id: string; name: string; mark: boolean }>(
      ['t1', 't2', 'held', 'marked'].map((tabId) => [tabId, { ...ROOM, mark: tabId === 'marked' }])
    )
    registerRoomStripHandlers(router, {
      server: options.server === true,
      membershipOf: (_projectId, tabId) => {
        const member = members.get(tabId)
        return member ? { ...member } : undefined
      },
      roomMark: (projectId, tabId, mark) => {
        calls.push(['roomMark', projectId, tabId, mark])
        const member = members.get(tabId)
        if (member) member.mark = mark
        return mark
      },
      markTurnedOn: (projectId, tabId) => {
        calls.push(['markTurnedOn', projectId, tabId])
      },
      deliverHeld: (projectId, tabId, overDraft) => {
        calls.push(['deliverHeld', projectId, tabId, overDraft])
        return tabId === 'held' ? { delivered: true } : { delivered: false, why: 'paused' }
      }
    })
    return { ipc, router, calls, members }
  }

  it("acts on the sender's own project, the tab id looked up there, and answers main's result", async () => {
    const { ipc, calls } = roomSetup()
    expect(await ipc.invoke('tabs.roomMark', 11, [{ tabId: 't1', room: ROOM, mark: true, projectId: PROJECT_B }])).toBe(true)
    expect(await ipc.invoke('tabs.roomMark', 12, [{ tabId: 't2', room: ROOM, mark: false }])).toBe(false)
    expect(await ipc.invoke('rooms.deliverHeld', 11, [{ tabId: 'held', room: ROOM, projectId: PROJECT_B }])).toEqual({ delivered: true })
    expect(await ipc.invoke('rooms.deliverHeld', 11, [{ tabId: 't1', room: ROOM }])).toEqual({ delivered: false, why: 'paused' })
    expect(calls).toEqual([
      ['roomMark', PROJECT_A, 't1', true],
      ['markTurnedOn', PROJECT_A, 't1'],
      ['roomMark', PROJECT_B, 't2', false],
      ['deliverHeld', PROJECT_A, 'held', false],
      ['deliverHeld', PROJECT_A, 't1', false]
    ])
  })

  it('offers what waits again only when the mark goes from off to on', async () => {
    const { ipc, calls } = roomSetup()
    // Set again while on, cleared, cleared again: stored, nothing offered (turning delivery off must not deliver).
    expect(await ipc.invoke('tabs.roomMark', 11, [{ tabId: 'marked', room: ROOM, mark: true }])).toBe(true)
    expect(await ipc.invoke('tabs.roomMark', 11, [{ tabId: 'marked', room: ROOM, mark: false }])).toBe(false)
    expect(await ipc.invoke('tabs.roomMark', 11, [{ tabId: 'marked', room: ROOM, mark: false }])).toBe(false)
    expect(calls.filter((c) => c[0] === 'markTurnedOn')).toEqual([])
    // Off to on: offered once; on again: not.
    expect(await ipc.invoke('tabs.roomMark', 11, [{ tabId: 'marked', room: ROOM, mark: true }])).toBe(true)
    expect(await ipc.invoke('tabs.roomMark', 11, [{ tabId: 'marked', room: ROOM, mark: true }])).toBe(true)
    expect(calls.filter((c) => c[0] === 'markTurnedOn')).toEqual([['markTurnedOn', PROJECT_A, 'marked']])
  })

  it('refuses a stale request: the tab left the room the strip showed and joined another (or the name changed)', async () => {
    const { ipc, calls, members } = roomSetup()
    // The person toggled the mark on room A's entry; before main handled it, the tab left A and joined B as bob.
    const roomB = { id: '22222222-2222-4222-8222-222222222222', name: 'bob' }
    members.set('t1', { ...roomB, mark: false })
    members.set('held', { ...roomB, mark: false })
    await expect(ipc.invoke('tabs.roomMark', 11, [{ tabId: 't1', room: ROOM, mark: true }])).rejects.toThrow(/stale request/)
    expect(await ipc.invoke('rooms.deliverHeld', 11, [{ tabId: 'held', room: ROOM }])).toEqual({ delivered: false, why: 'no-room' })
    expect(await ipc.invoke('rooms.deliverHeld', 11, [{ tabId: 'held', room: ROOM, overDraft: true }])).toEqual({
      delivered: false,
      why: 'no-room'
    })
    // Same room, another member name: a new membership too.
    members.set('t2', { id: ROOM.id, name: 'carol', mark: false })
    await expect(ipc.invoke('tabs.roomMark', 11, [{ tabId: 't2', room: ROOM, mark: true }])).rejects.toThrow(/stale request/)
    // In no room at all.
    members.delete('marked')
    await expect(ipc.invoke('tabs.roomMark', 11, [{ tabId: 'marked', room: ROOM, mark: false }])).rejects.toThrow(/in no room/)
    expect(await ipc.invoke('rooms.deliverHeld', 11, [{ tabId: 'marked', room: ROOM }])).toEqual({ delivered: false, why: 'no-room' })
    expect(calls).toEqual([])
    expect(members.get('t1')?.mark).toBe(false)
    // The request made against B goes through.
    expect(await ipc.invoke('tabs.roomMark', 11, [{ tabId: 't1', room: roomB, mark: true }])).toBe(true)
    expect(calls).toEqual([
      ['roomMark', PROJECT_A, 't1', true],
      ['markTurnedOn', PROJECT_A, 't1']
    ])
  })

  it('refuses a missing or malformed room before main is asked', async () => {
    const { ipc, calls } = roomSetup()
    const bad: unknown[] = [undefined, null, 'room', [], {}, { id: ROOM.id }, { name: 'bob' }, { id: 1, name: 'bob' }, { id: '', name: 'bob' }]
    bad.push({ id: 'x'.repeat(65), name: 'bob' }, { id: ROOM.id, name: 'b'.repeat(65) })
    for (const room of bad) {
      await expect(ipc.invoke('tabs.roomMark', 11, [{ tabId: 't1', room, mark: true }]), JSON.stringify(room)).rejects.toThrow(/room/)
      await expect(ipc.invoke('rooms.deliverHeld', 11, [{ tabId: 'held', room }]), JSON.stringify(room)).rejects.toThrow(/room/)
    }
    expect(calls).toEqual([])
  })

  it('"Deliver anyway": overDraft true passes through, anything but true or absent is refused', async () => {
    const { ipc, calls } = roomSetup()
    expect(await ipc.invoke('rooms.deliverHeld', 11, [{ tabId: 'held', room: ROOM, overDraft: true }])).toEqual({ delivered: true })
    for (const overDraft of [false, 'true', 1, null]) {
      await expect(ipc.invoke('rooms.deliverHeld', 11, [{ tabId: 'held', room: ROOM, overDraft }])).rejects.toThrow(/overDraft must be true or absent/)
    }
    expect(calls).toEqual([['deliverHeld', PROJECT_A, 'held', true]])
  })

  it('refuses a mark that is not a boolean and a missing tab id before main is asked', async () => {
    const { ipc, calls } = roomSetup()
    for (const mark of ['true', 1, null, undefined]) {
      await expect(ipc.invoke('tabs.roomMark', 11, [{ tabId: 't1', room: ROOM, mark }])).rejects.toThrow(/mark must be true or false/)
    }
    await expect(ipc.invoke('tabs.roomMark', 11, [{ room: ROOM, mark: true }])).rejects.toThrow()
    await expect(ipc.invoke('rooms.deliverHeld', 11, [{ room: ROOM }])).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it("takes both from the shell page's top frame of a project window only (never a plugin panel or the picker)", async () => {
    const { ipc, calls } = roomSetup()
    await expect(ipc.invoke('tabs.roomMark', 11, [{ tabId: 't1', room: ROOM, mark: true }], { parent: {}, url: APP_PAGE })).rejects.toThrow(/refused/)
    await expect(ipc.invoke('rooms.deliverHeld', 11, [{ tabId: 't1', room: ROOM }], { parent: {}, url: APP_PAGE })).rejects.toThrow(/refused/)
    await expect(
      ipc.invoke('tabs.roomMark', 11, [{ tabId: 't1', room: ROOM, mark: true }], { parent: null, url: 'cc-plugin://example.plugin/panel.html' })
    ).rejects.toThrow()
    await expect(ipc.invoke('tabs.roomMark', 13, [{ tabId: 't1', room: ROOM, mark: true }])).rejects.toThrow(/not a project window/)
    await expect(ipc.invoke('rooms.deliverHeld', 13, [{ tabId: 't1', room: ROOM }])).rejects.toThrow(/not a project window/)
    expect(calls).toEqual([])
  })

  it("adapted: a desktop's browser is refused, a server's browser counts as the person", async () => {
    const browser = webCaller({ kind: 'project', windowId: 1, projectId: PROJECT_A }, 'web:5', 'owner')
    const desktop = roomSetup()
    await expect(desktop.router.dispatch(browser, 'tabs.roomMark', { tabId: 't1', room: ROOM, mark: true })).rejects.toThrow(/outside server mode/)
    await expect(desktop.router.dispatch(browser, 'rooms.deliverHeld', { tabId: 'held', room: ROOM })).rejects.toThrow(/outside server mode/)
    expect(desktop.calls).toEqual([])
    const server = roomSetup({ server: true })
    expect(await server.router.dispatch(browser, 'tabs.roomMark', { tabId: 't1', room: ROOM, mark: true })).toBe(true)
    expect(await server.router.dispatch(browser, 'rooms.deliverHeld', { tabId: 'held', room: ROOM })).toEqual({ delivered: true })
    expect(server.calls).toEqual([
      ['roomMark', PROJECT_A, 't1', true],
      ['markTurnedOn', PROJECT_A, 't1'],
      ['deliverHeld', PROJECT_A, 'held', false]
    ])
    expect(REMOTE_CLASS['tabs.roomMark']).toBe('adapted')
    expect(REMOTE_CLASS['rooms.deliverHeld']).toBe('adapted')
  })
})

describe('guest callers (design-guests §4; deny-all until task 03)', () => {
  const A_CTX = { kind: 'project', windowId: 1, projectId: PROJECT_A } as const
  it('refuses every channel to a guest view before the handler, read-class ones included', async () => {
    const { router, logs } = setup()
    let calls = 0
    router.handleProject('tabs.list', () => {
      calls++
      return []
    })
    router.handleWindow('window.info', () => {
      calls++
      return { kind: 'picker', home: '/h' }
    })
    router.handleProject('presence.get', () => {
      calls++
      return { seq: 0, people: [], lastTyped: {} }
    })
    const guest = webCaller(A_CTX, 'web:5', { guest: 'g1' })
    // Registered channels only: the handler lookup comes first, so an unregistered one answers "no handler".
    for (const channel of ['tabs.list', 'window.info', 'presence.get']) {
      await expect(router.dispatch(guest, channel, undefined), channel).rejects.toThrow(/refused/)
    }
    expect(calls).toBe(0)
    expect(logs.join('\n')).toMatch(/refused for guest view web:5/)
    // The owner's view of the same window is unchanged.
    await expect(router.dispatch(webCaller(A_CTX, 'web:6', 'owner'), 'tabs.list', undefined)).resolves.toEqual([])
  })
})
