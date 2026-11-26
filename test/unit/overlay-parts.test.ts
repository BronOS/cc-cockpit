// Task 14 (shared/design-parts.md §2-§3, D13): parts. The pure attach rules (src/main/overlays/overlay-parts.ts) and
// the manager's records (OverlayManager.markAnnounced, attachPart, partsOf, infos, visibleTo, finish).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventChannel, IpcEventMap } from '../../src/shared/ipc'
import { OverlayManager, type OverlayChannel, type OverlayResult } from '../../src/main/overlays/overlay-manager'
import { MAX_PARTS, partRefusal, type PartParent } from '../../src/main/overlays/overlay-parts'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const W1 = 1
const W2 = 2
const MAIL = { kind: 'html', src: 'cc-plugin://g.mail/thread.html', title: 'Re: P-1', type: { name: 'mail-thread', data: { id: 't1' } } }
const part = (plugin: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: 'html', src: `cc-plugin://${plugin}/part.html`, title: plugin, ...extra })
const OK = { perView: true, inHost: true }

let events: Array<{ windowId: number; channel: EventChannel; payload: unknown }>
/** The guest's views and the plugins each may see (the wiring's mayConnectCopy over visibleTo). */
const seen = new Map<string, Set<string>>()

beforeEach(() => {
  vi.useFakeTimers()
  events = []
  seen.clear()
})
afterEach(() => {
  vi.useRealTimers()
})

function manager(): OverlayManager {
  const m: OverlayManager = new OverlayManager({
    ownerView: (viewId) => !seen.has(viewId),
    backend: new FakePtyBackend(),
    views: { create: () => ({ setBounds: () => {}, setVisible: () => {}, focus: () => {}, destroy: () => {} }), focusWindow: () => {} },
    isWindowOpen: () => true,
    env: () => ({}),
    emit: <C extends EventChannel>(windowId: number, channel: C, payload: IpcEventMap[C]) => {
      events.push({ windowId, channel, payload })
    },
    emitToView: () => true,
    isViewLive: () => true,
    // As guest-wiring.ts mayConnectCopyOf: the owner always; a guest when the overlay is visible to it.
    mayConnectCopy: (windowId, overlayId, viewId) => {
      const plugins = seen.get(viewId)
      if (!plugins) return true
      return m.visibleTo(windowId, overlayId, () => false, (p) => plugins.has(p))
    },
    guestOf: (viewId) => (seen.has(viewId) ? `guest-${viewId}` : undefined),
    reloadCopy: () => {},
    commandForChord: (_w, chord) => ({ escape: 'overlay.pop', 'shift+meta+w': 'overlay.closeTop' })[chord],
    log: () => {}
  })
  return m
}

const channel = (): OverlayChannel => ({ onMessage: () => {} })

/** The opener's overlay (g.mail, perView), announced unless said otherwise. */
function openMail(m: OverlayManager, announce = true, via: string[] = []): { id: string; result: Promise<OverlayResult> } {
  const result = m.open(W1, MAIL, 'plugin g.mail', undefined, channel(), 'g.mail', undefined, undefined, { perView: true, via })
  const id = m.infos(W1).at(-1)!.id
  if (announce) expect(m.markAnnounced(W1, id)).toBe(true)
  return { id, result }
}

function attach(m: OverlayManager, parentId: string, plugin: string, spec = part(plugin), options: { perView?: boolean; inHost?: boolean } = OK, peerGone?: AbortSignal): { result: Promise<OverlayResult>; id: () => string } {
  const result = m.attachPart(W1, parentId, plugin, spec, channel(), options, peerGone)
  result.catch(() => {})
  return { result, id: () => m.partsOf(W1, parentId).find((p) => p.pluginId === plugin)!.overlayId }
}

describe('partRefusal', () => {
  const parent = (over: Partial<PartParent> = {}): PartParent => ({ isPart: false, announced: true, kind: 'html', parts: [], ...over })
  const req = { pluginId: 'j.jira', perView: true, inHost: true, spec: part('j.jira') }

  it('attach refused without an announce', () => {
    expect(partRefusal(parent({ announced: false }), req)).toMatch(/did not announce/)
    // Fail closed: no record of the parent is refused.
    expect(partRefusal(undefined, req)).toMatch(/not open/)
    expect(partRefusal(parent(), req)).toBeUndefined()
  })

  it('attach refused: part of a part, not perView, not in this host, second of one plugin, third part, notes spec', () => {
    expect(partRefusal(parent({ isPart: true }), req)).toMatch(/cannot have parts/)
    expect(partRefusal(parent(), { ...req, perView: false })).toMatch(/perView/)
    expect(partRefusal(parent(), { ...req, inHost: false })).toMatch(/not one of this window/)
    expect(partRefusal(parent({ parts: [{ pluginId: 'j.jira' }] }), req)).toMatch(/already has a part of this plugin/)
    expect(partRefusal(parent({ parts: [{ pluginId: 'a' }, { pluginId: 'b' }] }), req)).toMatch(new RegExp(`${MAX_PARTS} parts`))
    expect(partRefusal(parent(), { ...req, spec: part('j.jira', { notes: { key: 'k' } }) })).toMatch(/no notes/)
    expect(partRefusal(parent({ kind: 'terminal' }), req)).toMatch(/html/)
    expect(partRefusal(parent(), { ...req, spec: { kind: 'url', url: 'https://example.com/' } })).toMatch(/html page/)
    expect(partRefusal(parent(), { ...req, spec: null })).toMatch(/html page/)
  })
})

describe('OverlayManager parts', () => {
  it('attach refused without an announce (the manager), and for an unknown or ended parent', async () => {
    const m = manager()
    const { id } = openMail(m, false)
    await expect(attach(m, id, 'j.jira').result).rejects.toThrow(/did not announce/)
    await expect(attach(m, 'no-such', 'j.jira').result).rejects.toThrow(/not open/)
    // Another window's overlay is no parent here.
    await expect(m.attachPart(W2, id, 'j.jira', part('j.jira'), channel(), OK)).rejects.toThrow(/not open/)
    expect(m.markAnnounced(W2, id)).toBe(false)
    m.close(W1, id)
    expect(m.markAnnounced(W1, id)).toBe(false)
    await expect(attach(m, id, 'j.jira').result).rejects.toThrow(/not open/)
    expect(m.infos(W1)).toEqual([])
  })

  it('attach refused: part of a part, not perView, not in this host, second of one plugin, third part, notes spec', async () => {
    const m = manager()
    const { id } = openMail(m)
    const first = attach(m, id, 'j.jira')
    const partId = first.id()
    // A part announces nothing and takes no parts.
    expect(m.markAnnounced(W1, partId)).toBe(false)
    await expect(attach(m, partId, 'c.cal').result).rejects.toThrow(/not announce|cannot have parts/)
    await expect(attach(m, id, 'c.cal', part('c.cal'), { perView: false, inHost: true }).result).rejects.toThrow(/perView/)
    await expect(attach(m, id, 'c.cal', part('c.cal'), { perView: true }).result).rejects.toThrow(/not one of this window/)
    await expect(attach(m, id, 'j.jira').result).rejects.toThrow(/part of this plugin/)
    await expect(attach(m, id, 'c.cal', part('c.cal', { notes: { key: 'k' } })).result).rejects.toThrow(/no notes/)
    attach(m, id, 'c.cal')
    await expect(attach(m, id, 'd.docs').result).rejects.toThrow(/2 parts/)
    expect(m.partsOf(W1, id).map((p) => p.pluginId)).toEqual(['j.jira', 'c.cal'])
    // A part's own partsOf is empty.
    expect(m.partsOf(W1, partId)).toEqual([])
  })

  it("a part's info carries no discuss, buttons or notes; infos lists it after its parent with partOf", () => {
    const m = manager()
    const { id } = openMail(m)
    const spec = part('j.jira', { buttons: [{ id: 'b', label: 'B' }], discuss: { tabId: 't1' }, type: { name: 'issue', data: {} } })
    const p = attach(m, id, 'j.jira', spec)
    const partId = p.id()
    // The part's plugin registers onDiscuss: its text goes into the parent's Discuss, never a button of its own.
    m.setDiscussHandler(W1, partId, true)
    expect(m.setButtons(W1, partId, [{ id: 'x', label: 'X' }])).toBe(false)
    const infos = m.infos(W1)
    expect(infos.map((i) => [i.id, i.partOf])).toEqual([
      [id, undefined],
      [partId, id]
    ])
    const info = infos[1]!
    expect(info).toMatchObject({ kind: 'html', perView: true, pluginId: 'j.jira', title: 'j.jira', src: 'cc-plugin://j.jira/part.html' })
    expect(info.discuss).toBeUndefined()
    expect(info.buttons).toBeUndefined()
    expect(info.typeButtons).toBeUndefined()
    expect(info.notes).toBeUndefined()
    // The list went out with it.
    const last = events.filter((e) => e.channel === 'overlays.updated').at(-1)!.payload as Array<{ id: string }>
    expect(last.map((i) => i.id)).toEqual([id, partId])
  })

  it("a part leaves the parent's via unchanged", () => {
    const m = manager()
    const { id } = openMail(m, true, ['r.reviewer'])
    attach(m, id, 'j.jira')
    seen.set('web:7', new Set(['g.mail', 'r.reviewer']))
    // Visible to a guest who sees the opener and its via: the part's plugin never joined the parent's via.
    expect(m.visibleTo(W1, id, () => false, (p) => seen.get('web:7')!.has(p))).toBe(true)
    // And the part's own via is empty: its plugin alone decides beyond its parent.
    const partId = m.partsOf(W1, id)[0]!.overlayId
    expect(m.visibleTo(W1, partId, () => false, (p) => ['g.mail', 'r.reviewer', 'j.jira'].includes(p))).toBe(true)
  })

  it("a part's connectCopy refused when its parent is hidden from that guest", () => {
    const m = manager()
    const { id } = openMail(m)
    const partId = attach(m, id, 'j.jira').id()
    // Sees the part's plugin but not the opener: neither.
    seen.set('web:7', new Set(['j.jira']))
    expect(m.connectCopy(W1, partId, 'web:7')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(m.connectCopy(W1, id, 'web:7')).toEqual({ ok: false, reason: 'not-allowed' })
    // Sees the opener but not the part's plugin: the parent only.
    seen.set('web:8', new Set(['g.mail']))
    expect(m.connectCopy(W1, id, 'web:8').ok).toBe(true)
    expect(m.connectCopy(W1, partId, 'web:8')).toEqual({ ok: false, reason: 'not-allowed' })
    // Sees both.
    seen.set('web:9', new Set(['g.mail', 'j.jira']))
    expect(m.connectCopy(W1, partId, 'web:9').ok).toBe(true)
    // The owner always.
    expect(m.connectCopy(W1, partId, 'desktop:1').ok).toBe(true)
    // Fail closed: once the parent is gone, the part is too (an unknown parent is not visible).
    expect(m.visibleTo(W1, partId, () => true, () => true)).toBe(true)
    m.close(W1, id)
    expect(m.visibleTo(W1, partId, () => true, () => true)).toBe(false)
  })

  it("a part plugin's dispose (peerGone) dismisses its part, not the parent", async () => {
    const m = manager()
    const { id } = openMail(m)
    const gone = new AbortController()
    const p = attach(m, id, 'j.jira', part('j.jira'), OK, gone.signal)
    gone.abort()
    await expect(p.result).resolves.toEqual({ kind: 'dismissed' })
    expect(m.infos(W1).map((i) => i.id)).toEqual([id])
    expect(m.partsOf(W1, id)).toEqual([])
  })

  it("announceRecord is main's title and type, only once announced", () => {
    const m = manager()
    const { id } = openMail(m, false)
    expect(m.announceRecord(W1, id)).toBeUndefined()
    m.markAnnounced(W1, id)
    expect(m.announceRecord(W1, id)).toEqual({ title: 'Re: P-1', type: { name: 'mail-thread', data: { id: 't1' } } })
    expect(m.announceRecord(W2, id)).toBeUndefined()
  })
})
