// The shell's command gate: what a bound command may do while a dialog, the palette, an overlay or
// the settings screen is up. It also gates `commands.trigger` (chords main forwards from a webview
// panel's page), so a web page can do no more than the same key typed into the shell.
import { describe, expect, it } from 'vitest'
import { commandAllowed, type ModalState } from '../../src/renderer/commands/command-gate'

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
