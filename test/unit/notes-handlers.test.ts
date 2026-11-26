// Notes channels (task 03; shared/design.md §3, spec-review S1-S4) through the real router, overlay manager, guest
// wiring and Notes service: the copy must be the caller's own live copy, the store is main's record of the opener and
// key, a read guest never writes, the author and the id are main's, and no service refuses every call.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IpcRouter, webCaller, type IpcEventLike, type IpcMainLike } from '../../src/main/ipc/router'
import { NOTES_CHANNELS, registerNotesHandlers } from '../../src/main/ipc/notes-handlers'
import { OverlayManager, type OverlayChannel, type UrlView, type UrlViewFactory } from '../../src/main/overlays/overlay-manager'
import { mayConnectCopyOf, overlayVisibleOf, type OverlayCopySources } from '../../src/main/guest-wiring'
import type { GuestService } from '../../src/main/ipc/guest-deps'
import { NotesService } from '../../src/main/notes/notes-service'
import type { NoteAuthor } from '../../src/shared/overlay-envelope'
import type { GuestAccess } from '../../src/shared/guests'
import type { InvokeChannel } from '../../src/shared/ipc'
import type { ViewId, Who } from '../../src/shared/views'
import type { SenderContext } from '../../src/main/windows/window-manager'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const W1 = 1
const PROJECT = 'aaaaaaaaaaaaaaaa'
const CTX = { kind: 'project', windowId: W1, projectId: PROJECT } as const
const APP_PAGE = 'file:///opt/cc-cockpit/out/renderer/index.html'
type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown

class NoViews implements UrlViewFactory {
  create(): UrlView {
    throw new Error('no url overlays here')
  }
  focusWindow(): void {}
}

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

// Views: web:1 the owner's browser; web:5 a read guest (Rita), web:6 a write guest (Walt); web:8 revoked.
const whoOf = (v: string): Who | undefined =>
  v === 'desktop:1' || v === 'web:1' ? 'owner' : v === 'web:5' ? { guest: 'gR' } : v === 'web:6' ? { guest: 'gW' } : v === 'web:8' ? { guest: 'gX' } : undefined
// Walt's role as the guest store has it now: the owner may change it while a write waits (S-2d).
let waltRole: 'read' | 'write' | 'revoked' = 'write'
const accessOf = (who: Who): GuestAccess => {
  if (who === 'owner') return { kind: 'owner' }
  if (who.guest === 'gR') return { kind: 'guest', id: 'gR', name: 'Rita', role: 'read', projectId: PROJECT, scope: 'all' }
  if (who.guest === 'gW') return waltRole === 'revoked' ? { kind: 'revoked' } : { kind: 'guest', id: 'gW', name: 'Walt', role: waltRole, projectId: PROJECT, scope: 'all' }
  return { kind: 'revoked' }
}

let dir: string
beforeEach(() => {
  waltRole = 'write'
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-notes-handlers-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup(opts: { wireGuests?: boolean; noService?: boolean; authorOf?: () => NoteAuthor | undefined } = {}) {
  const shown = new Set(['a.one'])
  const guests = {
    access: accessOf,
    tabVisible: () => false,
    pluginVisible: (_p: string, id: string) => shown.has(id),
    openedTabs: () => [],
    noteOpenedTab: () => {}
  } as unknown as GuestService
  const windowIdOf = (p: string): number | undefined => (p === PROJECT ? W1 : undefined)
  // eslint-disable-next-line prefer-const
  let m: OverlayManager
  const overlayVisible = overlayVisibleOf({
    guests,
    windowIdOf,
    overlays: { visibleTo: (w, o, t, p) => m.visibleTo(w, o, t, p), hiddenFrom: (w, o, g) => m.hiddenFrom(w, o, g) }
  })
  const sources: OverlayCopySources = {
    whoOf: (v) => whoOf(v),
    guests,
    windowIdOf,
    overlayVisible,
    overlays: { isPerView: (w, o) => m.isPerView(w, o), openerPluginOf: (w, o) => m.openerPluginOf(w, o) },
    port: (_p, id, role) => (!shown.has(id) ? 'none' : role === 'write' ? 'full' : 'oneWay')
  }
  const pushes: Array<{ viewId: string; copy?: string; message: string }> = []
  m = new OverlayManager({
    ownerView: (v) => whoOf(v) === 'owner',
    backend: new FakePtyBackend(),
    views: new NoViews(),
    isWindowOpen: () => true,
    env: () => ({}),
    emit: () => {},
    emitToView: (viewId, channel, payload) => {
      const p = payload as { envelope?: true; copy?: string; message: string }
      if (channel === 'overlays.message' && p.envelope === true) pushes.push({ viewId, copy: p.copy, message: p.message })
      return true
    },
    isViewLive: (v, w) => w === W1 && whoOf(v) !== undefined,
    guestOf: (v) => {
      const who = whoOf(v)
      return who === undefined || who === 'owner' ? undefined : who.guest
    },
    mayConnectCopy: mayConnectCopyOf(sources),
    commandForChord: () => undefined,
    log: () => {}
  })
  const notes = new NotesService({ dataDir: dir, log: () => {}, overlays: m, windowOfProject: (p) => windowIdOf(p) })
  const router = new IpcRouter({ handle: () => {} } as IpcMainLike, () => undefined, () => true, () => {}, (w, p) => w === W1 && p === PROJECT)
  if (opts.wireGuests !== false) router.setGuestDeps({ guests, overlayVisible })
  registerNotesHandlers(router, {
    ...(opts.noService ? {} : { notes }),
    overlays: m,
    // As index.ts: the owner, or a write guest with its invite name.
    authorOf:
      opts.authorOf ??
      ((view) => {
        if (view.who === 'owner') return { access: 'owner' }
        if (view.access?.role !== 'write') return undefined
        const access = accessOf(view.who)
        return access.kind === 'guest' ? { access: 'write', person: access.name } : { access: 'write' }
      })
  })
  const channel: OverlayChannel = { onMessage: () => {} }
  const open = (spec: Record<string, unknown> = {}, pluginId = 'a.one', perView = true): string => {
    void m
      .open(W1, { kind: 'html', src: `cc-plugin://${pluginId}/doc.html`, title: 'Doc', notes: { key: 'doc:1' }, ...spec }, `plugin ${pluginId}`, undefined, channel, pluginId, undefined, undefined, {
        perView
      })
      .catch(() => undefined)
    return m.infos(W1).at(-1)!.id
  }
  const copyOf = (overlayId: string, viewId: string): string => {
    const answer = m.connectReady(W1, overlayId, viewId)
    if (!('copy' in answer)) throw new Error(`refused: ${answer.refused}`)
    return answer.copy
  }
  const call = (viewId: string, ch: InvokeChannel, payload: unknown): Promise<unknown> =>
    Promise.resolve().then(() => router.dispatch(webCaller(CTX, viewId as ViewId, whoOf(viewId) ?? { guest: 'nobody' }), ch, payload))
  const outcome = (p: Promise<unknown>): Promise<unknown> => p.then((v) => v, (e: Error) => `refused: ${e.message}`)
  return { m, notes, router, open, copyOf, call, outcome, pushes, shown }
}

describe('notes handlers', () => {
  it('no service: every call is refused', async () => {
    const ipc = new FakeIpcMain()
    const senders = new Map<number, SenderContext>([[11, CTX]])
    const router = new IpcRouter(ipc, (id) => senders.get(id), (url) => url === APP_PAGE, () => undefined, () => true)
    registerNotesHandlers(router, { overlays: { copyOwner: () => 'desktop:1', notesOf: () => ({ pluginId: 'a.one', key: 'k' }) }, authorOf: () => ({ access: 'owner' }) })
    const payloads: Record<string, unknown> = {
      'overlays.notes.read': { overlayId: 'o1', copy: 'c1' },
      'overlays.notes.write': { overlayId: 'o1', copy: 'c1', op: 'setGlobal', text: 'x' }
    }
    for (const channel of NOTES_CHANNELS) {
      await expect(ipc.invoke(channel, 11, payloads[channel]), channel).rejects.toThrow(/refused \(notes are not available/)
    }
  })

  it('the owner, a write guest and another owner view edit one store; each sees the others', async () => {
    const t = setup()
    const id = t.open()
    const own = t.copyOf(id, 'web:1')
    const walt = t.copyOf(id, 'web:6')
    const added = (await t.call('web:1', 'overlays.notes.write', { overlayId: id, copy: own, op: 'add', quote: 'q', anchor: { at: 1 }, text: 'mine' })) as {
      note: { id: string }
    }
    await t.call('web:6', 'overlays.notes.write', { overlayId: id, copy: walt, op: 'change', id: added.note.id, text: 'edited by Walt' })
    await t.call('web:6', 'overlays.notes.write', { overlayId: id, copy: walt, op: 'setGlobal', text: 'look at the dates' })
    const listed = (await t.call('web:1', 'overlays.notes.read', { overlayId: id, copy: own })) as { global: string; notes: Array<{ text: string; rev: number; author: unknown }> }
    expect(listed.global).toBe('look at the dates')
    // The first writer stays the author; the change bumped the rev.
    expect(listed.notes).toEqual([expect.objectContaining({ text: 'edited by Walt', rev: 2, author: { access: 'owner' } })])
    // Every write went to both live copies.
    expect(new Set(t.pushes.map((p) => p.viewId))).toEqual(new Set(['web:1', 'web:6']))
  })

  it("a read guest's write is refused", async () => {
    const t = setup()
    const id = t.open()
    const rita = t.copyOf(id, 'web:5')
    // A read guest may read the notes of an overlay it is shown.
    expect(await t.outcome(t.call('web:5', 'overlays.notes.read', { overlayId: id, copy: rita }))).toMatchObject({ notes: [] })
    for (const op of [
      { op: 'add', quote: '', anchor: null, text: 'x' },
      { op: 'setGlobal', text: 'x' },
      { op: 'remove', id: 'n' }
    ]) {
      expect(await t.outcome(t.call('web:5', 'overlays.notes.write', { overlayId: id, copy: rita, ...op }))).toMatch(/^refused/)
    }
    expect((await t.notes.list(PROJECT, 'a.one', 'doc:1')).notes).toEqual([])
  })

  it('fail closed: an unwired guest store, a revoked guest or no author refuses a write', async () => {
    const unwired = setup({ wireGuests: false })
    const id = unwired.open()
    const walt = unwired.copyOf(id, 'web:6')
    expect(await unwired.outcome(unwired.call('web:6', 'overlays.notes.write', { overlayId: id, copy: walt, op: 'setGlobal', text: 'x' }))).toMatch(/^refused/)
    const noAuthor = setup({ authorOf: () => undefined })
    const id2 = noAuthor.open()
    const own = noAuthor.copyOf(id2, 'web:1')
    expect(await noAuthor.outcome(noAuthor.call('web:1', 'overlays.notes.write', { overlayId: id2, copy: own, op: 'setGlobal', text: 'x' }))).toMatch(/read only/)
    const revoked = setup()
    const id3 = revoked.open()
    expect(await revoked.outcome(revoked.call('web:8', 'overlays.notes.write', { overlayId: id3, copy: 'c', op: 'setGlobal', text: 'x' }))).toMatch(/^refused/)
  })

  it('author only from main; a page\'s author is ignored', async () => {
    const t = setup()
    const id = t.open()
    const walt = t.copyOf(id, 'web:6')
    const r = (await t.call('web:6', 'overlays.notes.write', {
      overlayId: id,
      copy: walt,
      op: 'add',
      quote: 'q',
      anchor: null,
      text: 't',
      author: { access: 'owner' },
      person: 'The Owner'
    })) as { note: { author: unknown } }
    expect(r.note.author).toEqual({ access: 'write', person: 'Walt' })
  })

  it('ids minted by core; a page\'s id on add is ignored', async () => {
    const t = setup()
    const id = t.open()
    const own = t.copyOf(id, 'web:1')
    const a = (await t.call('web:1', 'overlays.notes.write', { overlayId: id, copy: own, op: 'add', id: 'mine', quote: '', anchor: null, text: 'a' })) as { note: { id: string } }
    const b = (await t.call('web:1', 'overlays.notes.write', { overlayId: id, copy: own, op: 'add', id: 'mine', quote: '', anchor: null, text: 'b' })) as { note: { id: string } }
    expect(a.note.id).not.toBe('mine')
    expect(a.note.id).not.toBe(b.note.id)
    expect(a.note.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('an overlay without notes, or not perView: refused', async () => {
    const t = setup()
    // No notes key on a perView overlay.
    void t.m.open(W1, { kind: 'html', src: 'cc-plugin://a.one/plain.html', title: 'Plain' }, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one', undefined, undefined, { perView: true })
    const plain = t.m.infos(W1).at(-1)!.id
    const c = t.copyOf(plain, 'web:1')
    expect(await t.outcome(t.call('web:1', 'overlays.notes.read', { overlayId: plain, copy: c }))).toMatch(/has no notes/)
    // Not perView: the open itself is refused (00), so no copy and no store.
    const holder = t.open({}, 'a.one', false)
    expect(t.m.notesOf(W1, holder)).toBeUndefined()
    expect(await t.outcome(t.call('web:1', 'overlays.notes.read', { overlayId: holder, copy: 'c1' }))).toMatch(/^refused/)
  })

  it("a copy that is not the caller's own live one is refused", async () => {
    const t = setup()
    const id = t.open()
    const own = t.copyOf(id, 'web:1')
    const walt = t.copyOf(id, 'web:6')
    // Walt names the owner's copy; the owner names a made-up one; a released copy.
    expect(await t.outcome(t.call('web:6', 'overlays.notes.write', { overlayId: id, copy: own, op: 'setGlobal', text: 'x' }))).toMatch(/not your copy/)
    expect(await t.outcome(t.call('web:1', 'overlays.notes.read', { overlayId: id, copy: 'made-up' }))).toMatch(/not your copy/)
    t.m.releaseCopy(W1, id, 'web:6', walt)
    expect(await t.outcome(t.call('web:6', 'overlays.notes.read', { overlayId: id, copy: walt }))).toMatch(/^refused/)
  })

  it('a write that waited in the store\'s queue re-checks the caller first (S-2d)', async () => {
    const t = setup()
    const id = t.open()
    const own = t.copyOf(id, 'web:1')
    const store = (t.notes as unknown as { store: { serial(fn: () => Promise<unknown>): Promise<unknown> } }).store
    /** Holds the store's queue, starts `write`, lets the handler's own checks pass and queue it, runs `meanwhile`, then lets the queue go. */
    const queued = async (write: () => Promise<unknown>, meanwhile: () => void): Promise<unknown> => {
      let release!: () => void
      const held = store.serial(() => new Promise<void>((resolve) => (release = resolve)))
      const result = t.outcome(write())
      await new Promise((resolve) => setTimeout(resolve, 20))
      meanwhile()
      release()
      await held
      return result
    }
    const add = (viewId: string, copy: string, text: string) => () =>
      t.call(viewId, 'overlays.notes.write', { overlayId: id, copy, op: 'add', quote: '', anchor: null, text })
    // Set to read, revoked, or the copy released while the write waited: refused, nothing saved.
    const walt = t.copyOf(id, 'web:6')
    expect(await queued(add('web:6', walt, 'as read'), () => (waltRole = 'read'))).toMatch(/^refused/)
    waltRole = 'write'
    expect(await queued(() => t.call('web:6', 'overlays.notes.write', { overlayId: id, copy: walt, op: 'setGlobal', text: 'g' }), () => (waltRole = 'revoked'))).toMatch(/^refused/)
    waltRole = 'write'
    expect(await queued(add('web:6', walt, 'released'), () => t.m.releaseCopy(W1, id, 'web:6', walt))).toMatch(/not your copy/)
    const state = await t.notes.list(PROJECT, 'a.one', 'doc:1')
    expect(state.notes).toEqual([])
    expect(state.global).toBe('')
    // Nothing changed meanwhile: the queued writes of the owner and of a write guest land.
    const walt2 = t.copyOf(id, 'web:6')
    expect(await queued(add('web:1', own, 'owner'), () => {})).toMatchObject({ note: { text: 'owner' } })
    expect(await queued(add('web:6', walt2, 'walt'), () => {})).toMatchObject({ note: { text: 'walt', author: { access: 'write', person: 'Walt' } } })
  })

  it('the store is the opener\'s, never a plugin or key from the payload', async () => {
    const t = setup()
    const id = t.open()
    const own = t.copyOf(id, 'web:1')
    await t.call('web:1', 'overlays.notes.write', { overlayId: id, copy: own, op: 'setGlobal', text: 'g', pluginId: 'b.two', key: 'other' })
    expect((await t.notes.list(PROJECT, 'a.one', 'doc:1')).global).toBe('g')
    expect((await t.notes.list(PROJECT, 'b.two', 'other')).global).toBe('')
  })
})
