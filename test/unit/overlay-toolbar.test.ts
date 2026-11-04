import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_TOOLBAR_BUTTONS,
  STILL_LOADING_MS,
  inert,
  orderTypeButtons,
  stillLoadingTimer,
  toolbarLayout,
  urlViewBounds
} from '../../src/renderer/overlays/overlay-toolbar'
import type { OverlayButtonInfo, OverlayTypeButtonInfo } from '../../src/shared/ipc'

const opener = (...ids: string[]): OverlayButtonInfo[] => ids.map((id) => ({ id, label: id }))
const typed = (pluginId: string, pluginTitle: string, ...ids: string[]): OverlayTypeButtonInfo[] =>
  ids.map((id) => ({ id, label: id, pluginId, pluginTitle }))

describe('orderTypeButtons', () => {
  it('groups by plugin in plugin-title order (case-insensitive), keeping each plugin its own order', () => {
    const list = [...typed('z.mail', 'mail', 'm1', 'm2'), ...typed('a.editor', 'Editor', 'e1'), ...typed('b.chat', 'Chat', 'c1', 'c2')]
    expect(orderTypeButtons(list).map((b) => b.id)).toEqual(['c1', 'c2', 'e1', 'm1', 'm2'])
  })

  it('orders two plugins of the same title by id, and keeps a plugin together even when its buttons were apart', () => {
    const list = [...typed('b.two', 'Same', 'b1'), ...typed('a.one', 'Same', 'a1'), ...typed('b.two', 'Same', 'b2')]
    expect(orderTypeButtons(list).map((b) => b.id)).toEqual(['a1', 'b1', 'b2'])
  })
})

describe('toolbarLayout', () => {
  it('shows up to six in the row: the opener first, then the type buttons; no menu', () => {
    const layout = toolbarLayout(opener('o1', 'o2'), [...typed('b.x', 'B', 'b1'), ...typed('a.x', 'A', 'a1', 'a2', 'a3')])
    expect(layout.row.map((e) => e.button.id)).toEqual(['o1', 'o2', 'a1', 'a2', 'a3', 'b1'])
    expect(layout.row.map((e) => e.source)).toEqual(['opener', 'opener', 'type', 'type', 'type', 'type'])
    expect(layout.openerCount).toBe(2)
    expect(layout.menu).toEqual([])
  })

  it('with more than six, the first five show and the rest fold into the menu, in the same order', () => {
    const layout = toolbarLayout(opener('o1', 'o2', 'o3'), typed('a.x', 'A', 'a1', 'a2', 'a3', 'a4'))
    expect(layout.row).toHaveLength(MAX_TOOLBAR_BUTTONS - 1)
    expect(layout.row.map((e) => e.button.id)).toEqual(['o1', 'o2', 'o3', 'a1', 'a2'])
    expect(layout.menu.map((e) => e.button.id)).toEqual(['a3', 'a4'])
    expect(layout.menu[0]).toMatchObject({ source: 'type', pluginId: 'a.x' })
    expect(layout.openerCount).toBe(3)
  })

  it('counts only the opener buttons that fit in the row', () => {
    const layout = toolbarLayout(opener('o1', 'o2', 'o3', 'o4'), typed('a.x', 'A', 'a1', 'a2', 'a3'))
    expect(layout.openerCount).toBe(4)
    expect(layout.row.map((e) => e.button.id)).toEqual(['o1', 'o2', 'o3', 'o4', 'a1'])
    expect(layout.menu.map((e) => e.button.id)).toEqual(['a2', 'a3'])
  })

  it('is empty without buttons', () => {
    expect(toolbarLayout(undefined, undefined)).toEqual({ row: [], openerCount: 0, menu: [] })
    expect(toolbarLayout([], [])).toEqual({ row: [], openerCount: 0, menu: [] })
  })

  it('treats a busy or disabled button as taking no click', () => {
    expect(inert({ id: 'a', label: 'A' })).toBe(false)
    expect(inert({ id: 'a', label: 'A', busy: true })).toBe(true)
    expect(inert({ id: 'a', label: 'A', disabled: true })).toBe(true)
  })
})

describe('stillLoadingTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('says "still loading" after 10 s, once', () => {
    const still = vi.fn()
    stillLoadingTimer(still)
    vi.advanceTimersByTime(STILL_LOADING_MS - 1)
    expect(still).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(still).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(STILL_LOADING_MS * 3)
    expect(still).toHaveBeenCalledTimes(1)
    expect(STILL_LOADING_MS).toBe(10_000)
  })

  it('says nothing once cancelled (the loader went first)', () => {
    const still = vi.fn()
    const cancel = stillLoadingTimer(still)
    vi.advanceTimersByTime(9_000)
    cancel()
    vi.advanceTimersByTime(STILL_LOADING_MS)
    expect(still).not.toHaveBeenCalled()
  })
})

describe('urlViewBounds', () => {
  it('follows the body while the "…" menu is closed', () => {
    expect(urlViewBounds({ left: 10, top: 46, width: 800, height: 500 }, false)).toEqual({
      x: 10,
      y: 46,
      width: 800,
      height: 500
    })
  })

  it('is zero while the menu is open, so the native view does not cover it', () => {
    expect(urlViewBounds({ left: 10, top: 46, width: 800, height: 500 }, true)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})
