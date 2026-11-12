// design-web-browser.md §3.2 (plan 20261111-streamed-webviews.md Task 4): which browser views of a
// server's window show a webview panel, whose size its page has, and what that drives in the
// manager. Pure: fake timers and clock, a recorder for the manager's calls.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampSide,
  MAX_PLACE_SIDE,
  MIN_PLACE_SIDE,
  RESIZE_THROTTLE_MS,
  WebviewViewers,
  type PlaceReport,
  type ViewersChange,
  type WebviewPanelOf
} from '../../src/main/webview/webview-viewers'
import { WebviewManager, type WebviewView } from '../../src/main/webview/webview-manager'
import type { ViewBounds } from '../../src/main/overlays/overlay-manager'

const PANEL: WebviewPanelOf = { windowId: 7, pluginId: 'a.one', panelId: 'view' }
const OTHER_PANEL: WebviewPanelOf = { windowId: 7, pluginId: 'a.one', panelId: 'other' }
const OTHER_WINDOW: WebviewPanelOf = { windowId: 8, pluginId: 'a.one', panelId: 'view' }

const shown = (width = 800, height = 600): PlaceReport => ({ width, height, visible: true, hidden: false })

/** Timers run by hand: `advance(ms)` moves the clock and fires what is due. */
class Clock {
  t = 1000
  private timers: Array<{ at: number; fn: () => void; id: number }> = []
  private next = 1
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.next++
    this.timers.push({ at: this.t + ms, fn, id })
    return id
  }
  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== handle)
  }
  now = (): number => this.t
  advance(ms: number): void {
    this.t += ms
    for (;;) {
      const due = this.timers.filter((t) => t.at <= this.t).sort((a, b) => a.at - b.at)[0]
      if (!due) return
      this.timers = this.timers.filter((t) => t !== due)
      due.fn()
    }
  }
  pending(): number {
    return this.timers.length
  }
}

describe('WebviewViewers', () => {
  let clock: Clock
  let calls: unknown[][]
  let changes: ViewersChange[]
  let logs: string[]
  let viewers: WebviewViewers

  beforeEach(() => {
    clock = new Clock()
    calls = []
    changes = []
    logs = []
    viewers = new WebviewViewers({
      setViewed: (w, p, id, viewed) => void calls.push(['viewed', w, p, id, viewed]),
      setSize: (w, p, id, size) => void calls.push(['size', w, p, id, size]),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: clock.now,
      log: (m) => void logs.push(m)
    })
    viewers.onChange((c) => void changes.push(c))
  })

  it('makes a visible, not hidden report a viewer: the size first, then the first viewer shows the view', () => {
    viewers.report(PANEL, 'web:1', shown(800, 600))
    expect(calls).toEqual([
      ['size', 7, 'a.one', 'view', { width: 800, height: 600 }],
      ['viewed', 7, 'a.one', 'view', true]
    ])
    expect(viewers.viewers(PANEL)).toEqual(['web:1'])
    expect(viewers.isViewer(PANEL, 'web:1')).toBe(true)
    expect(viewers.ownerOf(PANEL)).toBe('web:1')
    expect(viewers.sizeOf(PANEL)).toEqual({ width: 800, height: 600 })
    expect(changes.map((c) => c.kind)).toEqual(['owner', 'size', 'added'])
    // A second viewer joins: no second setViewed, no resize (it is not the owner).
    calls.length = 0
    viewers.report(PANEL, 'web:2', shown(400, 300))
    expect(calls).toEqual([])
    expect(viewers.viewers(PANEL)).toEqual(['web:1', 'web:2'])
    expect(changes.at(-1)).toEqual({ kind: 'added', panel: PANEL, viewId: 'web:2' })
  })

  it('a hidden tab, a panel off screen or a collapsed panel is no viewer; the last viewer leaving hides the view', () => {
    viewers.report(PANEL, 'web:1', { ...shown(), hidden: true })
    viewers.report(PANEL, 'web:1', { ...shown(), visible: false })
    viewers.report(PANEL, 'web:1', shown(0, 600))
    viewers.report(PANEL, 'web:1', shown(800, 0))
    expect(calls).toEqual([])
    expect(viewers.viewers(PANEL)).toEqual([])
    viewers.report(PANEL, 'web:1', shown())
    viewers.report(PANEL, 'web:2', shown())
    calls.length = 0
    viewers.report(PANEL, 'web:1', { ...shown(), hidden: true })
    expect(calls).toEqual([])
    expect(viewers.viewers(PANEL)).toEqual(['web:2'])
    viewers.report(PANEL, 'web:2', { ...shown(), visible: false })
    expect(calls).toEqual([['viewed', 7, 'a.one', 'view', false]])
    expect(viewers.viewers(PANEL)).toEqual([])
    expect(viewers.ownerOf(PANEL)).toBeUndefined()
    // A view coming back is the first viewer again: shown, sized at once.
    clock.advance(1)
    calls.length = 0
    viewers.report(PANEL, 'web:2', shown(640, 480))
    expect(calls).toEqual([
      ['size', 7, 'a.one', 'view', { width: 640, height: 480 }],
      ['viewed', 7, 'a.one', 'view', true]
    ])
  })

  it('keeps panels and windows apart', () => {
    viewers.report(PANEL, 'web:1', shown())
    viewers.report(OTHER_PANEL, 'web:1', shown())
    viewers.report(OTHER_WINDOW, 'web:3', shown())
    expect(viewers.viewers(PANEL)).toEqual(['web:1'])
    expect(viewers.viewers(OTHER_PANEL)).toEqual(['web:1'])
    expect(viewers.viewers(OTHER_WINDOW)).toEqual(['web:3'])
    viewers.report(PANEL, 'web:1', { ...shown(), visible: false })
    expect(viewers.isViewer(OTHER_PANEL, 'web:1')).toBe(true)
    // A claim for another window's panel from a view that is not its viewer changes nothing.
    viewers.claimOwner(OTHER_WINDOW, 'web:1')
    expect(viewers.ownerOf(OTHER_WINDOW)).toBe('web:3')
  })

  describe('the size owner', () => {
    it('is the first reporter; only its reports resize the page', () => {
      viewers.report(PANEL, 'web:1', shown(800, 600))
      viewers.report(PANEL, 'web:2', shown(400, 300))
      clock.advance(RESIZE_THROTTLE_MS)
      calls.length = 0
      viewers.report(PANEL, 'web:2', shown(500, 300))
      expect(calls).toEqual([])
      viewers.report(PANEL, 'web:1', shown(900, 600))
      expect(calls).toEqual([['size', 7, 'a.one', 'view', { width: 900, height: 600 }]])
    })

    it('moves to a viewer that claims it (a press, a key, text, Fit to this screen), at its last size', () => {
      viewers.report(PANEL, 'web:1', shown(800, 600))
      viewers.report(PANEL, 'web:2', shown(400, 300))
      clock.advance(RESIZE_THROTTLE_MS)
      calls.length = 0
      viewers.claimOwner(PANEL, 'web:2')
      expect(viewers.ownerOf(PANEL)).toBe('web:2')
      expect(calls).toEqual([['size', 7, 'a.one', 'view', { width: 400, height: 300 }]])
      expect(changes.filter((c) => c.kind === 'owner').at(-1)).toEqual({ kind: 'owner', panel: PANEL, viewId: 'web:2' })
      // The owner claiming again changes nothing; a non-viewer's claim is ignored.
      calls.length = 0
      clock.advance(RESIZE_THROTTLE_MS)
      viewers.claimOwner(PANEL, 'web:2')
      viewers.claimOwner(PANEL, 'web:9')
      viewers.claimOwner(OTHER_PANEL, 'web:2')
      expect(calls).toEqual([])
      expect(viewers.ownerOf(PANEL)).toBe('web:2')
    })

    it('an owner that leaves hands the size to the viewer active last', () => {
      viewers.report(PANEL, 'web:1', shown(800, 600))
      viewers.report(PANEL, 'web:2', shown(400, 300))
      viewers.report(PANEL, 'web:3', shown(300, 200))
      // web:2 reports again (a resize): it is the one active last.
      viewers.report(PANEL, 'web:2', shown(420, 300))
      clock.advance(RESIZE_THROTTLE_MS)
      calls.length = 0
      viewers.viewGone('web:1')
      expect(viewers.ownerOf(PANEL)).toBe('web:2')
      expect(calls).toEqual([['size', 7, 'a.one', 'view', { width: 420, height: 300 }]])
      expect(viewers.viewers(PANEL)).toEqual(['web:2', 'web:3'])
      // A claim counts as activity too.
      viewers.claimOwner(PANEL, 'web:3')
      viewers.claimOwner(PANEL, 'web:2')
      viewers.report(PANEL, 'web:2', { ...shown(), hidden: true })
      expect(viewers.ownerOf(PANEL)).toBe('web:3')
    })
  })

  describe('the resize throttle', () => {
    it(`applies at most one resize per ${RESIZE_THROTTLE_MS} ms, the final size on the trailing edge`, () => {
      viewers.report(PANEL, 'web:1', shown(800, 600))
      calls.length = 0
      // A dragged splitter: a report per pixel.
      for (let w = 801; w <= 850; w++) {
        clock.advance(2)
        viewers.report(PANEL, 'web:1', shown(w, 600))
      }
      // 100 ms after the first resize: one trailing resize so far.
      expect(calls.length).toBeLessThanOrEqual(1)
      clock.advance(RESIZE_THROTTLE_MS)
      const sizes = calls.map((c) => c[4])
      expect(sizes.at(-1)).toEqual({ width: 850, height: 600 })
      expect(sizes.length).toBeLessThanOrEqual(2)
      expect(clock.pending()).toBe(0)
    })

    it('a report back to the applied size during the wait resizes nothing', () => {
      viewers.report(PANEL, 'web:1', shown(800, 600))
      calls.length = 0
      clock.advance(10)
      viewers.report(PANEL, 'web:1', shown(900, 600))
      viewers.report(PANEL, 'web:1', shown(800, 600))
      clock.advance(RESIZE_THROTTLE_MS)
      expect(calls).toEqual([])
    })

    it('a resize after a quiet spell applies at once', () => {
      viewers.report(PANEL, 'web:1', shown(800, 600))
      clock.advance(RESIZE_THROTTLE_MS + 1)
      calls.length = 0
      viewers.report(PANEL, 'web:1', shown(700, 600))
      expect(calls).toEqual([['size', 7, 'a.one', 'view', { width: 700, height: 600 }]])
    })

    it('a pending resize is dropped when the panel loses its viewers or its window', () => {
      viewers.report(PANEL, 'web:1', shown(800, 600))
      clock.advance(10)
      viewers.report(PANEL, 'web:1', shown(900, 600))
      viewers.viewGone('web:1')
      calls.length = 0
      clock.advance(RESIZE_THROTTLE_MS)
      expect(calls).toEqual([])
      viewers.report(OTHER_WINDOW, 'web:2', shown(800, 600))
      clock.advance(10)
      viewers.report(OTHER_WINDOW, 'web:2', shown(900, 600))
      viewers.closeWindow(8)
      calls.length = 0
      clock.advance(RESIZE_THROTTLE_MS)
      expect(calls).toEqual([])
      expect(clock.pending()).toBe(0)
    })
  })

  describe('sizes', () => {
    it(`clamps a side to [${MIN_PLACE_SIDE}, ${MAX_PLACE_SIDE}] whole CSS px`, () => {
      expect(clampSide(10)).toBe(MIN_PLACE_SIDE)
      expect(clampSide(1)).toBe(MIN_PLACE_SIDE)
      expect(clampSide(0)).toBe(MIN_PLACE_SIDE)
      expect(clampSide(-5)).toBe(MIN_PLACE_SIDE)
      expect(clampSide(799.6)).toBe(800)
      expect(clampSide(1e9)).toBe(MAX_PLACE_SIDE)
      expect(clampSide(Number.MAX_VALUE)).toBe(MAX_PLACE_SIDE)
      expect(clampSide(Number.NaN)).toBeUndefined()
      expect(clampSide(Infinity)).toBeUndefined()
      expect(clampSide(-Infinity)).toBeUndefined()
      expect(clampSide('800')).toBeUndefined()
    })

    it('a tiny, huge or non-finite report never reaches the manager unclamped', () => {
      viewers.report(PANEL, 'web:1', shown(10, 1e9))
      expect(calls[0]).toEqual(['size', 7, 'a.one', 'view', { width: MIN_PLACE_SIDE, height: MAX_PLACE_SIDE }])
      // A NaN or Infinity side (the router refuses them first): not a viewer.
      viewers.report(PANEL, 'web:2', shown(Number.NaN, 600))
      viewers.report(PANEL, 'web:3', shown(800, Infinity))
      expect(viewers.viewers(PANEL)).toEqual(['web:1'])
      // The owner sending one leaves the panel rather than resizing it.
      viewers.report(PANEL, 'web:1', shown(Number.NaN, Number.NaN))
      expect(viewers.viewers(PANEL)).toEqual([])
      expect(calls.filter((c) => c[0] === 'size')).toHaveLength(1)
    })
  })

  describe('views and windows going', () => {
    it('a view gone leaves every panel it viewed', () => {
      viewers.report(PANEL, 'web:1', shown())
      viewers.report(OTHER_PANEL, 'web:1', shown())
      viewers.report(OTHER_PANEL, 'web:2', shown())
      calls.length = 0
      viewers.viewGone('web:1')
      expect(calls).toEqual([['viewed', 7, 'a.one', 'view', false]])
      expect(viewers.viewers(PANEL)).toEqual([])
      expect(viewers.viewers(OTHER_PANEL)).toEqual(['web:2'])
      expect(viewers.ownerOf(OTHER_PANEL)).toBe('web:2')
      // Twice, or a view never seen: nothing.
      calls.length = 0
      viewers.viewGone('web:1')
      viewers.viewGone('web:42')
      expect(calls).toEqual([])
    })

    it('a closed window forgets its panels without telling the manager (it drops the views itself)', () => {
      viewers.report(PANEL, 'web:1', shown())
      viewers.report(OTHER_WINDOW, 'web:2', shown())
      calls.length = 0
      changes.length = 0
      viewers.closeWindow(7)
      expect(calls).toEqual([])
      expect(changes).toEqual([{ kind: 'removed', panel: PANEL, viewId: 'web:1' }])
      expect(viewers.viewers(PANEL)).toEqual([])
      expect(viewers.viewers(OTHER_WINDOW)).toEqual(['web:2'])
    })

    it('leave takes only the view\'s own entry in its own window off a panel named by key', () => {
      viewers.report(PANEL, 'web:1', shown())
      viewers.report(PANEL, 'web:2', shown())
      viewers.report(OTHER_WINDOW, 'web:1', shown())
      viewers.leave(7, 'web:1', 'a.one/view')
      expect(viewers.viewers(PANEL)).toEqual(['web:2'])
      expect(viewers.viewers(OTHER_WINDOW)).toEqual(['web:1'])
      // A key that names nothing, or another view's: nothing.
      viewers.leave(7, 'web:2', 'a.one/nope')
      viewers.leave(7, 'web:3', 'a.one/view')
      expect(viewers.viewers(PANEL)).toEqual(['web:2'])
    })
  })

  it('a throwing manager or listener is logged and breaks nothing', () => {
    const broken = new WebviewViewers({
      setViewed: () => {
        throw new Error('boom')
      },
      setSize: () => {
        throw new Error('bang')
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: clock.now,
      log: (m) => void logs.push(m)
    })
    broken.onChange(() => {
      throw new Error('listener')
    })
    const heard: ViewersChange[] = []
    const off = broken.onChange((c) => void heard.push(c))
    broken.report(PANEL, 'web:1', shown())
    expect(broken.viewers(PANEL)).toEqual(['web:1'])
    expect(heard.map((c) => c.kind)).toEqual(['owner', 'size', 'added'])
    expect(logs.join('\n')).toMatch(/boom/)
    expect(logs.join('\n')).toMatch(/bang/)
    expect(logs.join('\n')).toMatch(/listener/)
    off()
    broken.viewGone('web:1')
    expect(heard).toHaveLength(3)
  })
})

// The manager's side (webview-manager.ts): what the viewers drive in server mode.
describe('WebviewManager driven by the viewers (server mode)', () => {
  interface Fake extends WebviewView {
    bounds: ViewBounds[]
    visible: boolean[]
    loaded: string[]
  }
  let made: Fake[]
  const open = new Set([7])

  function managerFor(server: boolean): WebviewManager {
    return new WebviewManager({
      views: {
        create: () => {
          const v: Fake = {
            bounds: [],
            visible: [],
            loaded: [],
            load(url) {
              v.loaded.push(url)
              return Promise.resolve()
            },
            back: () => {},
            forward: () => {},
            reload: () => {},
            current: () => ({ url: '', title: '' }),
            isFocused: () => false,
            setBounds: (b) => void v.bounds.push(b),
            setVisible: (vis) => void v.visible.push(vis),
            destroy: () => {}
          }
          made.push(v)
          return v
        }
      },
      openExternal: () => {},
      isWindowOpen: (w) => open.has(w),
      homeDir: () => '/nonexistent-home',
      tempRoots: () => [],
      server,
      log: () => {}
    })
  }
  const owner = { windowId: 7, projectId: 'P1', pluginId: 'a.one', panelId: 'view' }

  beforeEach(() => {
    made = []
  })

  it('a deferred load runs for the first viewer, at the owner\'s size, and painting follows the viewers', async () => {
    const manager = managerFor(true)
    const viewers = new WebviewViewers({
      setViewed: (w, p, id, v) => manager.setViewed(w, p, id, v),
      setSize: (w, p, id, s) => manager.setViewSize(w, p, id, s)
    })
    await manager.navigate(owner, 'https://example.com/')
    expect(made).toEqual([])
    viewers.report(PANEL, 'web:1', shown(800, 600))
    expect(made).toHaveLength(1)
    const view = made[0] as Fake
    expect(view.loaded).toEqual(['https://example.com/'])
    expect(view.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
    expect(view.visible.at(-1)).toBe(true)
    expect(manager.isShown(7, 'a.one', 'view')).toBe(true)
    // An overlay in the window does not hide it: in a browser it is a layer over the canvas.
    manager.setWindowCovered(7, true)
    expect(manager.isShown(7, 'a.one', 'view')).toBe(true)
    manager.setWindowCovered(7, false)
    // Nobody views it: hidden (not painting), the page kept.
    viewers.viewGone('web:1')
    expect(view.visible.at(-1)).toBe(false)
    expect(manager.has(7, 'a.one', 'view')).toBe(true)
  })

  it('a plugin reload keeps the browsers\' viewers: its next navigate loads for the browser still showing the panel', async () => {
    const manager = managerFor(true)
    const viewers = new WebviewViewers({
      setViewed: (w, p, id, v) => manager.setViewed(w, p, id, v),
      setSize: (w, p, id, s) => manager.setViewSize(w, p, id, s)
    })
    viewers.report(PANEL, 'web:1', shown(640, 480))
    await manager.navigate(owner, 'https://example.com/')
    expect(made).toHaveLength(1)
    manager.destroyPlugin(7, 'a.one')
    await manager.navigate(owner, 'https://example.org/')
    expect(made).toHaveLength(2)
    const again = made[1] as Fake
    expect(again.loaded).toEqual(['https://example.org/'])
    expect(again.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 640, height: 480 })
    expect(again.visible.at(-1)).toBe(true)
  })

  it('setViewSize clamps and ignores what is no size; the desktop ignores setViewed and setViewSize', async () => {
    const manager = managerFor(true)
    await manager.navigate(owner, 'https://example.com/', undefined, { now: true })
    const view = made[0] as Fake
    manager.setViewSize(7, 'a.one', 'view', { width: 1e9, height: 300.4 })
    expect(view.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 4096, height: 300 })
    const before = view.bounds.length
    manager.setViewSize(7, 'a.one', 'view', { width: Number.NaN, height: 300 })
    manager.setViewSize(7, 'a.one', 'view', { width: 0, height: 300 })
    expect(view.bounds).toHaveLength(before)

    const desktop = managerFor(false)
    await desktop.navigate(owner, 'https://example.com/')
    const dv = made[1] as Fake
    desktop.setViewed(7, 'a.one', 'view', true)
    desktop.setViewSize(7, 'a.one', 'view', { width: 800, height: 600 })
    expect(desktop.isShown(7, 'a.one', 'view')).toBe(false)
    expect(dv.bounds.every((b) => b.width === 0)).toBe(true)
  })
})
