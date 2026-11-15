// The room view's channels (rooms Task 14, design-rooms.md §5): rooms.view, rooms.doc, rooms.pause / resume,
// rooms.remove with its answer, rooms.reveal. The real RoomService (registry, docs, delivery) over a real TabManager
// (fake PTYs) and SessionRegistry, behind the real router handlers and, for a server's browser, the real SharedAsks
// core, wired as index.ts wires them.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SharedAsks } from '../../src/main/asks/shared-asks'
import {
  appPageMatcher,
  IpcRouter,
  registerRoomViewHandlers,
  webCaller,
  type IpcEventLike,
  type IpcMainLike
} from '../../src/main/ipc/router'
import type { RoomOwner } from '../../src/main/rooms/room-registry'
import { ROOM_REMOVE_ASK_MS, RoomService } from '../../src/main/rooms/room-service'
import { SessionRegistry } from '../../src/main/sessions/session-registry'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { windowSnapshot } from '../../src/main/web/connection'
import type { SenderContext } from '../../src/main/windows/window-manager'
import { defaultLayout } from '../../src/shared/layout'
import { REMOTE_CLASS } from '../../src/shared/ipc'
import { ROOM_VIEW_LOG_LIMIT, ROOM_VIEW_LOG_MAX_BYTES, type RoomRemoveAsk, type RoomView } from '../../src/shared/room-view'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const P1 = 'p1'
const P2 = 'p2'
const owner: RoomOwner = { pluginId: 'example.team', projectId: P1 }
const owner2: RoomOwner = { pluginId: 'example.team', projectId: P2 }

let dir: string
let projectDir: string
let sessions: SessionRegistry
let tabs: TabManager
let service: RoomService
let changes: Array<{ id: string; projectId: string }>
let ids: number

function nextId(): string {
  ids++
  return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-room-view-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cc-room-view-proj-'))
  ids = 0
  changes = []
  sessions = new SessionRegistry({ projectName: () => 'p', broadcast: () => {}, write: () => {}, log: () => {} })
  service = new RoomService({
    dir: join(dir, 'rooms'),
    tabs: {
      setRoom: (p, t, r) => tabs.setRoom(p, t, r),
      clearRoom: (p, t) => tabs.clearRoom(p, t),
      roomOf: (p, t) => tabs.roomOf(p, t),
      kindOf: (p, t) => tabs.kindOf(p, t)
    },
    sessions,
    newId: nextId,
    log: () => {},
    changed: (room) => changes.push(room)
  })
  tabs = new TabManager({
    backend: new FakePtyBackend(),
    projectPath: () => projectDir,
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => undefined,
    rooms: service.tabHooks,
    lifecycle: {
      started: (t) => {
        sessions.tabStarted(t)
        service.tabStarted(t.tabId)
      },
      closed: (id) => {
        sessions.tabClosed(id)
        service.tabClosed(id)
      }
    },
    emit: () => {},
    log: () => {}
  })
})

afterEach(() => {
  service.dispose()
  sessions.dispose()
  tabs.disposeAll()
  rmSync(dir, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

/** A Claude tab whose session is waiting for input. */
function claudeTab(projectId = P1): string {
  const tab = tabs.create(projectId, { kind: 'claude' })
  sessions.applyHook(tab.id, 'UserPromptSubmit', { prompt: 'go' })
  sessions.applyHook(tab.id, 'Stop', {})
  return tab.id
}

/** A room of P1 with alice (coordinator, waiting) and bob (working). */
function team(): { id: string; alice: string; bob: string } {
  const id = service.create(owner, { title: 'Team' }).id
  const alice = claudeTab()
  const bob = claudeTab()
  service.addMember(owner, id, { tabId: alice, name: 'alice', coordinator: true })
  service.addMember(owner, id, { tabId: bob, name: 'bob' })
  sessions.applyHook(bob, 'UserPromptSubmit', { prompt: 'more' })
  return { id, alice, bob }
}

const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

describe('RoomService: the room view', () => {
  it('answers members with status, held and coordinator, every doc, and the newest log events', async () => {
    const { id, alice, bob } = team()
    service.sendAsPlugin(owner, id, 'bob', 'hello bob')
    await service.ownerDocPut(owner, id, 'shared/plan.md', 'plan')
    await service.ownerDocPut(owner, id, 'members/bob/notes.md', 'private')
    const view = await service.view(P1, id)
    expect(view).toMatchObject({ id, title: 'Team', pluginId: 'example.team', paused: false, logMore: false })
    expect(view.endedAt).toBeUndefined()
    expect(view.members).toEqual([
      { name: 'alice', coordinator: true, status: 'waiting', held: 0, tabId: alice },
      { name: 'bob', coordinator: false, status: 'working', held: 1, tabId: bob }
    ])
    // The person sees every folder, a member's private one too.
    expect(view.docs.map((d) => d.path)).toEqual(['members/bob/notes.md', 'shared/plan.md'])
    expect(view.log.map((e) => e.type)).toEqual(['create', 'join', 'join', 'send', 'doc-write', 'doc-write'])
    // Message text is in the person's record, as data.
    expect(view.log.find((e) => e.type === 'send')).toMatchObject({ text: 'hello bob' })
    // Plain data: it survives the structured clone of IPC unchanged.
    expect(structuredClone(view)).toEqual(view)
  })

  it('a member with no tab (after a quit) shows no-tab; an ended room is still viewable', async () => {
    const { id, bob } = team()
    service.tabHooks.gone?.(bob)
    expect((await service.view(P1, id)).members.find((m) => m.name === 'bob')).toEqual({ name: 'bob', coordinator: false, status: 'no-tab', held: 0 })
    service.end(owner, id)
    const ended = await service.view(P1, id)
    expect(ended.endedAt).toEqual(expect.any(Number))
    expect(ended.log.at(-1)?.type).toBe('end')
  })

  it(`carries at most the newest ${ROOM_VIEW_LOG_LIMIT} events, and fewer when they pass ${ROOM_VIEW_LOG_MAX_BYTES} bytes`, async () => {
    const { id } = team()
    const log = service.registry.logOf(id)
    for (let i = 0; i < ROOM_VIEW_LOG_LIMIT + 10; i++) log.append('send', { from: 'plugin', to: 'bob', text: `m${i}` })
    const many = await service.view(P1, id)
    expect(many.log).toHaveLength(ROOM_VIEW_LOG_LIMIT)
    expect(many.log.at(-1)).toMatchObject({ text: `m${ROOM_VIEW_LOG_LIMIT + 9}` })
    expect(many.logMore).toBe(true)
    // Big entries: only the newest that fit the byte cap, oldest first, and logMore says some were left out.
    const big = 'x'.repeat(300_000)
    for (let i = 0; i < 5; i++) log.append('send', { from: 'plugin', to: 'bob', text: `${i}${big}` })
    const sized = await service.view(P1, id)
    expect(sized.log.map((e) => String(e.text).slice(0, 1))).toEqual(['2', '3', '4'])
    expect(Buffer.byteLength(JSON.stringify(sized.log))).toBeLessThanOrEqual(ROOM_VIEW_LOG_MAX_BYTES)
    expect(sized.logMore).toBe(true)
  })

  it("another project's room, an unknown id and a deleted room are the same no such room", async () => {
    const { id } = team()
    const other = service.create(owner2, { title: 'Other' }).id
    for (const [projectId, roomId] of [
      [P1, other],
      [P2, id],
      [P1, 'nope'],
      [P1, 42]
    ] as const) {
      await expect(service.view(projectId, roomId)).rejects.toThrow('no such room')
      await expect(service.personDoc(projectId, roomId, 'shared/plan.md')).rejects.toThrow('no such room')
      expect(() => service.personPause(projectId, roomId)).toThrow('no such room')
      expect(() => service.personResume(projectId, roomId)).toThrow('no such room')
      expect(() => service.removeTarget(projectId, roomId, 'alice')).toThrow('no such room')
      expect(() => service.personRemove(projectId, roomId, 'alice')).toThrow('no such room')
      await expect(service.revealFolder(projectId, roomId)).rejects.toThrow('no such room')
    }
    service.end(owner2, other)
    service.delete(owner2, other)
    await expect(service.view(P2, other)).rejects.toThrow('no such room')
  })

  it('reads any doc as the person, logged by person; a refused path answers like a missing doc', async () => {
    const { id } = team()
    await service.ownerDocPut(owner, id, 'members/bob/notes.md', 'private notes')
    expect(await service.personDoc(P1, id, 'members/bob/notes.md')).toBe('private notes')
    const read = (await service.view(P1, id)).log.filter((e) => e.type === 'doc-read')
    expect(read).toEqual([expect.objectContaining({ by: 'person', path: 'members/bob/notes.md' })])
    await expect(service.personDoc(P1, id, 'shared/missing.md')).rejects.toThrow('no such doc')
    await expect(service.personDoc(P1, id, '../room.json')).rejects.toThrow()
  })

  it('pauses and resumes for the person; resume offers what waits', async () => {
    const { id, alice } = team()
    service.personPause(P1, id)
    expect((await service.view(P1, id)).paused).toBe(true)
    service.sendAsPlugin(owner, id, 'alice', 'while paused')
    expect(sessions.get(alice)?.held).toBe(1)
    service.personResume(P1, id)
    const view = await service.view(P1, id)
    expect(view.paused).toBe(false)
    expect(view.log.map((e) => e.type)).toContain('pause')
    expect(view.log.map((e) => e.type)).toContain('resume')
  })

  it('removes a member for the person (its tab leaves the room); the target is checked first', async () => {
    const { id, bob } = team()
    expect(service.removeTarget(P1, id, 'bob')).toEqual({ roomId: id, title: 'Team', name: 'bob' })
    expect(() => service.removeTarget(P1, id, 'carol')).toThrow('no such member')
    expect(() => service.removeTarget(P1, id, '__proto__')).toThrow('no such member')
    service.personRemove(P1, id, 'bob')
    expect(tabs.roomOf(P1, bob)).toBeUndefined()
    const view = await service.view(P1, id)
    expect(view.members.map((m) => m.name)).toEqual(['alice'])
    expect(view.log.at(-1)).toMatchObject({ type: 'leave', member: 'bob', why: 'removed' })
    expect(() => service.personRemove(P1, id, 'bob')).toThrow('no such member')
  })

  it("reveals the room's docs folder, its own folder before any doc, never a link", async () => {
    const { id } = team()
    const roomDir = join(realpathSync(dir), 'rooms', id)
    expect(await service.revealFolder(P1, id)).toBe(roomDir)
    await service.ownerDocPut(owner, id, 'shared/plan.md', 'plan')
    expect(await service.revealFolder(P1, id)).toBe(join(roomDir, 'docs'))
    // A docs folder replaced by a link is not shown (nor where it points): the room's own folder is.
    rmSync(join(roomDir, 'docs'), { recursive: true })
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(roomDir, 'docs'))
    expect(await service.revealFolder(P1, id)).toBe(roomDir)
  })

  it('tells each changed room once per burst, with its project, a delete included', async () => {
    const { id } = team()
    await flush()
    changes.length = 0
    // A send to all saves and logs per member: one change.
    service.sendAsPlugin(owner, id, 'all', 'hi all')
    await flush()
    expect(changes).toEqual([{ id, projectId: P1 }])
    changes.length = 0
    await service.ownerDocPut(owner, id, 'shared/a.md', 'a')
    await flush()
    expect(changes).toEqual([{ id, projectId: P1 }])
    changes.length = 0
    const other = service.create(owner2, { title: 'Other' }).id
    service.end(owner2, other)
    service.delete(owner2, other)
    service.personPause(P1, id)
    await flush()
    expect(changes).toEqual([
      { id: other, projectId: P2 },
      { id, projectId: P1 }
    ])
  })
})

// --- the router handlers, as a renderer and a browser call them ---

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown

const APP_FILE = '/opt/cc-cockpit/out/renderer/index.html'
const APP_PAGE = 'file:///opt/cc-cockpit/out/renderer/index.html'

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, Listener>()
  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener)
  }
  invoke(channel: string, senderId: number, args: unknown[] = [], senderFrame: IpcEventLike['senderFrame'] = { parent: null, url: APP_PAGE }): Promise<unknown> {
    const listener = this.handlers.get(channel)
    if (!listener) return Promise.reject(new Error(`no handler for ${channel}`))
    return Promise.resolve().then(() => listener({ sender: { id: senderId }, senderFrame }, ...args))
  }
}

/** webContents 11 is P1's desktop window (window 1), 12 P2's (window 2), 13 the picker. */
const senders = new Map<number, SenderContext>([
  [11, { kind: 'project', windowId: 1, projectId: P1 }],
  [12, { kind: 'project', windowId: 2, projectId: P2 }],
  [13, { kind: 'picker', windowId: 3 }]
])
const browser = (viewId: `web:${number}` = 'web:5') => webCaller({ kind: 'project', windowId: 1, projectId: P1 }, viewId)

function routerSetup(options: { server?: boolean } = {}) {
  const ipc = new FakeIpcMain()
  const router = new IpcRouter(
    ipc,
    (id) => senders.get(id),
    appPageMatcher({ kind: 'file', path: APP_FILE }),
    () => {},
    (windowId, projectId) => (windowId === 1 && projectId === P1) || (windowId === 2 && projectId === P2)
  )
  const posted: Array<{ windowId: number; ask: RoomRemoveAsk }> = []
  const settled: Array<{ windowId: number; requestId: string }> = []
  const asks = new SharedAsks<Omit<RoomRemoveAsk, 'requestId'>, boolean>({
    hooks: {
      send: (windowId, ask) => {
        posted.push({ windowId, ask })
        return true
      },
      settled: (windowId, requestId) => void settled.push({ windowId, requestId })
    },
    prefix: 'room-remove',
    refused: false,
    timeoutMs: ROOM_REMOVE_ASK_MS
  })
  const revealed: string[] = []
  registerRoomViewHandlers(router, {
    server: options.server === true,
    view: (projectId, roomId) => service.view(projectId, roomId),
    doc: (projectId, roomId, path) => service.personDoc(projectId, roomId, path),
    pause: (projectId, roomId) => service.personPause(projectId, roomId),
    resume: (projectId, roomId) => service.personResume(projectId, roomId),
    removeTarget: (projectId, roomId, name) => service.removeTarget(projectId, roomId, name),
    remove: (projectId, roomId, name) => service.personRemove(projectId, roomId, name),
    askRemove: (windowId, info) => asks.ask(windowId, info),
    removeAnswer: (windowId, requestId, remove) => asks.answer(windowId, requestId, remove),
    reveal: async (projectId, roomId) => void revealed.push(await service.revealFolder(projectId, roomId))
  })
  return { ipc, router, asks, posted, settled, revealed }
}

const memberNames = async (id: string): Promise<string[]> => (await service.view(P1, id)).members.map((m) => m.name)

describe('registerRoomViewHandlers', () => {
  it('rooms.view and rooms.doc answer for the sender project only, from any view', async () => {
    const { id } = team()
    await service.ownerDocPut(owner, id, 'shared/plan.md', 'the plan')
    const { ipc, router } = routerSetup()
    const view = (await ipc.invoke('rooms.view', 11, [{ roomId: id, projectId: P2 }])) as RoomView
    expect(view.title).toBe('Team')
    expect(await ipc.invoke('rooms.doc', 11, [{ roomId: id, path: 'shared/plan.md' }])).toBe('the plan')
    // Another project's window names the room: no such room (never a probe of what exists elsewhere).
    await expect(ipc.invoke('rooms.view', 12, [{ roomId: id }])).rejects.toThrow('no such room')
    await expect(ipc.invoke('rooms.doc', 12, [{ roomId: id, path: 'shared/plan.md' }])).rejects.toThrow('no such room')
    // Reading is a browser's too, outside server mode as well (`yes`).
    expect(((await router.dispatch(browser(), 'rooms.view', { roomId: id })) as RoomView).id).toBe(id)
    expect(await router.dispatch(browser(), 'rooms.doc', { roomId: id, path: 'shared/plan.md' })).toBe('the plan')
  })

  it('refuses bad payloads before the room service is asked', async () => {
    const { id } = team()
    const { ipc } = routerSetup()
    for (const channel of ['rooms.view', 'rooms.pause', 'rooms.resume', 'rooms.reveal']) {
      for (const roomId of [undefined, 1, '', 'x'.repeat(65)]) {
        await expect(ipc.invoke(channel, 11, [{ roomId }])).rejects.toThrow(/roomId must be a room id/)
      }
      await expect(ipc.invoke(channel, 11, [null])).rejects.toThrow(/bad payload/)
    }
    await expect(ipc.invoke('rooms.doc', 11, [{ roomId: id, path: 1 }])).rejects.toThrow(/path must be a string/)
    await expect(ipc.invoke('rooms.remove', 11, [{ roomId: id, name: 1 }])).rejects.toThrow(/name must be a string/)
    await expect(ipc.invoke('rooms.removeAnswer', 11, [{ requestId: 1, remove: true }])).rejects.toThrow(/requestId must be a string/)
    await expect(ipc.invoke('rooms.removeAnswer', 11, [{ requestId: 'x', remove: 'yes' }])).rejects.toThrow(/remove must be a boolean/)
    expect(await memberNames(id)).toEqual(['alice', 'bob'])
  })

  it("takes every channel from the shell page's top frame of a project window only", async () => {
    const { id } = team()
    const { ipc } = routerSetup()
    const calls: Array<[string, Record<string, unknown>]> = [
      ['rooms.view', { roomId: id }],
      ['rooms.doc', { roomId: id, path: 'shared/plan.md' }],
      ['rooms.pause', { roomId: id }],
      ['rooms.resume', { roomId: id }],
      ['rooms.remove', { roomId: id, name: 'bob' }],
      ['rooms.removeAnswer', { requestId: 'room-remove-1', remove: true }],
      ['rooms.reveal', { roomId: id }]
    ]
    for (const [channel, payload] of calls) {
      await expect(ipc.invoke(channel, 11, [payload], { parent: {}, url: APP_PAGE })).rejects.toThrow(/refused/)
      await expect(ipc.invoke(channel, 11, [payload], { parent: null, url: 'cc-plugin://example.plugin/panel.html' })).rejects.toThrow()
      await expect(ipc.invoke(channel, 13, [payload])).rejects.toThrow(/not a project window/)
    }
    expect(await memberNames(id)).toEqual(['alice', 'bob'])
    expect((await service.view(P1, id)).paused).toBe(false)
  })

  it('pause and resume: the desktop acts, a desktop-mode browser is refused, a server browser counts', async () => {
    const { id } = team()
    const desktop = routerSetup()
    await desktop.ipc.invoke('rooms.pause', 11, [{ roomId: id }])
    expect((await service.view(P1, id)).paused).toBe(true)
    await expect(desktop.router.dispatch(browser(), 'rooms.resume', { roomId: id })).rejects.toThrow(/outside server mode/)
    expect((await service.view(P1, id)).paused).toBe(true)
    await desktop.ipc.invoke('rooms.resume', 11, [{ roomId: id }])
    expect((await service.view(P1, id)).paused).toBe(false)
    await expect(desktop.router.dispatch(browser(), 'rooms.pause', { roomId: id })).rejects.toThrow(/outside server mode/)
    // Another project's window: no such room, and nothing paused.
    await expect(desktop.ipc.invoke('rooms.pause', 12, [{ roomId: id }])).rejects.toThrow('no such room')
    expect((await service.view(P1, id)).paused).toBe(false)
    const server = routerSetup({ server: true })
    await server.router.dispatch(browser(), 'rooms.pause', { roomId: id })
    expect((await service.view(P1, id)).paused).toBe(true)
    await server.router.dispatch(browser(), 'rooms.resume', { roomId: id })
    expect((await service.view(P1, id)).paused).toBe(false)
  })

  it('remove from the desktop is done at once, with no ask', async () => {
    const { id } = team()
    const { ipc, posted } = routerSetup()
    expect(await ipc.invoke('rooms.remove', 11, [{ roomId: id, name: 'bob' }])).toEqual({ removed: true })
    expect(await memberNames(id)).toEqual(['alice'])
    expect(posted).toEqual([])
    await expect(ipc.invoke('rooms.remove', 11, [{ roomId: id, name: 'bob' }])).rejects.toThrow('no such member')
    await expect(ipc.invoke('rooms.remove', 12, [{ roomId: id, name: 'alice' }])).rejects.toThrow('no such room')
  })

  it('remove from a desktop-mode browser is refused, and its answer too', async () => {
    const { id } = team()
    const { router, posted } = routerSetup()
    await expect(router.dispatch(browser(), 'rooms.remove', { roomId: id, name: 'bob' })).rejects.toThrow(/outside server mode/)
    await expect(router.dispatch(browser(), 'rooms.removeAnswer', { requestId: 'room-remove-1', remove: true })).rejects.toThrow(
      /outside server mode/
    )
    expect(posted).toEqual([])
    expect(await memberNames(id)).toEqual(['alice', 'bob'])
  })

  it("remove from a server's browser asks every view of the window first and removes only on a Remove answer", async () => {
    const { id, bob } = team()
    const { router, posted, settled } = routerSetup({ server: true })
    const pending = router.dispatch(browser('web:5'), 'rooms.remove', { roomId: id, name: 'bob' })
    await flush()
    await flush()
    // The ask names the window main bound the browser to, with plain-text words; nothing is removed yet.
    expect(posted).toEqual([{ windowId: 1, ask: { requestId: 'room-remove-1', roomId: id, title: 'Team', name: 'bob' } }])
    expect(await memberNames(id)).toEqual(['alice', 'bob'])
    // Another project's window cannot answer it.
    const otherWindow = webCaller({ kind: 'project', windowId: 2, projectId: P2 }, 'web:9')
    expect(await router.dispatch(otherWindow, 'rooms.removeAnswer', { requestId: 'room-remove-1', remove: true })).toBe(false)
    // Any view of the window may (here another browser): first answer wins.
    expect(await router.dispatch(browser('web:6'), 'rooms.removeAnswer', { requestId: 'room-remove-1', remove: true })).toBe(true)
    expect(await pending).toEqual({ removed: true })
    expect(settled).toEqual([{ windowId: 1, requestId: 'room-remove-1' }])
    expect(await memberNames(id)).toEqual(['alice'])
    expect(tabs.roomOf(P1, bob)).toBeUndefined()
    // A late second answer finds nothing.
    expect(await router.dispatch(browser('web:5'), 'rooms.removeAnswer', { requestId: 'room-remove-1', remove: true })).toBe(false)
  })

  it("a declined ask removes nothing; an ask for a member that is not there is never put", async () => {
    const { id } = team()
    const { router, posted } = routerSetup({ server: true })
    const pending = router.dispatch(browser(), 'rooms.remove', { roomId: id, name: 'bob' })
    await flush()
    await flush()
    expect(await router.dispatch(browser(), 'rooms.removeAnswer', { requestId: posted[0]!.ask.requestId, remove: false })).toBe(true)
    expect(await pending).toEqual({ removed: false })
    expect(await memberNames(id)).toEqual(['alice', 'bob'])
    await expect(router.dispatch(browser(), 'rooms.remove', { roomId: id, name: 'carol' })).rejects.toThrow('no such member')
    expect(posted).toHaveLength(1)
  })

  it('a member that left while the ask was up is not there to remove: the Remove answer fails, nothing else changes', async () => {
    const { id } = team()
    const { router, posted } = routerSetup({ server: true })
    const pending = router.dispatch(browser(), 'rooms.remove', { roomId: id, name: 'bob' })
    await flush()
    await flush()
    service.remove(owner, id, 'bob')
    expect(await router.dispatch(browser(), 'rooms.removeAnswer', { requestId: posted[0]!.ask.requestId, remove: true })).toBe(true)
    await expect(pending).rejects.toThrow('no such member')
    expect(await memberNames(id)).toEqual(['alice'])
  })

  it('the pending ask is in the window snapshot a joining browser gets (ready), and leaves it when settled', async () => {
    const { id } = team()
    const { router, asks, posted } = routerSetup({ server: true })
    const sources = {
      tabs: { list: () => [] },
      layouts: { view: () => ({ layout: defaultLayout(), defaults: defaultLayout() }) as never },
      overlays: { infos: () => [] },
      closeAsks: { pendingFor: () => [] },
      linkAsks: { pendingFor: () => [] },
      roomRemoveAsks: asks
    }
    const pending = router.dispatch(browser(), 'rooms.remove', { roomId: id, name: 'bob' })
    await flush()
    await flush()
    expect(windowSnapshot(sources, { windowId: 1, projectId: P1 }).roomRemoveAsks).toEqual([posted[0]!.ask])
    expect(windowSnapshot(sources, { windowId: 2, projectId: P2 }).roomRemoveAsks).toEqual([])
    asks.windowClosed(1)
    expect(await pending).toEqual({ removed: false })
    expect(windowSnapshot(sources, { windowId: 1, projectId: P1 }).roomRemoveAsks).toEqual([])
  })

  it('rooms.reveal: the desktop only, never a browser, never in server mode', async () => {
    const { id } = team()
    const desktop = routerSetup()
    await desktop.ipc.invoke('rooms.reveal', 11, [{ roomId: id }])
    expect(desktop.revealed).toEqual([join(realpathSync(dir), 'rooms', id)])
    await expect(desktop.ipc.invoke('rooms.reveal', 12, [{ roomId: id }])).rejects.toThrow('no such room')
    // `no`: the router refuses a browser before the handler runs.
    await expect(desktop.router.dispatch(browser(), 'rooms.reveal', { roomId: id })).rejects.toThrow()
    const server = routerSetup({ server: true })
    await expect(server.ipc.invoke('rooms.reveal', 11, [{ roomId: id }])).rejects.toThrow(/server mode/)
    await expect(server.router.dispatch(browser(), 'rooms.reveal', { roomId: id })).rejects.toThrow()
    expect([...desktop.revealed, ...server.revealed]).toHaveLength(1)
  })

  it('classes: reads and their events yes, the acts adapted, reveal no', () => {
    expect(REMOTE_CLASS['rooms.view']).toBe('yes')
    expect(REMOTE_CLASS['rooms.doc']).toBe('yes')
    expect(REMOTE_CLASS['rooms.changed']).toBe('yes')
    expect(REMOTE_CLASS['rooms.removeAsk']).toBe('yes')
    expect(REMOTE_CLASS['rooms.removeSettled']).toBe('yes')
    expect(REMOTE_CLASS['rooms.pause']).toBe('adapted')
    expect(REMOTE_CLASS['rooms.resume']).toBe('adapted')
    expect(REMOTE_CLASS['rooms.remove']).toBe('adapted')
    expect(REMOTE_CLASS['rooms.removeAnswer']).toBe('adapted')
    expect(REMOTE_CLASS['rooms.reveal']).toBe('no')
  })
})
