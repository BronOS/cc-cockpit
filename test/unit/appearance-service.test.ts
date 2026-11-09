// Task 33: "Appearance and keys" in main: the theme pick and the keybinding overrides, over the
// real ThemeService and CommandRegistry (their rules are what the page reports) with the stored
// values in plain variables.
import { describe, expect, it } from 'vitest'
import { CommandRegistry } from '../../src/main/commands/command-registry'
import {
  AppearanceService,
  claudeTabOnOpenOf,
  confirmTabCloseOf,
  notificationSoundsOf,
  sessionGistOf,
  statusLineUsageOf,
  tabCloseSideOf
} from '../../src/main/settings/appearance-service'
import { ThemeService } from '../../src/main/themes/theme-service'
import { minTerminalWidthOf, zoneAutoHideOf } from '../../src/shared/zone-auto-hide'
import { DEFAULT_TERMINAL_FONT, LEGACY_DEFAULT_FAMILY } from '../../src/shared/terminal-font'

const P = 'aaaaaaaaaaaaaaaa'

function rig(initialOverrides: unknown = {}) {
  const store: { theme?: string } = {}
  const saved: Record<string, string>[] = []
  const state = {
    overrides: initialOverrides,
    dark: false,
    keysChanged: 0,
    tabExit: undefined as unknown,
    claudeTabOnOpen: undefined as unknown,
    sessionGist: undefined as unknown,
    discussPrompt: undefined as unknown,
    sessionGistChanged: 0,
    statusLineUsage: undefined as unknown,
    statusLineUsageChanged: 0,
    notificationSounds: undefined as unknown,
    notificationSound: undefined as unknown,
    /** The system sound ids a fresh listing would hold now. */
    systemSounds: new Set<string>(),
    confirmTabClose: undefined as unknown,
    tabCloseSide: undefined as unknown,
    zoneAutoHide: undefined as unknown,
    minTerminalWidth: undefined as unknown,
    terminalFont: undefined as unknown,
    prefsChanged: 0,
    tabCommands: undefined as unknown,
    windowBackground: undefined as unknown,
    blurChanged: [] as boolean[]
  }
  const themes = new ThemeService({
    settings: { data: store, save: () => {} },
    isDark: () => state.dark,
    onChange: () => {}
  })
  const commands = new CommandRegistry('darwin', () => (state.overrides ?? {}) as Record<string, string>)
  const service = new AppearanceService({
    themes,
    commands,
    platform: 'darwin',
    overrides: {
      get: () => state.overrides,
      set: (next) => {
        state.overrides = next
        saved.push(next)
      }
    },
    keysChanged: () => {
      state.keysChanged++
    },
    tabExit: {
      get: () => state.tabExit,
      set: (next) => {
        state.tabExit = next
      }
    },
    claudeTabOnOpen: {
      get: () => state.claudeTabOnOpen,
      set: (next) => {
        state.claudeTabOnOpen = next
      }
    },
    sessionGist: {
      get: () => state.sessionGist,
      set: (next) => {
        state.sessionGist = next
      }
    },
    discussPrompt: {
      get: () => state.discussPrompt,
      set: (next) => {
        state.discussPrompt = next
      }
    },
    sessionGistChanged: () => {
      state.sessionGistChanged++
    },
    statusLineUsage: {
      get: () => state.statusLineUsage,
      set: (next) => {
        state.statusLineUsage = next
      }
    },
    statusLineUsageChanged: () => {
      state.statusLineUsageChanged++
    },
    notificationSounds: {
      get: () => state.notificationSounds,
      set: (next) => {
        state.notificationSounds = next
      }
    },
    notificationSound: {
      get: () => state.notificationSound,
      set: (next) => {
        state.notificationSound = next
      },
      systemHas: async (id) => state.systemSounds.has(id)
    },
    confirmTabClose: {
      get: () => state.confirmTabClose,
      set: (next) => {
        state.confirmTabClose = next
      }
    },
    zoneAutoHide: {
      get: () => state.zoneAutoHide,
      set: (next) => {
        state.zoneAutoHide = next
      }
    },
    minTerminalWidth: {
      get: () => state.minTerminalWidth,
      set: (next) => {
        state.minTerminalWidth = next
      }
    },
    tabCloseSide: {
      get: () => state.tabCloseSide,
      set: (next) => {
        state.tabCloseSide = next
      }
    },
    terminalFont: {
      get: () => state.terminalFont,
      set: (next) => {
        state.terminalFont = next
      }
    },
    prefsChanged: () => {
      state.prefsChanged++
    },
    tabCommands: { get: () => state.tabCommands },
    windowBackground: {
      get: () => state.windowBackground,
      set: (next) => {
        state.windowBackground = next
      }
    },
    blurSupport: 'vibrancy',
    blurChanged: (on) => {
      state.blurChanged.push(on)
    }
  })
  return { service, themes, commands, state, saved }
}

const row = (r: ReturnType<typeof rig>, id: string) => r.service.view(P).keys.find((k) => k.id === id)!

describe('theme', () => {
  it('lists the themes, the pick (none = follow the OS) and the one showing', () => {
    const r = rig()
    const view = r.service.view(P)
    expect(view.themes.map((t) => t.id)).toEqual(['light', 'dark'])
    expect(view.selected).toBeNull()
    expect(view.current).toBe('light')
    r.state.dark = true
    expect(r.service.view(P).current).toBe('dark')
  })

  it('picks a theme and goes back to following the OS with null', () => {
    const r = rig()
    r.service.setTheme('dark')
    expect(r.service.view(P)).toMatchObject({ selected: 'dark', current: 'dark' })
    r.service.setTheme(null)
    expect(r.service.view(P)).toMatchObject({ selected: null, current: 'light' })
  })

  it('offers a theme a plugin registered and refuses an unknown id', () => {
    const r = rig()
    r.themes.register({ id: 'test.dusk', name: 'Dusk', kind: 'dark', vars: { '--cc-bg': '#112233' }, xterm: {} })
    expect(r.service.view(P).themes.map((t) => t.id)).toContain('test.dusk')
    r.service.setTheme('test.dusk')
    expect(r.service.view(P).current).toBe('test.dusk')
    expect(() => r.service.setTheme('no.such')).toThrow('unknown theme')
    expect(() => r.service.setTheme(5)).toThrow('give a theme id')
  })
})

describe('keys: the list', () => {
  it('has a row per command with its default chord and no override', () => {
    const r = rig()
    expect(row(r, 'tab.newShell')).toMatchObject({
      title: 'New Shell Tab',
      source: 'core',
      defaultKey: 'shift+meta+t',
      key: 'shift+meta+t',
      overridden: false,
      conflictsWith: [],
      inactive: false
    })
  })

  it('lists plugin commands of the asking project with their manifest keys', () => {
    const r = rig()
    r.commands.registerPlugin(P, 'jira', [{ id: 'refresh', title: 'Jira: Refresh', key: 'Cmd+Shift+J' }])
    expect(row(r, 'jira/refresh')).toMatchObject({ source: 'plugin', key: 'shift+meta+j' })
    expect(r.commands.bindings('other').some((k) => k.id === 'jira/refresh')).toBe(false)
  })

  it('warns about a plugin chord that clashes with a core command: the core one keeps it', () => {
    const r = rig()
    r.commands.registerPlugin(P, 'jira', [{ id: 'new', title: 'Jira: New', key: 'Cmd+T' }])
    expect(row(r, 'jira/new')).toMatchObject({ key: 'meta+t', conflictsWith: ['New Claude Tab'], inactive: true })
    expect(row(r, 'tab.newClaude')).toMatchObject({ conflictsWith: ['Jira: New'], inactive: false })
  })
})

describe('keys: setKey', () => {
  it('stores the canonical chord, marks the row, and tells the windows', () => {
    const r = rig()
    r.service.setKey(P, 'tab.newShell', 'Cmd+Shift+Y')
    expect(r.saved.at(-1)).toEqual({ 'tab.newShell': 'shift+meta+y' })
    expect(r.state.keysChanged).toBe(1)
    expect(row(r, 'tab.newShell')).toMatchObject({ key: 'shift+meta+y', overridden: true })
  })

  it('drops an override that equals the default, and null goes back to the default', () => {
    const r = rig({ 'tab.newShell': 'meta+y' })
    r.service.setKey(P, 'tab.newShell', 'Cmd+Shift+T')
    expect(r.saved.at(-1)).toEqual({})
    r.service.setKey(P, 'tab.newShell', 'Cmd+Y')
    r.service.setKey(P, 'tab.newShell', null)
    expect(r.saved.at(-1)).toEqual({})
    expect(row(r, 'tab.newShell')).toMatchObject({ key: 'shift+meta+t', overridden: false })
  })

  it('unbinds with an empty string', () => {
    const r = rig()
    r.service.setKey(P, 'tab.newShell', '')
    expect(r.saved.at(-1)).toEqual({ 'tab.newShell': '' })
    const unbound = row(r, 'tab.newShell')
    expect(unbound.key).toBeUndefined()
    expect(unbound.overridden).toBe(true)
  })

  it('allows a conflict and reports it on both rows; the user override wins the chord', () => {
    const r = rig()
    r.service.setKey(P, 'tab.newShell', 'Cmd+W')
    expect(row(r, 'tab.newShell')).toMatchObject({ key: 'meta+w', conflictsWith: ['Close Tab'], inactive: false })
    expect(row(r, 'tab.close')).toMatchObject({ key: 'meta+w', conflictsWith: ['New Shell Tab'], inactive: true })
  })

  it('binds nobody when two user overrides claim the same chord', () => {
    const r = rig()
    r.service.setKey(P, 'tab.newShell', 'Cmd+Y')
    r.service.setKey(P, 'tab.close', 'Cmd+Y')
    expect(row(r, 'tab.newShell')).toMatchObject({ conflictsWith: ['Close Tab'], inactive: true })
    expect(row(r, 'tab.close')).toMatchObject({ conflictsWith: ['New Shell Tab'], inactive: true })
  })

  it('refuses a chord that is none (no modifier, nonsense), and says so', () => {
    const r = rig()
    expect(() => r.service.setKey(P, 'tab.newShell', 'k')).toThrow('not a key combination')
    expect(() => r.service.setKey(P, 'tab.newShell', 'Cmd+Banana')).toThrow('not a key combination')
    expect(r.saved).toEqual([])
    expect(r.state.keysChanged).toBe(0)
  })

  it('refuses Shift as the only modifier on a typing key (uppercase K, Shift+Enter, Shift+Tab)', () => {
    const r = rig()
    for (const chord of ['Shift+K', 'shift+1', 'Shift+Enter', 'Shift+Tab']) {
      expect(() => r.service.setKey(P, 'tab.newShell', chord), chord).toThrow('other than Shift')
    }
    expect(r.saved).toEqual([])
  })

  it("refuses the terminal's signal keys", () => {
    const r = rig()
    expect(() => r.service.setKey(P, 'tab.newShell', 'Ctrl+C')).toThrow("terminal's interrupt key")
    expect(() => r.service.setKey(P, 'tab.newShell', 'Ctrl+D')).toThrow('end of input')
    expect(() => r.service.setKey(P, 'tab.newShell', 'Ctrl+Z')).toThrow('suspend')
    expect(r.saved).toEqual([])
    r.service.setKey(P, 'tab.newShell', 'Ctrl+Shift+C')
    expect(r.saved.at(-1)).toEqual({ 'tab.newShell': 'ctrl+shift+c' })
  })

  it('keeps an override equal to the default when it is what makes the command win that chord', () => {
    const r = rig()
    r.commands.registerPlugin(P, 'jira', [{ id: 'new', title: 'Jira: New', key: 'Cmd+T' }])
    expect(row(r, 'jira/new').inactive).toBe(true)
    r.service.setKey(P, 'jira/new', 'Cmd+T')
    expect(r.saved.at(-1)).toEqual({ 'jira/new': 'meta+t' })
    expect(row(r, 'jira/new')).toMatchObject({ key: 'meta+t', overridden: true, inactive: false })
    expect(row(r, 'tab.newClaude').inactive).toBe(true)
  })

  it('does not keep an override equal to the default when it would only turn a loss into a tie', () => {
    const r = rig({ 'tab.newShell': 'meta+t' })
    r.service.setKey(P, 'tab.newClaude', 'Cmd+T')
    expect(r.saved.at(-1)).toEqual({ 'tab.newShell': 'meta+t' })
  })

  it('refuses a change that leaves no key into the settings screen (Open Settings or the palette)', () => {
    const r = rig()
    r.service.setKey(P, 'app.openSettings', '')
    expect(() => r.service.setKey(P, 'palette.open', '')).toThrow('no key for Open Settings')
    // A tie binds nobody: moving the palette onto a chord the other way in also holds is refused.
    r.service.setKey(P, 'app.openSettings', 'Cmd+Y')
    expect(() => r.service.setKey(P, 'palette.open', 'Cmd+Y')).toThrow('no key for Open Settings')
    expect(r.saved.at(-1)).toEqual({ 'app.openSettings': 'meta+y' })
  })

  it('still lets the two ways in swap chords through a conflict', () => {
    const r = rig()
    r.service.setKey(P, 'app.openSettings', 'Cmd+Shift+P')
    r.service.setKey(P, 'palette.open', 'Cmd+,')
    expect(row(r, 'app.openSettings')).toMatchObject({ key: 'shift+meta+p', inactive: false })
    expect(row(r, 'palette.open')).toMatchObject({ key: 'meta+,', inactive: false })
  })

  it('refuses a command this project does not have, and payloads of the wrong shape', () => {
    const r = rig()
    expect(() => r.service.setKey(P, 'no.such', 'Cmd+Y')).toThrow('unknown command')
    expect(() => r.service.setKey(P, 'jira/refresh', 'Cmd+Y')).toThrow('unknown command')
    expect(() => r.service.setKey(P, 7, 'Cmd+Y')).toThrow('unknown command')
    expect(() => r.service.setKey(P, 'tab.newShell', 7)).toThrow('give a key combination')
  })

  it('accepts a plugin command that is registered for the project', () => {
    const r = rig()
    r.commands.registerPlugin(P, 'jira', [{ id: 'refresh', title: 'Jira: Refresh' }])
    r.service.setKey(P, 'jira/refresh', 'Cmd+Shift+J')
    expect(r.saved.at(-1)).toEqual({ 'jira/refresh': 'shift+meta+j' })
  })

  it('keeps the other overrides and drops damaged entries of the stored object', () => {
    const r = rig({ 'tab.close': 'Cmd+Q', junk: 5 })
    r.service.setKey(P, 'tab.newShell', 'Cmd+Y')
    expect(r.saved.at(-1)).toEqual({ 'tab.close': 'Cmd+Q', 'tab.newShell': 'meta+y' })
  })

  it('starts from nothing when the stored overrides are not an object', () => {
    const r = rig(['x'])
    r.service.setKey(P, 'tab.newShell', 'Cmd+Y')
    expect(r.saved.at(-1)).toEqual({ 'tab.newShell': 'meta+y' })
  })
})

describe('tab exit', () => {
  it('closes on a clean exit by default, and reads anything but keep as that', () => {
    const r = rig()
    expect(r.service.view(P).tabExit).toBe('close-clean')
    // app.json is user-writable: a damaged value falls back to the default, never to keep.
    r.state.tabExit = 'KEEP'
    expect(r.service.view(P).tabExit).toBe('close-clean')
  })

  it('stores keep and close-clean, and refuses anything else', () => {
    const r = rig()
    r.service.setTabExit('keep')
    expect(r.state.tabExit).toBe('keep')
    expect(r.service.view(P).tabExit).toBe('keep')
    r.service.setTabExit('close-clean')
    expect(r.service.view(P).tabExit).toBe('close-clean')
    expect(() => r.service.setTabExit('close')).toThrow("give 'close-clean' or 'keep'")
    expect(() => r.service.setTabExit(true)).toThrow("give 'close-clean' or 'keep'")
    expect(r.state.tabExit).toBe('close-clean')
  })
})

describe('Claude tab on open', () => {
  it('is on by default, and only an explicit false turns it off', () => {
    const r = rig()
    expect(r.service.view(P).claudeTabOnOpen).toBe(true)
    // app.json is user-writable: a damaged value reads as the default, never as off.
    for (const damaged of ['false', 0, null]) {
      r.state.claudeTabOnOpen = damaged
      expect(r.service.view(P).claudeTabOnOpen).toBe(true)
    }
    r.state.claudeTabOnOpen = false
    expect(r.service.view(P).claudeTabOnOpen).toBe(false)
    expect(claudeTabOnOpenOf(undefined)).toBe(true)
  })

  it('stores true and false, and refuses anything else', () => {
    const r = rig()
    r.service.setClaudeTabOnOpen(false)
    expect(r.state.claudeTabOnOpen).toBe(false)
    expect(r.service.view(P).claudeTabOnOpen).toBe(false)
    r.service.setClaudeTabOnOpen(true)
    expect(r.service.view(P).claudeTabOnOpen).toBe(true)
    expect(() => r.service.setClaudeTabOnOpen('false')).toThrow('give true or false')
    expect(() => r.service.setClaudeTabOnOpen(0)).toThrow('give true or false')
    expect(r.state.claudeTabOnOpen).toBe(true)
  })
})

describe('session gist', () => {
  it('is off by default, and only an explicit true turns it on', () => {
    const r = rig()
    expect(r.service.view(P).sessionGist).toBe(false)
    // app.json is user-writable: a damaged value must not start spending the person's usage.
    for (const damaged of ['true', 1, {}, null]) {
      r.state.sessionGist = damaged
      expect(r.service.view(P).sessionGist).toBe(false)
    }
    r.state.sessionGist = true
    expect(r.service.view(P).sessionGist).toBe(true)
    expect(sessionGistOf(undefined)).toBe(false)
  })

  it('stores true and false, tells the scheduler only on a real flip, and refuses anything else', () => {
    const r = rig()
    r.service.setSessionGist(true)
    expect(r.state.sessionGist).toBe(true)
    expect(r.state.sessionGistChanged).toBe(1)
    r.service.setSessionGist(true)
    expect(r.state.sessionGistChanged).toBe(1)
    r.service.setSessionGist(false)
    expect(r.service.view(P).sessionGist).toBe(false)
    expect(r.state.sessionGistChanged).toBe(2)
    expect(() => r.service.setSessionGist('true')).toThrow('give true or false')
    expect(r.state.sessionGistChanged).toBe(2)
  })
})

describe('rate limits from the status line', () => {
  it('is on by default, and only an explicit false turns it off', () => {
    const r = rig()
    expect(r.service.view(P).statusLineUsage).toBe(true)
    // A damaged value reads as the default: on changes nothing the person sees.
    for (const damaged of ['false', 0, {}, null]) {
      r.state.statusLineUsage = damaged
      expect(r.service.view(P).statusLineUsage).toBe(true)
    }
    r.state.statusLineUsage = false
    expect(r.service.view(P).statusLineUsage).toBe(false)
    expect(statusLineUsageOf(undefined)).toBe(true)
  })

  it('stores true and false, rewrites hooks.json only on a real flip, and refuses anything else', () => {
    const r = rig()
    r.service.setStatusLineUsage(true)
    expect(r.state.statusLineUsage).toBe(true)
    expect(r.state.statusLineUsageChanged).toBe(0)
    r.service.setStatusLineUsage(false)
    expect(r.state.statusLineUsage).toBe(false)
    expect(r.state.statusLineUsageChanged).toBe(1)
    r.service.setStatusLineUsage(false)
    expect(r.state.statusLineUsageChanged).toBe(1)
    r.service.setStatusLineUsage(true)
    expect(r.state.statusLineUsageChanged).toBe(2)
    expect(() => r.service.setStatusLineUsage('off')).toThrow('give true or false')
    expect(r.state.statusLineUsage).toBe(true)
    expect(r.state.statusLineUsageChanged).toBe(2)
  })
})

describe('notification sounds', () => {
  it('is on by default, and only an explicit false turns it off', () => {
    const r = rig()
    expect(r.service.view(P).notificationSounds).toBe(true)
    // app.json is user-writable: a damaged value reads as on, the default a plugin author expects.
    for (const damaged of ['false', 0, null, 'no']) expect(notificationSoundsOf(damaged)).toBe(true)
    r.state.notificationSounds = false
    expect(r.service.view(P).notificationSounds).toBe(false)
    expect(notificationSoundsOf(undefined)).toBe(true)
  })

  it('stores true and false, and refuses anything else', () => {
    const r = rig()
    r.service.setNotificationSounds(false)
    expect(r.state.notificationSounds).toBe(false)
    r.service.setNotificationSounds(true)
    expect(r.state.notificationSounds).toBe(true)
    expect(() => r.service.setNotificationSounds('false')).toThrow('give true or false')
    expect(() => r.service.setNotificationSounds(undefined)).toThrow('give true or false')
    expect(r.state.notificationSounds).toBe(true)
  })
})

describe('notification sound', () => {
  it('is the Chime by default, and a damaged or unknown value reads as the Chime', () => {
    const r = rig()
    expect(r.service.view(P).notificationSound).toBe('builtin:chime')
    for (const damaged of [42, null, '', 'builtin:siren', 'chime', '/usr/share/sounds/x.oga', 'system:x:a.oga', 'system:0:../a.oga']) {
      r.state.notificationSound = damaged
      expect(r.service.view(P).notificationSound).toBe('builtin:chime')
    }
    r.state.notificationSound = 'builtin:marimba'
    expect(r.service.view(P).notificationSound).toBe('builtin:marimba')
    // A system id is kept as stored, even when its file went away: Settings shows it as missing.
    r.state.notificationSound = 'system:1:gone.wav'
    expect(r.service.view(P).notificationSound).toBe('system:1:gone.wav')
  })

  it('stores a built-in or a system sound main lists now, and refuses anything else', async () => {
    const r = rig()
    await r.service.setNotificationSound('builtin:bell')
    expect(r.state.notificationSound).toBe('builtin:bell')
    r.state.systemSounds.add('system:0:freedesktop/stereo/bell.oga')
    await r.service.setNotificationSound('system:0:freedesktop/stereo/bell.oga')
    expect(r.state.notificationSound).toBe('system:0:freedesktop/stereo/bell.oga')
    await expect(r.service.setNotificationSound('system:0:not-listed.oga')).rejects.toThrow('no longer there')
    for (const bad of ['builtin:siren', '/etc/passwd', 'system:0:../../etc/passwd', 7, undefined]) {
      await expect(r.service.setNotificationSound(bad)).rejects.toThrow('not a notification sound')
    }
    expect(r.state.notificationSound).toBe('system:0:freedesktop/stereo/bell.oga')
  })
})

describe('ask before closing a running tab', () => {
  it('is on by default, and only an explicit false turns it off', () => {
    const r = rig()
    expect(r.service.view(P).confirmTabClose).toBe(true)
    expect(r.service.confirmTabClose()).toBe(true)
    // app.json is user-writable: a damaged value reads as on (one extra click, never a killed task).
    for (const damaged of ['false', 0, null, 'no']) {
      r.state.confirmTabClose = damaged
      expect(r.service.confirmTabClose()).toBe(true)
    }
    r.state.confirmTabClose = false
    expect(r.service.view(P).confirmTabClose).toBe(false)
    expect(r.service.confirmTabClose()).toBe(false)
    expect(confirmTabCloseOf(undefined)).toBe(true)
  })

  it('stores true and false, and refuses anything else', () => {
    const r = rig()
    r.service.setConfirmTabClose(false)
    expect(r.state.confirmTabClose).toBe(false)
    expect(r.service.confirmTabClose()).toBe(false)
    r.service.setConfirmTabClose(true)
    expect(r.service.confirmTabClose()).toBe(true)
    expect(() => r.service.setConfirmTabClose('false')).toThrow('give true or false')
    expect(() => r.service.setConfirmTabClose(undefined)).toThrow('give true or false')
    expect(r.state.confirmTabClose).toBe(true)
  })
})

describe('tab close button side', () => {
  it("is 'right' by default, and anything but 'left' reads as right", () => {
    const r = rig()
    expect(r.service.view(P).tabCloseSide).toBe('right')
    expect(r.service.prefs().tabCloseSide).toBe('right')
    // app.json is user-writable: a damaged value keeps the layout the app always had.
    for (const damaged of ['LEFT', 'start', 1, null, true, { side: 'left' }]) {
      r.state.tabCloseSide = damaged
      expect(r.service.prefs().tabCloseSide).toBe('right')
    }
    r.state.tabCloseSide = 'left'
    expect(r.service.view(P).tabCloseSide).toBe('left')
    expect(r.service.prefs().tabCloseSide).toBe('left')
    expect(tabCloseSideOf(undefined)).toBe('right')
  })

  it('stores left and right and tells every window; refuses anything else without telling anyone', () => {
    const r = rig()
    r.service.setTabCloseSide('left')
    expect(r.state.tabCloseSide).toBe('left')
    expect(r.state.prefsChanged).toBe(1)
    r.service.setTabCloseSide('right')
    expect(r.service.prefs().tabCloseSide).toBe('right')
    expect(r.state.prefsChanged).toBe(2)
    for (const bad of ['Left', '', undefined, null, 0, ['left']]) {
      expect(() => r.service.setTabCloseSide(bad)).toThrow("give 'left' or 'right'")
    }
    expect(r.state.tabCloseSide).toBe('right')
    expect(r.state.prefsChanged).toBe(2)
  })
})

describe('terminal font', () => {
  it('shows and pushes the defaults until something is stored', () => {
    const r = rig()
    expect(r.service.view(P).terminalFont).toEqual(DEFAULT_TERMINAL_FONT)
    expect(r.service.prefs().terminalFont).toEqual(DEFAULT_TERMINAL_FONT)
  })

  it('merges a change into the fields set before, stores only set fields, and tells every window', () => {
    const r = rig()
    // A damaged stored field is dropped, not kept next to the fresh ones.
    r.state.terminalFont = { size: 'huge', lineHeight: 1.2 }
    r.service.setTerminalFont({ size: 16, family: '  "MesloLGS NF", monospace ' })
    expect(r.state.terminalFont).toEqual({ lineHeight: 1.2, size: 16, family: '"MesloLGS NF", monospace' })
    expect(r.state.prefsChanged).toBe(1)
    r.service.setTerminalFont({ weight: '300' })
    expect(r.service.prefs().terminalFont).toEqual({
      ...DEFAULT_TERMINAL_FONT,
      lineHeight: 1.2,
      size: 16,
      weight: '300',
      family: '"MesloLGS NF", monospace'
    })
    expect(r.state.prefsChanged).toBe(2)
  })

  it('a size change leaves the family unset, so it follows the default (the bundled font)', () => {
    const r = rig()
    r.service.setTerminalFont({ size: 18 })
    expect(r.state.terminalFont).toEqual({ size: 18 })
    expect(r.service.prefs().terminalFont.family).toBe(DEFAULT_TERMINAL_FONT.family)
    // The old setter's whole-font copy of the pre-bundling default is dropped on the next change.
    r.state.terminalFont = { ...DEFAULT_TERMINAL_FONT, family: LEGACY_DEFAULT_FAMILY }
    r.service.setTerminalFont({ size: 14 })
    expect(r.state.terminalFont).not.toHaveProperty('family')
  })

  it('refuses a bad change whole, without storing or telling anyone', () => {
    const r = rig()
    r.service.setTerminalFont({ size: 20 })
    expect(() => r.service.setTerminalFont({ family: 'Menlo', size: 200 })).toThrow('from 6 to 72')
    expect(() => r.service.setTerminalFont(undefined)).toThrow('or null for the defaults')
    expect(r.state.terminalFont).toEqual({ size: 20 })
    expect(r.state.prefsChanged).toBe(1)
  })

  it('null goes back to the defaults by removing the stored font', () => {
    const r = rig()
    r.service.setTerminalFont({ size: 20 })
    r.service.setTerminalFont(null)
    expect(r.state.terminalFont).toBeUndefined()
    expect(r.service.prefs().terminalFont).toEqual(DEFAULT_TERMINAL_FONT)
    expect(r.state.prefsChanged).toBe(2)
  })
})

describe('new-tab menu commands', () => {
  it('shows the stored app-wide entries, a damaged file costing only its bad entries', () => {
    const r = rig()
    expect(r.service.view(P).tabCommands).toEqual([])
    r.state.tabCommands = [{ id: 'a', label: 'Git', command: 'lazygit' }, { id: 'b', label: '', command: 'x' }, 'junk']
    expect(r.service.view(P).tabCommands).toEqual([{ id: 'a', label: 'Git', command: 'lazygit' }])
    r.state.tabCommands = { not: 'a list' }
    expect(r.service.view(P).tabCommands).toEqual([])
  })
})

describe('window background', () => {
  it('reads as opaque, 80 % and not blurred by default, with the platform blur and the opacity in the prefs', () => {
    const r = rig()
    expect(r.service.view(P).windowBackground).toEqual({ transparent: false, opacity: 80, blur: false, area: 'window' })
    expect(r.service.view(P).blurSupport).toBe('vibrancy')
    expect(r.service.prefs().backgroundOpacity).toBe(80)
  })

  it('reads each damaged stored field as its own default (app.json is user-writable)', () => {
    const r = rig()
    r.state.windowBackground = { transparent: 'yes', opacity: 120, blur: false }
    expect(r.service.windowBackground()).toEqual({ transparent: false, opacity: 80, blur: false, area: 'window' })
    // A fraction (someone wrote 0.6 for 60 %) is damaged too, not rounded into range.
    r.state.windowBackground = { transparent: true, opacity: 0.6 }
    expect(r.service.windowBackground()).toEqual({ transparent: true, opacity: 80, blur: false, area: 'window' })
    r.state.windowBackground = [1, 2]
    expect(r.service.windowBackground()).toEqual({ transparent: false, opacity: 80, blur: false, area: 'window' })
    r.state.windowBackground = { opacity: 40 }
    expect(r.service.prefs().backgroundOpacity).toBe(40)
    expect(r.service.prefs().seeThroughArea).toBe('window')
    r.state.windowBackground = { area: 'panels' }
    expect(r.service.windowBackground().area).toBe('window')
    r.state.windowBackground = { area: 'main' }
    expect(r.service.prefs().seeThroughArea).toBe('main')
  })

  it('stores a change merged into the good stored fields, dropping damaged ones', () => {
    const r = rig()
    r.state.windowBackground = { opacity: 60, blur: 'off' }
    r.service.setWindowBackground({ transparent: true })
    expect(r.state.windowBackground).toEqual({ opacity: 60, transparent: true })
    r.service.setWindowBackground({ opacity: 100, blur: false })
    expect(r.state.windowBackground).toEqual({ opacity: 100, transparent: true, blur: false })
  })

  it('pushes the prefs only when the opacity changes, and the blur only when it changes', () => {
    const r = rig()
    // The switch reaches nothing open: Electron cannot make a live window transparent.
    r.service.setWindowBackground({ transparent: true })
    expect(r.state.prefsChanged).toBe(0)
    expect(r.state.blurChanged).toEqual([])
    r.service.setWindowBackground({ opacity: 60 })
    r.service.setWindowBackground({ opacity: 60 })
    expect(r.state.prefsChanged).toBe(1)
    expect(r.service.prefs().backgroundOpacity).toBe(60)
    // Off is the default, so storing off is no change.
    r.service.setWindowBackground({ blur: false })
    expect(r.state.blurChanged).toEqual([])
    r.service.setWindowBackground({ blur: true })
    r.service.setWindowBackground({ blur: false, opacity: 70 })
    expect(r.state.blurChanged).toEqual([true, false])
    expect(r.state.prefsChanged).toBe(2)
    // The area is live too: it travels in the prefs, and only a real change is pushed.
    r.service.setWindowBackground({ area: 'window' })
    expect(r.state.prefsChanged).toBe(2)
    r.service.setWindowBackground({ area: 'main' })
    expect(r.state.prefsChanged).toBe(3)
    expect(r.service.prefs().seeThroughArea).toBe('main')
    expect(r.state.blurChanged).toEqual([true, false])
  })

  it('refuses a bad change whole, without storing or telling anyone', () => {
    const r = rig()
    r.service.setWindowBackground({ opacity: 50 })
    for (const bad of [
      { opacity: 39 },
      { opacity: 101 },
      { opacity: 72.5 },
      { opacity: '80' },
      { transparent: 1 },
      { blur: 'yes' },
      { area: 'panels' },
      { area: true },
      { transparent: true, opacity: 10 },
      { tint: true },
      null,
      'x',
      [true]
    ]) {
      expect(() => r.service.setWindowBackground(bad), JSON.stringify(bad)).toThrow()
    }
    expect(() => r.service.setWindowBackground({ opacity: 30 })).toThrow('from 40 to 100')
    expect(() => r.service.setWindowBackground({ tint: true })).toThrow('unknown window background field: tint')
    expect(r.state.windowBackground).toEqual({ opacity: 50 })
    expect(r.state.prefsChanged).toBe(1)
    expect(r.state.blurChanged).toEqual([])
  })
})

describe('side zone auto-hide', () => {
  it('is on with a 720 px minimum by default; a damaged value reads as the default', () => {
    const r = rig()
    expect(r.service.view(P)).toMatchObject({ zoneAutoHide: true, minTerminalWidth: 720 })
    expect(r.service.prefs()).toMatchObject({ zoneAutoHide: true, minTerminalWidth: 720 })
    // app.json is user-writable: only an explicit false turns it off, and a damaged width never
    // reads as "hide at any width" (0) or as a string.
    for (const damaged of ['false', 0, null, 'no']) {
      r.state.zoneAutoHide = damaged
      expect(r.service.prefs().zoneAutoHide).toBe(true)
    }
    for (const damaged of ['800', 0, 399, 2001, 720.5, null, true, NaN]) {
      r.state.minTerminalWidth = damaged
      expect(r.service.prefs().minTerminalWidth).toBe(720)
    }
    r.state.zoneAutoHide = false
    r.state.minTerminalWidth = 400
    expect(r.service.view(P)).toMatchObject({ zoneAutoHide: false, minTerminalWidth: 400 })
    expect(r.service.prefs()).toMatchObject({ zoneAutoHide: false, minTerminalWidth: 400 })
    expect(zoneAutoHideOf(undefined)).toBe(true)
    expect(minTerminalWidthOf(2000)).toBe(2000)
  })

  it('stores a boolean and a whole width in range and tells every window; refuses the rest without telling anyone', () => {
    const r = rig()
    r.service.setZoneAutoHide(false)
    expect(r.state.zoneAutoHide).toBe(false)
    r.service.setMinTerminalWidth(960)
    expect(r.state.minTerminalWidth).toBe(960)
    expect(r.state.prefsChanged).toBe(2)
    for (const bad of ['true', 1, undefined, null]) {
      expect(() => r.service.setZoneAutoHide(bad)).toThrow('give true or false')
    }
    for (const bad of [399, 2001, 720.5, '800', undefined, null, NaN]) {
      expect(() => r.service.setMinTerminalWidth(bad)).toThrow('give a whole number from 400 to 2000')
    }
    expect(r.state.zoneAutoHide).toBe(false)
    expect(r.state.minTerminalWidth).toBe(960)
    expect(r.state.prefsChanged).toBe(2)
  })
})
