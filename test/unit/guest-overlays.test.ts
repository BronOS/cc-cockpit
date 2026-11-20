// Overlays and guests (design-guests §9, spec-review 16, D-14): the origin an overlay is opened with and visibleTo, the
// `ownerView` hook that keeps a guest's view from holding an html overlay's page, and guestResize's explicit-only size.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GUEST_ORIGIN_OVERLAY_REFUSAL,
  OverlayManager,
  type OverlayChannel,
  type OverlayResult,
  type UrlView,
  type UrlViewFactory
} from '../../src/main/overlays/overlay-manager'
import { guestEvent, type GuestEventContext } from '../../src/main/web/guest-events'
import { mayConnectCopyOf, overlayCopyPortOf, overlayVisibleOf, type OverlayCopySources } from '../../src/main/guest-wiring'
import type { GuestService } from '../../src/main/ipc/guest-deps'
import { IpcRouter, registerOverlayHandlers, webCaller, type IpcMainLike } from '../../src/main/ipc/router'
import { guestOverlays } from '../../src/shared/guest-filter'
import type { GuestAccess, GuestOnlyAccess } from '../../src/shared/guests'
import type { InvokeChannel, OverlayInfo } from '../../src/shared/ipc'
import type { ViewId, Who } from '../../src/shared/views'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const W1 = 1
const GUEST = 'web:9'
const OWNER = 'web:1'

class NoViews implements UrlViewFactory {
  create(): UrlView {
    throw new Error('no url overlays here')
  }
  focusWindow(): void {}
}

let dir: string
let backend: FakePtyBackend

beforeEach(() => {
  vi.useFakeTimers()
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-guest-overlays-')))
  backend = new FakePtyBackend()
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function manager(extra: Partial<ConstructorParameters<typeof OverlayManager>[0]> = {}): OverlayManager {
  return new OverlayManager({
    ownerView: () => true,
    backend,
    views: new NoViews(),
    isWindowOpen: () => true,
    env: () => ({}),
    emit: () => {},
    emitToView: () => true,
    commandForChord: () => undefined,
    log: () => {},
    ...extra
  })
}

const terminal = { kind: 'terminal', argv: ['true'], cwd: '' }
const page = { kind: 'html', src: 'cc-plugin://a.one/chat.html' }
const swallow = (p: Promise<OverlayResult>): void => void p.catch(() => undefined)
const idOf = (m: OverlayManager): string => m.infos(W1).at(-1)!.id
const yes = () => true
const no = () => false

describe('visibleTo', () => {
  function opened(origin?: { tabId?: string; pluginId?: string }, pluginId?: string) {
    const m = manager()
    swallow(m.open(W1, { ...terminal, cwd: dir }, 'cli', undefined, undefined, pluginId, undefined, origin))
    return { m, id: idOf(m) }
  }

  it('is true through a visible origin tab, false when that tab is not visible', () => {
    const { m, id } = opened({ tabId: 't1' })
    expect(m.visibleTo(W1, id, (t) => t === 't1', no)).toBe(true)
    expect(m.visibleTo(W1, id, (t) => t === 't2', yes)).toBe(false)
  })

  it('is true through a visible origin plugin, false when it is not visible', () => {
    const { m, id } = opened({ pluginId: 'a.one' })
    expect(m.visibleTo(W1, id, no, (p) => p === 'a.one')).toBe(true)
    expect(m.visibleTo(W1, id, yes, (p) => p === 'b.two')).toBe(false)
  })

  it('an origin tab decides alone: a visible plugin does not add to a hidden tab', () => {
    const { m, id } = opened({ tabId: 't1', pluginId: 'a.one' })
    expect(m.visibleTo(W1, id, no, yes)).toBe(false)
  })

  it('is false with no origin, whatever the callbacks say', () => {
    const { m, id } = opened()
    expect(m.visibleTo(W1, id, yes, yes)).toBe(false)
  })

  it('a plugin open with a pluginId and no origin counts as that plugin', () => {
    const { m, id } = opened(undefined, 'a.one')
    expect(m.visibleTo(W1, id, no, (p) => p === 'a.one')).toBe(true)
    expect(m.visibleTo(W1, id, yes, (p) => p === 'b.two')).toBe(false)
  })

  it('is false for an unknown overlay and for another window', () => {
    const { m, id } = opened({ tabId: 't1' })
    expect(m.visibleTo(W1, 'nope', yes, yes)).toBe(false)
    expect(m.visibleTo(2, id, yes, yes)).toBe(false)
  })

  it('start takes the origin too', () => {
    const m = manager()
    swallow(m.start(W1, { ...terminal, cwd: dir }, 'cli', undefined, undefined, undefined, undefined, { tabId: 't7' }))
    expect(m.visibleTo(W1, idOf(m), (t) => t === 't7', no)).toBe(true)
  })
})

describe('ownerView: a guest view never holds an html overlay', () => {
  const live = () => true

  it("a guest's view as the origin: refused, any kind, desktop or server; nothing reaches the owner's screen (03e)", async () => {
    for (const server of [false, true]) {
      const emitted: string[] = []
      const m = manager({ server, isViewLive: live, browserViews: () => [OWNER, GUEST], ownerView: (v) => v !== GUEST, emit: (_w, ch) => void emitted.push(ch) })
      for (const spec of [page, { ...terminal, cwd: dir }]) {
        expect(() => m.start(W1, spec, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one', GUEST)).toThrow(GUEST_ORIGIN_OVERLAY_REFUSAL)
        await expect(m.open(W1, spec, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one', GUEST)).rejects.toThrow(GUEST_ORIGIN_OVERLAY_REFUSAL)
      }
      // A guest view that is gone by now is refused the same (only an owner's view lets it through).
      expect(() => manager({ server, isViewLive: () => false, ownerView: (v) => v !== GUEST }).start(W1, page, 'plugin a.one', undefined, undefined, 'a.one', GUEST)).toThrow(
        GUEST_ORIGIN_OVERLAY_REFUSAL
      )
      expect(m.infos(W1)).toEqual([])
      expect(backend.spawned).toHaveLength(0)
      expect(emitted).toEqual([])
    }
  })

  it("an owner's browser view as origin still holds it", () => {
    const m = manager({ isViewLive: live, ownerView: (v) => v !== GUEST })
    swallow(m.open(W1, page, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one', OWNER))
    expect(m.infos(W1)[0]?.heldBy?.viewId).toBe(OWNER)
  })

  it('an ownerView that says owner (no guests): a remote origin view holds it, as before', () => {
    const m = manager({ isViewLive: live })
    swallow(m.open(W1, page, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one', GUEST))
    expect(m.infos(W1)[0]?.heldBy?.viewId).toBe(GUEST)
  })

  it('server mode: a guest is skipped as browserHolder, in favour of the next owner browser', () => {
    const m = manager({ server: true, isViewLive: live, browserViews: () => [GUEST, OWNER], ownerView: (v) => v !== GUEST })
    swallow(m.open(W1, page, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one'))
    expect(m.infos(W1)[0]?.heldBy?.viewId).toBe(OWNER)
  })

  it('server mode: with only guests attached nobody holds a page opened with no origin view', () => {
    const only = manager({ server: true, isViewLive: live, browserViews: () => [GUEST], ownerView: (v) => v !== GUEST })
    swallow(only.open(W1, page, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one'))
    expect(only.infos(W1)[0]?.heldBy).toBeUndefined()
  })

  it('server mode: a guest listing the stack never picks up a waiting page; an owner browser does', () => {
    const m = manager({ server: true, isViewLive: live, browserViews: () => [], ownerView: (v) => v !== GUEST })
    swallow(m.open(W1, page, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one'))
    expect(m.list(W1, GUEST)[0]?.heldBy).toBeUndefined()
    expect(m.list(W1, OWNER)[0]?.heldBy?.viewId).toBe(OWNER)
  })

  it('a guest cannot take a page over (desktop or server)', () => {
    for (const server of [false, true]) {
      const m = manager({ server, isViewLive: live, browserViews: () => [OWNER], ownerView: (v) => v !== GUEST })
      swallow(m.open(W1, page, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one', OWNER))
      expect(m.take(W1, GUEST, idOf(m))).toBe(false)
      expect(m.infos(W1)[0]?.heldBy?.viewId).toBe(OWNER)
    }
  })
})

describe('guestResize', () => {
  it("is remembered but does not size the pty; the guest's typing takes the size", () => {
    const m = manager()
    swallow(m.open(W1, { ...terminal, cwd: dir }, 'cli'))
    const id = idOf(m)
    const pty = backend.last
    m.resize(W1, id, 120, 40, OWNER)
    m.guestResize(W1, id, 40, 10, GUEST)
    m.guestResize(W1, id, 41, 10, GUEST)
    expect(pty.resizes).toEqual([[120, 40]])
    m.input(W1, id, 'x', GUEST)
    vi.advanceTimersByTime(1000)
    expect(pty.resizes).toEqual([[120, 40], [41, 10]])
  })

  it('a lone guest report sizes nothing; an unknown overlay and a non-terminal one are ignored', () => {
    const m = manager()
    swallow(m.open(W1, { ...terminal, cwd: dir }, 'cli'))
    const id = idOf(m)
    m.guestResize(W1, id, 40, 10, GUEST)
    m.guestResize(W1, 'nope', 40, 10, GUEST)
    m.guestResize(2, id, 40, 10, GUEST)
    expect(backend.last.resizes).toEqual([])
  })
})

// Provenance (docs/design-overlay-views.md §4, D-4): `via`, the plugins an overlay was opened or filled for. A guest gets
// it (copies, title, list entry, terminal data) only when the opener and every `via` plugin are visible to it.
describe('provenance (via)', () => {
  /** The guest sees the Reviewer (a.rev) and a.vis; a.gmail is hidden from it. */
  const shown = (p: string): boolean => p === 'a.rev' || p === 'a.vis'
  const pv = { kind: 'html', src: 'cc-plugin://a.rev/review.html' }

  /** A guest connection's filter context whose overlay rule is the manager's own (index.ts guestSources). */
  function guestCtx(m: OverlayManager): GuestEventContext {
    return {
      viewId: GUEST,
      access: { kind: 'guest', id: 'g1', name: 'Bob', role: 'write', projectId: 'p1', scope: { kind: 'all' } as never },
      tabVisible: (t) => t === 't1',
      pluginVisible: shown,
      overlayVisible: (id) => m.visibleTo(W1, id, (t) => t === 't1', shown),
      personOf: () => undefined,
      tabOrder: () => [],
      downloadOrigin: () => undefined,
      ownerName: () => 'Oleg'
    }
  }

  it("a plugin's own overlay with no via is unchanged: visible when the opener is", () => {
    const m = manager()
    swallow(m.open(W1, { ...terminal, cwd: dir }, 'plugin a.rev', undefined, undefined, 'a.rev'))
    expect(m.visibleTo(W1, idOf(m), no, shown)).toBe(true)
  })

  it('A -> B -> Reviewer: both callers count; hidden when either is hidden, shown when all are', () => {
    const m = manager()
    swallow(m.open(W1, { ...terminal, cwd: dir }, 'plugin a.rev', undefined, undefined, 'a.rev', undefined, undefined, { via: ['a.vis', 'a.gmail'] }))
    const id = idOf(m)
    expect(m.visibleTo(W1, id, yes, shown)).toBe(false)
    expect(m.visibleTo(W1, id, no, (p) => shown(p) || p === 'a.gmail')).toBe(true)
    expect(m.visibleTo(W1, id, no, (p) => p === 'a.rev' || p === 'a.gmail')).toBe(false)
  })

  it('addSources only grows (a source cannot be taken back), ignores the opener and repeats, and answers whether it grew', () => {
    const m = manager()
    swallow(m.open(W1, { ...terminal, cwd: dir }, 'plugin a.rev', undefined, undefined, 'a.rev'))
    const id = idOf(m)
    expect(m.addSources(W1, id, ['a.rev'])).toBe(false)
    expect(m.addSources(W1, id, ['a.vis'])).toBe(true)
    expect(m.addSources(W1, id, ['a.vis', 'a.rev'])).toBe(false)
    expect(m.visibleTo(W1, id, no, shown)).toBe(true)
    expect(m.addSources(W1, id, ['a.gmail'])).toBe(true)
    expect(m.visibleTo(W1, id, no, shown)).toBe(false)
    expect(m.addSources(W1, 'nope', ['a.gmail'])).toBe(false)
    expect(m.addSources(2, id, ['a.gmail'])).toBe(false)
  })

  it('the shared-tab origin rule is unchanged; a via on one would still narrow it (fail closed)', () => {
    const m = manager()
    swallow(m.open(W1, { ...terminal, cwd: dir }, 'cli', undefined, undefined, undefined, undefined, { tabId: 't1' }))
    const id = idOf(m)
    expect(m.visibleTo(W1, id, (t) => t === 't1', no)).toBe(true)
    expect(m.visibleTo(W1, id, no, yes)).toBe(false)
    m.addSources(W1, id, ['a.gmail'])
    expect(m.visibleTo(W1, id, (t) => t === 't1', shown)).toBe(false)
  })

  it("the 0.24.0 leak: a hidden plugin's overlay shown in the Reviewer never reaches a guest, title, data and list included", () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const m = manager({ emit: (_w, channel, payload) => void sent.push({ channel, payload }) })
    // Non-perView (one holder), as 0.24.0's Reviewer: the title is the mail's subject.
    swallow(m.open(W1, { ...terminal, cwd: dir, title: 'Re: salary' }, 'plugin a.rev', undefined, undefined, 'a.rev', undefined, undefined, { via: ['a.gmail'] }))
    const id = idOf(m)
    const g = guestCtx(m)
    // Hidden from the very first listing (via is on the record before `changed`).
    const updated = sent.filter((e) => e.channel === 'overlays.updated')
    expect(updated).toHaveLength(1)
    expect((updated[0]!.payload as OverlayInfo[])[0]!.title).toBe('Re: salary')
    for (const e of updated) expect(guestEvent('overlays.updated', e.payload, g)).toEqual([])
    expect(guestEvent('overlays.data', { overlayId: id, data: 'Dear Oleg' }, g)).toBeUndefined()
    // The `ready` snapshot's overlays (guestSnapshot) and the router's overlays.list go through the same filter.
    expect(guestOverlays(m.infos(W1), g)).toEqual([])
    // The Reviewer's own overlay beside it still reaches the guest.
    swallow(m.open(W1, { ...terminal, cwd: dir, title: 'diff a.ts' }, 'plugin a.rev', undefined, undefined, 'a.rev'))
    const own = idOf(m)
    expect((guestEvent('overlays.updated', m.infos(W1), g) as OverlayInfo[]).map((o) => o.id)).toEqual([own])
    expect(guestEvent('overlays.data', { overlayId: own, data: 'x' }, g)).toEqual({ overlayId: own, data: 'x' })
  })

  it('growth on a non-perView overlay sends the list again, which the guest filter now drops it from', () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const m = manager({ emit: (_w, channel, payload) => void sent.push({ channel, payload }) })
    swallow(m.open(W1, { ...page, title: 'diff' }, 'plugin a.rev', undefined, { onMessage: () => {} }, 'a.rev'))
    const id = idOf(m)
    const g = guestCtx(m)
    expect((guestEvent('overlays.updated', sent.at(-1)!.payload, g) as OverlayInfo[]).map((o) => o.id)).toEqual([id])
    sent.length = 0
    expect(m.addSources(W1, id, ['a.gmail'])).toBe(true)
    expect(sent.map((e) => e.channel)).toEqual(['overlays.updated'])
    expect(guestEvent('overlays.updated', sent[0]!.payload, g)).toEqual([])
    // Nothing new: no emit.
    expect(m.addSources(W1, id, ['a.gmail'])).toBe(false)
    expect(sent).toHaveLength(1)
  })

  it("growth on a live perView overlay releases the guest's copy and drops its queue before the post that grew it is delivered", () => {
    const log: string[] = []
    const m = manager({
      ownerView: (v) => v !== GUEST,
      isViewLive: () => true,
      // Task 5's rule in short: a guest may load a copy only while the overlay is visible to it.
      mayConnectCopy: (w, o) => m.visibleTo(w, o, no, shown),
      emit: (_w, channel) => void log.push(`emit ${channel}`),
      emitToView: (viewId, channel, payload) => {
        const p = payload as { message?: string }
        log.push(`${viewId} ${channel}${p.message !== undefined ? ` ${p.message}` : ''}`)
        return true
      }
    })
    const channel: OverlayChannel = {
      onMessage: () => {},
      onConnect: (copy, view) => void log.push(`connect ${view}`),
      onDisconnect: (copy, view) => void log.push(`disconnect ${view}`)
    }
    swallow(m.open(W1, pv, 'plugin a.rev', undefined, channel, 'a.rev', undefined, undefined, { perView: true }))
    const id = idOf(m)
    const own = m.connectCopy(W1, id, OWNER)
    const guest = m.connectCopy(W1, id, GUEST)
    if (!own.ok || !guest.ok) throw new Error('refused')
    m.copyReady(W1, id, OWNER, own.copy)
    // The guest's page is not up yet: its starting state waits in its queue.
    m.post(W1, id, '"start-guest"', { copy: guest.copy })
    m.post(W1, id, '"start-owner"', { copy: own.copy })
    log.length = 0
    // What host-api does for a post carrying a new source: grow first, then post, in one synchronous step.
    m.addSources(W1, id, ['a.gmail'])
    m.post(W1, id, '"the mail"')
    expect(log).toEqual([`disconnect ${GUEST}`, `${GUEST} overlays.hide`, 'emit overlays.updated', `${OWNER} overlays.message "the mail"`])
    // Its queue went with it: its page coming up now gets nothing, and it cannot connect again.
    expect(m.copyReady(W1, id, GUEST, guest.copy)).toBe(false)
    expect(m.copies(W1, id).map((c) => c.view)).toEqual([OWNER])
    expect(m.connectCopy(W1, id, GUEST)).toEqual({ ok: false, reason: 'not-allowed' })
    expect(log.filter((l) => l.startsWith(`${GUEST} overlays.message`))).toEqual([])
  })

  it("growth to a source the guest sees keeps its copy; an owner's copies are never released", () => {
    const released: string[] = []
    const m = manager({
      ownerView: (v) => v !== GUEST,
      isViewLive: () => true,
      mayConnectCopy: (w, o) => m.visibleTo(w, o, no, shown),
      emitToView: () => true
    })
    swallow(m.open(W1, pv, 'plugin a.rev', undefined, { onMessage: () => {}, onDisconnect: (_c, v) => void released.push(v) }, 'a.rev', undefined, undefined, { perView: true }))
    const id = idOf(m)
    for (const v of ['desktop:1', OWNER, GUEST]) expect(m.connectCopy(W1, id, v).ok).toBe(true)
    m.addSources(W1, id, ['a.vis'])
    expect(released).toEqual([])
    m.addSources(W1, id, ['a.gmail'])
    expect(released).toEqual([GUEST])
    expect(m.copies(W1, id).map((c) => c.view)).toEqual(['desktop:1', OWNER])
  })

  it('with no mayConnectCopy wired (or one that throws), growth releases every guest copy (fail closed)', () => {
    const released: string[] = []
    let admit = true
    const m = manager({
      ownerView: (v) => v !== GUEST,
      isViewLive: () => true,
      mayConnectCopy: () => {
        if (admit) return true
        throw new Error('boom')
      },
      emitToView: () => true
    })
    swallow(m.open(W1, pv, 'plugin a.rev', undefined, { onMessage: () => {}, onDisconnect: (_c, v) => void released.push(v) }, 'a.rev', undefined, undefined, { perView: true }))
    const id = idOf(m)
    expect(m.connectCopy(W1, id, GUEST).ok).toBe(true)
    admit = false
    m.addSources(W1, id, ['a.vis'])
    expect(released).toEqual([GUEST])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Task 5 (docs/design-overlay-views.md §5 "Guest rows", "✕ and results", D-2, D-17): guests' own copies of a perView
// overlay through the real router, manager and wiring rules (guest-wiring.ts overlayVisibleOf, mayConnectCopyOf,
// overlayCopyPortOf), as index.ts wires them.
describe('guests and their own overlay copies (router, manager, wiring)', () => {
  const PROJECT = 'aaaaaaaaaaaaaaaa'
  const CTX = { kind: 'project' as const, windowId: W1, projectId: PROJECT }
  /** web:3 is the owner's browser; gR reads (web:5, and web:7 after a reconnect), gW writes (web:6), gX is revoked (web:8). */
  const whoOf = (v: string): Who | undefined =>
    v === 'desktop:1' || v === 'web:3'
      ? 'owner'
      : v === 'web:5' || v === 'web:7'
        ? { guest: 'gR' }
        : v === 'web:6'
          ? { guest: 'gW' }
          : v === 'web:8'
            ? { guest: 'gX' }
            : undefined
  const accessOf = (who: Who): GuestAccess => {
    if (who === 'owner') return { kind: 'owner' }
    if (who.guest === 'gR') return { kind: 'guest', id: 'gR', name: 'Rita', role: 'read', projectId: PROJECT, scope: 'all' }
    if (who.guest === 'gW') return { kind: 'guest', id: 'gW', name: 'Walt', role: 'write', projectId: PROJECT, scope: 'all' }
    return { kind: 'revoked' }
  }

  function setup(opts: { aware?: boolean } = {}) {
    const logs: string[] = []
    const heard: unknown[][] = []
    const events: Array<[string, string, unknown]> = []
    /** Plugins shown to the project's guests: the Reviewer (a.rev); a.gmail is hidden. */
    const shown = new Set(['a.rev'])
    const guests = {
      access: accessOf,
      tabVisible: () => false,
      pluginVisible: (_p: string, id: string) => shown.has(id)
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
      // shared/guest-access.ts guestPort over the fake visibility: hidden none; write or aware full; read one-way.
      port: (_p, id, role) => (!shown.has(id) ? 'none' : role === 'write' || opts.aware === true ? 'full' : 'oneWay')
    }
    m = manager({
      ownerView: (v) => whoOf(v) === 'owner',
      isViewLive: (v, w) => w === W1 && whoOf(v) !== undefined,
      guestOf: (v) => {
        const who = whoOf(v)
        return who === undefined || who === 'owner' ? undefined : who.guest
      },
      mayConnectCopy: mayConnectCopyOf(sources),
      copyPort: overlayCopyPortOf(sources),
      emit: (_w, channel, payload) => void events.push(['window', channel, payload]),
      emitToView: (viewId, channel, payload) => {
        events.push([viewId, channel, payload])
        return true
      },
      log: (l) => void logs.push(l)
    })
    const router = new IpcRouter(
      { handle: () => {} } as IpcMainLike,
      () => undefined,
      () => true,
      (l) => void logs.push(l),
      (windowId, projectId) => windowId === W1 && projectId === PROJECT
    )
    router.setGuestDeps({ guests, overlayVisible })
    registerOverlayHandlers(router, {
      list: (w, v) => m.list(w, v),
      close: (w, o) => m.close(w, o),
      input: () => {},
      resize: () => {},
      ack: () => {},
      setBounds: () => {},
      result: (w, o, value, v) => m.result(w, o, value, v),
      message: (w, o, text, v) => m.pageMessage(w, o, text, v),
      ready: (w, o, v) => m.pageReady(w, o, v),
      loaded: (w, o, v) => m.pageLoaded(w, o, v),
      take: (w, v, o) => m.take(w, v, o),
      button: (w, o, click, v) => m.buttonClick(w, o, click, v),
      discuss: (w, o, t, g, v) => m.discuss(w, o, t, g, v),
      perView: (w, o) => m.isPerView(w, o),
      connectCopy: (w, o, v) => m.connectReady(w, o, v),
      copyLoaded: (w, o, v, c) => m.copyLoaded(w, o, v, c),
      copyMessage: (w, o, v, c, text) => m.copyMessage(w, o, v, c, text),
      copyResult: (w, o, v, c, value) => m.copyResult(w, o, v, c, value),
      releaseCopy: (w, o, v, c, options) => m.releaseCopy(w, o, v, c, options)
    })
    const channel: OverlayChannel = {
      onMessage: (message, view, copy) => void heard.push(['message', message, view, copy]),
      onConnect: (copy, view) => void heard.push(['connect', view, copy]),
      onDisconnect: (copy, view) => void heard.push(['disconnect', view, copy])
    }
    const results: Array<Promise<OverlayResult>> = []
    const openPv = (via?: string[], ready?: 'manual'): string => {
      const r = m.open(W1, { kind: 'html', html: '<p>diff</p>', title: 'diff', ...(ready ? { ready } : {}) }, 'plugin a.rev', undefined, channel, 'a.rev', undefined, undefined, {
        perView: true,
        ...(via ? { via } : {})
      })
      swallow(r)
      results.push(r)
      return idOf(m)
    }
    const pv = openPv()
    swallow(m.open(W1, { kind: 'html', html: '<p>one</p>', title: 'plain' }, 'plugin a.rev', undefined, channel, 'a.rev'))
    const plain = idOf(m)
    const call = (viewId: string, ch: InvokeChannel, payload: unknown): Promise<unknown> =>
      Promise.resolve().then(() => router.dispatch(webCaller(CTX, viewId as ViewId, whoOf(viewId) ?? { guest: 'nobody' }), ch, payload))
    const outcome = (p: Promise<unknown>): Promise<unknown> => p.then((v) => v, () => 'refused')
    /** The guest connection's filter context for a view (index.ts guestSources over the same rule). */
    const sink = (viewId: string): GuestEventContext => {
      const who = whoOf(viewId) as { guest: string }
      const access = accessOf(who) as GuestOnlyAccess
      return {
        viewId,
        access,
        tabVisible: () => false,
        pluginVisible: (id) => shown.has(id),
        overlayVisible: (o) => overlayVisible(PROJECT, o, access),
        ownCopy: (o, c) => m.copyViewOf(W1, o, c) === viewId,
        personOf: () => undefined,
        tabOrder: () => [],
        downloadOrigin: () => undefined,
        ownerName: () => 'Oleg'
      }
    }
    return { m, pv, plain, openPv, results, call, outcome, heard, events, logs, shown, sink }
  }

  it('a read and a write guest each connect their own copy of a perView overlay; the opener hears each with its view', async () => {
    const { m, pv, call, heard } = setup()
    const r = (await call('web:5', 'overlays.ready', { overlayId: pv })) as { copy: string }
    const w = (await call('web:6', 'overlays.ready', { overlayId: pv })) as { copy: string }
    expect(r.copy).toMatch(/^[0-9a-f]{32}$/)
    expect(m.copies(W1, pv).map((c) => [c.view, c.ready])).toEqual([['web:5', true], ['web:6', true]])
    expect(heard).toEqual([['connect', 'web:5', r.copy], ['connect', 'web:6', w.copy]])
    await call('web:5', 'overlays.loaded', { overlayId: pv, copy: r.copy })
    expect(m.copyState(W1, pv, 'web:5', r.copy)?.loaded).toBe(true)
  })

  it('every widened row refuses a non-perView overlay to a guest (never the single holder page), owners unchanged', async () => {
    const { plain, call, outcome, heard } = setup()
    for (const viewId of ['web:5', 'web:6']) {
      expect(await outcome(call(viewId, 'overlays.ready', { overlayId: plain })), viewId).toBe('refused')
      expect(await outcome(call(viewId, 'overlays.loaded', { overlayId: plain })), viewId).toBe('refused')
      expect(await outcome(call(viewId, 'overlays.message', { overlayId: plain, message: '"x"' })), viewId).toBe('refused')
      expect(await outcome(call(viewId, 'overlays.release', { overlayId: plain, copy: 'c' })), viewId).toBe('refused')
    }
    expect(heard).toEqual([])
    // The owner's browser keeps the holder's path.
    expect(await outcome(call('web:3', 'overlays.ready', { overlayId: plain }))).toBeUndefined()
  })

  it('a forged copy id and another view\'s copy are dropped, never heard as the guest\'s', async () => {
    const { openPv, call, heard, m } = setup()
    // `manual`: a copy's loader stays until its own page says so, so a forged `loaded` would show.
    const pv = openPv(undefined, 'manual')
    const own = (await call('web:3', 'overlays.ready', { overlayId: pv })) as { copy: string }
    const w = (await call('web:6', 'overlays.ready', { overlayId: pv })) as { copy: string }
    heard.length = 0
    for (const copy of ['0'.repeat(32), own.copy]) {
      expect(await call('web:6', 'overlays.message', { overlayId: pv, message: '"forged"', copy })).toBe(false)
      expect(await call('web:6', 'overlays.release', { overlayId: pv, copy })).toBe(false)
      expect(await call('web:5', 'overlays.release', { overlayId: pv, copy: w.copy })).toBe(false)
      await call('web:6', 'overlays.loaded', { overlayId: pv, copy })
    }
    expect(heard).toEqual([])
    expect(m.copies(W1, pv).map((c) => [c.view, c.loaded])).toEqual([['web:3', false], ['web:6', false]])
    await call('web:6', 'overlays.loaded', { overlayId: pv, copy: w.copy })
    expect(m.copies(W1, pv).map((c) => [c.view, c.loaded])).toEqual([['web:3', false], ['web:6', true]])
    // A missing copy on a perView overlay is refused outright.
    await expect(call('web:6', 'overlays.message', { overlayId: pv, message: '"x"' })).rejects.toThrow(/copy is required/)
  })

  it('an overlay hidden by via (a hidden plugin asked for it) refuses every row at the gate; a revoked guest is refused too', async () => {
    const { openPv, call, outcome, heard, logs } = setup()
    const viaHidden = openPv(['a.gmail'])
    for (const ch of ['overlays.ready', 'overlays.loaded', 'overlays.message', 'overlays.release'] as const) {
      expect(await outcome(call('web:6', ch, { overlayId: viaHidden, copy: 'c', message: '"x"' })), ch).toBe('refused')
      expect(await outcome(call('web:8', ch, { overlayId: viaHidden, copy: 'c', message: '"x"' })), ch).toBe('refused')
    }
    expect(heard).toEqual([])
    expect(logs.some((l) => l.includes('target not visible'))).toBe(true)
    expect(logs.some((l) => l.includes('not a live guest of this project'))).toBe(true)
  })

  it('a revoked guest is refused on a perView overlay it saw before', async () => {
    const { pv, call, outcome } = setup()
    for (const ch of ['overlays.ready', 'overlays.message', 'overlays.release'] as const) {
      expect(await outcome(call('web:8', ch, { overlayId: pv, copy: 'c', message: '"x"' })), ch).toBe('refused')
    }
  })

  it('results are the owner\'s: refused for a read guest (class) and a write guest (handler), perView or not', async () => {
    const { pv, plain, call, outcome, m } = setup()
    const w = (await call('web:6', 'overlays.ready', { overlayId: pv })) as { copy: string }
    expect(await outcome(call('web:6', 'overlays.result', { overlayId: pv, value: 1, copy: w.copy }))).toBe('refused')
    expect(await outcome(call('web:6', 'overlays.result', { overlayId: plain, value: 1 }))).toBe('refused')
    expect(await outcome(call('web:5', 'overlays.result', { overlayId: pv, value: 1, copy: 'c' }))).toBe('refused')
    expect(m.infos(W1)).toHaveLength(2)
  })

  it("a write guest's close ends the overlay for everyone (D-2); a read guest's close is refused (its ✕ is a release)", async () => {
    const { pv, call, outcome, results, m } = setup()
    expect(await outcome(call('web:5', 'overlays.close', { overlayId: pv }))).toBe('refused')
    expect(m.isPerView(W1, pv)).toBe(true)
    expect(await call('web:6', 'overlays.close', { overlayId: pv })).toBe(true)
    await expect(results[0]).resolves.toEqual({ kind: 'dismissed' })
    expect(m.isPerView(W1, pv)).toBe(false)
  })

  it("a read guest's release is its hide: off its stack on every view, refused on a reconnect's new view, other guests unchanged", async () => {
    const { m, pv, plain, call, outcome, events, sink, heard } = setup()
    const a = (await call('web:5', 'overlays.ready', { overlayId: pv })) as { copy: string }
    const w = (await call('web:6', 'overlays.ready', { overlayId: pv })) as { copy: string }
    events.length = 0
    expect(await call('web:5', 'overlays.release', { overlayId: pv, copy: a.copy })).toBe(true)
    expect(heard.at(-1)).toEqual(['disconnect', 'web:5', a.copy])
    expect(m.hiddenFrom(W1, pv, 'gR')).toBe(true)
    // The list went out again; the read guest's filter drops the overlay, the write guest's keeps it.
    const updated = events.filter((e) => e[1] === 'overlays.updated').at(-1)![2] as OverlayInfo[]
    // (The non-perView overlay beside it stays: it was not hidden.)
    expect((guestEvent('overlays.updated', updated, sink('web:5')) as OverlayInfo[]).map((o) => o.id)).toEqual([plain])
    expect((guestEvent('overlays.updated', updated, sink('web:6')) as OverlayInfo[]).map((o) => o.id)).toContain(pv)
    // A reconnect (a new view of the same guest): the list, the snapshot's overlays and a connect all leave it out.
    expect((await call('web:7', 'overlays.list', undefined)) as OverlayInfo[]).not.toContainEqual(expect.objectContaining({ id: pv }))
    expect(guestOverlays(m.infos(W1), sink('web:7')).map((o) => o.id)).not.toContain(pv)
    expect(await outcome(call('web:7', 'overlays.ready', { overlayId: pv }))).toBe('refused')
    expect(m.connectCopy(W1, pv, 'web:7')).toEqual({ ok: false, reason: 'not-allowed' })
    // The write guest's copy is untouched; its release only lets go (no hide).
    expect(m.copies(W1, pv).map((c) => c.view)).toEqual(['web:6'])
    expect(await call('web:6', 'overlays.release', { overlayId: pv, copy: w.copy })).toBe(true)
    expect(m.hiddenFrom(W1, pv, 'gW')).toBe(false)
    expect(((await call('web:6', 'overlays.ready', { overlayId: pv })) as { copy?: string }).copy).toBeDefined()
  })

  it("a read guest's hide releases its other views' copies with overlays.hide to each, which its sink passes", async () => {
    const { m, pv, call, events, sink } = setup()
    const a = (await call('web:5', 'overlays.ready', { overlayId: pv })) as { copy: string }
    const b = (await call('web:7', 'overlays.ready', { overlayId: pv })) as { copy: string }
    events.length = 0
    await call('web:5', 'overlays.release', { overlayId: pv, copy: a.copy })
    const hides = events.filter((e) => e[1] === 'overlays.hide')
    expect(hides).toEqual([['web:7', 'overlays.hide', { overlayId: pv, copy: b.copy }]])
    // Sent after the copy was released and the overlay hidden from that guest: the sink still passes its own copy's hide,
    // and never another view's.
    expect(guestEvent('overlays.hide', hides[0]![2], sink('web:7'))).toEqual({ overlayId: pv, copy: b.copy })
    expect(guestEvent('overlays.hide', hides[0]![2], sink('web:6'))).toBeUndefined()
    expect(m.copies(W1, pv)).toEqual([])
  })

  it("the opener's hide of a guest's copy is recorded for that guest; of an owner's copy it only releases", async () => {
    const { m, pv, call } = setup()
    const own = (await call('web:3', 'overlays.ready', { overlayId: pv })) as { copy: string }
    const w = (await call('web:6', 'overlays.ready', { overlayId: pv })) as { copy: string }
    expect(m.hideCopy(W1, pv, own.copy)).toBe(true)
    expect(m.connectCopy(W1, pv, 'web:3').ok).toBe(true)
    expect(m.hideCopy(W1, pv, w.copy)).toBe(true)
    expect(m.hiddenFrom(W1, pv, 'gW')).toBe(true)
    expect(m.connectCopy(W1, pv, 'web:6')).toEqual({ ok: false, reason: 'not-allowed' })
  })

  it('a growth release is not a hide: the guest gets the overlay back once the owner shows that plugin', async () => {
    const { m, pv, call, shown } = setup()
    await call('web:6', 'overlays.ready', { overlayId: pv })
    m.addSources(W1, pv, ['a.gmail'])
    expect(m.copies(W1, pv)).toEqual([])
    expect(m.hiddenFrom(W1, pv, 'gW')).toBe(false)
    shown.add('a.gmail')
    expect(((await call('web:6', 'overlays.ready', { overlayId: pv })) as { copy?: string }).copy).toBeDefined()
  })

  it('a read guest of a plugin that is not guests.aware gets a one-way copy: its messages dropped (logged once), posts still reach it', async () => {
    const { m, pv, call, heard, events, logs } = setup()
    const r = (await call('web:5', 'overlays.ready', { overlayId: pv })) as { copy: string }
    const w = (await call('web:6', 'overlays.ready', { overlayId: pv })) as { copy: string }
    heard.length = 0
    expect(await call('web:5', 'overlays.message', { overlayId: pv, message: '"note"', copy: r.copy })).toBe(false)
    expect(await call('web:5', 'overlays.message', { overlayId: pv, message: '"again"', copy: r.copy })).toBe(false)
    expect(logs.filter((l) => l.includes('is one-way'))).toHaveLength(1)
    // A write guest's copy is full.
    expect(await call('web:6', 'overlays.message', { overlayId: pv, message: '"edit"', copy: w.copy })).toBe(true)
    expect(heard).toEqual([['message', 'edit', 'web:6', w.copy]])
    // The opener's posts reach the one-way copy.
    events.length = 0
    m.post(W1, pv, '"state"', { copy: r.copy })
    expect(events).toEqual([['web:5', 'overlays.message', { overlayId: pv, message: '"state"', copy: r.copy }]])
  })

  it('a guests.aware plugin gives a read guest a full copy', async () => {
    const { pv, call, heard } = setup({ aware: true })
    const r = (await call('web:5', 'overlays.ready', { overlayId: pv })) as { copy: string }
    expect(await call('web:5', 'overlays.message', { overlayId: pv, message: '"hi"', copy: r.copy })).toBe(true)
    expect(heard.at(-1)).toEqual(['message', 'hi', 'web:5', r.copy])
  })

  it("the sink passes a copy's messages to its own view only, by the manager's record", async () => {
    const { m, pv, call, events, sink } = setup()
    const r = (await call('web:5', 'overlays.ready', { overlayId: pv })) as { copy: string }
    await call('web:6', 'overlays.ready', { overlayId: pv })
    events.length = 0
    m.post(W1, pv, '"to rita"', { copy: r.copy })
    const [, ch, payload] = events[0]!
    expect(guestEvent(ch, payload, sink('web:5'))).toEqual(payload)
    expect(guestEvent(ch, payload, sink('web:6'))).toBeUndefined()
    expect(guestEvent(ch, payload, sink('web:7'))).toBeUndefined()
  })

  it('remembers the views of the last released copies only (bounded)', async () => {
    const { m, pv, call } = setup()
    const first = (await call('web:3', 'overlays.ready', { overlayId: pv })) as { copy: string }
    m.releaseCopy(W1, pv, 'web:3', first.copy)
    expect(m.copyViewOf(W1, pv, first.copy)).toBe('web:3')
    for (let i = 0; i < 40; i++) {
      const c = m.connectCopy(W1, pv, 'desktop:1')
      if (!c.ok) {
        vi.advanceTimersByTime(10_000)
        i--
        continue
      }
      m.releaseCopy(W1, pv, 'desktop:1', c.copy)
    }
    expect(m.copyViewOf(W1, pv, first.copy)).toBeUndefined()
    expect(m.copyViewOf(W1, pv, 'nope')).toBeUndefined()
    expect(m.copyViewOf(W1, 'other', first.copy)).toBeUndefined()
  })
})
