// Which frame has the keys (docs/design-split-pages.md §4, plan Task 3): the shell's decision about a
// page tab frame holding the keyboard (renderer/tabs/frame-focus.ts framePick), the pointer half of
// its evidence, and the pool's half (page-frames.ts: its own focus calls, the frame holding the
// keyboard, blurring one, the page's focus hint). DOM-free; the browser's behaviour is e2e's
// (editor-split.spec.ts).
import { describe, expect, it } from 'vitest'
import {
  checkFrames,
  distanceTo,
  framePick,
  PointerEvidence,
  pointerNear,
  POINTER_FRESH_MS,
  POINTER_NEAR_PX,
  viewportRect,
  watchShellEvidence,
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
    expect(framePick(TAB_A, CLAUDE, ev({ pointerNear: true, pointerFresh: false }))).toEqual({ blur: true })
  })

  // The review's MAJOR: the focused pane is often the Claude terminal, and an unproven frame focus is
  // as often a real click into the file; a key typed into Claude then could answer a permission prompt.
  it('with no evidence the frame is blurred and the keyboard goes to nothing, never to the focused pane', () => {
    expect(framePick(TAB_A, CLAUDE, ev())).toEqual({ blur: true })
    // Typing in Claude with the pointer resting over the file, then a click into it without moving:
    // no evidence (the key came after the pointer), and the keys must not go back to Claude.
    expect(framePick(TAB_A, CLAUDE, ev({ pointerNear: true, keyAfterPointer: true }))).toEqual({ blur: true })
    // A pane mounting while the person types elsewhere (the pointer away): no give-back either, the
    // steal may be the page's own focus(); the keys typed after it are lost, never misdirected.
    expect(framePick(TAB_A, CLAUDE, ev({ keyAfterPointer: true }))).toEqual({ blur: true })
  })

  it('keys off picks nothing, whatever the evidence: the frame is blurred', () => {
    expect(framePick(TAB_A, null, ev({ own: true, pointerNear: true }))).toEqual({ blur: true })
    expect(framePick(TAB_A, null, ev())).toEqual({ blur: true })
  })

  it("the focused pane's own frame with evidence, or no frame with the keyboard, is no change", () => {
    expect(framePick(TAB_A, TAB_A, ev({ own: true, pointerNear: true }))).toBeNull()
    expect(framePick(TAB_A, TAB_A, ev({ own: true, keyAfterPointer: true }))).toBeNull()
    expect(framePick(TAB_A, TAB_A, ev({ pointerNear: true }))).toBeNull()
    expect(framePick(null, CLAUDE, ev())).toBeNull()
    expect(framePick(null, null, ev())).toBeNull()
  })

  // The external review's MAJOR: the selection alone is no evidence. With the file pane focused and
  // the person typing in a shell field (the palette, a search box), the page's own focus() must not
  // take their keys.
  // The final review's MAJOR: a refusal puts the view keys off with `activeId` still named. The
  // person's next click into a frame with evidence picks it, the focused pane's own frame too (the
  // pick is what turns the keys back on); without evidence it is blurred again. D3's keys off (null)
  // stays as it was: nothing is picked.
  it('after a refusal, evidence picks the frame, the focused pane included; none blurs again', () => {
    expect(framePick(TAB_A, CLAUDE, ev({ pointerNear: true }), true)).toEqual({ pick: TAB_A })
    expect(framePick(TAB_A, TAB_A, ev({ pointerNear: true }), true)).toEqual({ pick: TAB_A })
    expect(framePick(TAB_A, TAB_A, ev(), true)).toEqual({ blur: true })
    expect(framePick(TAB_A, CLAUDE, ev({ pointerNear: true, keyAfterPointer: true }), true)).toEqual({ blur: true })
    expect(framePick(TAB_A, null, ev({ pointerNear: true }), true)).toEqual({ blur: true })
    expect(framePick(null, CLAUDE, ev(), true)).toBeNull()
  })

  it("the focused pane's own frame needs evidence too: without, it is blurred", () => {
    expect(framePick(TAB_A, TAB_A, ev({ keyAfterPointer: true }))).toEqual({ blur: true })
    expect(framePick(TAB_A, TAB_A, ev())).toEqual({ blur: true })
    expect(framePick(TAB_A, TAB_A, ev({ pointerNear: true, pointerFresh: false }))).toEqual({ blur: true })
  })
})

describe('pointer evidence', () => {
  const rect = viewportRect({ left: 100, top: 50, width: 200, height: 100 })

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
    expect(pointerNear({ x: 0, y: 0 }, viewportRect({ left: 0, top: 0, width: 0, height: 0 }))).toBe(false)
  })

  it('two frames across a divider (3 px inset each side): a position between them is evidence for the nearer one only, a tie for none', () => {
    const left = viewportRect({ left: 0, top: 0, width: 400, height: 300 })
    const right = viewportRect({ left: 406, top: 0, width: 400, height: 300 })
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
    p.shellInput()
    expect(p.keyAfterPointer()).toBe(true)
    p.moved(160, 90)
    expect(p.keyAfterPointer()).toBe(false)
    p.shellInput()
    expect(p.keyAfterPointer()).toBe(true)
    // A non-finite position (a synthetic event) is no position.
    p.moved(Number.NaN, 0)
    expect(p.near(rect)).toBe(true)
  })

  // PageTabArea's wiring of the evidence: a dropped listener here would pass every test above.
  it("the shell's listeners feed the evidence: pointer events move it, a key or a shell focus voids it, a blur checks a task later", () => {
    const win = new EventTarget()
    const doc = new EventTarget()
    let now = 1000
    const p = new PointerEvidence(() => now)
    const calls: string[] = []
    const tasks: Array<() => void> = []
    let frameTarget = false
    watchShellEvidence(win, doc, p, {
      check: () => void calls.push('check'),
      endPassThrough: () => void calls.push('through'),
      shellFocused: () => void calls.push('focused'),
      isFrame: () => frameTarget,
      later: (fn) => void tasks.push(fn)
    })
    const at = (type: string, x: number, y: number): Event => Object.assign(new Event(type), { clientX: x, clientY: y })
    for (const [i, type] of ['pointermove', 'pointerdown', 'pointerout', 'wheel'].entries()) {
      now += 10
      win.dispatchEvent(at(type, 150 + i, 80))
      expect([p.near(rect), p.fresh(), p.keyAfterPointer()]).toEqual([true, true, false])
      win.dispatchEvent(new Event('keydown'))
      expect(p.keyAfterPointer()).toBe(true)
    }
    expect(calls).toEqual(['through', 'through', 'through', 'through'])
    // A focus within the shell voids the pointer and tells the pool; one on a frame (or none) does not.
    win.dispatchEvent(at('pointermove', 150, 80))
    expect(p.keyAfterPointer()).toBe(false)
    frameTarget = true
    doc.dispatchEvent(new Event('focusin'))
    expect(p.keyAfterPointer()).toBe(false)
    frameTarget = false
    doc.dispatchEvent(new Event('focusin'))
    expect(p.keyAfterPointer()).toBe(true)
    expect(calls.slice(5)).toEqual(['focused'])
    // The window's blur: the check runs a task later, not in the blur itself.
    calls.length = 0
    win.dispatchEvent(new Event('blur'))
    expect(calls).toEqual([])
    for (const t of tasks.splice(0)) t()
    expect(calls).toEqual(['check'])
  })

  it('a pointerout where the pointer already was (a re-render under a resting pointer) is no move; a press there is', () => {
    const win = new EventTarget()
    let now = 1000
    const p = new PointerEvidence(() => now)
    const calls: string[] = []
    watchShellEvidence(win, new EventTarget(), p, {
      check: () => void calls.push('check'),
      endPassThrough: () => void calls.push('through'),
      shellFocused: () => void calls.push('focused'),
      isFrame: () => false,
      later: (fn) => fn()
    })
    const at = (type: string, x: number, y: number): Event => Object.assign(new Event(type), { clientX: x, clientY: y })
    // The pointer rests over the file pane's header; the person then types in a shell field.
    win.dispatchEvent(at('pointermove', 150, 80))
    now += POINTER_FRESH_MS - 100
    win.dispatchEvent(new Event('keydown'))
    calls.length = 0
    // The panes re-render under it: boundary events at the same place revive nothing, end no passThrough.
    win.dispatchEvent(at('pointerout', 150, 80))
    expect([p.keyAfterPointer(), calls]).toEqual([true, []])
    now += 200
    expect(p.fresh()).toBe(false)
    // A pointerout elsewhere is the pointer moving (out of the window, say), and a press in place is the person's act.
    win.dispatchEvent(at('pointerout', 151, 80))
    expect([p.keyAfterPointer(), p.fresh(), calls]).toEqual([false, true, ['through']])
    win.dispatchEvent(new Event('keydown'))
    win.dispatchEvent(at('pointerdown', 151, 80))
    expect([p.keyAfterPointer(), calls]).toEqual([false, ['through', 'through']])
  })

  it('the last position is fresh for POINTER_FRESH_MS', () => {
    let now = 1000
    const p = new PointerEvidence(() => now)
    expect(p.fresh()).toBe(false)
    p.moved(150, 80)
    now += POINTER_FRESH_MS
    expect(p.fresh()).toBe(true)
    now += 1
    expect(p.fresh()).toBe(false)
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

// The invariant (design-split-pages.md §4): nothing a page does (its focus(), its hint, any message)
// ever moves the keyboard INTO a terminal. Keys enter one only from the person's act on it in the
// shell. The review's MAJOR: a give-back to the element of a recent shell key let a hint from file B
// push the keyboard out of file A, just chosen, into the Claude textarea.
describe('checkFrames: a check a page triggered never gives the keyboard to a terminal', () => {
  /**
   * Files A and B visible side by side and one keyboard for the fake document: a frame, the Claude
   * terminal's textarea, or nothing. Only the test (the person) could focus the terminal; the check
   * has no way to, which the assertions hold it to.
   */
  async function setup(focused: string) {
    const t = pool()
    t.frames.sync([entry(TAB_A), entry(TAB_B)])
    t.frames.show([TAB_A, TAB_B], focused === CLAUDE ? null : focused)
    t.frames.place([boxOf(TAB_A, 0), boxOf(TAB_B, 406)])
    await settle()
    t.el(TAB_A).fire()
    t.el(TAB_B).fire()
    const els = [t.el(TAB_A), t.el(TAB_B)]
    const keyboard = { terminal: true }
    for (const el of els) {
      el.focus = () => {
        el.focused++
        keyboard.terminal = false
        for (const e of els) e.focusedNow = e === el
      }
    }
    const picks: string[] = []
    let active = focused
    // TabsPane's state as the handler sees it: a refusal puts the view keys off (TabsState.focusRefused)
    // with `activeId` still named; a pick turns the keys on again.
    const keys = { refusals: 0, off: false }
    const handler = {
      activeId: () => active,
      refused: () => keys.off,
      pick: (id: string) => {
        picks.push(id)
        keys.off = false
      },
      refuse: () => {
        keys.refusals++
        keys.off = true
      }
    }
    let now = 10_000
    const pointer = new PointerEvidence(() => now)
    return {
      t,
      keyboard,
      keys,
      picks,
      pointer,
      handler,
      select: (id: string) => {
        active = id
        keys.off = false
        t.frames.show([TAB_A, TAB_B], id)
      },
      wait: (ms: number) => void (now += ms)
    }
  }

  it('typing in Claude, a chord into A, then a hint from B within 500 ms: the keys go to nothing, never to Claude', async () => {
    const s = await setup(CLAUDE)
    s.pointer.shellInput()
    // The pane chord into A: the shell's own focus call.
    s.select(TAB_A)
    s.t.frames.focus(TAB_A)
    expect(s.t.frames.keyboardTab()).toBe(TAB_A)
    s.wait(100)
    // B's page posts the hint: resync puts the keyboard in B, which has no evidence, so it is blurred.
    expect(checkFrames(s.t.frames, s.handler, s.pointer, TAB_B)).toBe('blurred')
    expect(s.t.el(TAB_B).focused).toBe(1)
    expect(s.t.el(TAB_B).blurred).toBe(1)
    expect(s.t.frames.keyboardTab()).toBeNull()
    expect(s.keyboard.terminal).toBe(false)
    expect(s.picks).toEqual([])
    expect(s.t.frames.passesThrough(TAB_B)).toBe(true)
  })

  it("the same with A's header clicked (pointer near A, not B): B's hint gets no pick and no give-back", async () => {
    const s = await setup(CLAUDE)
    s.pointer.shellInput()
    s.pointer.moved(100, 10)
    s.select(TAB_A)
    s.t.frames.focus(TAB_A)
    expect(checkFrames(s.t.frames, s.handler, s.pointer, TAB_B)).toBe('blurred')
    expect([s.t.frames.keyboardTab(), s.keyboard.terminal, s.picks]).toEqual([null, false, []])
  })

  it('a page posting the hint in a loop only empties the keyboard: never a terminal, never a pick', async () => {
    const s = await setup(CLAUDE)
    s.select(TAB_A)
    s.t.frames.focus(TAB_A)
    for (let i = 0; i < 10; i++) {
      s.pointer.shellInput()
      // The first hint moves the keyboard out of A (to B, then nothing); the rest find no frame.
      expect(checkFrames(s.t.frames, s.handler, s.pointer, TAB_B)).toBe(i === 0 ? 'blurred' : 'none')
    }
    expect([s.t.frames.keyboardTab(), s.keyboard.terminal, s.picks]).toEqual([null, false, []])
    expect(s.t.el(TAB_B).focused).toBe(1)
  })

  it("a frame's own focus() while the person types in Claude (a pane mounting): blurred, the keys to nothing", async () => {
    const s = await setup(CLAUDE)
    expect(s.keyboard.terminal).toBe(true)
    s.pointer.shellInput()
    s.wait(50)
    // The page's script focuses its own window (the window `blur` runs the check a task later).
    s.t.el(TAB_B).focus()
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toBe('blurred')
    // Its own hint after it: nothing holds the keyboard, nothing moves.
    expect(checkFrames(s.t.frames, s.handler, s.pointer, TAB_B)).toBe('none')
    expect([s.t.frames.keyboardTab(), s.keyboard.terminal, s.picks]).toEqual([null, false, []])
    expect(s.t.el(TAB_B).focused).toBe(1)
  })

  // A hidden frame has no box and nothing the person sees is there: were it to hold the keyboard (its
  // pane hidden under a zoom or another group while focused), a chord from it would name a pane not
  // on screen. Even with every piece of evidence for it, it is blurred and nothing is picked.
  it('a frame that is not visible holding the keyboard is blurred, whatever the evidence: no pick', async () => {
    const s = await setup(TAB_B)
    s.pointer.moved(500, 50)
    s.t.frames.focus(TAB_B)
    expect(s.t.frames.keyboardTab()).toBe(TAB_B)
    // B's pane goes out of view (A zoomed) while its frame keeps the keyboard.
    s.t.frames.show([TAB_A], TAB_A)
    expect([s.t.frames.isVisible(TAB_B), s.t.el(TAB_B).focusedNow]).toEqual([false, true])
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toBe('blurred')
    expect(s.t.el(TAB_B).blurred).toBe(1)
    expect([s.t.frames.keyboardTab(), s.keyboard.terminal, s.picks]).toEqual([null, false, []])
    // Its own hint after that finds no frame holding the keyboard.
    expect(checkFrames(s.t.frames, s.handler, s.pointer, TAB_B)).toBe('none')
    expect(s.picks).toEqual([])
  })

  it('a hint while the terminal holds the keyboard moves nothing', async () => {
    const s = await setup(CLAUDE)
    s.pointer.shellInput()
    expect(checkFrames(s.t.frames, s.handler, s.pointer, TAB_B)).toBe('none')
    expect([s.t.el(TAB_B).focused, s.keyboard.terminal, s.picks]).toEqual([0, true, []])
  })

  it("the focused file's frame focusing itself while the person types in a shell field is blurred: the keys go to nothing", async () => {
    const s = await setup(TAB_A)
    // The shell's own focus put the keys in A (a select), then the person clicked a shell field and typed.
    s.t.frames.focus(TAB_A)
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toEqual({ tab: TAB_A })
    s.pointer.moved(900, 5)
    s.t.el(TAB_A).blur()
    s.t.frames.shellFocused()
    s.pointer.shellInput()
    expect(s.t.frames.ownFocus(TAB_A)).toBe(false)
    // A's page calls focus() (the window `blur` runs the check): the selection is no evidence.
    s.t.el(TAB_A).focus()
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toBe('blurred')
    expect([s.t.frames.keyboardTab(), s.keyboard.terminal, s.picks]).toEqual([null, false, []])
    expect(s.t.frames.passesThrough(TAB_A)).toBe(true)
    // Its hint after that finds no frame with the keys.
    expect(checkFrames(s.t.frames, s.handler, s.pointer, TAB_A)).toBe('none')
  })

  it('a frame kept or picked on pointer evidence stays proven: a chord from it long after still names it, until a shell focus', async () => {
    const s = await setup(CLAUDE)
    // The person comes in over B's header and clicks into it: picked on the pointer evidence.
    s.pointer.moved(500, 10)
    s.t.el(TAB_B).focus()
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toEqual({ tab: TAB_B })
    expect(s.picks).toEqual([TAB_B])
    s.select(TAB_B)
    // They type in it for a while (keys in a frame never reach the shell): the pointer is stale.
    s.wait(POINTER_FRESH_MS + 1000)
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toEqual({ tab: TAB_B })
    // The same for the focused pane's own frame clicked into again (no pick, kept).
    s.t.el(TAB_B).blur()
    s.pointer.moved(500, 10)
    s.t.el(TAB_B).focus()
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toEqual({ tab: TAB_B })
    s.wait(POINTER_FRESH_MS + 1000)
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toEqual({ tab: TAB_B })
    expect(s.picks).toEqual([TAB_B])
    // A focus within the shell ends it: the frame focusing itself after that is blurred.
    s.t.el(TAB_B).blur()
    s.t.frames.shellFocused()
    s.t.el(TAB_B).focus()
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toBe('blurred')
  })

  // The final review's MAJOR: the person's own click into the file beside Claude that the shell cannot
  // prove (a tap, a pointer that jumped in) left the outline and `activeId` on Claude, and their next
  // Cmd+W acted on Claude. Every refusal now puts the view keys off; their next click with evidence
  // picks the file and turns the keys on again.
  it('a refused frame puts the view keys off; the next click into it with evidence picks it and turns them on', async () => {
    const s = await setup(CLAUDE)
    // The pointer jumped into B with no shell event over it (a touch tap): no evidence.
    s.t.el(TAB_B).focus()
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toBe('blurred')
    expect([s.keys.refusals, s.keys.off, s.picks, s.keyboard.terminal]).toEqual([1, true, [], false])
    // Nothing holding the keyboard: no further refusal.
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toBe('none')
    expect(s.keys.refusals).toBe(1)
    // The person moves over B (the shell sees it through the pass-through) and clicks into it.
    s.pointer.moved(500, 100)
    s.t.el(TAB_B).focus()
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toEqual({ tab: TAB_B })
    expect([s.keys.refusals, s.keys.off, s.picks]).toEqual([1, false, [TAB_B]])
  })

  it('after a refusal of the focused pane\'s own frame, the next click into it with evidence picks it again (the keys back on)', async () => {
    const s = await setup(TAB_A)
    s.pointer.shellInput()
    s.t.el(TAB_A).focus()
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toBe('blurred')
    expect(s.keys.off).toBe(true)
    s.pointer.moved(100, 100)
    s.t.el(TAB_A).focus()
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toEqual({ tab: TAB_A })
    expect([s.keys.off, s.picks]).toEqual([false, [TAB_A]])
  })

  it('a hidden frame holding the keyboard is refused too: the view goes keys off', async () => {
    const s = await setup(TAB_B)
    s.t.frames.focus(TAB_B)
    s.t.frames.show([TAB_A], TAB_A)
    expect(checkFrames(s.t.frames, s.handler, s.pointer)).toBe('blurred')
    expect(s.keys.refusals).toBe(1)
  })

  it('with fresh pointer evidence for B, its hint picks B (page to page, the outline follows): only ever a page tab', async () => {
    const s = await setup(TAB_A)
    s.t.frames.focus(TAB_A)
    // The pointer came down over B's header (B's box starts at x 406, y 22).
    s.pointer.moved(500, 10)
    expect(checkFrames(s.t.frames, s.handler, s.pointer, TAB_B)).toEqual({ tab: TAB_B })
    expect([s.t.frames.keyboardTab(), s.keyboard.terminal, s.picks]).toEqual([TAB_B, false, [TAB_B]])
  })
})

// The external review's MINOR, checked as a bug: the frame layer sits at the page area's left and top
// (below the tab strip, beside the side panels), not at the viewport's origin. The pointer evidence is
// in viewport pixels (clientX/clientY), so the boxes it is measured against must be the frames' viewport
// boxes (getBoundingClientRect), never their layer boxes: those would put the 24 px evidence region up
// and to the left of the frame, over the tab strip and the side panel.
describe('checkFrames: the pointer evidence is measured in viewport pixels', () => {
  async function offsetLayer() {
    const t = pool({}, { left: 240, top: 64 })
    t.frames.sync([entry(TAB_A), entry(TAB_B)])
    t.frames.show([TAB_A, TAB_B], TAB_A)
    t.frames.place([boxOf(TAB_A, 0), boxOf(TAB_B, 406)])
    await settle()
    t.el(TAB_A).fire()
    t.el(TAB_B).fire()
    const picks: string[] = []
    const handler = { activeId: () => TAB_A, refused: () => false, pick: (id: string) => void picks.push(id), refuse: () => {} }
    return { t, picks, handler, pointer: new PointerEvidence(() => 1000) }
  }

  it("names each frame's viewport box: its layer box moved by the layer's origin", async () => {
    const { t } = await offsetLayer()
    expect(t.frames.frameRect(TAB_A)).toEqual({ left: 240, top: 86, width: 400, height: 300 })
    expect(t.frames.frameRect(TAB_B)).toEqual({ left: 646, top: 86, width: 400, height: 300 })
  })

  it("a pointer at B's layer position (over A's pane header in the viewport) is no evidence for B; one inside B's viewport box is", async () => {
    const { t, picks, handler, pointer } = await offsetLayer()
    // Inside B's layer box (406, 22, 400, 300), but in the viewport 46 px above A's frame and far from B's.
    pointer.moved(416, 40)
    t.el(TAB_B).focusedNow = true
    expect(checkFrames(t.frames, handler, pointer)).toBe('blurred')
    expect(picks).toEqual([])
    // Inside B's viewport box (646, 86, 400, 300).
    pointer.moved(660, 100)
    t.el(TAB_B).focusedNow = true
    expect(checkFrames(t.frames, handler, pointer)).toEqual({ tab: TAB_B })
    expect(picks).toEqual([TAB_B])
  })
})
