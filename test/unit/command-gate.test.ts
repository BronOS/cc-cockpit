// The shell's command gate: what a bound command may do while a dialog, the palette, an overlay or
// the settings screen is up. It also gates `commands.trigger` (chords main forwards from a webview
// panel's page), so a web page can do no more than the same key typed into the shell.
import { describe, expect, it } from 'vitest'
import { commandAllowed, guestMayRun, type ModalState } from '../../src/renderer/commands/command-gate'
import { GUEST_SAFE_COMMANDS } from '../../src/shared/guest-class'

const idle: ModalState = { confirming: false, paletteOpen: false, overlayOpen: false, settingsShown: false }

describe('commandAllowed', () => {
  it('allows everything when nothing is up', () => {
    expect(commandAllowed('tab.close', idle)).toBe(true)
  })

  it('drops every command behind the close dialog', () => {
    for (const id of ['tab.close', 'tab.new', 'palette.open', 'overlay.pop']) {
      expect(commandAllowed(id, { ...idle, confirming: true })).toBe(false)
    }
  })

  it('lets only the palette chord through while the palette is open', () => {
    const s = { ...idle, paletteOpen: true }
    expect(commandAllowed('tab.close', s)).toBe(false)
    expect(commandAllowed('palette.open', s)).toBe(true)
  })

  it('lets only the overlay keys through behind an overlay', () => {
    const s = { ...idle, overlayOpen: true }
    expect(commandAllowed('tab.new', s)).toBe(false)
    expect(commandAllowed('overlay.pop', s)).toBe(true)
    expect(commandAllowed('overlay.closeTop', s)).toBe(true)
  })

  it('lets the settings chord and the overlay keys through behind the settings screen', () => {
    const s = { ...idle, settingsShown: true }
    expect(commandAllowed('tab.close', s)).toBe(false)
    expect(commandAllowed('app.openSettings', s)).toBe(true)
    expect(commandAllowed('overlay.pop', s)).toBe(true)
  })
})

// Guests (design-guests §10, spec-review 10 and 24): a guest's view runs only GUEST_SAFE_COMMANDS of its
// role among core commands, plugin commands only as a write guest, never the owner's [+] entries.
describe('guestMayRun', () => {
  it('lets the owner run everything (and an absent access is the owner)', () => {
    for (const id of ['app.openSettings', 'pane.splitRight', 'tab.newCommand.app.dev', 'a.one/run']) {
      expect(guestMayRun(id, 'owner')).toBe(true)
      expect(guestMayRun(id)).toBe(true)
    }
  })

  it("lets a read guest navigate only: no new tab, close, overlay keys, plugin commands or owner's tools", () => {
    for (const id of GUEST_SAFE_COMMANDS.read) expect(guestMayRun(id, 'read')).toBe(true)
    for (const id of ['tab.newClaude', 'tab.close', 'overlay.pop', 'a.one/run', 'app.openSettings', 'tab.rename', 'pane.splitRight']) {
      expect(guestMayRun(id, 'read')).toBe(false)
    }
  })

  it("lets a write guest also open Claude and Shell tabs, close, the overlay keys and plugins' commands", () => {
    for (const id of GUEST_SAFE_COMMANDS.write) expect(guestMayRun(id, 'write')).toBe(true)
    expect(guestMayRun('a.one/run', 'write')).toBe(true)
    for (const id of ['app.openSettings', 'app.openFolder', 'tab.toggleFlag', 'pane.splitRight', 'tab.inGroup.tab.newClaude']) {
      expect(guestMayRun(id, 'write')).toBe(false)
    }
  })

  it("never runs the owner's new-tab menu entries for a guest, though their ids hold no slash", () => {
    expect(guestMayRun('tab.newCommand.app.dev', 'write')).toBe(false)
    expect(guestMayRun('tab.newCommand.project.x', 'read')).toBe(false)
  })

  it('is the first rule of commandAllowed: nothing up changes it', () => {
    expect(commandAllowed('tab.newClaude', { ...idle, access: 'read' })).toBe(false)
    expect(commandAllowed('tab.newClaude', { ...idle, access: 'write' })).toBe(true)
    expect(commandAllowed('palette.open', { ...idle, access: 'read', paletteOpen: true })).toBe(true)
    expect(commandAllowed('app.openSettings', { ...idle, access: 'write', settingsShown: true })).toBe(false)
  })
})
