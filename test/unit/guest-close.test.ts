// D-9 (design-guests §7, spec-review 6): a write guest's Close of a tab it did not open asks the owner. The
// guest's notice waits for the tab to go and otherwise says it was kept; the owner's approval's texts.
import { describe, expect, it } from 'vitest'
import {
  askedCloseText,
  GUEST_CLOSE_WAIT_MS,
  guestCloseAskTitle,
  GuestCloseNotices,
  KEPT_OPEN_SHOW_MS,
  keptOpenText,
  type GuestCloseNotice,
  type GuestCloseTimers
} from '../../src/renderer/tabs/guest-close'

function fakeTimers(): GuestCloseTimers & { advance(ms: number): void; pending(): number } {
  let now = 0
  let next = 1
  const due = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeout: (fn, ms) => {
      const id = next++
      due.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (h) => void due.delete(h as number),
    advance(ms) {
      now += ms
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && due.has(id)) {
          due.delete(id)
          t.fn()
        }
      }
    },
    pending: () => due.size
  }
}

function notices(): { n: GuestCloseNotices; seen: Array<readonly GuestCloseNotice[]>; clock: ReturnType<typeof fakeTimers> } {
  const clock = fakeTimers()
  const seen: Array<readonly GuestCloseNotice[]> = []
  return { n: new GuestCloseNotices((l) => seen.push(l), clock), seen, clock }
}

describe('guest close texts', () => {
  it('names the owner and the tab, as plain sentences', () => {
    expect(askedCloseText('Oleg', 'npm dev')).toBe('Asked Oleg to close npm dev.')
    expect(keptOpenText('Oleg')).toBe('Oleg kept the tab open.')
    expect(guestCloseAskTitle('Ana', 'npm dev')).toBe('Ana asks to close npm dev.')
  })
})

describe('GuestCloseNotices', () => {
  it('shows "Asked" until the tab leaves the strip, then nothing (the owner closed it)', () => {
    const { n, clock } = notices()
    n.asked('t1', 'npm dev', 'Host')
    expect(n.notices).toEqual([{ tabId: 't1', kind: 'asked', text: 'Asked Host to close npm dev.' }])
    n.tabsChanged((id) => id === 't1')
    expect(n.notices).toHaveLength(1)
    n.tabsChanged(() => false)
    expect(n.notices).toEqual([])
    // Its timer went with it: nothing turns into "kept" later.
    expect(clock.pending()).toBe(0)
  })

  it('says the owner kept the tab once the wait is over, and that line goes by itself', () => {
    const { n, clock } = notices()
    n.asked('t1', 'npm dev', 'Oleg')
    clock.advance(GUEST_CLOSE_WAIT_MS - 1)
    expect(n.notices[0]?.kind).toBe('asked')
    clock.advance(1)
    expect(n.notices).toEqual([{ tabId: 't1', kind: 'kept', text: 'Oleg kept the tab open.' }])
    clock.advance(KEPT_OPEN_SHOW_MS)
    expect(n.notices).toEqual([])
  })

  it('a second ask for the same tab replaces the first and restarts its wait; tabs are kept apart', () => {
    const { n, clock } = notices()
    n.asked('t1', 'a', 'Host')
    clock.advance(GUEST_CLOSE_WAIT_MS - 10)
    n.asked('t1', 'a', 'Host')
    n.asked('t2', 'b', 'Host')
    clock.advance(20)
    expect(n.notices.map((x) => [x.tabId, x.kind])).toEqual([
      ['t1', 'asked'],
      ['t2', 'asked']
    ])
    n.drop('t1')
    expect(n.notices.map((x) => x.tabId)).toEqual(['t2'])
  })

  it('tells nobody after dispose, and leaves no timer behind', () => {
    const { n, seen, clock } = notices()
    n.asked('t1', 'a', 'Host')
    const before = seen.length
    n.dispose()
    clock.advance(GUEST_CLOSE_WAIT_MS + KEPT_OPEN_SHOW_MS)
    n.asked('t2', 'b', 'Host')
    expect(seen.length).toBe(before)
    expect(clock.pending()).toBe(0)
  })
})
