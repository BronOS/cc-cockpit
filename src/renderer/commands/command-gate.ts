/** What is up in the shell that limits which commands may run. */
export interface ModalState {
  /** The close-tab confirmation dialog. */
  confirming: boolean
  paletteOpen: boolean
  overlayOpen: boolean
  settingsShown: boolean
}

/**
 * Whether a bound command may run now, given what is up. The one gate for keys typed into the
 * shell page and for chords main forwards from a webview panel's view (`commands.trigger`), so a
 * key typed into a web page can do no more than the same key typed here.
 */
export function commandAllowed(id: string, s: ModalState): boolean {
  // While the close dialog is up no command runs at all: Cmd+W again must not close a second
  // tab, nor Cmd+T open one, nor anything move the focus out of the dialog unanswered.
  if (s.confirming) return false
  // With the palette open only the palette chord (to toggle it shut) works: Cmd+W must not
  // close a tab, nor Cmd+T open one, behind the dialog.
  if (s.paletteOpen && id !== 'palette.open') return false
  // Likewise behind an overlay: only the overlay keys act until it is closed.
  if (s.overlayOpen && id !== 'overlay.pop' && id !== 'overlay.closeTop') return false
  // And behind the settings screen: its own chord toggles it, the overlay keys reach an
  // overlay opened over it (Esc inside the screen itself is handled by the screen).
  if (s.settingsShown && id !== 'app.openSettings' && id !== 'overlay.pop' && id !== 'overlay.closeTop') return false
  return true
}
