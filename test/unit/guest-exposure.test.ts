// Item 18: the Plugins page's generic "what it exposes" text, from aware and the port kind only.
import { describe, expect, it } from 'vitest'
import { guestExposure } from '../../src/shared/guest-exposure'

describe('guestExposure', () => {
  it('a blocked plugin gives guests nothing', () => {
    const e = guestExposure({ aware: false, blocked: 'all-windows' })
    expect(e.read).toBe('Nothing.')
    expect(e.write).toBe('Nothing.')
    expect(e.summary).toMatch(/every window/)
  })

  it('a plugin that does not check access: read-only guests watch through a one-way line, write guests use it like the owner', () => {
    const e = guestExposure({ aware: false })
    expect(e.read).toMatch(/^Sees what the plugin pushes to its panels, slots and tabs; a page that asks for its state first shows nothing\. /)
    expect(e.read).toMatch(/does not reach the plugin/)
    expect(e.write).toMatch(/like you/)
    expect(e.summary).toMatch(/Does not check/)
  })

  it('a guest-aware plugin is told the viewer and decides', () => {
    const e = guestExposure({ aware: true })
    expect(e.read).toMatch(/read-only guest and decides/)
    expect(e.write).toMatch(/decides/)
    expect(e.summary).toMatch(/Checks who is looking/)
  })

  it('never offers the settings to a guest and names no plugin', () => {
    for (const r of [{ aware: true }, { aware: false }]) {
      const e = guestExposure(r)
      expect(e.read).toMatch(/Never its settings/)
      expect(e.write).toMatch(/Never its settings/)
      expect(JSON.stringify(e)).not.toMatch(/cockpit|Usage|Sessions/)
    }
  })
})
