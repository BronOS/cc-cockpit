// Uploads' channels through the router (design-upload.md §3.1, §6; plan Task 6): `uploads.begin`, `resolve`,
// `cancel`, `paste` and `folders` are `adapted`: served only to a browser view of the owner or a write guest, the
// view's device and window main's own (the connection), the source resolved in the caller's own project (a panel
// the layout places now, any kind; a Claude or shell tab), a guest's targets checked by GUEST_CLASS before the
// handler and its role read again after each await. The real Uploads, writer and LayoutService behind it.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UploadWriter } from '../../src/main/files/upload-writer'
import { Uploads, UPLOAD_UNKNOWN_TEXT, type UploadCaller } from '../../src/main/files/uploads'
import type { GuestService } from '../../src/main/ipc/guest-deps'
import {
  IpcRouter,
  registerUploadHandlers,
  UPLOAD_PANEL_REFUSED,
  UPLOAD_TAB_REFUSED,
  webCaller,
  type IpcEventLike,
  type IpcMainLike,
  type UploadHandlerDeps,
  type UploadPasteCall
} from '../../src/main/ipc/router'
import { LayoutService } from '../../src/main/layout/layout-service'
import type { SenderContext } from '../../src/main/windows/window-manager'
import type { GuestRole } from '../../src/shared/guests'
import { defaultLayout, type LayoutState } from '../../src/shared/layout'
import type { TabKind } from '../../src/shared/types'
import type { UploadBegun } from '../../src/shared/uploads'
import { remoteViewId, type ViewId, type Who } from '../../src/shared/views'

const APP_PAGE = 'file:///opt/cc-cockpit/out/renderer/index.html'
const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'
const FILES = 'cockpit.files/tree'
const CHANNELS = ['uploads.begin', 'uploads.resolve', 'uploads.cancel', 'uploads.paste', 'uploads.folders'] as const

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, Listener>()
  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener)
  }
  invoke(channel: string, senderId: number, payload: unknown): Promise<unknown> {
    const listener = this.handlers.get(channel)
    if (!listener) return Promise.reject(new Error(`no handler for ${channel}`))
    return Promise.resolve().then(() => listener({ sender: { id: senderId }, senderFrame: { parent: null, url: APP_PAGE } }, payload))
  }
}

let tmp: string
let projA: string
let projB: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-uploads-router-')))
  projA = join(tmp, 'a')
  projB = join(tmp, 'b')
  for (const d of [projA, join(projA, 'sub'), join(projA, 'sub', 'deep'), projB, join(tmp, 'data')]) mkdirSync(d)
  writeFileSync(join(projA, 'sub', 'taken.txt'), 'old')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

/** Views: the owner's browser on window 1 and on window 2 (one device), a write and a read guest of A. */
const OWNER = remoteViewId(1)
const WRITER = remoteViewId(2)
const READER = remoteViewId(3)
const OWNER_B = remoteViewId(4)

function setup(over: Partial<UploadHandlerDeps> = {}) {
  const ipc = new FakeIpcMain()
  // webContents 11 is window 1's desktop page (project A), 14 server mode's hidden page of window 2 (project B):
  // both Electron callers, so `view.remote` is false for them.
  const senders = new Map<number, SenderContext>([
    [11, { kind: 'project', windowId: 1, projectId: A }],
    [14, { kind: 'project', windowId: 2, projectId: B }]
  ])
  const open = new Map<number, string>([
    [1, A],
    [2, B]
  ])
  const router = new IpcRouter(ipc, (id) => senders.get(id), (url) => url === APP_PAGE, () => undefined, (w, p) => open.get(w) === p)
  const roles: Record<string, GuestRole> = { gW: 'write', gR: 'read' }
  const visiblePlugins = new Set(['cockpit.files'])
  const guests = {
    access: (who: Who) =>
      who === 'owner'
        ? { kind: 'owner' }
        : roles[who.guest]
          ? { kind: 'guest', id: who.guest, name: who.guest, role: roles[who.guest], projectId: A, scope: ['c1', 's1', 'pg'] }
          : { kind: 'revoked' },
    tabVisible: (_g: string, tabId: string) => ['c1', 's1', 'pg'].includes(tabId),
    pluginVisible: (projectId: string, pluginId: string) => projectId === A && visiblePlugins.has(pluginId)
  } as unknown as GuestService
  router.setGuestDeps({ guests })

  // The layout: Files (an html panel) placed in A, a hidden panel and a webview panel; B has none of them.
  const stored = new Map<string, LayoutState>([
    [A, { ...defaultLayout(), hidden: ['cockpit.notes/notes'] }],
    [B, defaultLayout()]
  ])
  const layouts = new LayoutService({ getLayout: (id) => stored.get(id), setLayout: (id, l) => stored.set(id, l), publish: () => {} })
  layouts.setPluginPanels(A, 'cockpit.files', [{ id: 'tree', title: 'Files', defaultZone: 'left', entry: 'panels/tree.html' }])
  layouts.setPluginPanels(A, 'cockpit.notes', [{ id: 'notes', title: 'Notes', defaultZone: 'right', entry: 'notes.html' }])
  layouts.setPluginPanels(A, 'cockpit.browser', [{ id: 'web', title: 'Browser', defaultZone: 'bottom', kind: 'webview' }])
  visiblePlugins.add('cockpit.notes')

  const tabs = new Map<string, Map<string, TabKind>>([
    [A, new Map<string, TabKind>([['c1', 'claude'], ['s1', 'shell'], ['pg', 'page'], ['cmd', 'command'], ['c2', 'claude']])],
    [B, new Map<string, TabKind>([['b1', 'claude']])]
  ])
  // main's view-to-device table: the owner's browser has one device for both windows.
  const devices = new Map<ViewId, { windowId: number; deviceId: string }>([
    [OWNER, { windowId: 1, deviceId: 'devO' }],
    [WRITER, { windowId: 1, deviceId: 'devW' }],
    [READER, { windowId: 1, deviceId: 'devR' }],
    [OWNER_B, { windowId: 2, deviceId: 'devO' }]
  ])
  const writer: UploadWriter = new UploadWriter({
    grants: () => uploads,
    projectRoot: (id) => (id === 1 ? projA : id === 2 ? projB : undefined),
    tempsFile: join(tmp, 'data', 'uploads', 'temps.json'),
    log: () => {}
  })
  const uploads: Uploads = new Uploads({
    projectRoot: (id) => (id === 1 ? projA : id === 2 ? projB : undefined),
    dataDir: join(tmp, 'data'),
    writer,
    statfs: async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }),
    platform: 'linux',
    log: () => {}
  })
  const calls: Array<[string, ...unknown[]]> = []
  const deps: UploadHandlerDeps = {
    deviceOf: (viewId, windowId) => {
      const d = devices.get(viewId)
      return d?.windowId === windowId ? d.deviceId : undefined
    },
    placedPanel: (projectId, panelKey) => layouts.placedPanel(projectId, panelKey),
    tabKind: (projectId, tabId) => tabs.get(projectId)?.get(tabId),
    begin: (caller, source, folder, files) => {
      calls.push(['begin', caller, source])
      return uploads.begin(caller, source, folder, files)
    },
    resolve: (caller, uploadId, choice) => {
      calls.push(['resolve', caller, uploadId])
      return uploads.resolve(caller, uploadId, choice)
    },
    cancel: (caller, uploadId) => {
      calls.push(['cancel', caller, uploadId])
      return uploads.cancel(caller, uploadId)
    },
    folders: (windowId, path) => {
      calls.push(['folders', windowId, path])
      return uploads.folders(windowId, path)
    },
    ...over
  }
  registerUploadHandlers(router, deps)
  const web = (view: ViewId, who: Who, windowId = 1) =>
    webCaller({ kind: 'project', windowId, projectId: windowId === 1 ? A : B }, view, who)
  return { ipc, router, roles, visiblePlugins, uploads, layouts, calls, devices, web }
}

const begin = (source: unknown, files: unknown = [{ name: 'a.txt', size: 3 }], folder = 'sub') => ({ source, folder, files })
const caller = (deviceId: string, windowId = 1): UploadCaller => ({ deviceId, windowId })

describe('uploads.*: who may call (design-upload.md §3.1, §6)', () => {
  it("refuses the desktop page and server mode's hidden page on every channel: neither is a browser's device", async () => {
    // A device lookup that would answer for any view: the browser-only gate alone must refuse the Electron pages.
    const { ipc, calls } = setup({ paste: () => ({ text: 'x ' }), deviceOf: () => 'devX' })
    const payloads = {
      'uploads.begin': begin({ panel: FILES }),
      'uploads.resolve': { uploadId: 'u', choice: 'cancel' },
      'uploads.cancel': { uploadId: 'u' },
      'uploads.paste': { uploadId: 'u' },
      'uploads.folders': { tab: 'c1', path: '' }
    }
    for (const sender of [11, 14]) {
      for (const channel of CHANNELS) {
        await expect(ipc.invoke(channel, sender, payloads[channel]), `${channel} from ${sender}`).rejects.toThrow(/refused/)
      }
    }
    expect(calls).toEqual([])
  })

  it("the owner's browser begins from the Files panel (an html panel) and from a Claude or shell tab", async () => {
    const { router, web, calls } = setup()
    const o = web(OWNER, 'owner')
    const fromPanel = (await router.dispatch(o, 'uploads.begin', begin({ panel: FILES }))) as UploadBegun
    expect(fromPanel.tokens).toHaveLength(1)
    expect(fromPanel.tokens?.[0]?.name).toBe('a.txt')
    // Cancelled as it goes: a device runs at most two uploads at once.
    await router.dispatch(o, 'uploads.cancel', { uploadId: fromPanel.uploadId })
    for (const tab of ['c1', 's1']) {
      const r = (await router.dispatch(o, 'uploads.begin', begin({ tab }, [{ name: `${tab}.png`, size: 1, pasted: true }]))) as UploadBegun
      expect(r.uploadId, tab).toEqual(expect.any(String))
      await router.dispatch(o, 'uploads.cancel', { uploadId: r.uploadId })
    }
    // The caller is main's: the device of the view, its window; never a payload's (a forged deviceId is ignored).
    await router.dispatch(o, 'uploads.begin', { ...begin({ tab: 'c1' }), deviceId: 'devW', windowId: 2 })
    expect(calls.filter((c) => c[0] === 'begin').map((c) => c[1])).toEqual([caller('devO'), caller('devO'), caller('devO'), caller('devO')])
  })

  it('a write guest may use every channel, from a visible plugin and a tab in its scope', async () => {
    const { router, web, uploads } = setup({ paste: (call) => ({ held: 'not at the prompt', text: String(call.guest) }) })
    const w = web(WRITER, { guest: 'gW' })
    const panel = (await router.dispatch(w, 'uploads.begin', begin({ panel: FILES }))) as UploadBegun
    expect(panel.tokens).toHaveLength(1)
    const clash = (await router.dispatch(w, 'uploads.begin', begin({ tab: 'c1' }, [{ name: 'taken.txt', size: 1 }]))) as UploadBegun
    expect(clash.clashes).toEqual([{ index: 0, name: 'taken.txt', replaceable: true }])
    await expect(router.dispatch(w, 'uploads.resolve', { uploadId: clash.uploadId, choice: 'keep-both' })).resolves.toEqual({
      tokens: [expect.objectContaining({ index: 0, name: 'taken (1).txt' })],
      refused: []
    })
    await expect(router.dispatch(w, 'uploads.cancel', { uploadId: clash.uploadId })).resolves.toBeUndefined()
    expect(uploads.outcome(caller('devW'), clash.uploadId)).toBeUndefined()
    await expect(router.dispatch(w, 'uploads.paste', { uploadId: panel.uploadId })).resolves.toEqual({ held: 'not at the prompt', text: 'true' })
    await expect(router.dispatch(w, 'uploads.folders', { tab: 's1', path: 'sub' })).resolves.toEqual({ folders: ['deep'], more: false })
  })

  it('refuses a read guest on every channel, before any handler runs', async () => {
    const { router, web, calls } = setup({ paste: () => ({ text: 'x ' }) })
    const r = web(READER, { guest: 'gR' })
    await expect(router.dispatch(r, 'uploads.begin', begin({ panel: FILES }))).rejects.toThrow(/refused/)
    await expect(router.dispatch(r, 'uploads.begin', begin({ tab: 'c1' }))).rejects.toThrow(/refused/)
    await expect(router.dispatch(r, 'uploads.resolve', { uploadId: 'u', choice: 'cancel' })).rejects.toThrow(/refused/)
    await expect(router.dispatch(r, 'uploads.cancel', { uploadId: 'u' })).rejects.toThrow(/refused/)
    await expect(router.dispatch(r, 'uploads.paste', { uploadId: 'u' })).rejects.toThrow(/refused/)
    await expect(router.dispatch(r, 'uploads.folders', { tab: 'c1', path: '' })).rejects.toThrow(/refused/)
    expect(calls).toEqual([])
  })

  it('refuses a view main cannot name a device for (gone, or bound to another window)', async () => {
    const { router, web, devices, calls } = setup()
    devices.delete(OWNER)
    await expect(router.dispatch(web(OWNER, 'owner'), 'uploads.begin', begin({ panel: FILES }))).rejects.toThrow(/refused/)
    devices.set(OWNER, { windowId: 2, deviceId: 'devO' })
    await expect(router.dispatch(web(OWNER, 'owner'), 'uploads.folders', { tab: 'c1', path: '' })).rejects.toThrow(/refused/)
    expect(calls).toEqual([])
  })
})

describe('uploads.begin: the source, resolved in the caller\'s own project', () => {
  it('a panel key the layout does not place now: undeclared, hidden, or of another project', async () => {
    const { router, web, calls } = setup()
    const o = web(OWNER, 'owner')
    for (const panel of ['cockpit.files/ghost', 'nobody/tree', 'cockpit.notes/notes', 'noslash']) {
      await expect(router.dispatch(o, 'uploads.begin', begin({ panel })), panel).resolves.toEqual({ error: UPLOAD_PANEL_REFUSED })
    }
    // Any kind the layout places counts (Files is html; a webview panel is placed too).
    await expect(router.dispatch(o, 'uploads.begin', begin({ panel: 'cockpit.browser/web' }))).resolves.toEqual(
      expect.objectContaining({ uploadId: expect.any(String) })
    )
    expect(calls.filter((c) => c[0] === 'begin')).toHaveLength(1)
  })

  it('a page tab, a command tab, an unknown tab or another project\'s is no source; nor a malformed source', async () => {
    const { router, web, calls } = setup()
    const o = web(OWNER, 'owner')
    for (const tab of ['pg', 'cmd', 'nope', 'b1']) {
      await expect(router.dispatch(o, 'uploads.begin', begin({ tab })), tab).resolves.toEqual({ error: UPLOAD_TAB_REFUSED })
    }
    for (const source of [undefined, {}, { panel: FILES, tab: 'c1' }, { tab: 3 }, 'c1']) {
      await expect(router.dispatch(o, 'uploads.begin', begin(source)), JSON.stringify(source)).rejects.toThrow(/bad source/)
    }
    expect(calls).toEqual([])
  })

  it("another window's view (the owner's same device) cannot name window 1's panel or tabs", async () => {
    const { router, web, calls } = setup()
    const other = web(OWNER_B, 'owner', 2)
    await expect(router.dispatch(other, 'uploads.begin', begin({ panel: FILES }))).resolves.toEqual({ error: UPLOAD_PANEL_REFUSED })
    await expect(router.dispatch(other, 'uploads.begin', begin({ tab: 'c1' }))).resolves.toEqual({ error: UPLOAD_TAB_REFUSED })
    await expect(router.dispatch(other, 'uploads.folders', { tab: 'c1', path: '' })).resolves.toEqual({ error: UPLOAD_TAB_REFUSED })
    expect(calls).toEqual([])
    // Its own tab works, in its own project.
    await expect(router.dispatch(other, 'uploads.folders', { tab: 'b1', path: '' })).resolves.toEqual({ folders: [], more: false })
    expect(calls).toEqual([['folders', 2, '']])
  })

  it("a guest: a plugin hidden from it, a tab outside its scope, a page tab in scope (refused by kind)", async () => {
    const { router, web, visiblePlugins, calls } = setup()
    const w = web(WRITER, { guest: 'gW' })
    visiblePlugins.delete('cockpit.files')
    await expect(router.dispatch(w, 'uploads.begin', begin({ panel: FILES }))).rejects.toThrow(/refused/)
    await expect(router.dispatch(w, 'uploads.begin', begin({ tab: 'c2' }))).rejects.toThrow(/refused/)
    await expect(router.dispatch(w, 'uploads.folders', { tab: 'c2', path: '' })).rejects.toThrow(/refused/)
    await expect(router.dispatch(w, 'uploads.begin', begin({ tab: 'pg' }))).resolves.toEqual({ error: UPLOAD_TAB_REFUSED })
    await expect(router.dispatch(w, 'uploads.folders', { tab: 'pg', path: '' })).resolves.toEqual({ error: UPLOAD_TAB_REFUSED })
    expect(calls).toEqual([])
  })
})

describe('upload ids and the role after an await', () => {
  it("an upload id answers only to the device that began it: another device's resolve and cancel do nothing", async () => {
    const { router, web, uploads } = setup()
    const mine = (await router.dispatch(web(OWNER, 'owner'), 'uploads.begin', begin({ tab: 'c1' }, [{ name: 'taken.txt', size: 1 }]))) as UploadBegun
    const w = web(WRITER, { guest: 'gW' })
    await expect(router.dispatch(w, 'uploads.resolve', { uploadId: mine.uploadId, choice: 'replace' })).resolves.toEqual({ error: UPLOAD_UNKNOWN_TEXT })
    await router.dispatch(w, 'uploads.cancel', { uploadId: mine.uploadId })
    expect(uploads.outcome(caller('devO'), mine.uploadId)?.state).toBe('pending')
  })

  it('a guest made read-only while begin awaited is refused, and what began is cancelled', async () => {
    let began: string | undefined
    let roles: Record<string, GuestRole> = {}
    const s = setup({
      begin: async (c, source, folder, files) => {
        const r = await s.uploads.begin(c, source, folder, files)
        if ('uploadId' in r) began = r.uploadId
        roles.gW = 'read'
        return r
      }
    })
    roles = s.roles
    await expect(s.router.dispatch(s.web(WRITER, { guest: 'gW' }), 'uploads.begin', begin({ panel: FILES }))).rejects.toThrow(/refused/)
    expect(began).toEqual(expect.any(String))
    expect(s.uploads.outcome(caller('devW'), began)).toBeUndefined()
  })

  it('a guest ended while resolve awaited is refused, and the upload is cancelled', async () => {
    let roles: Record<string, GuestRole> = {}
    const s = setup({
      resolve: async (c, id, choice) => {
        const r = await s.uploads.resolve(c, id, choice)
        delete roles.gW
        return r
      }
    })
    roles = s.roles
    const w = s.web(WRITER, { guest: 'gW' })
    const b = (await s.router.dispatch(w, 'uploads.begin', begin({ tab: 'c1' }, [{ name: 'taken.txt', size: 1 }]))) as UploadBegun
    await expect(s.router.dispatch(w, 'uploads.resolve', { uploadId: b.uploadId, choice: 'keep-both' })).rejects.toThrow(/refused/)
    expect(s.uploads.outcome(caller('devW'), b.uploadId)).toBeUndefined()
  })

  it("folders re-reads the guest's role after its listing", async () => {
    let roles: Record<string, GuestRole> = {}
    const s = setup({
      folders: async (windowId, path) => {
        const r = await s.uploads.folders(windowId, path)
        roles.gW = 'read'
        return r
      }
    })
    roles = s.roles
    await expect(s.router.dispatch(s.web(WRITER, { guest: 'gW' }), 'uploads.folders', { tab: 'c1', path: '' })).rejects.toThrow(/refused/)
  })
})

describe('uploads.paste: the gate only (the rule is the terminal entry\'s)', () => {
  it('is refused while main has no paste rule wired', async () => {
    const { router, web } = setup()
    await expect(router.dispatch(web(OWNER, 'owner'), 'uploads.paste', { uploadId: 'u' })).rejects.toThrow(/refused/)
  })

  it("hands on main's caller, view and role, never the payload's; manual must be a boolean", async () => {
    const seen: UploadPasteCall[] = []
    const { router, web } = setup({
      paste: (call) => {
        seen.push(call)
        return { text: 'x ' }
      }
    })
    await router.dispatch(web(OWNER, 'owner'), 'uploads.paste', { uploadId: 'u1', manual: true, viewId: 'web:9', guest: true })
    await router.dispatch(web(WRITER, { guest: 'gW' }), 'uploads.paste', { uploadId: 'u2' })
    expect(seen).toEqual([
      { caller: caller('devO'), projectId: A, viewId: OWNER, guest: false, uploadId: 'u1', manual: true },
      { caller: caller('devW'), projectId: A, viewId: WRITER, guest: true, uploadId: 'u2', manual: false }
    ])
    await expect(router.dispatch(web(OWNER, 'owner'), 'uploads.paste', { uploadId: 'u1', manual: 'yes' })).rejects.toThrow(/manual/)
  })
})

describe('LayoutService.placedPanel', () => {
  it('answers a placed panel of any kind, by the first slash; undefined for hidden, undeclared or junk keys', () => {
    const { layouts } = setup()
    expect(layouts.placedPanel(A, FILES)).toEqual({ pluginId: 'cockpit.files', panelId: 'tree' })
    expect(layouts.placedPanel(A, 'cockpit.browser/web')).toEqual({ pluginId: 'cockpit.browser', panelId: 'web' })
    expect(layouts.placedPanel(A, 'cockpit.notes/notes')).toBeUndefined()
    expect(layouts.placedPanel(B, FILES)).toBeUndefined()
    expect(layouts.placedPanel('nope', FILES)).toBeUndefined()
    for (const key of [undefined, 3, '', '/tree', 'cockpit.files']) expect(layouts.placedPanel(A, key)).toBeUndefined()
  })
})
