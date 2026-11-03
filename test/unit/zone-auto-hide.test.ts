// The side zone auto-hide decision (src/renderer/zones/auto-hide.ts): which zones give way to a
// narrow terminal, in which order they come back, the hysteresis, and what the person's own
// actions do to it.
import { describe, expect, it } from 'vitest'
import {
  decideAutoHide,
  INITIAL_AUTO_HIDE,
  newlyShown,
  RESTORE_MARGIN,
  revealZone,
  type AutoHideInput,
  type AutoHideState
} from '../../src/renderer/zones/auto-hide'
import { defaultLayout, movePanel, reconcile, setZoneCollapsed, togglePanel } from '../../src/shared/layout'

const MIN = 720
const LEFT = 280
const RIGHT = 320

function input(room: number, over: Partial<AutoHideInput> = {}): AutoHideInput {
  return {
    enabled: true,
    minWidth: MIN,
    room,
    sizes: { left: LEFT, right: RIGHT },
    open: { left: true, right: true },
    panels: ['core/sessions', 'test/notes'],
    ...over
  }
}

/** Play a sequence of rooms (window widths) from a state, returning the hidden zones after each. */
function play(rooms: number[], from: AutoHideState = INITIAL_AUTO_HIDE, over: Partial<AutoHideInput> = {}): string[][] {
  let state = from
  return rooms.map((room) => {
    state = decideAutoHide(state, input(room, over))
    return [...state.hidden]
  })
}

describe('decideAutoHide: thresholds and order', () => {
  it('hides nothing while the terminal keeps its minimum with both zones shown', () => {
    // 1320 - 280 - 320 = 720: exactly the minimum is enough.
    expect(play([1600, 1320])).toEqual([[], []])
  })

  it('hides the right zone first, then the left one, as the window narrows', () => {
    // 1319: 719 with both, 1039 without the right. 999: 679 without the right, so the left goes too.
    expect(play([1600, 1319, 1100, 999, 600])).toEqual([[], ['right'], ['right'], ['right', 'left'], ['right', 'left']])
  })

  it('hides both at once when one is not enough', () => {
    expect(play([900])).toEqual([['right', 'left']])
  })

  it('restores the left zone first, then the right, each only with the margin to spare', () => {
    let state = decideAutoHide(INITIAL_AUTO_HIDE, input(900))
    expect(state.hidden).toEqual(['right', 'left'])
    // Left back at 280 + 720 + margin, right at 600 + 720 + margin.
    const leftBack = LEFT + MIN + RESTORE_MARGIN
    const rightBack = LEFT + RIGHT + MIN + RESTORE_MARGIN
    state = decideAutoHide(state, input(leftBack - 1))
    expect(state.hidden).toEqual(['right', 'left'])
    state = decideAutoHide(state, input(leftBack))
    expect(state.hidden).toEqual(['right'])
    state = decideAutoHide(state, input(rightBack - 1))
    expect(state.hidden).toEqual(['right'])
    state = decideAutoHide(state, input(rightBack))
    expect(state.hidden).toEqual([])
  })

  it('restores both in one step on a jump to a wide window', () => {
    expect(play([900, 2000])).toEqual([['right', 'left'], []])
  })

  it('hides the left zone first when the right one is not open', () => {
    const over = { open: { left: true, right: false } }
    expect(play([1000, 999], INITIAL_AUTO_HIDE, over)).toEqual([[], ['left']])
  })

  it('counts each zone at its own width: a zone dragged wide gives way sooner and needs more room back', () => {
    const wide = { sizes: { left: LEFT, right: 700 } }
    expect(play([1699], INITIAL_AUTO_HIDE, wide)).toEqual([['right']])
    // Back at 280 + 700 + 720 + 48, not at the default size's threshold.
    expect(play([1699, 1500, 1748], INITIAL_AUTO_HIDE, wide)).toEqual([['right'], ['right'], []])
  })

  it('makes no decision before the row is laid out', () => {
    const state = decideAutoHide(INITIAL_AUTO_HIDE, input(900))
    expect(decideAutoHide(state, input(0))).toBe(state)
    expect(decideAutoHide(state, input(Number.NaN))).toBe(state)
    expect(decideAutoHide(INITIAL_AUTO_HIDE, input(0))).toBe(INITIAL_AUTO_HIDE)
  })

  it('returns the same state when nothing changed', () => {
    const state = decideAutoHide(INITIAL_AUTO_HIDE, input(1000))
    expect(decideAutoHide(state, input(1000))).toBe(state)
    expect(decideAutoHide(state, { ...input(1000), panels: ['core/sessions', 'test/notes'] })).toBe(state)
  })
})

describe('decideAutoHide: hysteresis', () => {
  it('does not flap for a window resting around the threshold', () => {
    // Hidden at 719 of terminal; 1 px wider (or a few) is not enough to come back.
    expect(play([1400, 1319, 1321, 1319, 1330, 1320, 1367])).toEqual([[], ['right'], ['right'], ['right'], ['right'], ['right'], ['right']])
  })

  it('does not flap for a window resting around the restore point either', () => {
    const back = LEFT + RIGHT + MIN + RESTORE_MARGIN
    // Back at `back`; a pixel narrower is still over the minimum, so it stays.
    expect(play([1000, back, back - 1, back, back - 2])).toEqual([['right'], [], [], [], []])
  })
})

describe('decideAutoHide: the person', () => {
  it('a zone the person shows by hand stays until the window shrinks again', () => {
    let state = decideAutoHide(INITIAL_AUTO_HIDE, input(1200))
    expect(state.hidden).toEqual(['right'])
    state = revealZone(state, 'right')
    expect(state.hidden).toEqual([])
    // The same width, a wider one short of the restore point, a zone resized: no re-hide.
    state = decideAutoHide(state, input(1200))
    expect(state.hidden).toEqual([])
    state = decideAutoHide(state, input(1250))
    expect(state.hidden).toEqual([])
    state = decideAutoHide(state, input(1250, { sizes: { left: 300, right: RIGHT } }))
    expect(state.hidden).toEqual([])
    // The next shrink: the right zone gives way again (still narrow), the left stays.
    state = decideAutoHide(state, input(1249))
    expect(state.hidden).toEqual(['right'])
  })

  it('a shrink after a manual show applies the whole rule: both can go', () => {
    let state = revealZone(decideAutoHide(INITIAL_AUTO_HIDE, input(1200)), 'right')
    state = decideAutoHide(state, input(990))
    expect(state.hidden).toEqual(['right', 'left'])
  })

  it('showing one of two hidden zones by hand keeps the other hidden, and that one comes back with room', () => {
    let state = decideAutoHide(INITIAL_AUTO_HIDE, input(900))
    state = revealZone(state, 'right')
    expect(state.hidden).toEqual(['left'])
    state = decideAutoHide(state, input(900))
    expect(state.hidden).toEqual(['left'])
    state = decideAutoHide(state, input(LEFT + RIGHT + MIN + RESTORE_MARGIN))
    expect(state.hidden).toEqual([])
  })

  it('revealing a zone that is not hidden changes nothing', () => {
    const state = decideAutoHide(INITIAL_AUTO_HIDE, input(1200))
    expect(revealZone(state, 'left')).toBe(state)
  })

  it('a zone the person opens while narrow is not hidden at once', () => {
    // Right closed by the person: the left alone fits. Then they open the right one.
    let state = decideAutoHide(INITIAL_AUTO_HIDE, input(1200, { open: { left: true, right: false } }))
    expect(state.hidden).toEqual([])
    state = decideAutoHide(state, input(1200))
    expect(state.hidden).toEqual([])
    state = decideAutoHide(state, input(1199))
    expect(state.hidden).toEqual(['right'])
  })

  it('a zone dragged wider does not push the other one out; dragged narrower, the other comes back', () => {
    let state = decideAutoHide(INITIAL_AUTO_HIDE, input(1400))
    state = decideAutoHide(state, input(1400, { sizes: { left: 500, right: RIGHT } }))
    expect(state.hidden).toEqual([])
    state = decideAutoHide(INITIAL_AUTO_HIDE, input(1250))
    expect(state.hidden).toEqual(['right'])
    state = decideAutoHide(state, input(1250, { sizes: { left: 160, right: RIGHT } }))
    // 1250 - 160 - 320 = 770 >= 768.
    expect(state.hidden).toEqual([])
  })

  it('a zone the person closes while auto-hidden is theirs: it never comes back on its own', () => {
    let state = decideAutoHide(INITIAL_AUTO_HIDE, input(1200))
    expect(state.hidden).toEqual(['right'])
    state = decideAutoHide(state, input(1200, { open: { left: true, right: false } }))
    expect(state.hidden).toEqual([])
    // Wide again: nothing to restore, the zone stays as the person left it (closed).
    state = decideAutoHide(state, input(2000, { open: { left: true, right: false } }))
    expect(state.hidden).toEqual([])
  })

  it('a zone the person keeps closed is never hidden or counted', () => {
    const over = { open: { left: false, right: false } }
    expect(play([2000, 500, 2000], INITIAL_AUTO_HIDE, over)).toEqual([[], [], []])
  })
})

describe('decideAutoHide: the setting and other re-checks', () => {
  it('off: nothing is hidden, and turning it back on checks at once', () => {
    let state = decideAutoHide(INITIAL_AUTO_HIDE, input(900))
    expect(state.hidden).toEqual(['right', 'left'])
    state = decideAutoHide(state, input(900, { enabled: false }))
    expect(state).toBe(INITIAL_AUTO_HIDE)
    expect(decideAutoHide(state, input(800, { enabled: false }))).toBe(state)
    state = decideAutoHide(state, input(900))
    expect(state.hidden).toEqual(['right', 'left'])
  })

  it('a higher minimum checks at once; a lower one restores with the margin', () => {
    let state = decideAutoHide(INITIAL_AUTO_HIDE, input(1400))
    expect(state.hidden).toEqual([])
    state = decideAutoHide(state, input(1400, { minWidth: 1000 }))
    expect(state.hidden).toEqual(['right'])
    state = decideAutoHide(state, input(1400, { minWidth: 400 }))
    expect(state.hidden).toEqual([])
  })

  it('a panel that appears (the layout arrived, a plugin declared one) checks at once', () => {
    // The window's first decision has no panels yet (the empty default layout): nothing is open.
    let state = decideAutoHide(INITIAL_AUTO_HIDE, input(1000, { open: { left: false, right: false }, panels: [] }))
    expect(state.hidden).toEqual([])
    state = decideAutoHide(state, input(1000))
    expect(state.hidden).toEqual(['right'])
    // A panel that only goes away re-checks nothing.
    state = revealZone(state, 'right')
    state = decideAutoHide(state, input(1000, { panels: ['core/sessions'] }))
    expect(state.hidden).toEqual([])
  })
})

describe('newlyShown', () => {
  const available = [
    { panelKey: 'core/sessions', defaultZone: 'right' as const },
    { panelKey: 'test/notes', defaultZone: 'left' as const },
    { panelKey: 'test/other', defaultZone: 'left' as const }
  ]
  const base = reconcile(defaultLayout(), available)

  it('names a zone that got a panel opened in it, expanded or moved in', () => {
    const opened = togglePanel(base, 'core/sessions')
    expect(newlyShown(base, opened)).toEqual(['right'])
    // A second panel in an open zone is new too.
    const both = togglePanel(togglePanel(base, 'test/notes'), 'test/other')
    expect(newlyShown(togglePanel(base, 'test/notes'), both)).toEqual(['left'])
    // An expanded zone with an open panel.
    const collapsed = setZoneCollapsed(opened, 'right', true)
    expect(newlyShown(collapsed, opened)).toEqual(['right'])
    // An open panel moved into the other zone.
    expect(newlyShown(opened, movePanel(opened, 'core/sessions', 'left'))).toEqual(['left'])
  })

  it('names nothing for a close, a collapse or an unchanged layout', () => {
    const opened = togglePanel(base, 'core/sessions')
    expect(newlyShown(opened, opened)).toEqual([])
    expect(newlyShown(opened, togglePanel(opened, 'core/sessions'))).toEqual([])
    expect(newlyShown(opened, setZoneCollapsed(opened, 'right', true))).toEqual([])
    // The bottom zone is not a side zone.
    expect(newlyShown(opened, togglePanel(movePanel(base, 'test/notes', 'bottom'), 'test/notes'))).toEqual([])
  })
})
