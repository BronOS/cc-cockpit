import { describe, expect, it } from 'vitest'
import { guestPort, guestVisibility, guestVisibilityOf, type GuestAccessInput } from '../../src/shared/guest-access'
import { isGuestAware } from '../../src/shared/manifest'

// design-guests §6, §16.1: which plugins a guest sees. Hidden by default, bundled plugins included.

const plain = { manifest: {}, appValue: undefined, projectValue: undefined } satisfies GuestAccessInput
const aware = { guests: { aware: true } }
const allWindows = { access: { sessions: 'all-windows' as const } }

describe('guestVisibility', () => {
  it('is hidden by default', () => {
    expect(guestVisibility(plain)).toEqual({ effective: 'hidden', source: 'default', aware: false })
    expect(guestVisibility({ ...plain, manifest: undefined }).effective).toBe('hidden')
  })

  it('takes the app value, and the project value over it either way', () => {
    expect(guestVisibility({ ...plain, appValue: 'shown' })).toEqual({ effective: 'shown', source: 'app', aware: false })
    expect(guestVisibility({ ...plain, appValue: 'shown', projectValue: 'hidden' })).toEqual({ effective: 'hidden', source: 'project', aware: false })
    expect(guestVisibility({ ...plain, appValue: 'hidden', projectValue: 'shown' })).toEqual({ effective: 'shown', source: 'project', aware: false })
    expect(guestVisibility({ ...plain, projectValue: 'shown' }).source).toBe('project')
  })

  it('ignores a damaged stored value (the files are user-writable)', () => {
    for (const bad of ['SHOWN', 'yes', true, 1, {}, null]) {
      expect(guestVisibility({ ...plain, appValue: bad as never }).source, String(bad)).toBe('default')
      expect(guestVisibility({ ...plain, appValue: 'shown', projectValue: bad as never }).source).toBe('app')
    }
    expect(guestVisibilityOf('shown')).toBe('shown')
    expect(guestVisibilityOf('hidden')).toBe('hidden')
    expect(guestVisibilityOf('x')).toBeUndefined()
  })

  it('blocks an all-windows plugin that is not guest-aware, whatever the owner set', () => {
    const r = guestVisibility({ manifest: allWindows, appValue: 'shown', projectValue: 'shown' })
    expect(r).toEqual({ effective: 'hidden', source: 'project', aware: false, blocked: 'all-windows' })
    expect(guestPort(r, 'write')).toBe('none')
  })

  it('does not block an all-windows plugin that declares it checks guests', () => {
    const r = guestVisibility({ manifest: { ...allWindows, ...aware }, appValue: 'shown', projectValue: undefined })
    expect(r).toEqual({ effective: 'shown', source: 'app', aware: true })
  })

  it('gives bundled ids no special case', () => {
    // The resolver never sees the id: a cockpit.* plugin is hidden until the owner shows it, like any other.
    const bundledLike = { manifest: {}, appValue: undefined, projectValue: undefined }
    expect(guestVisibility(bundledLike).effective).toBe('hidden')
    expect(guestVisibility({ ...bundledLike, appValue: 'shown' }).effective).toBe('shown')
  })

  it('reads guests.aware strictly', () => {
    expect(isGuestAware({ guests: { aware: true } })).toBe(true)
    expect(isGuestAware({ guests: { aware: false } })).toBe(false)
    expect(isGuestAware({ guests: {} })).toBe(false)
    expect(isGuestAware({ guests: { aware: 'true' as never } })).toBe(false)
    expect(isGuestAware(undefined)).toBe(false)
  })
})

describe('guestPort (D-17)', () => {
  it('none while hidden, full for write guests and aware plugins, one-way for read guests of the rest', () => {
    const hidden = guestVisibility(plain)
    const shown = guestVisibility({ ...plain, appValue: 'shown' })
    const shownAware = guestVisibility({ ...plain, manifest: aware, appValue: 'shown' })
    expect(guestPort(hidden, 'read')).toBe('none')
    expect(guestPort(hidden, 'write')).toBe('none')
    expect(guestPort(shown, 'write')).toBe('full')
    expect(guestPort(shown, 'read')).toBe('oneWay')
    expect(guestPort(shownAware, 'read')).toBe('full')
    expect(guestPort(shownAware, 'write')).toBe('full')
  })
})
