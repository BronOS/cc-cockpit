import { describe, expect, it } from 'vitest'
import { FocusGiveBack } from '../../src/renderer/tabs/focus-give-back'

/** A rule with a manual frame queue and a settable "an iframe holds the keyboard". */
function rig() {
  const frames: Array<() => void> = []
  let inFrame = false
  const rule = new FocusGiveBack({ later: (fn) => frames.push(fn), keyboardInFrame: () => inFrame })
  let restored = 0
  const restore = (): void => {
    restored++
  }
  return {
    rule,
    restore,
    restored: () => restored,
    setInFrame: (v: boolean) => {
      inFrame = v
    },
    flush: () => frames.splice(0).forEach((fn) => fn())
  }
}

describe('FocusGiveBack: only the person closing a popup gives the keyboard back to the pane', () => {
  it("the person's close (Escape, a pick, a click on the shell) restores at the next frame", () => {
    const r = rig()
    r.rule.closed('person', r.restore)
    expect(r.restored()).toBe(0)
    r.flush()
    expect(r.restored()).toBe(1)
  })

  it("round 3's CRITICAL: a close a blur caused (a page frame's focus() blurred the palette or the window under the switcher) restores nothing", () => {
    const r = rig()
    // The page's focus(): the palette's field blurs (its close is `auto`), then the window.
    r.rule.closed('auto', r.restore)
    r.rule.windowBlurred()
    // The frame check blurred the frame for want of evidence: no iframe holds the keyboard now, and
    // still nothing may put it into the Claude pane.
    r.setInFrame(false)
    r.flush()
    expect(r.restored()).toBe(0)
  })

  it("a person's close whose keyboard left the shell before the frame fired restores nothing", () => {
    const r = rig()
    // Escape, then a page's focus() before the frame: the window blurred in between (the check may
    // already have blurred the frame, keys on nothing).
    r.rule.closed('person', r.restore)
    r.rule.windowBlurred()
    r.flush()
    expect(r.restored()).toBe(0)
    // An iframe holding the keyboard when the frame fires: left there (the check decides for it).
    r.rule.closed('person', r.restore)
    r.setInFrame(true)
    r.flush()
    expect(r.restored()).toBe(0)
    // A blur before the close is no reason to refuse it: the person closed the popup afterwards.
    r.setInFrame(false)
    r.rule.windowBlurred()
    r.rule.closed('person', r.restore)
    r.flush()
    expect(r.restored()).toBe(1)
  })
})
