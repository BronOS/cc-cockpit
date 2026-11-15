// Which frame has the keys (docs/design-split-pages.md §4, plan Task 3): the shell's decision about a
// page tab frame holding the keyboard (renderer/tabs/frame-focus.ts framePick), the pointer half of
// its evidence, and the pool's half (page-frames.ts: its own focus calls, the frame holding the
// keyboard, blurring one, the page's focus hint). DOM-free; the browser's behaviour is e2e's
// (editor-split.spec.ts).
import { describe, expect, it } from 'vitest'
import {
  distanceTo,
  framePick,
  GIVE_BACK_MS,
  PointerEvidence,
  pointerNear,
  POINTER_FRESH_MS,
  POINTER_NEAR_PX,
  type FrameEvidence
} from '../../src/renderer/tabs/frame-focus'
import { TAB_FOCUS_MESSAGE } from '../../src/sdk/panel-core'
import { boxOf, entry, pool, settle, TAB_A, TAB_B } from '../fakes/fake-page-frames'

const CLAUDE = 'claude-tab'

/** Evidence with nothing in it, and `over` set. */
const ev = (over: Partial<FrameEvidence> = {}): FrameEvidence => ({
  own: false,
  pointerNear: false,
  pointerFresh: true,
  keyAfterPointer: false,
  recentKey: false,
  ...over
})

describe('framePick', () => {
  it("the shell's own focus picks the frame's pane (keys on)", () => {
    expect(framePick(TAB_A, CLAUDE, ev({ own: true }))).toEqual({ pick: TAB_A })
    // A key in the shell after the pointer does not void the shell's own call.
    expect(framePick(TAB_A, CLAUDE, ev({ own: true, keyAfterPointer: true }))).toEqual({ pick: TAB_A })
  })

  it('the pointer going into the frame a moment ago, with no shell key after it, picks its pane', () => {
    expect(framePick(TAB_A, CLAUDE, ev({ pointerNear: true }))).toEqual({ pick: TAB_A })
  })

  it('hover is not consent for ever: a pointer that stopped beside the frame long ago is no evidence', () => {
    expect(framePick(TAB_A, CLAUDE, ev({ pointerNear: true, pointerFresh: false }))).toEqual({ blur: true, giveBack: false })
  })

  // The review's MAJOR: the focused pane is often the Claude terminal, and an unproven frame focus is
  // as often a real click into the file; a key typed into Claude then could answer a permission prompt.
  it('with no evidence the frame is blurred and the keyboard goes to nothing, never to the focused pane', () => {
    expect(framePick(TAB_A, CLAUDE, ev())).toEqual({ blur: true, giveBack: false })
    // Typing in Claude with the pointer resting over the file, then a click into it without moving:
    // no evidence (the key came after the pointer), and the keys must not go back to Claude.
    expect(framePick(TAB_A, CLAUDE, ev({ pointerNear: true, keyAfterPointer: true }))).toEqual({ blur: true, giveBack: false })
    // Even within GIVE_BACK_MS of that key: the pointer over the frame says it may have been a click.
    expect(framePick(TAB_A, CLAUDE, ev({ pointerNear: true, keyAfterPointer: true, recentKey: true }))).toEqual({ blur: true, giveBack: false })
  })

  it('a pane mounting while the person types elsewhere: the keyboard goes back to where they were typing', () => {
    expect(framePick(TAB_A, CLAUDE, ev({ keyAfterPointer: true, recentKey: true }))).toEqual({ blur: true, giveBack: true })
  })

  it('keys off picks nothing and gives nothing back, whatever the evidence: the frame is blurred', () => {
    expect(framePick(TAB_A, null, ev({ own: true, pointerNear: true }))).toEqual({ blur: true, giveBack: false })
    expect(framePick(TAB_A, null, ev({ recentKey: true }))).toEqual({ blur: true, giveBack: false })
    expect(framePick(TAB_A, null, ev())).toEqual({ blur: true, giveBack: false })
  })

  it("the focused pane's own frame, or no frame with the keyboard, is no change", () => {
    expect(framePick(TAB_A, TAB_A, ev({ keyAfterPointer: true }))).toBeNull()
    expect(framePick(TAB_A, TAB_A, ev({ own: true, pointerNear: true }))).toBeNull()
    expect(framePick(null, CLAUDE, ev())).toBeNull()
    expect(framePick(null, null, ev())).toBeNull()
  })
})

describe('pointer evidence', () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 }

  it('inside the box or within POINTER_NEAR_PX of it counts (the last shell event before the frame); farther, a zero box or no position does not', () => {
    expect(pointerNear({ x: 150, y: 80 }, rect)).toBe(true)
    // The pane header above the frame (22 px): the shell's last position as the pointer came down into it.
    expect(pointerNear({ x: 150, y: 50 - 11 }, rect)).toBe(true)
    expect(pointerNear({ x: 100 - POINTER_NEAR_PX, y: 80 }, rect)).toBe(true)
    expect(pointerNear({ x: 100 - POINTER_NEAR_PX - 1, y: 80 }, rect)).toBe(false)
    expect(pointerNear({ x: 150, y: 151 + POINTER_NEAR_PX }, rect)).toBe(false)
    // A corner is measured as a distance, not per axis.
    expect(pointerNear({ x: 300 + 20, y: 150 + 20 }, rect)).toBe(false)
    expect(distanceTo({ x: 303, y: 154 }, rect)).toBe(5)
    expect(pointerNear(null, rect)).toBe(false)
    expect(pointerNear({ x: 150, y: 80 }, null)).toBe(false)
    expect(pointerNear({ x: 0, y: 0 }, { left: 0, top: 0, width: 0, height: 0 })).toBe(false)
  })

  it('two frames across a divider (3 px inset each side): a position between them is evidence for the nearer one only, a tie for none', () => {
    const left = { left: 0, top: 0, width: 400, height: 300 }
    const right = { left: 406, top: 0, width: 400, height: 300 }
    for (let x = 390; x <= 416; x++) expect(pointerNear({ x, y: 10 }, left, [right]) && pointerNear({ x, y: 10 }, right, [left])).toBe(false)
    expect(pointerNear({ x: 401, y: 10 }, left, [right])).toBe(true)
    expect(pointerNear({ x: 401, y: 10 }, right, [left])).toBe(false)
    expect(pointerNear({ x: 403, y: 10 }, left, [right])).toBe(false)
    expect(pointerNear({ x: 403, y: 10 }, right, [left])).toBe(false)
  })

  it('a key (or a focus in the shell) after the last move voids it until the pointer moves again', () => {
    const p = new PointerEvidence()
    expect(p.near(rect)).toBe(false)
    p.moved(150, 80)
    expect([p.near(rect), p.keyAfterPointer()]).toEqual([true, false])
    p.shellKey(null)
    expect(p.keyAfterPointer()).toBe(true)
    p.moved(160, 90)
    expect(p.keyAfterPointer()).toBe(false)
    p.shellFocus('textarea')
    expect(p.keyAfterPointer()).toBe(true)
    // A non-finite position (a synthetic event) is no position.
    p.moved(Number.NaN, 0)
    expect(p.near(rect)).toBe(true)
  })

  it('the last position is fresh for POINTER_FRESH_MS; the last key names its element for GIVE_BACK_MS', () => {
    let now = 1000
    const p = new PointerEvidence<string>(() => now)
    expect(p.fresh()).toBe(false)
    expect(p.recentKeyTarget()).toBeNull()
    p.moved(150, 80)
    now += POINTER_FRESH_MS
    expect(p.fresh()).toBe(true)
    now += 1
    expect(p.fresh()).toBe(false)
    p.shellKey('claude-textarea')
    expect(p.recentKeyTarget()).toBe('claude-textarea')
    now += GIVE_BACK_MS
    expect(p.recentKeyTarget()).toBe('claude-textarea')
    now += 1
    // A click after a pause: nothing to give back.
    expect(p.recentKeyTarget()).toBeNull()
    // The focus moving within the shell to the same element keeps the key; to another drops it.
    p.shellKey('claude-textarea')
    p.shellFocus('claude-textarea')
    expect(p.recentKeyTarget()).toBe('claude-textarea')
    p.shellFocus('rename-input')
    expect(p.recentKeyTarget()).toBeNull()
    // A key with no element (the shell's body) gives back nothing either.
    p.shellKey(null)
    expect(p.recentKeyTarget()).toBeNull()
  })
})

describe("PageFrames: the shell's half of the evidence", () => {
  async function twoPanes() {
    const hints: string[] = []
    const t = pool({ focusHint: (id) => void hints.push(id) })
    t.frames.sync([entry(TAB_A), entry(TAB_B)])
    t.frames.show([TAB_A, TAB_B], TAB_A)
    t.frames.place([boxOf(TAB_A, 0), boxOf(TAB_B, 406)])
    await settle()
    t.el(TAB_A).fire()
    t.el(TAB_B).fire()
    return { t, hints }
  }

  it("records its own focus calls (focus, a load's wantFocus) for a visible frame; a shell focus clears them", async () => {
    const { t } = await twoPanes()
    expect(t.frames.ownFocus(TAB_A)).toBe(false)
    t.frames.focus(TAB_B)
    expect([t.frames.ownFocus(TAB_A), t.frames.ownFocus(TAB_B)]).toEqual([false, true])
    t.frames.shellFocused()
    expect(t.frames.ownFocus(TAB_B)).toBe(false)
    // Hidden: no evidence for it, whatever the shell did before.
    t.frames.focus(TAB_B)
    t.frames.show([TAB_A], TAB_A)
    expect(t.frames.ownFocus(TAB_B)).toBe(false)
    // wantFocus at the load is the shell's own call too.
    const u = pool()
    u.frames.sync([entry(TAB_A)])
    u.frames.show([TAB_A], TAB_A)
    u.frames.focus(TAB_A)
    await settle()
    expect(u.frames.ownFocus(TAB_A)).toBe(false)
    u.el(TAB_A).fire()
    expect(u.frames.ownFocus(TAB_A)).toBe(true)
  })

  it('names the frame holding the keyboard, its viewport box while visible, and blurs it', async () => {
    const { t } = await twoPanes()
    expect(t.frames.keyboardTab()).toBeNull()
    t.el(TAB_B).focusedNow = true
    expect(t.frames.keyboardTab()).toBe(TAB_B)
    expect(t.frames.frameRect(TAB_B)).toEqual({ left: 406, top: 22, width: 400, height: 300 })
    expect([...t.frames.frameRects().keys()]).toEqual([TAB_A, TAB_B])
    t.frames.focus(TAB_B)
    // Already holding it: the shell records the call and does not focus the frame again.
    expect(t.el(TAB_B).focused).toBe(0)
    expect(t.frames.ownFocus(TAB_B)).toBe(true)
    t.frames.blurFrame(TAB_B)
    expect(t.el(TAB_B).blurred).toBe(1)
    expect(t.frames.keyboardTab()).toBeNull()
    expect(t.frames.ownFocus(TAB_B)).toBe(false)
    // D3's keys off: whichever frame holds it is blurred; none holding it blurs nothing.
    t.el(TAB_A).focusedNow = true
    expect(t.frames.blurKeyboard()).toBe(TAB_A)
    expect(t.el(TAB_A).blurred).toBe(1)
    expect(t.frames.blurKeyboard()).toBeNull()
    t.frames.show([TAB_A], TAB_A)
    expect(t.frames.frameRect(TAB_B)).toBeNull()
  })

  it('the shell\'s own focus counts only while its pane stays the focused one', async () => {
    const { t } = await twoPanes()
    t.frames.focus(TAB_A)
    expect(t.frames.ownFocus(TAB_A)).toBe(true)
    // The selection moves to B (still loading, or a terminal): A's old focus call is no evidence for A.
    t.frames.show([TAB_A, TAB_B], TAB_B)
    expect(t.frames.ownFocus(TAB_A)).toBe(false)
    t.frames.focus(TAB_B)
    // Keys off (no focused pane): none either.
    t.frames.show([TAB_A, TAB_B], null)
    expect(t.frames.ownFocus(TAB_B)).toBe(false)
  })

  it('a blurred frame lets the pointer through to its pane until the shell sees the pointer, or focuses it itself', async () => {
    const { t } = await twoPanes()
    t.frames.passThrough(TAB_B)
    expect([t.el(TAB_B).through, t.frames.passesThrough(TAB_B), t.el(TAB_A).through]).toEqual([true, true, false])
    t.frames.endPassThrough()
    expect([t.el(TAB_B).through, t.frames.passesThrough(TAB_B)]).toEqual([false, false])
    // The shell's own focus call (the person pressed the pane through it) takes the pointer back too.
    t.frames.passThrough(TAB_A)
    t.frames.focus(TAB_A)
    expect([t.el(TAB_A).through, t.frames.passesThrough(TAB_A)]).toEqual([false, false])
    // A tab with no live frame: nothing to set.
    t.frames.passThrough('no-such-tab')
    expect(t.frames.passesThrough('no-such-tab')).toBe(false)
  })

  it("hands on a page's focus hint from any live frame; it carries nothing the shell trusts", async () => {
    const { t, hints } = await twoPanes()
    t.el(TAB_B).fromPage({ type: TAB_FOCUS_MESSAGE })
    t.el(TAB_A).fromPage({ type: TAB_FOCUS_MESSAGE, tab: 'anything' })
    expect(hints).toEqual([TAB_B, TAB_A])
  })
})
