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
import { guestOverlays } from '../../src/shared/guest-filter'
import type { OverlayInfo } from '../../src/shared/ipc'
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
