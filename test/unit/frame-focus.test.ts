// Which frame has the keys (docs/design-split-pages.md §4, plan Task 3): the shell's decision about a
// page tab frame holding the keyboard (renderer/tabs/frame-focus.ts framePick), the pointer half of
// its evidence, and the pool's half (page-frames.ts: its own focus calls, the frame holding the
// keyboard, blurring one, the page's focus hint). DOM-free; the browser's behaviour is e2e's
// (editor-split.spec.ts).
import { describe, expect, it } from 'vitest'
import { distanceTo, framePick, PointerEvidence, pointerNear, POINTER_NEAR_PX } from '../../src/renderer/tabs/frame-focus'
import { TAB_FOCUS_MESSAGE } from '../../src/sdk/panel-core'
import { boxOf, entry, pool, settle, TAB_A, TAB_B } from '../fakes/fake-page-frames'

const CLAUDE = 'claude-tab'

describe('framePick', () => {
  it("the shell's own focus picks the frame's pane (keys on)", () => {
    expect(framePick(TAB_A, CLAUDE, true, false, false)).toEqual({ pick: TAB_A })
    // A key in the shell after the pointer does not void the shell's own call.
    expect(framePick(TAB_A, CLAUDE, true, false, true)).toEqual({ pick: TAB_A })
  })

  it('the pointer going into the frame, with no shell key after it, picks its pane', () => {
    expect(framePick(TAB_A, CLAUDE, false, true, false)).toEqual({ pick: TAB_A })
  })

  it('with neither, the frame is blurred and the keyboard goes back to the focused pane', () => {
    expect(framePick(TAB_A, CLAUDE, false, false, false)).toEqual({ blur: true })
  })

  it('a shell keydown after the pointer stopped over the frame is no evidence: typing in Claude beside it', () => {
    expect(framePick(TAB_A, CLAUDE, false, true, true)).toEqual({ blur: true })
  })

  it('keys off picks nothing, whatever the evidence: the frame is blurred', () => {
    expect(framePick(TAB_A, null, true, true, false)).toEqual({ blur: true })
    expect(framePick(TAB_A, null, false, false, false)).toEqual({ blur: true })
  })

  it("the focused pane's own frame, or no frame with the keyboard, is no change", () => {
    expect(framePick(TAB_A, TAB_A, false, false, true)).toBeNull()
    expect(framePick(TAB_A, TAB_A, true, true, false)).toBeNull()
    expect(framePick(null, CLAUDE, false, false, false)).toBeNull()
    expect(framePick(null, null, false, false, false)).toBeNull()
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
    p.shellKey()
    expect(p.keyAfterPointer()).toBe(true)
    p.moved(160, 90)
    expect(p.keyAfterPointer()).toBe(false)
    // A non-finite position (a synthetic event) is no position.
    p.moved(Number.NaN, 0)
    expect(p.near(rect)).toBe(true)
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

  it("hands on a page's focus hint from any live frame; it carries nothing the shell trusts", async () => {
    const { t, hints } = await twoPanes()
    t.el(TAB_B).fromPage({ type: TAB_FOCUS_MESSAGE })
    t.el(TAB_A).fromPage({ type: TAB_FOCUS_MESSAGE, tab: 'anything' })
    expect(hints).toEqual([TAB_B, TAB_A])
  })
})
