import { describe, expect, it } from 'vitest'
import { desktopViewId, isRemoteViewId, remoteViewId, viewIdOf } from '../../src/shared/views'

describe('view ids', () => {
  it('mints desktop and remote ids', () => {
    expect(desktopViewId(4)).toBe('desktop:4')
    expect(remoteViewId(1)).toBe('web:1')
    expect(isRemoteViewId(remoteViewId(12))).toBe(true)
    expect(isRemoteViewId(desktopViewId(12))).toBe(false)
  })

  it('refuses a view number main could not have counted to', () => {
    for (const n of [0, -1, 1.5, Number.NaN, 1e12, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => remoteViewId(n)).toThrow(/bad view number/)
    }
  })

  it('parses only remote ids from a host hint; anything else reads as the desktop', () => {
    expect(viewIdOf('web:3')).toBe('web:3')
    expect(viewIdOf('web:999999999999')).toBe('web:999999999999')
    for (const raw of ['web:0', 'web:01', 'web:', 'web:1 ', ' web:1', 'web:1\n', 'desktop:1', 'web:1000000000000', 3, null, undefined, {}]) {
      expect(viewIdOf(raw)).toBeUndefined()
    }
  })
})
