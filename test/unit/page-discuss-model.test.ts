import { describe, expect, it } from 'vitest'
import {
  PAGE_DISCUSS_OPENS_PER_MINUTE,
  PageDiscussGate,
  pageDiscussRefusal,
  pagePopoverKey,
  PagePopoverArm,
  popoverTakesFocus,
  type PageDiscussState
} from '../../src/renderer/overlays/page-discuss-model'
import { APPROVAL_ARM_MS } from '../../src/renderer/notices/approval-model'
import { DISCUSS_REOPEN_COOLDOWN_MS } from '../../src/renderer/tabs/page-tab-discuss-model'

// Task 04, spec-review S6: a page-started Discuss opens core's popover only under these guards.

const ok: PageDiscussState = { top: true, discuss: true, write: true, open: false }

function clock() {
  let now = 1_000_000
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

/** Timers run by hand, for the arm. */
function manualTimers() {
  const list: Array<{ fn: () => void; at: number; done: boolean }> = []
  let now = 0
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const t = { fn, at: now + ms, done: false }
      list.push(t)
      return t
    },
    clearTimeout: (h: unknown) => {
      ;(h as { done: boolean }).done = true
    },
    advance: (ms: number) => {
      now += ms
      for (const t of list) {
        if (!t.done && t.at <= now) {
          t.done = true
          t.fn()
        }
      }
    }
  }
}

describe('which page requests open the popover', () => {
  it('a Discuss request from an overlay not on top is ignored', () => {
    const gate = new PageDiscussGate(clock().now)
    expect(gate.request('o1', { ...ok, top: false })).toBe('not-top')
    // A refused request never counts toward the rate.
    for (let i = 0; i < PAGE_DISCUSS_OPENS_PER_MINUTE; i++) gate.request('o1', { ...ok, top: false })
    expect(gate.request('o1', ok)).toBe('open')
  })

  it('ignored without info.discuss or from a view that is not write', () => {
    const gate = new PageDiscussGate(clock().now)
    expect(gate.request('o1', { ...ok, discuss: false })).toBe('no-discuss')
    expect(gate.request('o1', { ...ok, write: false })).toBe('not-write')
    expect(pageDiscussRefusal('no-discuss')).toMatch(/not available/)
  })

  it("a read guest's request opens nothing", () => {
    const gate = new PageDiscussGate(clock().now)
    // A read guest's view is never write (shellAllows('read').write is false), whatever else holds.
    expect(gate.request('o1', { top: true, discuss: true, write: false, open: false })).toBe('not-write')
  })

  it('cooldown 2 s after cancel and 5 opens a minute', () => {
    const c = clock()
    const gate = new PageDiscussGate(c.now)
    expect(gate.request('o1', ok)).toBe('open')
    gate.cancelled('o1')
    expect(gate.request('o1', ok)).toBe('cooldown')
    // Another overlay has its own clock.
    expect(gate.request('o2', ok)).toBe('open')
    c.advance(DISCUSS_REOPEN_COOLDOWN_MS)
    expect(DISCUSS_REOPEN_COOLDOWN_MS).toBe(2000)
    expect(gate.request('o1', ok)).toBe('open')
    for (let i = 2; i < PAGE_DISCUSS_OPENS_PER_MINUTE; i++) expect(gate.request('o1', ok)).toBe('open')
    expect(PAGE_DISCUSS_OPENS_PER_MINUTE).toBe(5)
    expect(gate.request('o1', ok)).toBe('rate')
    c.advance(60_000)
    expect(gate.request('o1', ok)).toBe('open')
  })
})

describe('the page-opened popover', () => {
  it('Send armed after about 1 s; a press begun before does not count; a repeated request never re-arms', () => {
    const t = manualTimers()
    const changes: boolean[] = []
    const arm = new PagePopoverArm((on) => changes.push(on), t)
    arm.visible(true)
    expect(arm.armed).toBe(false)
    // A click before the second: nothing.
    arm.pressBegan()
    expect(arm.click()).toBe(false)
    // A press that began disarmed and lands after arming still does not count.
    arm.pressBegan()
    t.advance(APPROVAL_ARM_MS)
    expect(arm.armed).toBe(true)
    expect(arm.click()).toBe(false)
    // A fresh press while armed counts.
    arm.pressBegan()
    expect(arm.click()).toBe(true)

    // The page asking again while it is open: the gate does nothing, so this arm is never started over.
    const gate = new PageDiscussGate(clock().now)
    expect(gate.request('o1', ok)).toBe('open')
    expect(gate.request('o1', { ...ok, open: true })).toBe('already-open')
    // And the same visibility reported again (a focus event) does not restart the second either.
    arm.visible(true)
    expect(arm.armed).toBe(true)
    expect(changes).toEqual([true])
    arm.dispose()
  })

  it('the popover takes no focus; Enter and Space inside are blocked', () => {
    expect(popoverTakesFocus('page')).toBe(false)
    // The ▾'s own popover keeps its keyboard list.
    expect(popoverTakesFocus('menu')).toBe(true)
    expect(pagePopoverKey('Enter')).toBe('block')
    expect(pagePopoverKey(' ')).toBe('block')
    expect(pagePopoverKey('Spacebar')).toBe('block')
    expect(pagePopoverKey('ArrowDown')).toBe('pass')
    expect(pagePopoverKey('Escape')).toBe('pass')
  })
})
