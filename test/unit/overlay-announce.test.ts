// Task 05 (design-parts.md §1, spec-review S12): the window's announcements in the plugin host
// (src/host/overlay-announce.ts) and the shared checks (src/shared/announce.ts).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OverlayAnnouncements, parseAnnounced, type Announcement } from '../../src/host/overlay-announce'
import { checkAnnounceRefs, isAnnounceKind, MAX_ANNOUNCES_PER_MINUTE, takeAnnounce } from '../../src/shared/announce'

const event = (id: string, kind = 'mail.issues', refs: string[] = ['P-1']): unknown => ({
  overlay: { id, opener: 'bronos.gmail', title: `mail ${id}` },
  kind,
  refs
})

function registry(listenerMs?: number): { reg: OverlayAnnouncements; logs: Array<[string, string]> } {
  const logs: Array<[string, string]> = []
  return { reg: new OverlayAnnouncements((pluginId, m) => void logs.push([pluginId, m]), listenerMs), logs }
}

/** Let queued microtasks (the replay's turns) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('announce checks', () => {
  it('announce refused over 20 refs, 200 characters or a bad kind', () => {
    for (const kind of ['mail', 'mail.issues', 'a-b.c9', 'x'.repeat(40)]) expect(isAnnounceKind(kind), kind).toBe(true)
    for (const kind of ['', 'Mail', 'mail issues', 'mail_issues', 'x'.repeat(41), 5, null]) expect(isAnnounceKind(kind), String(kind)).toBe(false)
    expect(checkAnnounceRefs(Array.from({ length: 20 }, (_, i) => `P-${i}`))).toHaveLength(20)
    expect(() => checkAnnounceRefs(Array.from({ length: 21 }, () => 'P-1'))).toThrow(RangeError)
    expect(checkAnnounceRefs(['x'.repeat(200)])).toEqual(['x'.repeat(200)])
    expect(() => checkAnnounceRefs(['x'.repeat(201)])).toThrow(RangeError)
    expect(() => checkAnnounceRefs(['ok', 5])).toThrow(TypeError)
    expect(() => checkAnnounceRefs('P-1')).toThrow(TypeError)
    // main's event is checked the same way: anything off is dropped, never cut.
    expect(parseAnnounced(event('ov1', 'Bad'))).toBeUndefined()
    expect(parseAnnounced(event('ov1', 'mail', ['x'.repeat(201)]))).toBeUndefined()
    expect(parseAnnounced({ overlay: { id: '', opener: 'p', title: '' }, kind: 'mail', refs: [] })).toBeUndefined()
    expect(parseAnnounced({ overlay: { id: 'ov1', opener: 'p' }, kind: 'mail', refs: [] })).toBeUndefined()
    expect(parseAnnounced(null)).toBeUndefined()
  })

  it('over 5 a minute refused', () => {
    const times: number[] = []
    for (let i = 0; i < MAX_ANNOUNCES_PER_MINUTE; i++) expect(takeAnnounce(times, 1000 + i)).toBe(true)
    expect(takeAnnounce(times, 2000)).toBe(false)
    // A refused one takes nothing; a minute after the first, one is free again.
    expect(times).toHaveLength(MAX_ANNOUNCES_PER_MINUTE)
    expect(takeAnnounce(times, 61_000)).toBe(true)
    // The other four are still inside their minute.
    expect(takeAnnounce(times, 61_000)).toBe(false)
  })
})

describe('OverlayAnnouncements', () => {
  it('a slow or throwing listener is skipped, the rest run', async () => {
    vi.useFakeTimers()
    const { reg, logs } = registry(2000)
    const heard: string[] = []
    reg.listen('a.slow', 'mail.issues', () => new Promise(() => {}))
    reg.listen('a.throws', 'mail.issues', () => {
      throw new Error('boom')
    })
    reg.listen('a.rejects', 'mail.issues', () => Promise.reject(new Error('nope')))
    reg.listen('a.good', 'mail.issues', (a: Announcement) => void heard.push(a.overlay.id))
    reg.listen('a.other', 'other.kind', (a: Announcement) => void heard.push(`other ${a.overlay.id}`))
    reg.announced(event('ov1'))
    expect(heard).toEqual(['ov1'])
    await vi.advanceTimersByTimeAsync(2000)
    expect(logs.map(([p]) => p).sort()).toEqual(['a.rejects', 'a.slow', 'a.throws'])
    expect(logs.find(([p]) => p === 'a.slow')?.[1]).toMatch(/more than 2000 ms/)
    // The next announcement still reaches every listener: a skip removes nobody.
    reg.announced(event('ov2'))
    expect(heard).toEqual(['ov1', 'ov2'])
  })

  it('a later listener hears the live announcements only', async () => {
    const { reg } = registry()
    reg.announced(event('ov1'))
    reg.announced(event('ov2'))
    // ov1 announces again: it replaces its last. ov2 ends.
    reg.announced(event('ov1', 'mail.issues', ['P-7']))
    reg.unannounced({ id: 'ov2' })
    reg.announced(event('ov3', 'other.kind'))
    const heard: Announcement[] = []
    reg.listen('a.late', 'mail.issues', (a: Announcement) => void heard.push(a))
    // After the registering call returns, each in its own turn.
    expect(heard).toEqual([])
    await flush()
    expect(heard.map((a) => [a.overlay.id, a.refs])).toEqual([['ov1', ['P-7']]])
    expect(reg.liveIds().sort()).toEqual(['ov1', 'ov3'])
  })

  it('the replay runs after onAnnounce returns: a listener may call its own disposer (N6)', async () => {
    const { reg, logs } = registry()
    reg.announced(event('ov1'))
    reg.announced(event('ov2'))
    const heard: string[] = []
    const off = reg.listen('a.once', 'mail.issues', (a: Announcement) => {
      off()
      heard.push(a.overlay.id)
    })
    await flush()
    // The first replay disposed it: no throw (the disposer exists), and the second is not heard.
    expect(heard).toEqual(['ov1'])
    expect(logs).toEqual([])
    // A replayed announcement that ended, or was replaced, before its turn is not heard.
    reg.announced(event('ov3'))
    const late: string[] = []
    reg.listen('a.late', 'mail.issues', (a: Announcement) => void late.push(`${a.overlay.id}:${a.refs.join()}`))
    reg.unannounced({ id: 'ov1' })
    reg.announced(event('ov2', 'mail.issues', ['P-9']))
    await flush()
    // ov2's new one is heard live (it replaced the old before its replay), ov3 replayed, ov1 not at all.
    expect(late.sort()).toEqual(['ov2:P-9', 'ov3:P-1'])
  })

  it('each listener gets its own frozen copy; the disposer and removePlugin end listening', () => {
    const { reg } = registry()
    let seen: Announcement | undefined
    const counts = { a: 0, b: 0 }
    reg.listen('a.one', 'mail', (a: Announcement) => {
      seen = a
      counts.a++
      ;(a.refs as string[]).push?.('x')
    })
    const off = reg.listen('a.two', 'mail', (a: Announcement) => {
      counts.b++
      expect(a.refs).toEqual(['P-1'])
    })
    reg.announced(event('ov1', 'mail'))
    expect(Object.isFrozen(seen)).toBe(true)
    expect(Object.isFrozen(seen?.refs)).toBe(true)
    off()
    reg.announced(event('ov2', 'mail'))
    reg.removePlugin('a.one')
    reg.announced(event('ov3', 'mail'))
    expect(counts).toEqual({ a: 2, b: 1 })
    expect(() => reg.listen('a.one', 'Bad', () => {})).toThrow(TypeError)
    expect(() => reg.listen('a.one', 'mail', 5)).toThrow(TypeError)
  })
})
