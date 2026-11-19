// Presence (main/web/presence.ts, design-guests §10, shared/design.md §16.7): who is in a project and where,
// on a fake clock and fake timers so the throttle (MIN_EMIT_MS), the typing window (TYPING_MS) and the
// reconnect grace (RECONNECT_GRACE_MS) are stepped by hand. Main only, never saved: the tests read the
// snapshots main would send.
import { describe, expect, it } from 'vitest'
import {
  MIN_EMIT_MS,
  PALETTE,
  Presence,
  RECONNECT_GRACE_MS,
  TYPING_MS,
  presenceColor,
  type PresenceDeps
} from '../../src/main/web/presence'
import type { PresenceSnapshot } from '../../src/shared/guests'
import type { GuestRole } from '../../src/shared/views'

const BOB = { guest: 'g1' } as const
const EVE = { guest: 'g2' } as const

interface Timer {
  fn: () => void
  at: number
}

function harness(over: Partial<PresenceDeps> = {}) {
  let now = 10_000
  const timers: Timer[] = []
  const emitted: Array<{ projectId: string; snap: PresenceSnapshot }> = []
  const logs: string[] = []
  const guests: Array<{ id: string; name: string; role: GuestRole }> = [
    { id: 'g1', name: 'Bob', role: 'write' },
    { id: 'g2', name: 'Eve', role: 'read' }
  ]
  const p = new Presence({
    ownerName: () => 'Oleg',
    guestsOf: (projectId) => (projectId === 'p1' ? guests : []),
    emit: (projectId, snap) => emitted.push({ projectId, snap }),
    filterFor: (_viewId, who) => (who === 'owner' ? undefined : (s) => ({ ...s, people: s.people.filter((x) => x.id === who.guest) })),
    log: (m) => logs.push(m),
    now: () => now,
    setTimeout: (fn, ms) => {
      const t: Timer = { fn, at: now + ms }
      timers.push(t)
      return t
    },
    clearTimeout: (h) => {
      const i = timers.indexOf(h as Timer)
      if (i >= 0) timers.splice(i, 1)
    },
    ...over
  })
  /** Moves the clock, firing every timer that comes due on the way, in order (a fired one may set another). */
  const advance = (ms: number): void => {
    const end = now + ms
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers.splice(timers.indexOf(due), 1)
      now = Math.max(now, due.at)
      due.fn()
    }
    now = end
  }
  const person = (id: string, projectId = 'p1') => p.snapshot(projectId).people.find((x) => x.id === id)
  return { p, timers, emitted, logs, guests, advance, person, now: () => now }
}

describe('presenceColor', () => {
  it('the owner is 0; a guest is in 1..7 and the same for the same id', () => {
    expect(presenceColor('owner')).toBe(0)
    for (const id of ['g1', 'g2', 'a-much-longer-guest-id', '', 'owner2']) {
      const c = presenceColor(id)
      expect(c, id).toBeGreaterThanOrEqual(1)
      expect(c, id).toBeLessThan(PALETTE)
      expect(presenceColor(id)).toBe(c)
    }
  })
})

describe('Presence: people', () => {
  it('the owner first, named by ownerName(), then every guest of the project, with a view or not', () => {
    const { p } = harness()
    p.viewJoined('desktop:1', 'p1', 'owner')
    p.viewJoined('web:2', 'p1', BOB)
    expect(p.snapshot('p1').people).toEqual([
      { id: 'owner', name: 'Oleg', role: 'owner', color: 0, state: 'live', tabId: null, typing: false },
      { id: 'g1', name: 'Bob', role: 'write', color: presenceColor('g1'), state: 'live', tabId: null, typing: false },
      { id: 'g2', name: 'Eve', role: 'read', color: presenceColor('g2'), state: 'away', tabId: null, typing: false }
    ])
  })

  it('an owner name lookup that throws reads as "Host"; a guest list that throws as none (logged)', () => {
    const { p, logs } = harness({
      ownerName: () => {
        throw new Error('settings gone')
      },
      guestsOf: () => {
        throw new Error('store gone')
      }
    })
    p.viewJoined('desktop:1', 'p1', 'owner')
    expect(p.snapshot('p1').people.map((x) => [x.id, x.name])).toEqual([['owner', 'Host']])
    expect(p.personOf('desktop:1')).toBe('Host')
    expect(logs.some((m) => m.includes('guest list failed'))).toBe(true)
  })

  it('live while a view is open; reconnecting for the grace after the last one left; then away', () => {
    const { p, advance, person } = harness()
    p.viewJoined('web:2', 'p1', BOB)
    p.viewJoined('web:3', 'p1', BOB)
    p.viewLeft('web:2')
    // One view left of two: still live.
    expect(person('g1')?.state).toBe('live')
    p.viewLeft('web:3')
    expect(person('g1')?.state).toBe('reconnecting')
    advance(RECONNECT_GRACE_MS - 1)
    expect(person('g1')?.state).toBe('reconnecting')
    advance(1)
    expect(person('g1')?.state).toBe('away')
    // Back within or after the grace: live again.
    p.viewJoined('web:4', 'p1', BOB)
    expect(person('g1')?.state).toBe('live')
  })

  it('the grace running out is announced by itself (a wake timer), with no other change', () => {
    const { p, advance, emitted } = harness()
    p.viewJoined('web:2', 'p1', BOB)
    advance(MIN_EMIT_MS)
    p.viewLeft('web:2')
    advance(MIN_EMIT_MS)
    const before = emitted.length
    expect(emitted.at(-1)?.snap.people.find((x) => x.id === 'g1')?.state).toBe('reconnecting')
    advance(RECONNECT_GRACE_MS)
    expect(emitted.length).toBe(before + 1)
    expect(emitted.at(-1)?.snap.people.find((x) => x.id === 'g1')?.state).toBe('away')
  })

  it("a person's tab is the one its most recently active view shows (selected or typed)", () => {
    const { p, advance, person } = harness()
    p.viewJoined('desktop:1', 'p1', 'owner')
    p.viewJoined('web:5', 'p1', 'owner')
    p.viewSelected('desktop:1', 't1')
    advance(10)
    p.viewSelected('web:5', 't2')
    expect(person('owner')?.tabId).toBe('t2')
    advance(10)
    // Keys in the desktop window make it the most recent again, and move it to the tab typed into.
    p.typed('desktop:1', 't3')
    expect(person('owner')?.tabId).toBe('t3')
    // The active view leaves: the other one's tab.
    p.viewLeft('desktop:1')
    expect(person('owner')?.tabId).toBe('t2')
    // No view at all: no tab.
    p.viewLeft('web:5')
    expect(person('owner')?.tabId).toBeNull()
  })

  it('personOf names the person behind a view: the owner name, the guest name, nothing for others', () => {
    const { p } = harness()
    p.viewJoined('desktop:1', 'p1', 'owner')
    p.viewJoined('web:2', 'p1', BOB)
    p.viewJoined('web:3', 'p1', { guest: 'gone' })
    expect(p.personOf('desktop:1')).toBe('Oleg')
    expect(p.personOf('web:2')).toBe('Bob')
    expect(p.personOf('web:3')).toBeUndefined()
    expect(p.personOf('web:99')).toBeUndefined()
    expect(p.personOf(null)).toBeUndefined()
  })
})

describe('Presence: typing', () => {
  it('typing for TYPING_MS after a key, then not, and the end is emitted by a wake timer', () => {
    const { p, advance, emitted, person } = harness()
    p.viewJoined('web:2', 'p1', BOB)
    advance(MIN_EMIT_MS)
    p.typed('web:2', 't1')
    expect(person('g1')).toMatchObject({ typing: true, tabId: 't1' })
    expect(p.snapshot('p1').lastTyped).toEqual({ t1: 'g1' })
    expect(emitted.at(-1)?.snap.people.find((x) => x.id === 'g1')?.typing).toBe(true)
    const before = emitted.length
    advance(TYPING_MS - 1)
    expect(person('g1')?.typing).toBe(true)
    expect(emitted.length).toBe(before)
    advance(1)
    expect(person('g1')?.typing).toBe(false)
    // Nothing else happened: the wake timer told every view.
    expect(emitted.length).toBe(before + 1)
    expect(emitted.at(-1)?.snap.people.find((x) => x.id === 'g1')?.typing).toBe(false)
    // lastTyped stays after the typing ends.
    expect(emitted.at(-1)?.snap.lastTyped).toEqual({ t1: 'g1' })
  })

  it('keys while already typing on the same tab emit nothing; another tab or another person does', () => {
    const { p, advance, emitted, timers } = harness()
    p.viewJoined('web:2', 'p1', BOB)
    p.viewJoined('web:3', 'p1', EVE)
    advance(MIN_EMIT_MS)
    p.typed('web:2', 't1')
    advance(MIN_EMIT_MS)
    const before = emitted.length
    for (let i = 0; i < 5; i++) {
      p.typed('web:2', 't1')
      advance(50)
    }
    expect(emitted.length).toBe(before)
    // No throttle timer was even set for them (only the wake).
    expect(timers.length).toBe(1)
    advance(MIN_EMIT_MS)
    p.typed('web:2', 't2')
    expect(emitted.length).toBe(before + 1)
    advance(MIN_EMIT_MS)
    // Eve typing into t2 takes lastTyped there.
    p.typed('web:3', 't2')
    expect(emitted.length).toBe(before + 2)
    expect(emitted.at(-1)?.snap.lastTyped).toEqual({ t1: 'g1', t2: 'g2' })
  })

  it('tabClosed drops the tab from lastTyped and from every view showing it', () => {
    const { p, advance, emitted, person } = harness()
    p.viewJoined('desktop:1', 'p1', 'owner')
    p.viewJoined('web:2', 'p1', BOB)
    p.typed('desktop:1', 't1')
    p.viewSelected('web:2', 't1')
    p.typed('web:2', 't2')
    p.viewSelected('web:2', 't1')
    advance(TYPING_MS + MIN_EMIT_MS)
    const before = emitted.length
    p.tabClosed('t1')
    expect(emitted.length).toBe(before + 1)
    const snap = emitted.at(-1)!.snap
    expect(snap.lastTyped).toEqual({ t2: 'g1' })
    expect(snap.people.find((x) => x.id === 'owner')?.tabId).toBeNull()
    expect(person('g1')?.tabId).toBeNull()
    // A tab nobody shows or typed into changes nothing: no emit.
    advance(MIN_EMIT_MS)
    p.tabClosed('t-unknown')
    expect(emitted.length).toBe(before + 1)
  })
})

describe('Presence: emits', () => {
  it(`at most one emit per ${MIN_EMIT_MS} ms per project: the first at once, the rest as one trailing emit; seq counts them`, () => {
    const { p, advance, emitted } = harness()
    p.viewJoined('desktop:1', 'p1', 'owner')
    expect(emitted.map((e) => e.snap.seq)).toEqual([1])
    p.viewSelected('desktop:1', 't1')
    advance(10)
    p.viewSelected('desktop:1', 't2')
    advance(10)
    p.viewSelected('desktop:1', 't3')
    expect(emitted).toHaveLength(1)
    advance(MIN_EMIT_MS - 21)
    expect(emitted).toHaveLength(1)
    advance(1)
    // The trailing one carries the last state.
    expect(emitted.map((e) => e.snap.seq)).toEqual([1, 2])
    expect(emitted[1]!.snap.people[0]!.tabId).toBe('t3')
    // Quiet past the window: the next change goes at once.
    advance(MIN_EMIT_MS)
    p.viewSelected('desktop:1', 't4')
    expect(emitted.map((e) => e.snap.seq)).toEqual([1, 2, 3])
  })

  it('each project has its own window and seq', () => {
    const { p, emitted } = harness()
    p.viewJoined('desktop:1', 'p1', 'owner')
    p.viewJoined('desktop:2', 'p2', 'owner')
    expect(emitted.map((e) => [e.projectId, e.snap.seq])).toEqual([
      ['p1', 1],
      ['p2', 1]
    ])
  })

  it('an emit that throws is logged and the next one still goes', () => {
    let fail = true
    const sent: number[] = []
    const { p, advance, logs } = harness({
      emit: (_projectId, snap) => {
        if (fail) throw new Error('registry gone')
        sent.push(snap.seq)
      }
    })
    p.viewJoined('desktop:1', 'p1', 'owner')
    expect(logs.some((m) => m.includes('emit failed'))).toBe(true)
    fail = false
    advance(MIN_EMIT_MS)
    p.viewSelected('desktop:1', 't1')
    expect(sent).toEqual([2])
  })

  it('a closed project (and dispose) clears its timers', () => {
    const { p, timers } = harness()
    p.viewJoined('desktop:1', 'p1', 'owner')
    p.typed('desktop:1', 't1')
    p.viewJoined('desktop:2', 'p2', 'owner')
    p.typed('desktop:2', 't9')
    expect(timers.length).toBeGreaterThan(0)
    p.projectClosed('p1')
    p.dispose()
    expect(timers).toEqual([])
  })
})

describe('Presence: snapshotFor', () => {
  it("an owner view gets the whole snapshot; a guest view gets filterFor's", () => {
    const { p } = harness()
    p.viewJoined('desktop:1', 'p1', 'owner')
    p.viewJoined('web:2', 'p1', BOB)
    expect(p.snapshotFor('desktop:1').people.map((x) => x.id)).toEqual(['owner', 'g1', 'g2'])
    expect(p.snapshotFor('web:2').people.map((x) => x.id)).toEqual(['g1'])
  })

  it("a revoked guest's view, an unknown view and a filter that throws get nobody", () => {
    const { p, logs } = harness({
      filterFor: (viewId) => {
        if (viewId === 'web:3') throw new Error('boom')
        return 'revoked'
      }
    })
    p.viewJoined('web:2', 'p1', BOB)
    p.viewJoined('web:3', 'p1', EVE)
    p.typed('web:2', 't1')
    expect(p.snapshotFor('web:2')).toEqual({ seq: expect.any(Number), people: [], lastTyped: {} })
    expect(p.snapshotFor('web:3')).toEqual({ seq: expect.any(Number), people: [], lastTyped: {} })
    expect(logs.some((m) => m.includes('filter failed'))).toBe(true)
    expect(p.snapshotFor('web:99')).toEqual({ seq: 0, people: [], lastTyped: {} })
  })
})
