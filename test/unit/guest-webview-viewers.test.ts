// A guest's view among a streamed panel's viewers (design-guests §8, spec-review 14; WebviewViewers.report's guest role):
// a read guest is a viewer and never the size owner; a write guest owns only by a claim, or as the first viewer while no
// owner's view watches (an owner's view joining later takes the size back unless the guest claimed); an owner leaving
// hands the size to an owner's view only, and with only guests left nobody owns it and the applied size stays.
import { beforeEach, describe, expect, it } from 'vitest'
import { WebviewViewers, type PlaceReport, type ViewersChange, type WebviewPanelOf } from '../../src/main/webview/webview-viewers'

const PANEL: WebviewPanelOf = { windowId: 7, pluginId: 'a.one', panelId: 'view' }
const OWNER = 'web:1'
const OWNER2 = 'web:2'
const READ = 'web:8'
const WRITE = 'web:9'

const shown = (width = 800, height = 600): PlaceReport => ({ width, height, visible: true, hidden: false })

let calls: unknown[][]
let changes: ViewersChange[]
let viewers: WebviewViewers
let t: number

beforeEach(() => {
  calls = []
  changes = []
  t = 1000
  viewers = new WebviewViewers({
    setViewed: (w, p, id, viewed) => void calls.push(['viewed', w, p, id, viewed]),
    setSize: (w, p, id, size) => void calls.push(['size', w, p, id, size]),
    setTimer: () => 0,
    clearTimer: () => undefined,
    now: () => (t += 1000),
    log: () => undefined
  })
  viewers.onChange((c) => void changes.push(c))
})

describe('a read guest', () => {
  it('is a viewer but never the owner, not even as the first viewer', () => {
    viewers.report(PANEL, READ, shown(300, 200), 'read')
    expect(viewers.isViewer(PANEL, READ)).toBe(true)
    expect(viewers.ownerOf(PANEL)).toBeUndefined()
    expect(viewers.sizeOf(PANEL)).toBeUndefined()
    expect(calls.filter((c) => c[0] === 'size')).toEqual([])
  })

  it("an owner's view joining after it becomes the owner and the page takes its size", () => {
    viewers.report(PANEL, READ, shown(300, 200), 'read')
    viewers.report(PANEL, OWNER, shown(800, 600), 'owner')
    expect(viewers.ownerOf(PANEL)).toBe(OWNER)
    expect(viewers.sizeOf(PANEL)).toEqual({ width: 800, height: 600 })
  })

  it('claimOwner from a read guest changes nothing', () => {
    viewers.report(PANEL, OWNER, shown(800, 600), 'owner')
    viewers.report(PANEL, READ, shown(300, 200), 'read')
    viewers.claimOwner(PANEL, READ)
    expect(viewers.ownerOf(PANEL)).toBe(OWNER)
    expect(viewers.sizeOf(PANEL)).toEqual({ width: 800, height: 600 })
  })

  it('stays a guest on later reports even with no role passed (sticky)', () => {
    viewers.report(PANEL, READ, shown(300, 200), 'read')
    viewers.report(PANEL, READ, shown(310, 200), 'owner')
    viewers.claimOwner(PANEL, READ)
    expect(viewers.ownerOf(PANEL)).toBeUndefined()
  })
})

describe('a write guest', () => {
  it('does not own by joining, not even as the first viewer (only a press, key or Fit claims)', () => {
    viewers.report(PANEL, WRITE, shown(400, 300), 'write')
    expect(viewers.isViewer(PANEL, WRITE)).toBe(true)
    expect(viewers.ownerOf(PANEL)).toBeUndefined()
    expect(calls.filter((c) => c[0] === 'size')).toEqual([])
    // The page still paints for it.
    expect(calls).toContainEqual(['viewed', 7, 'a.one', 'view', true])
  })

  it('an owner view joining after an unclaimed write guest owns the size', () => {
    viewers.report(PANEL, WRITE, shown(400, 300), 'write')
    viewers.report(PANEL, OWNER, shown(800, 600), 'owner')
    expect(viewers.ownerOf(PANEL)).toBe(OWNER)
    expect(viewers.sizeOf(PANEL)).toEqual({ width: 800, height: 600 })
    expect(changes.filter((c) => c.kind === 'owner').map((c) => (c as { viewId?: string }).viewId)).toEqual([OWNER])
  })

  it('an owner view joining later does not take it back after the guest claimed it from an owner view', () => {
    viewers.report(PANEL, OWNER, shown(800, 600), 'owner')
    viewers.report(PANEL, WRITE, shown(400, 300), 'write')
    viewers.claimOwner(PANEL, WRITE)
    viewers.report(PANEL, OWNER2, shown(700, 500), 'owner')
    expect(viewers.ownerOf(PANEL)).toBe(WRITE)
    expect(viewers.sizeOf(PANEL)).toEqual({ width: 400, height: 300 })
  })

  it('a lone write guest that claims keeps the size when an owner view joins', () => {
    viewers.report(PANEL, WRITE, shown(500, 400), 'write')
    viewers.claimOwner(PANEL, WRITE)
    viewers.report(PANEL, OWNER, shown(800, 600), 'owner')
    expect(viewers.ownerOf(PANEL)).toBe(WRITE)
    expect(viewers.sizeOf(PANEL)).toEqual({ width: 500, height: 400 })
  })

  it('a write guest joining beside an owner view does not own, and owns by its claim', () => {
    viewers.report(PANEL, OWNER, shown(800, 600), 'owner')
    viewers.report(PANEL, WRITE, shown(400, 300), 'write')
    expect(viewers.ownerOf(PANEL)).toBe(OWNER)
    viewers.claimOwner(PANEL, WRITE)
    expect(viewers.ownerOf(PANEL)).toBe(WRITE)
    expect(viewers.sizeOf(PANEL)).toEqual({ width: 400, height: 300 })
  })

  it('a write guest joining after a read guest (no owner yet) owns only once it claims', () => {
    viewers.report(PANEL, READ, shown(300, 200), 'read')
    viewers.report(PANEL, WRITE, shown(400, 300), 'write')
    expect(viewers.ownerOf(PANEL)).toBeUndefined()
    viewers.claimOwner(PANEL, WRITE)
    expect(viewers.ownerOf(PANEL)).toBe(WRITE)
  })
})

describe('the owner leaving', () => {
  it('hands the size to an owner view, never to a guest that reported or claimed more recently', () => {
    viewers.report(PANEL, OWNER, shown(800, 600), 'owner')
    viewers.report(PANEL, OWNER2, shown(700, 500), 'owner')
    viewers.report(PANEL, WRITE, shown(400, 300), 'write')
    viewers.report(PANEL, WRITE, shown(410, 300), 'owner')
    viewers.viewGone(OWNER)
    expect(viewers.ownerOf(PANEL)).toBe(OWNER2)
  })

  it('with only guests left nobody owns it, owner undefined is emitted and the applied size stays', () => {
    viewers.report(PANEL, OWNER, shown(800, 600), 'owner')
    viewers.report(PANEL, WRITE, shown(400, 300), 'write')
    viewers.report(PANEL, READ, shown(300, 200), 'read')
    changes.length = 0
    viewers.viewGone(OWNER)
    expect(viewers.ownerOf(PANEL)).toBeUndefined()
    expect(viewers.sizeOf(PANEL)).toEqual({ width: 800, height: 600 })
    expect(changes).toContainEqual({ kind: 'owner', panel: PANEL, viewId: undefined })
    expect(calls.filter((c) => c[0] === 'size')).toHaveLength(1)
    expect(viewers.viewers(PANEL)).toEqual([WRITE, READ])
  })

  it('after that a guest claim owns it again and the page takes its size', () => {
    viewers.report(PANEL, OWNER, shown(800, 600), 'owner')
    viewers.report(PANEL, WRITE, shown(400, 300), 'write')
    viewers.viewGone(OWNER)
    viewers.claimOwner(PANEL, WRITE)
    expect(viewers.ownerOf(PANEL)).toBe(WRITE)
    expect(viewers.sizeOf(PANEL)).toEqual({ width: 400, height: 300 })
  })
})
