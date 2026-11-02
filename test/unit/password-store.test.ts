// choosePasswordStore: when main appends --password-store=gnome-libsecret before `ready`.
// Pure function with an injected bus runner; nothing here spawns dbus-send or touches a keyring.
import { describe, expect, it, vi } from 'vitest'
import {
  choosePasswordStore,
  execRunner,
  NAME_HAS_OWNER_ARGV,
  RECOGNISED_DESKTOPS
} from '../../src/main/secrets/password-store'

const owner = (has: boolean) => () =>
  `method return time=1.0 sender=org.freedesktop.DBus -> destination=:1.5 serial=3 reply_serial=2\n   boolean ${has}\n`
const broken = () => {
  throw new Error('spawn dbus-send ENOENT')
}
const bus = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }

function choose(
  over: Partial<Parameters<typeof choosePasswordStore>[0]> & {
    run?: () => string
  }
) {
  return choosePasswordStore({
    platform: 'linux',
    argv: ['/usr/bin/cc-cockpit'],
    env: { ...bus, XDG_CURRENT_DESKTOP: 'Hyprland' },
    isPackaged: true,
    run: owner(true),
    ...over
  })
}

describe('choosePasswordStore', () => {
  it('Linux with a Secret Service owner: libsecret, asked through dbus-send argv', () => {
    const run = vi.fn(owner(true))
    expect(choose({ run })).toBe('gnome-libsecret')
    expect(run).toHaveBeenCalledWith([...NAME_HAS_OWNER_ARGV])
    expect(NAME_HAS_OWNER_ARGV).toContain('string:org.freedesktop.secrets')
  })

  it('also on a recognised desktop when the owner exists (harmless, same backend)', () => {
    expect(choose({ env: { ...bus, XDG_CURRENT_DESKTOP: 'GNOME' } })).toBe('gnome-libsecret')
  })

  it('no owner on the bus: no switch, even on an unknown desktop', () => {
    expect(choose({ run: owner(false) })).toBeNull()
  })

  it('check impossible, unrecognised desktop, bus address set: libsecret anyway', () => {
    expect(choose({ run: broken })).toBe('gnome-libsecret')
  })

  it('check impossible and unreadable output behave the same', () => {
    expect(choose({ run: () => 'garbage' })).toBe('gnome-libsecret')
  })

  it('check impossible, unrecognised desktop, no bus address: none', () => {
    expect(choose({ run: broken, env: { XDG_CURRENT_DESKTOP: 'Hyprland' } })).toBeNull()
  })

  it('check impossible, recognised desktop: none (Electron picks its own backend)', () => {
    for (const d of ['GNOME', 'ubuntu:GNOME', 'KDE', 'X-Cinnamon', 'XFCE', 'Pantheon', 'Unity', 'Deepin', 'UKUI']) {
      expect(choose({ run: broken, env: { ...bus, XDG_CURRENT_DESKTOP: d } }), d).toBeNull()
    }
    expect(RECOGNISED_DESKTOPS).toContain('gnome')
  })

  it('check impossible and no XDG_CURRENT_DESKTOP at all: counts as unrecognised', () => {
    expect(choose({ run: broken, env: { ...bus } })).toBe('gnome-libsecret')
  })

  it('an explicit --password-store wins, in both spellings', () => {
    const run = vi.fn(owner(true))
    expect(choose({ argv: ['app', '--password-store=basic'], run })).toBeNull()
    expect(choose({ argv: ['app', '--password-store', 'kwallet6'], run })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('not Linux: none, and the bus is never asked', () => {
    const run = vi.fn(owner(true))
    expect(choose({ platform: 'darwin', run })).toBeNull()
    expect(choose({ platform: 'win32', run })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('a test run with fake secrets: none; a packaged app ignores the fake variables and still checks', () => {
    const env = { ...bus, CC_COCKPIT_FAKE_SECRETS: '1', CC_COCKPIT_TEST: '1' }
    expect(choose({ env, isPackaged: false })).toBeNull()
    expect(choose({ env, isPackaged: true })).toBe('gnome-libsecret')
    expect(
      choose({
        env: { ...bus, CC_COCKPIT_FAKE_SECRETS: '1' },
        isPackaged: false
      })
    ).toBe('gnome-libsecret')
  })

  it('execRunner throws for a missing binary instead of returning', () => {
    expect(() => execRunner(['cc-cockpit-no-such-binary-xyz'])).toThrow()
  })
})
