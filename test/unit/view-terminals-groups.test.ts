import { describe, expect, it } from 'vitest'
import type { MirrorView } from '../../src/main/terminals/mirror'
import { JOIN_DRAIN_BYTES, JOIN_DRAIN_POLL_MS, ViewTerminals } from '../../src/main/web/view-terminals'

/**
 * A browser view selecting a split group (design §1 "Web and cost"): every member is joined, the
 * selected one first, the rest one at a time after the previous snapshot went out and the socket
 * drained. A fake mirror: each join is held until the test delivers its snapshot.
 */
function setup(opts: { held?: string[]; follow?: (tabId: string) => boolean } = {}) {
  const held = new Set(opts.held ?? ['a', 'b', 'c', 'd'])
  const joins: Array<{ tabId: string; view: MirrorView; left: boolean }> = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  const sent: string[] = []
  let buffered = 0
  const vt = new ViewTerminals({
    mirror: {
      join: (tabId, view) => {
        if (!held.has(tabId)) return undefined
        const j = { tabId, view, left: false }
        joins.push(j)
        return () => {
          j.left = true
        }
      }
    },
    canFollow: opts.follow ?? ((t) => t !== 'foreign'),
    send: (frame) => sent.push(`${frame.t}:${frame.tabId}`),
    buffered: () => buffered,
    defer: (fn, ms) => timers.push({ fn, ms })
  })
  const snapshot = (tabId: string): void => {
    const j = [...joins].reverse().find((x) => x.tabId === tabId && !x.left)
    if (!j) throw new Error(`no live join of ${tabId}`)
    j.view.snapshot({ seq: 0, cols: 20, rows: 5, data: `screen ${tabId}` })
  }
  /** Runs the timers due now (each may schedule another). */
  const tick = (): void => {
    const due = timers.splice(0)
    for (const t of due) t.fn()
  }
  return {
    vt,
    joins,
    timers,
    sent,
    snapshot,
    tick,
    joined: () => joins.map((j) => j.tabId),
    setBuffered: (n: number) => {
      buffered = n
    },
    start: (tabId: string) => held.add(tabId)
  }
}

describe('ViewTerminals.selectGroup', () => {
  it('joins the selected pane first, then each member after the previous snapshot went out', () => {
    const t = setup()
    expect(t.vt.selectGroup(['b', 'a', 'c'])).toBe(true)
    expect(t.joined()).toEqual(['b'])
    expect(t.vt.queued()).toEqual(['b', 'a', 'c'])
    // Nothing more until b's snapshot is sent.
    t.tick()
    expect(t.joined()).toEqual(['b'])
    t.snapshot('b')
    expect(t.sent).toEqual(['term.snapshot:b'])
    // Never inside the mirror's callback: on a later turn.
    expect(t.joined()).toEqual(['b'])
    t.tick()
    expect(t.joined()).toEqual(['b', 'a'])
    t.snapshot('a')
    t.tick()
    expect(t.joined()).toEqual(['b', 'a', 'c'])
    t.snapshot('c')
    t.tick()
    expect(t.vt.queued()).toEqual([])
    expect(t.vt.following().sort()).toEqual(['a', 'b', 'c'])
  })

  it('waits while the socket is above the drain mark, polling', () => {
    const t = setup()
    t.vt.selectGroup(['a', 'b'])
    t.setBuffered(JOIN_DRAIN_BYTES + 1)
    t.snapshot('a')
    t.tick()
    expect(t.joined()).toEqual(['a'])
    expect(t.timers.map((x) => x.ms)).toEqual([JOIN_DRAIN_POLL_MS])
    t.tick()
    expect(t.joined()).toEqual(['a'])
    t.setBuffered(10)
    t.tick()
    expect(t.joined()).toEqual(['a', 'b'])
  })

  it('skips members already followed, foreign ones and ones with no pty (joined at their start)', () => {
    const t = setup({ held: ['a', 'b', 'd'] })
    t.vt.select('b')
    t.snapshot('b')
    t.vt.selectGroup(['a', 'b', 'foreign', 'c', 'd'])
    t.snapshot('a')
    t.tick()
    // b already followed, foreign refused, c has no pty yet: straight to d.
    expect(t.joined()).toEqual(['b', 'a', 'd'])
    expect(t.vt.waitingFor()).toEqual(['c'])
    t.start('c')
    t.vt.started('c')
    expect(t.joined()).toEqual(['b', 'a', 'd', 'c'])
  })

  it('a selected pane already followed lets the rest start at once', () => {
    const t = setup()
    t.vt.select('a')
    t.snapshot('a')
    expect(t.vt.selectGroup(['a', 'b'])).toBe(true)
    t.tick()
    expect(t.joined()).toEqual(['a', 'b'])
  })

  it('a member that stops being followed before its snapshot does not stall the queue', () => {
    const t = setup()
    t.vt.selectGroup(['a', 'b', 'c'])
    t.snapshot('a')
    t.tick()
    expect(t.joined()).toEqual(['a', 'b'])
    t.vt.leave('b')
    t.tick()
    expect(t.joined()).toEqual(['a', 'b', 'c'])
  })

  it('selecting again replaces the queue: a group that gained a member joins only what is new', () => {
    const t = setup()
    t.vt.selectGroup(['a', 'b'])
    t.snapshot('a')
    t.tick()
    t.snapshot('b')
    t.tick()
    t.vt.selectGroup(['a', 'b', 'c'])
    t.tick()
    expect(t.joined()).toEqual(['a', 'b', 'c'])
    // Another group selected while c's snapshot is still out: c stays in flight (D23 R4), d joins at
    // once, and the old queue is dropped.
    t.vt.selectGroup(['d', 'a'])
    expect(t.vt.queued()).toEqual(['c', 'd', 'a'])
  })

  it('a reselect keeps the join in flight: the queue waits for its snapshot (D23 R4)', () => {
    const t = setup()
    t.vt.selectGroup(['a', 'b', 'c', 'd'])
    t.snapshot('a')
    t.tick()
    expect(t.joined()).toEqual(['a', 'b'])
    // b's snapshot is still in the worker (not in bufferedAmount) when another view edits the group:
    // groups.changed re-runs the selection. b must still hold the queue, or c joins beside it.
    t.vt.selectGroup(['a', 'b', 'c', 'd'])
    t.tick()
    t.vt.selectGroup(['a', 'c', 'b', 'd'])
    t.tick()
    expect(t.joined()).toEqual(['a', 'b'])
    expect(t.vt.queued()).toEqual(['b', 'c', 'b', 'd'])
    t.snapshot('b')
    t.tick()
    expect(t.joined()).toEqual(['a', 'b', 'c'])
    t.snapshot('c')
    t.tick()
    expect(t.joined()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a reselect onto a new pane joins it at once, and the queue waits for both snapshots', () => {
    const t = setup()
    t.vt.selectGroup(['a', 'b', 'c'])
    t.snapshot('a')
    t.tick()
    expect(t.joined()).toEqual(['a', 'b'])
    // The person selects d (its own group with c) while b is still in flight.
    t.vt.selectGroup(['d', 'c'])
    expect(t.joined()).toEqual(['a', 'b', 'd'])
    expect(t.vt.queued()).toEqual(['b', 'd', 'c'])
    t.snapshot('d')
    t.tick()
    expect(t.joined()).toEqual(['a', 'b', 'd'])
    t.snapshot('b')
    t.tick()
    expect(t.joined()).toEqual(['a', 'b', 'd', 'c'])
  })

  it('an in-flight join that stops being followed no longer holds a reselect', () => {
    const t = setup()
    t.vt.selectGroup(['a', 'b', 'c'])
    t.snapshot('a')
    t.tick()
    // b goes before its snapshot (the page left it): c may go; c is then still in flight.
    t.vt.leave('b')
    t.tick()
    expect(t.joined()).toEqual(['a', 'b', 'c'])
    t.vt.selectGroup(['a', 'd'])
    t.tick()
    expect(t.vt.queued()).toEqual(['c', 'd'])
    t.vt.leave('c')
    t.tick()
    expect(t.joined()).toEqual(['a', 'b', 'c', 'd'])
    expect(t.vt.queued()).toEqual(['d'])
  })

  it('a disposed view joins nothing more', () => {
    const t = setup()
    t.vt.selectGroup(['a', 'b'])
    t.vt.dispose()
    t.tick()
    expect(t.joined()).toEqual(['a'])
    expect(t.vt.selectGroup(['c'])).toBe(false)
  })
})
