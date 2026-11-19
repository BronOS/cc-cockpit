// A guest's view in ViewSelections (design-guests §7): its own selection for presence and the exit focus, but it never
// sets the project's active tab, is never lastActing, hands nothing back when it goes and is never a handback candidate.
import { beforeEach, describe, expect, it } from 'vitest'
import { EXIT_FOCUS_TYPED_MS, ViewSelections } from '../../src/main/tabs/view-selections'

const P = 'aaaaaaaaaaaaaaaa'
const TABS = ['t1', 't2', 't3']

let active: Array<[string, string | undefined]>
let t: number
let sel: ViewSelections

beforeEach(() => {
  active = []
  t = 1000
  sel = new ViewSelections({
    isTab: (p, tab) => p === P && TABS.includes(tab),
    setActive: (p, tab) => void active.push([p, tab]),
    now: () => t
  })
})

describe('guestActed and guestTyped', () => {
  it("remember the guest view's own selection and never set the active tab", () => {
    sel.guestActed(P, 'web:9', 't2')
    sel.guestTyped(P, 'web:9', 't3')
    expect(sel.selectionOf('web:9')).toBe('t3')
    expect(active).toEqual([])
  })

  it('ignore a tab that is not one of the project', () => {
    sel.guestActed(P, 'web:9', 'nope')
    sel.guestTyped(P, 'web:9', 'nope')
    expect(sel.selectionOf('web:9')).toBeUndefined()
  })

  it('never change lastActing: the owner view stays the last to act however the guest acts', () => {
    sel.acted(P, 'web:1', 't1')
    sel.guestActed(P, 'web:9', 't2')
    sel.guestTyped(P, 'web:9', 't2')
    expect(sel.lastActing(['web:1', 'web:9'])).toBe('web:1')
    expect(sel.lastActing(['web:9'])).toBeUndefined()
  })

  it('a view that acted as an owner and then as a guest is no longer a lastActing candidate', () => {
    sel.acted(P, 'web:9', 't1')
    sel.guestActed(P, 'web:9', 't2')
    expect(sel.lastActing(['web:9'])).toBeUndefined()
  })
})

describe('viewGone with guests', () => {
  it("a guest's going hands nothing back", () => {
    sel.acted(P, 'desktop:1', 't1')
    sel.guestActed(P, 'web:9', 't2')
    active = []
    sel.viewGone('web:9')
    expect(active).toEqual([])
    expect(sel.selectionOf('web:9')).toBeUndefined()
  })

  it('an owner view going never hands the active tab to a guest view', () => {
    sel.acted(P, 'desktop:1', 't1')
    sel.acted(P, 'web:1', 't3')
    sel.guestActed(P, 'web:9', 't2')
    active = []
    sel.viewGone('web:1')
    expect(active).toEqual([[P, 't1']])
    active = []
    sel.viewGone('desktop:1')
    expect(active).toEqual([])
  })
})

describe('exitFocus with guests', () => {
  function typedAndExited(viewId: string, tab = 't1', guest = true) {
    if (guest) sel.guestTyped(P, viewId, tab)
    else sel.typed(P, viewId, tab)
  }

  it('hands a guest view only a pane it sees', () => {
    typedAndExited('web:9')
    const out = sel.exitFocus(P, 't1', ['t2', 't3'], (viewId, tab) => viewId === 'web:9' && tab === 't3')
    expect(out).toEqual([{ viewId: 'web:9', tabId: 't3' }])
  })

  it('prefers the guest view\'s most recent visible pane', () => {
    sel.guestActed(P, 'web:9', 't3')
    sel.guestTyped(P, 'web:9', 't1')
    const out = sel.exitFocus(P, 't1', ['t2', 't3'], () => true)
    expect(out).toEqual([{ viewId: 'web:9', tabId: 't3' }])
  })

  it('leaves a guest keys-off when it sees none of the panes, or when there is no guestSees', () => {
    typedAndExited('web:9')
    expect(sel.exitFocus(P, 't1', ['t2', 't3'], () => false)).toEqual([])
    expect(sel.exitFocus(P, 't1', ['t2', 't3'])).toEqual([])
  })

  it('an owner view is still handed a pane with no guestSees, beside a guest left out', () => {
    typedAndExited('web:9')
    typedAndExited('web:1', 't1', false)
    expect(sel.exitFocus(P, 't1', ['t2', 't3'])).toEqual([{ viewId: 'web:1', tabId: 't2' }])
  })

  it('a guest typing is too old after EXIT_FOCUS_TYPED_MS', () => {
    typedAndExited('web:9')
    t += EXIT_FOCUS_TYPED_MS + 1
    expect(sel.exitFocus(P, 't1', ['t2'], () => true)).toEqual([])
  })
})
