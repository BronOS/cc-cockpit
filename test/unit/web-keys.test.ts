// The web shell's key table (design-web.md §5.2 "Keys", plan Task 16): chords a browser keeps for
// itself move to their Alt alternative, per the browser's platform; nothing else changes.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chordOf, commandForEvent, registerHandlers, resetKeybindings, setCommands } from '../../src/renderer/commands/keybindings'
import { browserKeeps, webKeyTable, withAlt } from '../../src/renderer/commands/web-keys'
import { holdsPage, isOwnView, markWebShell, resetShellKindForTest, setOwnView } from '../../src/renderer/shell-kind'
import type { CommandsView } from '../../src/shared/ipc'

afterEach(() => {
  vi.unstubAllGlobals()
  resetShellKindForTest()
  resetKeybindings()
})

const view = (keys: Record<string, string | undefined>): CommandsView => ({
  commands: Object.entries(keys).map(([id, key]) => ({ id, title: id, source: 'core' as const, ...(key ? { key } : {}) })),
  conflicts: []
})

const keysOf = (v: CommandsView): Record<string, string | undefined> => Object.fromEntries(v.commands.map((c) => [c.id, c.key]))

describe('browserKeeps', () => {
  it('Ctrl+W, T, N (and with Shift) and Ctrl+Tab elsewhere; Cmd+W, T, N and Ctrl+Tab on a Mac', () => {
    for (const c of ['ctrl+w', 'ctrl+t', 'ctrl+n', 'ctrl+shift+t', 'ctrl+shift+w', 'ctrl+shift+n', 'ctrl+tab', 'ctrl+shift+tab']) {
      expect(browserKeeps(c, false), c).toBe(true)
    }
    for (const c of ['meta+w', 'meta+t', 'meta+n', 'meta+shift+t', 'ctrl+tab', 'ctrl+shift+tab']) {
      expect(browserKeeps(c, true), c).toBe(true)
    }
    // Free in that browser: another platform's command key, other letters, Alt already added, junk.
    for (const c of ['meta+w', 'ctrl+b', 'ctrl+alt+w', 'ctrl+alt+tab', 'meta+tab', 'escape', 'ctrl+shift+p', '', '+']) {
      expect(browserKeeps(c, false), c).toBe(false)
    }
    for (const c of ['ctrl+w', 'ctrl+t', 'alt+meta+t', 'meta+b']) expect(browserKeeps(c, true), c).toBe(false)
  })

  it('withAlt keeps the canonical modifier order', () => {
    expect(withAlt('ctrl+shift+w')).toBe('ctrl+alt+shift+w')
    expect(withAlt('meta+t')).toBe('alt+meta+t')
    expect(withAlt('ctrl+tab')).toBe('ctrl+alt+tab')
    expect(withAlt('ctrl+alt+w')).toBe('ctrl+alt+w')
  })
})

describe('webKeyTable', () => {
  const host = view({
    'tab.newClaude': 'ctrl+t',
    'tab.newShell': 'ctrl+shift+t',
    'tab.close': 'ctrl+w',
    'overlay.closeTop': 'ctrl+shift+w',
    'tab.switchNext': 'ctrl+tab',
    'tab.switchPrev': 'ctrl+shift+tab',
    'zone.toggleLeft': 'ctrl+b',
    'palette.open': undefined
  })

  it('moves the kept chords to Alt and leaves the rest (a Linux or Windows browser)', () => {
    expect(keysOf(webKeyTable(host, false))).toEqual({
      'tab.newClaude': 'ctrl+alt+t',
      'tab.newShell': 'ctrl+alt+shift+t',
      'tab.close': 'ctrl+alt+w',
      'overlay.closeTop': 'ctrl+alt+shift+w',
      'tab.switchNext': 'ctrl+alt+tab',
      'tab.switchPrev': 'ctrl+alt+shift+tab',
      'zone.toggleLeft': 'ctrl+b',
      'palette.open': undefined
    })
    // The table main sent is not changed.
    expect(host.commands[0]!.key).toBe('ctrl+t')
  })

  it("a Mac browser keeps a Linux host's Ctrl+T and Ctrl+W free, but not Ctrl+Tab; a Mac host's Cmd chords move", () => {
    expect(keysOf(webKeyTable(host, true))).toMatchObject({ 'tab.newClaude': 'ctrl+t', 'tab.close': 'ctrl+w', 'tab.switchNext': 'ctrl+alt+tab' })
    expect(keysOf(webKeyTable(view({ 'tab.close': 'meta+w', 'tab.newClaude': 'meta+t' }), true))).toEqual({
      'tab.close': 'alt+meta+w',
      'tab.newClaude': 'alt+meta+t'
    })
  })

  it('an alternative another command already has is not stolen: the command keeps no chord', () => {
    const v = webKeyTable(view({ 'tab.close': 'ctrl+w', 'my.plugin/close': 'ctrl+alt+w', 'tab.newClaude': 'ctrl+t' }), false)
    expect(keysOf(v)).toEqual({ 'tab.close': undefined, 'my.plugin/close': 'ctrl+alt+w', 'tab.newClaude': 'ctrl+alt+t' })
  })
})

describe('setCommands in the web shell', () => {
  it('the desktop table is used as it is; the web shell answers the Alt chord and shows it', () => {
    // A Linux browser: Node on a Mac has a navigator whose platform says Mac, which keeps Ctrl+W free.
    vi.stubGlobal('navigator', { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    registerHandlers({ 'tab.close': () => undefined })
    const ev = { key: 'w', code: 'KeyW', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }
    setCommands(view({ 'tab.close': 'ctrl+w' }))
    expect(commandForEvent(ev)).toBe('tab.close')
    markWebShell()
    setCommands(view({ 'tab.close': 'ctrl+w' }))
    expect(chordOf('tab.close')).toBe('ctrl+alt+w')
    expect(commandForEvent(ev)).toBeUndefined()
    expect(commandForEvent({ ...ev, altKey: true })).toBe('tab.close')
  })
})

describe('setCommands in a remote desktop window', () => {
  const ev = { key: 'w', code: 'KeyW', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }
  const run = (userAgent: string): void => {
    vi.stubGlobal('navigator', { userAgent, platform: 'Linux x86_64' })
    registerHandlers({ 'tab.close': () => undefined })
    markWebShell()
    setCommands(view({ 'tab.close': 'ctrl+w' }))
  }

  it('the web shell with the desktop agent keeps the desktop table', () => {
    run('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 cc-cockpit-desktop/0.17.0 (laptop)')
    expect(chordOf('tab.close')).toBe('ctrl+w')
    expect(commandForEvent(ev)).toBe('tab.close')
  })

  it('a web shell in an ordinary browser still moves the chords', () => {
    run('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36')
    expect(chordOf('tab.close')).toBe('ctrl+alt+w')
    expect(commandForEvent(ev)).toBeUndefined()
  })

  it('a malformed agent counts as a browser', () => {
    run('Chrome/130.0 cc-cockpit-desktop/0.17.0')
    expect(chordOf('tab.close')).toBe('ctrl+alt+w')
  })
})

describe('isOwnView', () => {
  it("the desktop page is any desktop view, never a browser's; a web page only the view main named", () => {
    expect(isOwnView('desktop:3')).toBe(true)
    expect(isOwnView('web:1')).toBe(false)
    markWebShell()
    expect(isOwnView('web:1')).toBe(false)
    setOwnView('web:1')
    expect(isOwnView('web:1')).toBe(true)
    expect(isOwnView('web:2')).toBe(false)
    expect(isOwnView('desktop:3')).toBe(false)
  })
})

describe('holdsPage (an html overlay held by one view, design-web.md §5.4)', () => {
  it('no heldBy is the desktop view: the desktop page holds it, a browser does not', () => {
    expect(holdsPage(undefined)).toBe(true)
    expect(holdsPage({ viewId: 'web:1' })).toBe(false)
    markWebShell()
    setOwnView('web:1')
    expect(holdsPage(undefined)).toBe(false)
    expect(holdsPage({ viewId: 'web:1' })).toBe(true)
    expect(holdsPage({ viewId: 'web:2' })).toBe(false)
  })
})
