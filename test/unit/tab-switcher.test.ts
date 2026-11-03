import { describe, expect, it } from 'vitest'
import type { TabInfo } from '../../src/shared/ipc'
import { heldModifiers, openSwitcher, recentOrder, released, step, touchRecent } from '../../src/renderer/tabs/tab-switcher'

const tab = (id: string): TabInfo => ({ id, kind: 'shell', cwd: '/p', gen: 1 }) as TabInfo
const tabs = ['a', 'b', 'c', 'd'].map(tab)
const up = { ctrlKey: false, altKey: false, metaKey: false }

describe('tab switcher', () => {
  it('keeps the recency list most recent first, each id once', () => {
    expect(touchRecent(['b', 'a', 'c'], 'c')).toEqual(['c', 'b', 'a'])
    expect(touchRecent([], 'a')).toEqual(['a'])
  })

  it('orders tabs by recency, drops closed ids, appends never-visited tabs in strip order', () => {
    expect(recentOrder(tabs, ['c', 'gone', 'a']).map((t) => t.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('wraps a step at both ends', () => {
    expect(step(3, 4, 1)).toBe(0)
    expect(step(0, 4, -1)).toBe(3)
    expect(step(0, 0, 1)).toBe(0)
  })

  it('opens on the previous tab forward and the least recent backward', () => {
    expect(openSwitcher(tabs, ['b', 'a'], 1, ['ctrl'], false)).toEqual({
      order: ['b', 'a', 'c', 'd'],
      index: 1,
      shown: false,
      sticky: false,
      mods: ['ctrl']
    })
    expect(openSwitcher(tabs, ['b', 'a'], -1, ['ctrl'], false)?.index).toBe(3)
  })

  it('does not open with fewer than two tabs', () => {
    expect(openSwitcher([tab('a')], ['a'], 1, ['ctrl'], false)).toBeNull()
  })

  it('opens shown and sticky with no modifier to hold, or when asked (a web panel chord)', () => {
    expect(openSwitcher(tabs, [], 1, [], false)).toMatchObject({ shown: true, sticky: true })
    expect(openSwitcher(tabs, [], 1, ['ctrl'], true)).toMatchObject({ shown: true, sticky: true })
  })

  it('holds the chord modifiers but Shift', () => {
    expect(heldModifiers('ctrl+shift+tab')).toEqual(['ctrl'])
    expect(heldModifiers('alt+meta+`')).toEqual(['alt', 'meta'])
    expect(heldModifiers('f6')).toEqual([])
    expect(heldModifiers(undefined)).toEqual([])
  })

  it('counts as released only when every held modifier is up', () => {
    expect(released(['ctrl'], up)).toBe(true)
    expect(released(['ctrl'], { ...up, ctrlKey: true })).toBe(false)
    expect(released(['alt', 'meta'], { ...up, metaKey: true })).toBe(false)
    expect(released([], up)).toBe(false)
  })
})
