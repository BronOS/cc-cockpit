// Overlays and guests (design-guests §9, spec-review 16, D-14): the origin an overlay is opened with and visibleTo, the
// `ownerView` hook that keeps a guest's view from holding an html overlay's page, and guestResize's explicit-only size.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OverlayManager, type OverlayResult, type UrlView, type UrlViewFactory } from '../../src/main/overlays/overlay-manager'
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

  it('desktop: a guest as the origin view is not the holder; the desktop holds (no remote holder shown)', () => {
    const m = manager({ isViewLive: live, ownerView: (v) => v !== GUEST })
    swallow(m.open(W1, page, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one', GUEST))
    expect(m.infos(W1)[0]?.heldBy).toBeUndefined()
  })

  it("an owner's browser view as origin still holds it", () => {
    const m = manager({ isViewLive: live, ownerView: (v) => v !== GUEST })
    swallow(m.open(W1, page, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one', OWNER))
    expect(m.infos(W1)[0]?.heldBy?.viewId).toBe(OWNER)
  })

  it('without ownerView a remote origin view holds it, as before', () => {
    const m = manager({ isViewLive: live })
    swallow(m.open(W1, page, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one', GUEST))
    expect(m.infos(W1)[0]?.heldBy?.viewId).toBe(GUEST)
  })

  it('server mode: a guest is skipped as browserHolder, in favour of the next owner browser', () => {
    const m = manager({ server: true, isViewLive: live, browserViews: () => [GUEST, OWNER], ownerView: (v) => v !== GUEST })
    swallow(m.open(W1, page, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one'))
    expect(m.infos(W1)[0]?.heldBy?.viewId).toBe(OWNER)
  })

  it('server mode: a guest origin view falls to the owner browser; with only guests attached nobody holds it', () => {
    const m = manager({ server: true, isViewLive: live, browserViews: () => [OWNER, GUEST], ownerView: (v) => v !== GUEST })
    swallow(m.open(W1, page, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one', GUEST))
    expect(m.infos(W1)[0]?.heldBy?.viewId).toBe(OWNER)

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
